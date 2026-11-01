import type { AiSummaryProvider } from './app.js';

const GEMINI_FREE_MODEL = 'gemini/gemini-3.5-flash-lite';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_RESPONSE_BYTES = 16_384;
const MAX_OUTPUT_LENGTH = 2_000;
const MAX_HIGHLIGHT_LENGTH = 300;
const MAX_HIGHLIGHTS = 8;

export interface GeminiSummaryConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetcher?: typeof fetch;
}

interface SummaryAggregates {
  totalRevenue: number;
  transactionCount: number;
  unitsSold: number;
}

interface GeminiChatCompletion {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

export function createGeminiFreeSummaryProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AiSummaryProvider | undefined {
  if (environment.LOCAL_GEMINI_SUMMARY_ENABLED !== 'true') return undefined;

  const baseUrl = environment.LOCAL_GEMINI_ROUTER_BASE_URL?.trim();
  const model = environment.LOCAL_GEMINI_ROUTER_MODEL?.trim();
  const apiKey = environment.LOCAL_GEMINI_ROUTER_API_KEY?.trim();

  if (!baseUrl || !model || !apiKey) return undefined;
  return createGeminiFreeSummaryProvider({ baseUrl, model, apiKey });
}

export function createGeminiFreeSummaryProvider(
  config: GeminiSummaryConfig,
): AiSummaryProvider | undefined {
  const endpoint = getChatCompletionsEndpoint(config.baseUrl);
  if (!endpoint || config.model !== GEMINI_FREE_MODEL || !config.apiKey.trim()) {
    return undefined;
  }

  const apiKey = config.apiKey.trim();
  const fetcher = config.fetcher ?? fetch;

  return {
    async summarize(input) {
      const aggregates: SummaryAggregates = {
        totalRevenue: input.totalRevenue,
        transactionCount: input.transactionCount,
        unitsSold: input.unitsSold,
      };
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        body: JSON.stringify({
          model: config.model,
          stream: false,
          temperature: 0,
          max_tokens: 180,
          messages: [
            {
              role: 'system',
              content: [
                'Buat keluaran JSON Bahasa Indonesia dari agregat yang diberikan.',
                'Ganti placeholder pada format berikut hanya dengan angka mentah dari input, tanpa format lain:',
                'summary: "Pendapatan pada periode terpilih {totalRevenue}; transaksi selesai {transactionCount}; unit terjual {unitsSold}."',
                'highlights: ["Pendapatan: {totalRevenue}", "Transaksi selesai: {transactionCount}", "Unit terjual: {unitsSold}"]',
                'Jangan menambah atau mengubah kata, klaim, angka, tanggal, tren, sebab, saran, atau perkiraan.',
                'Kembalikan JSON valid dengan hanya kunci summary dan highlights.',
              ].join(' '),
            },
            { role: 'user', content: JSON.stringify(aggregates) },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) throw new Error('Gemini Free provider unavailable.');
      const responseBody = await readLimitedResponse(response);
      let payload: GeminiChatCompletion;
      try {
        payload = JSON.parse(responseBody) as GeminiChatCompletion;
      } catch {
        throw new Error('Gemini Free response was invalid.');
      }
      if (payload.model !== 'gemini-3.5-flash-lite' && payload.model !== GEMINI_FREE_MODEL) {
        throw new Error('Gemini Free provider returned an unexpected model.');
      }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Gemini Free response was invalid.');

      const output = parseSummary(content);
      validateGrounding(output, aggregates);
      return output;
    },
  };
}

function getChatCompletionsEndpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const basePath = url.pathname.replace(/\/+$/, '');
    if (
      url.protocol !== 'http:'
      || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      || url.username
      || url.password
      || url.search
      || url.hash
      || basePath !== '/v1'
    ) {
      return undefined;
    }
    return new URL('/v1/chat/completions', url.origin).toString();
  } catch {
    return undefined;
  }
}

async function readLimitedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gemini Free response was invalid.');

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Gemini Free response was too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSummary(content: string): { summary: string; highlights: string[] } {
  const json = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Gemini Free response was invalid.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Gemini Free response was invalid.');
  }
  const value = parsed as Record<string, unknown>;
  const summary = value.summary;
  const highlights = value.highlights;
  if (
    Object.keys(value).length !== 2
    || typeof summary !== 'string'
    || summary.trim().length === 0
    || summary.length > MAX_OUTPUT_LENGTH
    || !Array.isArray(highlights)
    || highlights.length !== 3
    || highlights.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > MAX_HIGHLIGHT_LENGTH)
  ) {
    throw new Error('Gemini Free response was invalid.');
  }
  return { summary: summary.trim(), highlights: highlights.map((item) => (item as string).trim()) };
}

function validateGrounding(
  output: { summary: string; highlights: string[] },
  aggregates: SummaryAggregates,
): void {
  const expected = {
    summary: `Pendapatan pada periode terpilih ${aggregates.totalRevenue}; transaksi selesai ${aggregates.transactionCount}; unit terjual ${aggregates.unitsSold}.`,
    highlights: [
      `Pendapatan: ${aggregates.totalRevenue}`,
      `Transaksi selesai: ${aggregates.transactionCount}`,
      `Unit terjual: ${aggregates.unitsSold}`,
    ],
  };
  if (output.summary !== expected.summary || output.highlights.some((value, index) => value !== expected.highlights[index])) {
    throw new Error('Gemini Free response did not match the approved factual format.');
  }
}
