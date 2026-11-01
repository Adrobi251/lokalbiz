import type {
  AssistantSummary,
  Business,
  CreatedTransaction,
  ForecastItem,
  PageData,
  Product,
  SalesReport,
  StockAlert,
  TransactionDetail,
  TransactionStatus,
  TransactionSummary,
} from '../types';

const defaultApiBase = import.meta.env.VITE_API_BASE_URL || '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(message: string, status: number, code = 'REQUEST_FAILED', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type AuthMode = 'register' | 'login';

export type AuthSession = {
  user: { id: string; email: string };
};

const mutatingMethods = new Set(['POST', 'PATCH', 'DELETE']);

type RequestSecurity = { csrfToken?: string; csrfMode?: 'required' | 'none' };

async function requestJson<T>(url: string, init: RequestInit = {}, security: RequestSecurity = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method || 'GET').toUpperCase();
  if (mutatingMethods.has(method) && security.csrfMode !== 'none') {
    if (!security.csrfToken) throw new ApiError('Token keamanan sesi belum tersedia. Muat ulang halaman lalu coba lagi.', 0, 'CSRF_TOKEN_UNAVAILABLE');
    headers.set('X-CSRF-Token', security.csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError('Tidak dapat tersambung ke server. Periksa alamat API dan coba lagi.', 0, 'NETWORK_ERROR');
  }

  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error as { message?: string; code?: string; details?: unknown } | undefined;
    throw new ApiError(
      error?.message || 'Permintaan belum berhasil. Coba lagi.',
      response.status,
      error?.code || 'REQUEST_FAILED',
      error?.details,
    );
  }
  return body as T;
}

export async function fetchCsrfToken(baseUrl = defaultApiBase): Promise<string> {
  const result = await requestJson<{ data: { csrfToken: string } }>(`${baseUrl.replace(/\/$/, '')}/auth/csrf`);
  if (!result.data.csrfToken) throw new ApiError('Server tidak memberikan token keamanan sesi.', 0, 'CSRF_TOKEN_UNAVAILABLE');
  return result.data.csrfToken;
}

export async function authenticateUser(
  mode: AuthMode,
  email: string,
  password: string,
  baseUrl = defaultApiBase,
): Promise<AuthSession> {
  const route = mode === 'register' ? '/auth/register' : '/auth/login';
  const result = await requestJson<{ data: AuthSession }>(`${baseUrl.replace(/\/$/, '')}${route}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, { csrfMode: 'none' });
  return result.data;
}

export class ApiClient {
  readonly baseUrl: string;
  private csrfToken: string;

  constructor(baseUrl = defaultApiBase, csrfToken = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.csrfToken = csrfToken;
  }

  setCsrfToken(csrfToken: string) {
    this.csrfToken = csrfToken;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    return requestJson<T>(`${this.baseUrl}${path}`, { ...init, headers }, { csrfToken: this.csrfToken });
  }

  async logout(): Promise<void> {
    await this.request<void>('/auth/logout', { method: 'POST' });
  }

  async getBusiness(): Promise<Business> {
    const result = await this.request<{ data: Business }>('/businesses/current');
    return result.data;
  }

  async createBusiness(input: { name: string; timeZone: string }): Promise<Business> {
    const result = await this.request<{ data: Business }>('/businesses', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return result.data;
  }

  private businessPath(businessId: string, path: string): string {
    return `/businesses/${encodeURIComponent(businessId)}${path}`;
  }

  async getProducts(businessId: string, search = '', page = 1, pageSize = 20): Promise<PageData<Product>> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) params.set('search', search.trim());
    return this.request(this.businessPath(businessId, `/products?${params.toString()}`));
  }

  async createProduct(businessId: string, input: {
    name: string;
    sellingPrice: number;
    initialStock: number;
    minStock: number;
  }): Promise<Product> {
    const result = await this.request<{ data: Product }>(this.businessPath(businessId, '/products'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return result.data;
  }

  async adjustStock(businessId: string, productId: string, input: { newQuantity: number; reason: string }): Promise<void> {
    await this.request(this.businessPath(businessId, `/products/${encodeURIComponent(productId)}/stock-adjustments`), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async archiveProduct(businessId: string, productId: string): Promise<void> {
    await this.request(this.businessPath(businessId, `/products/${encodeURIComponent(productId)}`), {
      method: 'PATCH',
      body: JSON.stringify({ isArchived: true }),
    });
  }

  async getAlerts(businessId: string): Promise<StockAlert[]> {
    const result = await this.request<{ data: { items: StockAlert[]; totalItems: number } }>(
      this.businessPath(businessId, '/inventory/alerts'),
    );
    return result.data.items;
  }

  async getForecasts(businessId: string): Promise<ForecastItem[]> {
    const result = await this.request<{ data: { items: ForecastItem[] } }>(
      this.businessPath(businessId, '/inventory/forecasts?windowDays=30'),
    );
    return result.data.items;
  }

  async getReport(businessId: string, from: string, to: string): Promise<SalesReport> {
    const params = new URLSearchParams({ from, to });
    const result = await this.request<{ data: SalesReport }>(
      this.businessPath(businessId, `/reports/sales?${params.toString()}`),
    );
    return result.data;
  }

  async getTransactions(
    businessId: string,
    from: string,
    to: string,
    page = 1,
    status?: TransactionStatus,
  ): Promise<PageData<TransactionSummary>> {
    const params = new URLSearchParams({ from, to, page: String(page), pageSize: '10' });
    if (status) params.set('status', status);
    return this.request(this.businessPath(businessId, `/transactions?${params.toString()}`));
  }

  async getTransaction(businessId: string, transactionId: string): Promise<TransactionDetail> {
    const result = await this.request<{ data: TransactionDetail }>(
      this.businessPath(businessId, `/transactions/${encodeURIComponent(transactionId)}`),
    );
    return result.data;
  }

  async createTransaction(
    businessId: string,
    items: Array<{ productId: string; quantity: number }>,
    idempotencyKey: string,
  ): Promise<CreatedTransaction> {
    const result = await this.request<{ data: CreatedTransaction }>(this.businessPath(businessId, '/transactions'), {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ items }),
    });
    return result.data;
  }

  async voidTransaction(businessId: string, transactionId: string, reason: string): Promise<void> {
    await this.request(this.businessPath(businessId, `/transactions/${encodeURIComponent(transactionId)}/void`), {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async getAssistantSummary(businessId: string, from: string, to: string): Promise<AssistantSummary> {
    const result = await this.request<{ data: AssistantSummary }>(
      this.businessPath(businessId, '/assistant/summaries'),
      { method: 'POST', body: JSON.stringify({ from, to }) },
    );
    return result.data;
  }
}
