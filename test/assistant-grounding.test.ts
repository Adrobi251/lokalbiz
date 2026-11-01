import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp, type AiSummaryProvider } from '../src/app.js';
import { createDatabase, type SqliteDatabase, nowIso } from '../src/db.js';
import { createGeminiFreeSummaryProviderFromEnvironment } from '../src/gemini-summary.js';
import { createTestBearerToken } from './auth-fixtures.js';
import { addDays, formatDate } from '../web/src/lib/format.ts';

const authSecret = 'test-secret-with-at-least-thirty-two-bytes';
process.env.AUTH_JWT_SECRET = authSecret;

type Json = any;

interface TestContext {
  database: SqliteDatabase;
  server: Server;
  baseUrl: string;
  businessId: string;
  token: string;
  close: () => Promise<void>;
}

async function createContext(aiSummaryProvider: AiSummaryProvider, timeZone = 'UTC'): Promise<TestContext> {
  const database = createDatabase(':memory:');
  const businessId = randomUUID();
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO business (id, name, currency, time_zone, created_at)
    VALUES (?, 'Toko Uji', 'IDR', ?, ?)
  `).run(businessId, timeZone, createdAt);
  database.prepare(`
    INSERT INTO business_membership (id, business_id, user_id, role, is_active, created_at)
    VALUES (?, ?, 'owner-1', 'OWNER', 1, ?)
  `).run(randomUUID(), businessId, createdAt);

  const token = await createTestBearerToken(database, 'owner-1');
  const server = createServer(createApp(database, { aiSummaryProvider }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    database,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    businessId,
    token,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}

async function call(
  context: TestContext,
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<{ response: Response; body: Json }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${context.token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`${context.baseUrl}/api/businesses/${context.businessId}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() as Json };
}

