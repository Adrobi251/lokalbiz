import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { test } from 'node:test';
import { createApp, type AiSummaryProvider } from '../src/app.js';
import { createDatabase, type SqliteDatabase, nowIso } from '../src/db.js';
import { periodBounds } from '../src/period.js';

const authSecret = 'test-secret-with-at-least-thirty-two-bytes';
process.env.AUTH_JWT_SECRET = authSecret;

type Json = any;

interface TestContext {
  database: SqliteDatabase;
  server: Server;
  baseUrl: string;
  businessId: string;
  tokenFor: (userId?: string) => Promise<string>;
  close: () => Promise<void>;
}

async function createContext(options: { timeZone?: string; aiSummaryProvider?: AiSummaryProvider } = {}): Promise<TestContext> {
  const database = createDatabase(':memory:');
  const businessId = addBusiness(database, 'owner-1', options.timeZone ?? 'UTC');
  const tokenCache = new Map<string, Promise<string>>();
  const tokenFor = (userId = 'owner-1'): Promise<string> => {
    const cached = tokenCache.get(userId);
    if (cached) return cached;
    const token = new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(new TextEncoder().encode(authSecret));
    tokenCache.set(userId, token);
    return token;
  };
  const server = createServer(createApp(database, options.aiSummaryProvider ? { aiSummaryProvider: options.aiSummaryProvider } : {}));
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
    tokenFor,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}

