import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGeminiFreeSummaryProvider,
  createGeminiFreeSummaryProviderFromEnvironment,
} from '../src/gemini-summary.js';

const input = {
  businessName: 'Warung QA Sintetis',
  timeZone: 'Asia/Jakarta',
  from: '2026-11-01',
  to: '2026-11-02',
  startAt: '2026-10-31T17:00:00.000Z',
  endAt: '2026-11-01T17:00:00.000Z',
  totalRevenue: 2500,
  transactionCount: 1,
  unitsSold: 2,
};

const baseConfig = {
  baseUrl: 'http://127.0.0.1:20128/v1',
  model: 'gemini/gemini-3.5-flash-lite',
  apiKey: 'local-test-key',
};

test('Gemini Free provider stays disabled unless its runtime gate and settings are complete', () => {
  assert.equal(createGeminiFreeSummaryProviderFromEnvironment({
    LOCAL_GEMINI_SUMMARY_ENABLED: 'false',
    LOCAL_GEMINI_ROUTER_BASE_URL: baseConfig.baseUrl,
    LOCAL_GEMINI_ROUTER_MODEL: baseConfig.model,
    LOCAL_GEMINI_ROUTER_API_KEY: baseConfig.apiKey,
  }), undefined);
  assert.equal(createGeminiFreeSummaryProviderFromEnvironment({
    LOCAL_GEMINI_SUMMARY_ENABLED: 'true',
    LOCAL_GEMINI_ROUTER_BASE_URL: baseConfig.baseUrl,
    LOCAL_GEMINI_ROUTER_MODEL: baseConfig.model,
  }), undefined);
});

test('Gemini Free provider accepts only loopback 9Router and the approved model', () => {
  assert.equal(createGeminiFreeSummaryProvider({ ...baseConfig, baseUrl: 'https://router.example/v1' }), undefined);
  assert.equal(createGeminiFreeSummaryProvider({ ...baseConfig, baseUrl: 'http://127.0.0.1:20128/v1?token=secret' }), undefined);
  assert.equal(createGeminiFreeSummaryProvider({ ...baseConfig, model: 'openrouter/google/gemini-3.5-flash-lite' }), undefined);
});

test('summary request sends only selected server aggregates and validates the result', async () => {
  let requestedUrl = '';
  let requestHeaders: HeadersInit | undefined;
  let requestBody = '';
  let requestSignal: AbortSignal | null = null;
  const provider = createGeminiFreeSummaryProvider({
    ...baseConfig,
    fetcher: async (url, init) => {
      requestedUrl = String(url);
      requestHeaders = init?.headers;
      requestBody = String(init?.body);
      requestSignal = init?.signal as AbortSignal;
      return new Response(JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        choices: [{ message: { content: '```json\n{"summary":"Pendapatan pada periode terpilih 2500; transaksi selesai 1; unit terjual 2.","highlights":["Pendapatan: 2500","Transaksi selesai: 1","Unit terjual: 2"]}\n```' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.ok(provider);

  const result = await provider.summarize(input);
  const request = JSON.parse(requestBody) as { model: string; stream: boolean; messages: Array<{ role: string; content: string }> };
  const userMessage = request.messages.find((message) => message.role === 'user');

  assert.equal(requestedUrl, 'http://127.0.0.1:20128/v1/chat/completions');
  assert.equal(new Headers(requestHeaders).get('authorization'), 'Bearer local-test-key');
  assert.equal(request.model, 'gemini/gemini-3.5-flash-lite');
  assert.equal(request.stream, false);
  assert.deepEqual(JSON.parse(userMessage?.content ?? ''), {
    totalRevenue: 2500,
    transactionCount: 1,
    unitsSold: 2,
  });
  assert.ok(requestSignal instanceof AbortSignal);
  assert.deepEqual(result, {
    summary: 'Pendapatan pada periode terpilih 2500; transaksi selesai 1; unit terjual 2.',
    highlights: ['Pendapatan: 2500', 'Transaksi selesai: 1', 'Unit terjual: 2'],
  });
});

test('summary provider rejects unsupported numbers and dates', async (context) => {
  const invalidContents = [
    '{"summary":"Pendapatan 2500 meningkat karena promosi berhasil.","highlights":["Tren naik","Transaksi selesai: 1","Unit terjual: 2"]}',
    '{"summary":"Pendapatan pada periode terpilih 2500; transaksi selesai 1; unit terjual 2.","highlights":["Pendapatan: 2500","Meningkat karena promosi berhasil","Unit terjual: 2"]}',
    '{"summary":"Pendapatan pada periode terpilih 2500; transaksi selesai 1; unit terjual 2.","highlights":["Pendapatan: 2500","Transaksi selesai: 1 pada 2 November","Unit terjual: 2"]}',
  ];
  for (const content of invalidContents) {
    const provider = createGeminiFreeSummaryProvider({
      ...baseConfig,
      fetcher: async () => new Response(JSON.stringify({ model: 'gemini-3.5-flash-lite', choices: [{ message: { content } }] }), { status: 200 }),
    });
    assert.ok(provider);
    await context.test(content, async () => {
      await assert.rejects(provider.summarize(input), /approved factual format/);
    });
  }
});

test('provider failures never include upstream response or credentials', async () => {
  const provider = createGeminiFreeSummaryProvider({
    ...baseConfig,
    fetcher: async () => new Response('sensitive-upstream-body', { status: 429 }),
  });
  assert.ok(provider);
  await assert.rejects(provider.summarize(input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Gemini Free provider unavailable.');
    assert.doesNotMatch(error.message, /local-test-key|sensitive-upstream-body/);
    return true;
  });
});