async function createProduct(context: TestContext): Promise<string> {
  const { response, body } = await call(context, '/products', {
    method: 'POST',
    body: { name: 'Produk Uji', sellingPrice: 1_200, initialStock: 20, minStock: 2 },
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.id as string;
}

async function createSale(context: TestContext, productId: string, quantity: number, key: string): Promise<string> {
  const { response, body } = await call(context, '/transactions', {
    method: 'POST',
    body: { items: [{ productId, quantity }] },
    idempotencyKey: key,
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.id as string;
}

test('assistant uses a business-local half-open period and displays the included-through date', async () => {
  type SummaryInput = Parameters<AiSummaryProvider['summarize']>[0];
  let receivedInput: SummaryInput | undefined;
  const provider: AiSummaryProvider = {
    summarize: async (input) => {
      receivedInput = input;
      return { summary: 'Ringkasan sintetis untuk 1 November 2026.', highlights: [] };
    },
  };
  const context = await createContext(provider, 'Asia/Jakarta');
  try {
    const productId = await createProduct(context);
    const voidedSaleId = await createSale(context, productId, 2, 'assistant-grounding-voided');
    const completedSaleId = await createSale(context, productId, 1, 'assistant-grounding-completed');
    const outOfPeriodSaleId = await createSale(context, productId, 4, 'assistant-grounding-outside-period');

    const voided = await call(context, `/transactions/${voidedSaleId}/void`, {
      method: 'POST',
      body: { reason: 'Transaksi uji dibatalkan' },
    });
    assert.equal(voided.response.status, 200, JSON.stringify(voided.body));

    const from = '2026-11-01';
    const to = '2026-11-02';
    context.database.prepare('UPDATE sales_transaction SET created_at = ? WHERE id = ?')
      .run('2026-10-31T17:00:00.000Z', completedSaleId);
    context.database.prepare('UPDATE sales_transaction SET created_at = ? WHERE id = ?')
      .run('2026-11-01T16:59:59.999Z', voidedSaleId);
    context.database.prepare('UPDATE sales_transaction SET created_at = ? WHERE id = ?')
      .run('2026-11-01T17:00:00.000Z', outOfPeriodSaleId);

    const summary = await call(context, '/assistant/summaries', {
      method: 'POST',
      body: { from, to },
    });

    assert.equal(summary.response.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.data.dataStatus, 'READY');
    assert.deepEqual(summary.body.data.period, { from, to, timeZone: 'Asia/Jakarta' });
    assert.equal(summary.body.data.summary, 'Ringkasan sintetis untuk 1 November 2026.');
    assert.equal(addDays(to, -1), '2026-11-01');
    assert.equal(
      `Periode ${formatDate(from)} sampai ${formatDate(addDays(to, -1))}`,
      'Periode 1 Nov 2026 sampai 1 Nov 2026',
    );
    assert.notEqual(formatDate(to), formatDate(addDays(to, -1)));
    assert.deepEqual(receivedInput, {
      businessName: 'Toko Uji',
      timeZone: 'Asia/Jakarta',
      from,
      to,
      startAt: '2026-10-31T17:00:00.000Z',
      endAt: '2026-11-01T17:00:00.000Z',
      totalRevenue: 1_200,
      transactionCount: 1,
      unitsSold: 1,
    });
    assert.deepEqual(Object.keys(receivedInput ?? {}).sort(), [
      'businessName', 'endAt', 'from', 'startAt', 'timeZone', 'to', 'totalRevenue', 'transactionCount', 'unitsSold',
    ]);
  } finally {
    await context.close();
  }
});

const liveGeminiProvider = createGeminiFreeSummaryProviderFromEnvironment();
test('Gemini Free summary stays grounded to completed synthetic sales and server period', {
  skip: liveGeminiProvider ? false : 'LOCAL_GEMINI_SUMMARY_ENABLED and Gemini Free runtime settings are required',
}, async () => {
  assert.ok(liveGeminiProvider);
  const context = await createContext(liveGeminiProvider, 'Asia/Jakarta');
  try {
    const productId = await createProduct(context);
    const voidedSaleId = await createSale(context, productId, 2, 'gemini-live-grounding-voided');
    const includedSaleId = await createSale(context, productId, 1, 'gemini-live-grounding-included');
    const outOfPeriodSaleId = await createSale(context, productId, 4, 'gemini-live-grounding-outside');
    const voided = await call(context, `/transactions/${voidedSaleId}/void`, {
      method: 'POST',
      body: { reason: 'QA sintetis' },
    });
    assert.equal(voided.response.status, 200, JSON.stringify(voided.body));

    const from = '2026-11-01';
    const to = '2026-11-02';
    context.database.prepare('UPDATE sales_transaction SET created_at = ? WHERE id = ?')
      .run('2026-10-31T18:00:00.000Z', includedSaleId);
    context.database.prepare('UPDATE sales_transaction SET created_at = ? WHERE id = ?')
      .run('2026-11-01T17:00:00.000Z', outOfPeriodSaleId);

    const result = await call(context, '/assistant/summaries', {
      method: 'POST',
      body: { from, to },
    });

    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.dataStatus, 'READY');
    assert.deepEqual(result.body.data.period, { from, to, timeZone: 'Asia/Jakarta' });
    assert.doesNotMatch(result.body.data.summary, /(?:2026-11-02|2\s+November)/i);
    const numericTokens = `${result.body.data.summary} ${result.body.data.highlights.join(' ')}`.match(/\d[\d.,]*/g) ?? [];
    const normalizedNumbers = numericTokens.map((token: string) => token.replace(/[.,]/g, ''));
    assert.ok(normalizedNumbers.includes('1200'), `Expected included revenue 1200: ${JSON.stringify(result.body.data)}`);
    assert.ok(normalizedNumbers.includes('1'), `Expected one completed transaction and unit: ${JSON.stringify(result.body.data)}`);
    assert.ok(normalizedNumbers.every((value: string) => ['1200', '1'].includes(value)), `Unexpected numbers: ${numericTokens.join(', ')}`);
  } finally {
    await context.close();
  }
});

test('provider errors return a generic 503 without upstream details', async () => {
  const provider: AiSummaryProvider = {
    summarize: async () => {
      throw new Error('upstream secret local-test-key and response body');
    },
  };
  const context = await createContext(provider);
  try {
    const productId = await createProduct(context);
    await createSale(context, productId, 1, 'assistant-summary-provider-error');
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const result = await call(context, '/assistant/summaries', { method: 'POST', body: { from, to } });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, 'AI_SUMMARY_UNAVAILABLE');
    assert.equal(result.body.error.message, 'Ringkasan belum tersedia. Coba lagi nanti.');
    assert.doesNotMatch(JSON.stringify(result.body), /local-test-key|upstream|response body/i);
  } finally {
    await context.close();
  }
});

test('empty sales period returns insufficient data without calling the provider', async () => {
  let providerCalls = 0;
  const provider: AiSummaryProvider = {
    summarize: async () => {
      providerCalls += 1;
      return { summary: 'Tidak seharusnya dipanggil.', highlights: [] };
    },
  };
  const context = await createContext(provider);
  try {
    const result = await call(context, '/assistant/summaries', {
      method: 'POST',
      body: { from: '2026-11-01', to: '2026-11-02' },
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.dataStatus, 'INSUFFICIENT_DATA');
    assert.equal(result.body.data.summary, 'Belum ada transaksi pada periode yang dipilih.');
    assert.equal(providerCalls, 0);
  } finally {
    await context.close();
  }
});