function addBusiness(database: SqliteDatabase, userId: string, timeZone: string): string {
  const businessId = randomUUID();
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO business (id, name, currency, time_zone, created_at)
    VALUES (?, ?, 'IDR', ?, ?)
  `).run(businessId, `Usaha ${userId}`, timeZone, createdAt);
  database.prepare(`
    INSERT INTO business_membership (id, business_id, user_id, role, is_active, created_at)
    VALUES (?, ?, ?, 'OWNER', 1, ?)
  `).run(randomUUID(), businessId, userId, createdAt);
  return businessId;
}

function seedProduct(
  context: TestContext,
  businessId: string,
  options: { name?: string; stock?: number; price?: number; createdAt?: string } = {},
): string {
  const id = randomUUID();
  const createdAt = options.createdAt ?? nowIso();
  context.database.prepare(`
    INSERT INTO product (id, business_id, name, sku, unit_price, stock_quantity, low_stock_threshold, is_archived, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, 5, 0, ?, ?)
  `).run(id, businessId, options.name ?? 'Produk tes', options.price ?? 100, options.stock ?? 20, createdAt, createdAt);
  return id;
}

async function call(
  context: TestContext,
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string; userId?: string } = {},
): Promise<{ response: Response; body: Json }> {
  const userId = options.userId ?? 'owner-1';
  const headers: Record<string, string> = { Authorization: `Bearer ${await context.tokenFor(userId)}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const membership = context.database.prepare('SELECT business_id FROM business_membership WHERE user_id = ? AND is_active = 1').get(userId) as { business_id: string } | undefined;
  const suffix = path.slice('/api'.length);
  const routeSuffix = suffix === '/forecasts/sales' ? '/inventory/forecasts'
    : suffix === '/alerts' ? '/inventory/alerts'
      : suffix;
  const tenantPath = path.startsWith('/api/businesses/')
    ? path
    : `/api/businesses/${membership?.business_id ?? context.businessId}${routeSuffix}`;
  const response = await fetch(`${context.baseUrl}${tenantPath}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() as Json };
}

async function makeSale(context: TestContext, productId: string, quantity: number, key: string): Promise<string> {
  const { response, body } = await call(context, '/api/transactions', {
    method: 'POST',
    body: { items: [{ productId, quantity }] },
    idempotencyKey: key,
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.id as string;
}

test('dua penjualan bersamaan untuk stok terakhir hanya menyelesaikan satu transaksi', async () => {
  const context = await createContext();
  try {
    const productId = seedProduct(context, context.businessId, { stock: 1, price: 750 });
    const requests = await Promise.all([
      call(context, '/api/transactions', {
        method: 'POST', body: { items: [{ productId, quantity: 1 }] }, idempotencyKey: 'parallel-last-unit-a',
      }),
      call(context, '/api/transactions', {
        method: 'POST', body: { items: [{ productId, quantity: 1 }] }, idempotencyKey: 'parallel-last-unit-b',
      }),
    ]);

    assert.deepEqual(requests.map(({ response }) => response.status).sort(), [201, 409]);
    const rejected = requests.find(({ response }) => response.status === 409)!;
    assert.equal(rejected.body.error.code, 'INSUFFICIENT_STOCK');
    assert.deepEqual(rejected.body.error.details.items, [{ productId, available: 0, requested: 1 }]);
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(productId) as { stock_quantity: number }).stock_quantity, 0);
    assert.equal((context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get() as { count: number }).count, 1);
    assert.equal((context.database.prepare("SELECT COUNT(*) AS count FROM stock_movement WHERE movement_type = 'SALE'").get() as { count: number }).count, 1);
  } finally {
    await context.close();
  }
});

test('retry paralel dengan key dan payload identik mengembalikan transaksi pertama satu kali', async () => {
  const context = await createContext();
  try {
    const productId = seedProduct(context, context.businessId, { stock: 4, price: 1_250 });
    const payload = { items: [{ productId, quantity: 2 }] };
    const [first, retry] = await Promise.all([
      call(context, '/api/transactions', { method: 'POST', body: payload, idempotencyKey: 'parallel-retry' }),
      call(context, '/api/transactions', { method: 'POST', body: payload, idempotencyKey: 'parallel-retry' }),
    ]);

    assert.equal(first.response.status, 201);
    assert.equal(retry.response.status, 201);
    assert.deepEqual(first.body, retry.body);
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(productId) as { stock_quantity: number }).stock_quantity, 2);
    assert.equal((context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get() as { count: number }).count, 1);
    assert.equal((context.database.prepare('SELECT COUNT(*) AS count FROM idempotency_record').get() as { count: number }).count, 1);
  } finally {
    await context.close();
  }
});

test('harga penjualan ditentukan server dan field harga dari klien ditolak', async () => {
  const context = await createContext();
  try {
    const productId = seedProduct(context, context.businessId, { stock: 5, price: 1_250 });
    const sale = await call(context, '/api/transactions', {
      method: 'POST',
      body: { items: [{ productId, quantity: 2 }] },
      idempotencyKey: 'server-priced-sale',
    });
    assert.equal(sale.response.status, 201, JSON.stringify(sale.body));
    assert.equal(sale.body.data.items[0].unitPrice, 1_250);
    assert.equal(sale.body.data.totalAmount, 2_500);

    const clientPricedSale = await call(context, '/api/transactions', {
      method: 'POST',
      body: { items: [{ productId, quantity: 1, unitPrice: 1 }] },
      idempotencyKey: 'client-priced-sale',
    });
    assert.equal(clientPricedSale.response.status, 422);
    assert.equal(clientPricedSale.body.error.code, 'VALIDATION_ERROR');
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(productId) as { stock_quantity: number }).stock_quantity, 3);
    assert.equal((context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get() as { count: number }).count, 1);
  } finally {
    await context.close();
  }
});

test('void menolak alasan kosong dan memulihkan semua item satu kali', async () => {
  const context = await createContext();
  try {
    const firstProduct = seedProduct(context, context.businessId, { name: 'Kopi', stock: 5, price: 2_000 });
    const secondProduct = seedProduct(context, context.businessId, { name: 'Teh', stock: 7, price: 3_000 });
    const sale = await call(context, '/api/transactions', {
      method: 'POST',
      body: { items: [{ productId: firstProduct, quantity: 2 }, { productId: secondProduct, quantity: 3 }] },
      idempotencyKey: 'void-multiple-items',
    });
    assert.equal(sale.response.status, 201);
    const from = sale.body.data.createdAt.slice(0, 10);
    const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const reportBeforeVoid = await call(context, `/api/reports/sales?from=${from}&to=${to}`);
    assert.equal(reportBeforeVoid.response.status, 200);
    assert.equal(reportBeforeVoid.body.data.totalRevenue, 13_000);
    assert.equal(reportBeforeVoid.body.data.transactionCount, 1);

    const missingReason = await call(context, `/api/transactions/${sale.body.data.id}/void`, { method: 'POST', body: {} });
    assert.equal(missingReason.response.status, 422);
    assert.equal((context.database.prepare('SELECT status FROM sales_transaction WHERE id = ?').get(sale.body.data.id) as { status: string }).status, 'COMPLETED');
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(firstProduct) as { stock_quantity: number }).stock_quantity, 3);
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(secondProduct) as { stock_quantity: number }).stock_quantity, 4);

    const voided = await call(context, `/api/transactions/${sale.body.data.id}/void`, { method: 'POST', body: { reason: 'Salah input' } });
    const secondVoid = await call(context, `/api/transactions/${sale.body.data.id}/void`, { method: 'POST', body: { reason: 'Percobaan kedua' } });
    assert.equal(voided.response.status, 200);
    assert.equal(secondVoid.response.status, 409);
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(firstProduct) as { stock_quantity: number }).stock_quantity, 5);
    assert.equal((context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(secondProduct) as { stock_quantity: number }).stock_quantity, 7);
    assert.equal((context.database.prepare("SELECT COUNT(*) AS count FROM stock_movement WHERE movement_type = 'VOID'").get() as { count: number }).count, 2);
    assert.equal((context.database.prepare('SELECT status FROM sales_transaction WHERE id = ?').get(sale.body.data.id) as { status: string }).status, 'VOIDED');
    const reportAfterVoid = await call(context, `/api/reports/sales?from=${from}&to=${to}`);
    assert.equal(reportAfterVoid.response.status, 200);
    assert.equal(reportAfterVoid.body.data.totalRevenue, 0);
    assert.equal(reportAfterVoid.body.data.transactionCount, 0);
    assert.deepEqual(reportAfterVoid.body.data.dailyRevenue[0], { date: from, totalRevenue: 0, transactionCount: 0 });
    assert.deepEqual(reportAfterVoid.body.data.topProducts, []);
  } finally {
    await context.close();
  }
});

test('periode laporan mengikuti batas tanggal lokal inklusif-eksklusif saat DST berganti', async () => {
  const period = periodBounds('2025-03-09', '2025-03-10', 'America/Los_Angeles', true);
  assert.equal(period.startAt, '2025-03-09T08:00:00.000Z');
  assert.equal(period.endAt, '2025-03-10T07:00:00.000Z');

  const context = await createContext({ timeZone: 'America/Los_Angeles' });
  try {
    const productId = seedProduct(context, context.businessId, { stock: 100, price: 10 });
    const samples = [
      { at: '2025-03-09T07:59:59.999Z', quantity: 8, included: false },
      { at: '2025-03-09T08:00:00.000Z', quantity: 2, included: true },
      { at: '2025-03-10T06:59:59.999Z', quantity: 3, included: true },
      { at: '2025-03-10T07:00:00.000Z', quantity: 7, included: false },
    ];
    for (const [index, sample] of samples.entries()) {
      const transactionId = await makeSale(context, productId, sample.quantity, `dst-boundary-${index}`);
      context.database.prepare('UPDATE sales_transaction SET created_at = ? WHERE id = ?').run(sample.at, transactionId);
    }

    const report = await call(context, '/api/reports/sales?from=2025-03-09&to=2025-03-10');
    assert.equal(report.response.status, 200);
    assert.equal(report.body.data.totalRevenue, 50);
    assert.equal(report.body.data.transactionCount, 2);
    assert.deepEqual(report.body.data.dailyRevenue, [{ date: '2025-03-09', totalRevenue: 50, transactionCount: 2 }]);
  } finally {
    await context.close();
  }
});

test('akses usaha tidak dapat membaca produk atau transaksi milik keanggotaan lain', async () => {
  const context = await createContext();
  try {
    const otherBusinessId = addBusiness(context.database, 'owner-2', 'UTC');
    const otherProductId = seedProduct(context, otherBusinessId, { name: 'Rahasia usaha kedua', stock: 2 });
    const otherSale = await call(context, '/api/transactions', {
      method: 'POST',
      body: { items: [{ productId: otherProductId, quantity: 1 }] },
      idempotencyKey: 'other-business-sale',
      userId: 'owner-2',
    });
    assert.equal(otherSale.response.status, 201);

    const productList = await call(context, '/api/products');
    const crossProduct = await call(context, `/api/products/${otherProductId}`);
    const crossTransaction = await call(context, `/api/transactions/${otherSale.body.data.id}`);
    const foreignBusinessProducts = await call(context, `/api/businesses/${otherBusinessId}/products`);
    const foreignBusinessTransactions = await call(context, `/api/businesses/${otherBusinessId}/transactions`);
    assert.equal(productList.body.data.length, 0);
    assert.equal(crossProduct.response.status, 404);
    assert.equal(crossProduct.body.error.code, 'PRODUCT_NOT_FOUND');
    assert.equal(crossTransaction.response.status, 404);
    assert.equal(crossTransaction.body.error.code, 'TRANSACTION_NOT_FOUND');
    assert.equal(foreignBusinessProducts.response.status, 404);
    assert.equal(foreignBusinessProducts.body.error.code, 'BUSINESS_NOT_FOUND');
    assert.equal(foreignBusinessTransactions.response.status, 404);
    assert.equal(foreignBusinessTransactions.body.error.code, 'BUSINESS_NOT_FOUND');
  } finally {
    await context.close();
  }
});

test('GET businesses/current mengambil usaha dari JWT dan mengembalikan 404 tanpa keanggotaan', async () => {
  const context = await createContext();
  try {
    const otherBusinessId = addBusiness(context.database, 'owner-2', 'Asia/Jakarta');
    const currentOwner = await call(context, '/api/businesses/current');
    const currentOther = await call(context, '/api/businesses/current', { userId: 'owner-2' });
    const noBusiness = await call(context, '/api/businesses/current', { userId: 'owner-3' });

    assert.equal(currentOwner.response.status, 200, JSON.stringify(currentOwner.body));
    assert.equal(currentOwner.body.data.id, context.businessId);
    assert.equal(currentOwner.body.data.name, 'Usaha owner-1');
    assert.equal(currentOwner.body.data.currency, 'IDR');
    assert.equal(currentOwner.body.data.timeZone, 'UTC');
    assert.ok(currentOwner.body.data.createdAt);
    assert.equal(currentOther.response.status, 200, JSON.stringify(currentOther.body));
    assert.equal(currentOther.body.data.id, otherBusinessId);
    assert.equal(currentOther.body.data.timeZone, 'Asia/Jakarta');
    assert.equal(noBusiness.response.status, 404);
    assert.equal(noBusiness.body.error.code, 'BUSINESS_NOT_FOUND');
  } finally {
    await context.close();
  }
});

test('user tanpa bisnis dapat membuat usaha setelah current mengembalikan BUSINESS_NOT_FOUND', async () => {
  const context = await createContext();
  try {
    const userId = 'owner-3';
    const token = await context.tokenFor(userId);
    const before = await call(context, '/api/businesses/current', { userId });
    assert.equal(before.response.status, 404);
    assert.equal(before.body.error.code, 'BUSINESS_NOT_FOUND');

    const createdResponse = await fetch(`${context.baseUrl}/api/businesses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Usaha owner-3', timeZone: 'Asia/Jakarta' }),
    });
    const createdBody = await createdResponse.json() as Json;
    assert.equal(createdResponse.status, 201, JSON.stringify(createdBody));
    assert.equal(createdBody.data.name, 'Usaha owner-3');
    assert.equal(createdBody.data.timeZone, 'Asia/Jakarta');

    const after = await call(context, '/api/businesses/current', { userId });
    assert.equal(after.response.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.data.id, createdBody.data.id);
  } finally {
    await context.close();
  }
});

test('path bisnis menolak pembacaan usaha milik pengguna lain', async () => {
  const context = await createContext();
  try {
    const otherBusinessId = addBusiness(context.database, 'owner-2', 'Asia/Jakarta');
    const requestedForeignBusiness = await call(context, `/api/businesses/${otherBusinessId}`);
    assert.equal(requestedForeignBusiness.response.status, 404);
    assert.equal(requestedForeignBusiness.body.error.code, 'BUSINESS_NOT_FOUND');
  } finally {
    await context.close();
  }
});

test('handler tenant hanya bisa diakses lewat prefix businessId kanonis', async () => {
  const context = await createContext();
  try {
    const canonicalBusiness = await call(context, `/api/businesses/${context.businessId}`);
    assert.equal(canonicalBusiness.response.status, 200);
    assert.equal(canonicalBusiness.body.data.id, context.businessId);

    for (const path of ['/api/business', '/api/products', '/api/transactions']) {
      const response = await fetch(`${context.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${await context.tokenFor('owner-1')}` },
      });
      const body = await response.json() as Json;
      assert.equal(response.status, 404, path);
      assert.equal(body.error.code, 'BUSINESS_PATH_REQUIRED', path);
    }
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get()?.count, 0);
  } finally {
    await context.close();
  }
});

test('respons kosong dan error API tetap berbentuk stabil untuk UI state', async () => {
  const context = await createContext();
  try {
    const products = await call(context, '/api/products?search=tidak-ada');
    const report = await call(context, '/api/reports/sales?from=2025-01-01&to=2025-01-02');
    const invalidTransactionId = await call(context, '/api/transactions/not-a-uuid');

    assert.deepEqual(products.body.data, []);
    assert.deepEqual(products.body.pagination, { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
    assert.equal(report.body.data.totalRevenue, 0);
    assert.equal(report.body.data.transactionCount, 0);
    assert.deepEqual(report.body.data.dailyRevenue, [{ date: '2025-01-01', totalRevenue: 0, transactionCount: 0 }]);
    assert.deepEqual(report.body.data.topProducts, []);
    assert.equal(invalidTransactionId.response.status, 422);
    assert.equal(typeof invalidTransactionId.body.error.code, 'string');
    assert.equal(typeof invalidTransactionId.body.error.message, 'string');
  } finally {
    await context.close();
  }
});

test('produk memakai kontrak final sellingPrice dan minStock', async () => {
  const context = await createContext();
  try {
    const product = await call(context, '/api/products', {
      method: 'POST',
      body: { name: 'Barang kontrak final', sellingPrice: 12_000, initialStock: 0, minStock: 2 },
    });
    assert.equal(product.response.status, 201, JSON.stringify(product.body));
    assert.equal(product.body.data.sellingPrice, 12_000);
    assert.equal(product.body.data.minStock, 2);
    assert.equal('unitPrice' in product.body.data, false);
    const initialMovement = context.database.prepare("SELECT quantity_delta, reason FROM stock_movement WHERE product_id = ? AND movement_type = 'INITIAL'").get(product.body.data.id) as { quantity_delta: number; reason: string };
    assert.equal(initialMovement.quantity_delta, 0);
    assert.equal(initialMovement.reason, 'INITIAL_STOCK');
  } finally {
    await context.close();
  }
});

test('laporan sales menerima from/to dan mengembalikan dailyRevenue serta topProducts', async () => {
  const context = await createContext();
  try {
    const report = await call(context, '/api/reports/sales?from=2025-01-01&to=2025-01-02');
    assert.equal(report.response.status, 200, JSON.stringify(report.body));
    assert.ok(Array.isArray(report.body.data.dailyRevenue));
    assert.ok(Array.isArray(report.body.data.topProducts));
    assert.equal(report.body.data.totalRevenue, 0);
    assert.equal(report.body.data.transactionCount, 0);
  } finally {
    await context.close();
  }
});

test('prediksi sales mengembalikan status NO_RECENT_SALES dan metrik kontrak', async () => {
  const context = await createContext();
  try {
    const noSalesId = seedProduct(context, context.businessId, {
      name: 'Barang tanpa penjualan', stock: 9, createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    });
    const belowThresholdId = seedProduct(context, context.businessId, {
      name: 'Riwayat 13 hari', createdAt: new Date(Date.now() - 13 * 86_400_000).toISOString(),
    });
    const thresholdId = seedProduct(context, context.businessId, {
      name: 'Riwayat 14 hari', createdAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    });
    const forecast = await call(context, '/api/inventory/forecasts?windowDays=30');
    assert.equal(forecast.response.status, 200, JSON.stringify(forecast.body));
    const item = forecast.body.data.items.find((entry: Json) => entry.productId === noSalesId);
    const belowThreshold = forecast.body.data.items.find((entry: Json) => entry.productId === belowThresholdId);
    const atThreshold = forecast.body.data.items.find((entry: Json) => entry.productId === thresholdId);
    assert.equal(Date.parse(forecast.body.data.to) - Date.parse(forecast.body.data.from), 30 * 86_400_000);
    assert.equal(item.productName, 'Barang tanpa penjualan');
    assert.equal(item.stockQuantity, 9);
    assert.equal(item.status, 'NO_RECENT_SALES');
    assert.equal(item.estimatedDaysRemaining, null);
    assert.equal(item.insufficientData, false);
    assert.equal(item.from, forecast.body.data.from);
    assert.equal(item.to, forecast.body.data.to);
    assert.equal(belowThreshold.historyDays, 13);
    assert.equal(belowThreshold.status, 'INSUFFICIENT_DATA');
    assert.equal(belowThreshold.insufficientData, true);
    assert.equal(atThreshold.historyDays, 14);
    assert.equal(atThreshold.status, 'NO_RECENT_SALES');
    assert.equal(atThreshold.insufficientData, false);
  } finally {
    await context.close();
  }
});

test('ringkasan AI memakai POST nested path, rentang from/to, dan dataStatus', async () => {
  const provider: AiSummaryProvider = {
    summarize: async () => ({ summary: 'Ringkasan periode yang dipilih.', highlights: [] }),
  };
  const context = await createContext({ aiSummaryProvider: provider });
  try {
    const productId = seedProduct(context, context.businessId, { name: 'Produk ringkasan', stock: 4, price: 500 });
    await makeSale(context, productId, 1, 'assistant-summary-seed');
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const summary = await call(context, `/api/businesses/${context.businessId}/assistant/summaries`, {
      method: 'POST', body: { from, to },
    });
    assert.equal(summary.response.status, 200, JSON.stringify(summary.body));
    assert.ok(summary.body.data.period);
    assert.equal(summary.body.data.summary, 'Ringkasan periode yang dipilih.');
    assert.ok('dataStatus' in summary.body.data);
    assert.ok(Array.isArray(summary.body.data.highlights));
  } finally {
    await context.close();
  }
});

test('assistant returns 503 AI_SUMMARY_NOT_CONFIGURED when provider is disabled and sales exist', async () => {
  const context = await createContext();
  try {
    const productId = seedProduct(context, context.businessId, { name: 'Produk tanpa provider', stock: 3, price: 700 });
    await makeSale(context, productId, 1, 'assistant-summary-no-provider');
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const summary = await call(context, `/api/businesses/${context.businessId}/assistant/summaries`, {
      method: 'POST',
      body: { from, to },
    });

    assert.equal(summary.response.status, 503, JSON.stringify(summary.body));
    assert.equal(summary.body.error.code, 'AI_SUMMARY_NOT_CONFIGURED');
    assert.equal(summary.body.error.message, 'Penyedia ringkasan AI belum dikonfigurasi.');
  } finally {
    await context.close();
  }
});
