import { createHash, randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type {
  AuthResponse,
  ForecastItem,
  Pagination,
  ProductResponse,
  StockAdjustmentResult,
  TransactionCreated,
  TransactionDetail,
  TransactionItemSnapshot,
  TransactionStatus,
  VoidResult,
} from './contracts.js';
import {
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_TTL_MS,
  authenticate,
  createAuthSession,
  getAllowedAppOrigin,
  hashPassword,
  isAllowedAppOriginValue,
  requireCsrfForCookieMutations,
  verifyPassword,
  type AuthSession,
} from './auth.js';
import { type SqliteDatabase, nowIso, withImmediateTransaction } from './db.js';
import { ApiError, errorHandler, sendApiError } from './errors.js';
import { consumeAuthRateLimit } from './auth-rate-limit.js';
import { periodBounds, subtractDays } from './period.js';
import {
  createBusinessSchema,
  authCredentialsSchema,
  createProductSchema,
  createTransactionSchema,
  forecastFilterSchema,
  idParamSchema,
  productFilterSchema,
  productIdParamSchema,
  reportFilterSchema,
  stockAdjustmentSchema,
  transactionFilterSchema,
  updateProductSchema,
  voidTransactionSchema,
} from './schemas.js';

interface BusinessRow {
  id: string;
  name: string;
  currency: 'IDR';
  time_zone: string;
  created_at: string;
}

interface ProductRow {
  id: string;
  business_id: string;
  name: string;
  sku: string | null;
  unit_price: number;
  stock_quantity: number;
  low_stock_threshold: number;
  is_archived: number;
  created_at: string;
  updated_at: string;
}

interface TransactionRow {
  id: string;
  business_id: string;
  status: TransactionStatus;
  currency: 'IDR';
  total_amount: number;
  created_by_user_id: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

interface TransactionItemRow {
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

interface TransactionListRow extends TransactionRow {}

interface AiSummaryInput {
  businessName: string;
  timeZone: string;
  from: string;
  to: string;
  startAt: string;
  endAt: string;
  totalRevenue: number;
  transactionCount: number;
  unitsSold: number;
}

export interface AiSummaryProvider {
  summarize(input: AiSummaryInput): Promise<{ summary: string; highlights: string[] }>;
}

interface AppOptions {
  aiSummaryProvider?: AiSummaryProvider;
}

const aiSummaryOutputSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  highlights: z.array(z.string().trim().min(1).max(300)).max(8),
}).strict();

export function createApp(database: SqliteDatabase, options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const trustProxyHops = process.env.TRUST_PROXY_HOPS ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(trustProxyHops) || !Number.isSafeInteger(Number(trustProxyHops))) {
    throw new Error('TRUST_PROXY_HOPS harus berupa bilangan bulat nonnegatif.');
  }
  app.set('trust proxy', Number(trustProxyHops));
  app.use(appCorsMiddleware);
  app.use(express.json({ limit: '64kb' }));

  app.post('/api/auth/register', async (request, response) => {
    assertAllowedAuthOrigin(request);
    const input = parseInput(authCredentialsSchema, request.body);
    const secret = getAuthJwtSecret();
    const retryAfterSeconds = consumeAuthRateLimit(database, {
      action: 'register',
      clientIp: request.ip || request.socket.remoteAddress || 'unknown',
      secret,
    });
    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
      sendApiError(response, 429, 'AUTH_RATE_LIMITED', 'Terlalu banyak percobaan autentikasi. Coba lagi nanti.');
      return;
    }
    const userId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const session = await createAuthSession(userId, secret);
    const insert = database.prepare(`
      INSERT INTO app_user (id, email, password_hash, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO NOTHING
    `).run(userId, input.email, passwordHash, nowIso());

    if (Number(insert.changes) === 0) {
      sendApiError(response, 409, 'EMAIL_ALREADY_REGISTERED', 'Email sudah terdaftar.');
      return;
    }

    persistAuthSession(database, userId, session);
    setSessionCookie(response, session.token);
    const payload: AuthResponse = { data: { user: { id: userId, email: input.email } } };
    response.status(201).json(payload);
  });

  app.post('/api/auth/login', async (request, response) => {
    assertAllowedAuthOrigin(request);
    const input = parseInput(authCredentialsSchema, request.body);
    const secret = getAuthJwtSecret();
    const retryAfterSeconds = consumeAuthRateLimit(database, {
      action: 'login',
      clientIp: request.ip || request.socket.remoteAddress || 'unknown',
      email: input.email,
      secret,
    });
    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
      sendApiError(response, 429, 'AUTH_RATE_LIMITED', 'Terlalu banyak percobaan autentikasi. Coba lagi nanti.');
      return;
    }
    const user = database.prepare('SELECT id, email, password_hash FROM app_user WHERE email = ?').get(input.email) as {
      id: string;
      email: string;
      password_hash: string;
    } | undefined;

    let passwordIsValid = false;
    if (user) {
      passwordIsValid = await verifyPassword(input.password, user.password_hash);
    } else {
      await hashPassword(input.password);
    }
    if (!user || !passwordIsValid) {
      sendApiError(response, 401, 'INVALID_CREDENTIALS', 'Email atau password tidak valid.');
      return;
    }

    const session = await createAuthSession(user.id, secret);
    persistAuthSession(database, user.id, session);
    setSessionCookie(response, session.token);
    const payload: AuthResponse = { data: { user: { id: user.id, email: user.email } } };
    response.status(200).json(payload);
  });

  app.use(authenticate(database));
  app.use(requireCsrfForCookieMutations);
  app.get('/api/auth/csrf', (request, response) => {
    if (request.authMethod !== 'cookie' || !request.csrfToken) {
      sendApiError(response, 401, 'COOKIE_SESSION_REQUIRED', 'Sesi cookie diperlukan.');
      return;
    }
    response.json({ data: { csrfToken: request.csrfToken } });
  });
  app.post('/api/auth/logout', (request, response) => {
    if (request.authMethod !== 'cookie' || !request.authJti) {
      sendApiError(response, 401, 'COOKIE_SESSION_REQUIRED', 'Sesi cookie diperlukan.');
      return;
    }
    database.prepare(`
      UPDATE auth_session SET revoked_at = ? WHERE jti = ? AND user_id = ? AND revoked_at IS NULL
    `).run(Math.floor(Date.now() / 1_000), request.authJti, requireUserId(request));
    response.cookie(AUTH_SESSION_COOKIE_NAME, '', {
      ...sessionCookieOptions(),
      maxAge: 0,
      expires: new Date(0),
    });
    response.status(204).end();
  });
  const businessRouter = express.Router({ mergeParams: true });
  businessRouter.use((request, response, next) => {
    const businessId = request.params.businessId;
    if (typeof businessId !== 'string' || !z.string().uuid().safeParse(businessId).success) {
      sendApiError(response, 404, 'BUSINESS_NOT_FOUND', 'Usaha tidak ditemukan.');
      return;
    }
    request.businessId = businessId;
    next();
  });

  app.post('/api/businesses', (request, response) => {
    const input = parseInput(createBusinessSchema, request.body);
    const userId = requireUserId(request);
    try {
      new Intl.DateTimeFormat('id-ID', { timeZone: input.timeZone });
    } catch {
      throw new ApiError(422, 'INVALID_TIME_ZONE', 'timeZone harus berupa zona waktu IANA yang valid.');
    }

    const createdAt = nowIso();
    const businessId = randomUUID();
    withImmediateTransaction(database, () => {
      const existing = database.prepare('SELECT id FROM business_membership WHERE user_id = ?').get(userId);
      if (existing) {
        throw new ApiError(409, 'BUSINESS_ALREADY_EXISTS', 'Akun ini sudah terhubung dengan usaha.');
      }
      database.prepare(`
        INSERT INTO business (id, name, currency, time_zone, created_at)
        VALUES (?, ?, 'IDR', ?, ?)
      `).run(businessId, input.name, input.timeZone, createdAt);
      database.prepare(`
        INSERT INTO business_membership (id, business_id, user_id, role, is_active, created_at)
        VALUES (?, ?, ?, 'OWNER', 1, ?)
      `).run(randomUUID(), businessId, userId, createdAt);
    });

    response.status(201).json({ data: { id: businessId, name: input.name, currency: 'IDR', timeZone: input.timeZone, createdAt } });
  });

  app.get('/api/businesses/current', (request, response) => {
    const business = findBusinessForUser(database, requireUserId(request));
    if (!business) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'Usaha tidak ditemukan.');
    response.json({ data: mapBusiness(business) });
  });

  businessRouter.get('/', (request, response) => {
    const business = requireBusiness(database, request);
    response.json({ data: mapBusiness(business) });
  });

  businessRouter.get('/products', (request, response) => {
    const business = requireBusiness(database, request);
    const filter = parseInput(productFilterSchema, request.query);
    const where = ['business_id = ?', 'is_archived = 0'];
    const params: (string | number)[] = [business.id];
    if (filter.search) {
      where.push("(instr(lower(name), lower(?)) > 0 OR instr(lower(coalesce(sku, '')), lower(?)) > 0)");
      params.push(filter.search, filter.search);
    }
    const whereSql = where.join(' AND ');
    const count = database.prepare(`SELECT COUNT(*) AS total FROM product WHERE ${whereSql}`).get(...params) as { total: number };
    const rows = database.prepare(`
      SELECT id, business_id, name, sku, unit_price, stock_quantity, low_stock_threshold, is_archived, created_at, updated_at
      FROM product WHERE ${whereSql}
      ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ? OFFSET ?
    `).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as unknown as ProductRow[];
    response.json({
      data: rows.map(mapProduct),
      pagination: makePagination(filter.page, filter.pageSize, count.total),
    });
  });

  businessRouter.post('/products', (request, response) => {
    const business = requireBusiness(database, request);
    const userId = requireUserId(request);
    const input = parseInput(createProductSchema, request.body);
    const productId = randomUUID();
    const createdAt = nowIso();
    const sku = input.sku?.trim() || null;

    withImmediateTransaction(database, () => {
      if (sku && database.prepare('SELECT id FROM product WHERE business_id = ? AND sku = ?').get(business.id, sku)) {
        throw new ApiError(409, 'SKU_ALREADY_EXISTS', 'SKU tersebut sudah digunakan oleh produk lain.');
      }
      database.prepare(`
        INSERT INTO product (id, business_id, name, sku, unit_price, stock_quantity, low_stock_threshold, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(productId, business.id, input.name, sku, input.sellingPrice, input.initialStock, input.minStock, createdAt, createdAt);
      database.prepare(`
        INSERT INTO stock_movement (id, business_id, product_id, movement_type, quantity_delta, reason, transaction_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, 'INITIAL', ?, ?, NULL, ?, ?)
      `).run(randomUUID(), business.id, productId, input.initialStock, 'INITIAL_STOCK', userId, createdAt);
    });

    const product = findProduct(database, business.id, productId)!;
    response.status(201).json({ data: mapProduct(product) });
  });

  businessRouter.get('/products/:productId', (request, response) => {
    const business = requireBusiness(database, request);
    const { productId } = parseInput(productIdParamSchema, request.params);
    const product = findProduct(database, business.id, productId);
    if (!product || product.is_archived) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.');
    response.json({ data: mapProduct(product) });
  });

  businessRouter.patch('/products/:productId', (request, response) => {
    const business = requireBusiness(database, request);
    const { productId } = parseInput(productIdParamSchema, request.params);
    const input = parseInput(updateProductSchema, request.body);
    const current = findProduct(database, business.id, productId);
    if (!current) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.');

    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name); }
    if (input.sku !== undefined) {
      const sku = input.sku?.trim() || null;
      if (sku && database.prepare('SELECT id FROM product WHERE business_id = ? AND sku = ? AND id <> ?').get(business.id, sku, productId)) {
        throw new ApiError(409, 'SKU_ALREADY_EXISTS', 'SKU tersebut sudah digunakan oleh produk lain.');
      }
      fields.push('sku = ?'); values.push(sku);
    }
    if (input.sellingPrice !== undefined) { fields.push('unit_price = ?'); values.push(input.sellingPrice); }
    if (input.minStock !== undefined) { fields.push('low_stock_threshold = ?'); values.push(input.minStock); }
    if (input.isArchived !== undefined) { fields.push('is_archived = ?'); values.push(input.isArchived ? 1 : 0); }
    const updatedAt = nowIso();
    fields.push('updated_at = ?'); values.push(updatedAt, business.id, productId);
    database.prepare(`UPDATE product SET ${fields.join(', ')} WHERE business_id = ? AND id = ?`).run(...values);
    response.json({ data: mapProduct(findProduct(database, business.id, productId)!) });
  });

  businessRouter.post('/products/:productId/stock-adjustments', (request, response) => {
    const business = requireBusiness(database, request);
    const userId = requireUserId(request);
    const { productId } = parseInput(productIdParamSchema, request.params);
    const input = parseInput(stockAdjustmentSchema, request.body);
    const createdAt = nowIso();
    const movementId = randomUUID();

    const result = withImmediateTransaction(database, () => {
      const product = findProduct(database, business.id, productId);
      if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.');
      if (input.newQuantity === product.stock_quantity) {
        throw new ApiError(422, 'NO_STOCK_CHANGE', 'newQuantity harus berbeda dari stok saat ini.');
      }
      const previousQuantity = product.stock_quantity;
      const quantityDelta = input.newQuantity - previousQuantity;
      database.prepare(`
        UPDATE product SET stock_quantity = ?, updated_at = ? WHERE business_id = ? AND id = ?
      `).run(input.newQuantity, createdAt, business.id, productId);
      database.prepare(`
        INSERT INTO stock_movement (id, business_id, product_id, movement_type, quantity_delta, reason, transaction_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, NULL, ?, ?)
      `).run(movementId, business.id, productId, quantityDelta, input.reason, userId, createdAt);
      const payload: StockAdjustmentResult = {
        id: movementId,
        productId,
        stockQuantity: input.newQuantity,
        movement: { id: movementId, type: 'ADJUSTMENT', previousQuantity, quantityDelta, newQuantity: input.newQuantity, reason: input.reason, createdAt },
      };
      return payload;
    });
    response.status(201).json({ data: result });
  });

  businessRouter.get('/inventory/alerts', (request, response) => {
    const business = requireBusiness(database, request);
    const rows = database.prepare(`
      SELECT id, name, stock_quantity, low_stock_threshold
      FROM product
      WHERE business_id = ? AND is_archived = 0 AND (stock_quantity = 0 OR stock_quantity <= low_stock_threshold)
      ORDER BY CASE WHEN stock_quantity = 0 THEN 0 ELSE 1 END, stock_quantity ASC, name COLLATE NOCASE ASC
    `).all(business.id) as unknown as Array<Pick<ProductRow, 'id' | 'name' | 'stock_quantity' | 'low_stock_threshold'>>;
    const items = rows.map((product) => ({
      type: product.stock_quantity === 0 ? 'OUT_OF_STOCK' as const : 'LOW_STOCK' as const,
      productId: product.id,
      productName: product.name,
      stockQuantity: product.stock_quantity,
      minStock: product.low_stock_threshold,
    }));
    response.json({ data: { items, totalItems: items.length } });
  });

  businessRouter.get('/inventory/forecasts', (request, response) => {
    const business = requireBusiness(database, request);
    const filter = parseInput(forecastFilterSchema, request.query);
    if (filter.windowDays !== 30) throw new ApiError(422, 'INVALID_FORECAST_WINDOW', 'windowDays pada MVP harus 30.');
    const endAt = nowIso();
    const startAt = subtractDays(endAt, filter.windowDays);
    const rows = database.prepare(`
      SELECT p.id, p.name, p.stock_quantity, p.created_at,
        COALESCE(SUM(ti.quantity), 0) AS sold_quantity
      FROM product p
      LEFT JOIN sales_transaction t
        ON t.business_id = p.business_id AND t.status = 'COMPLETED'
        AND t.created_at >= ? AND t.created_at < ?
      LEFT JOIN transaction_item ti
        ON ti.business_id = p.business_id AND ti.transaction_id = t.id AND ti.product_id = p.id
      WHERE p.business_id = ? AND p.is_archived = 0
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
    `).all(normalizeSqlTimestamp(startAt), normalizeSqlTimestamp(endAt), business.id) as unknown as Array<{
      id: string;
      name: string;
      stock_quantity: number;
      created_at: string;
      sold_quantity: number;
    }>;

    const endMs = Date.parse(endAt);
    const items: ForecastItem[] = rows.map((row) => {
      const historyDays = Math.max(0, Math.min(30, Math.floor((endMs - Date.parse(row.created_at)) / 86_400_000)));
      const insufficientData = historyDays < 14;
      const averageUnitsPerDay = insufficientData ? null : round2(row.sold_quantity / historyDays);
      const status = insufficientData ? 'INSUFFICIENT_DATA' : averageUnitsPerDay === 0 ? 'NO_RECENT_SALES' : 'READY';
      return {
        productId: row.id,
        productName: row.name,
        stockQuantity: row.stock_quantity,
        from: startAt,
        to: endAt,
        historyDays,
        averageUnitsPerDay,
        estimatedDaysRemaining: averageUnitsPerDay === null || averageUnitsPerDay === 0
          ? null
          : Math.round((row.stock_quantity / averageUnitsPerDay) * 10) / 10,
        insufficientData,
        status,
      };
    });
    response.json({ data: { from: startAt, to: endAt, timeZone: business.time_zone, items } });
  });

  businessRouter.get('/reports/sales', (request, response) => {
    const business = requireBusiness(database, request);
    const filter = parseInput(reportFilterSchema, request.query);
    const period = periodBounds(filter.from, filter.to, business.time_zone, true);
    const report = calculateReport(database, business, filter.from, filter.to, period.startAt!, period.endAt!);
    response.json({ data: { ...report, currency: 'IDR' } });
  });

  businessRouter.get('/transactions', (request, response) => {
    const business = requireBusiness(database, request);
    const filter = parseInput(transactionFilterSchema, request.query);
    const period = periodBounds(filter.from, filter.to, business.time_zone);
    const where = ['business_id = ?'];
    const params: (string | number)[] = [business.id];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (period.startAt) { where.push('created_at >= ?'); params.push(normalizeSqlTimestamp(period.startAt)); }
    if (period.endAt) { where.push('created_at < ?'); params.push(normalizeSqlTimestamp(period.endAt)); }
    const whereSql = where.join(' AND ');
    const count = database.prepare(`SELECT COUNT(*) AS total FROM sales_transaction WHERE ${whereSql}`).get(...params) as { total: number };
    const rows = database.prepare(`
      SELECT id, business_id, status, currency, total_amount, created_by_user_id, created_at, voided_at, void_reason
      FROM sales_transaction WHERE ${whereSql}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as unknown as TransactionListRow[];
    response.json({
      data: rows.map(mapTransactionListItem),
      pagination: makePagination(filter.page, filter.pageSize, count.total),
    });
  });

  businessRouter.get('/transactions/:id', (request, response) => {
    const business = requireBusiness(database, request);
    const { id } = parseInput(idParamSchema, request.params);
    const transaction = findTransaction(database, business.id, id);
    if (!transaction) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'Transaksi tidak ditemukan.');
    response.json({ data: mapTransactionDetail(database, transaction) });
  });

  businessRouter.post('/transactions', (request, response) => {
    const business = requireBusiness(database, request);
    const userId = requireUserId(request);
    const input = parseInput(createTransactionSchema, request.body);
    const keyHeader = request.get('Idempotency-Key');
    if (!keyHeader || keyHeader.trim().length === 0) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key wajib diisi.');
    }
    const idempotencyKey = keyHeader.trim();
    if (idempotencyKey.length > 128) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key maksimal 128 karakter.');
    }

    const normalizedItems = input.items.map((item) => ({ productId: item.productId.toLowerCase(), quantity: item.quantity }));
    const canonicalItems = [...normalizedItems].sort((left, right) => left.productId.localeCompare(right.productId));
    const requestHash = createHash('sha256').update(JSON.stringify(canonicalItems)).digest('hex');
    const createdAt = nowIso();
    const transactionId = randomUUID();

    const result = withImmediateTransaction(database, () => {
      const prior = database.prepare(`
        SELECT request_hash, response_body FROM idempotency_record WHERE business_id = ? AND idempotency_key = ?
      `).get(business.id, idempotencyKey) as { request_hash: string; response_body: string } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key sudah dipakai dengan payload berbeda.');
        }
        return JSON.parse(prior.response_body) as { data: TransactionCreated };
      }

      const productIds = normalizedItems.map((item) => item.productId);
      const placeholders = productIds.map(() => '?').join(', ');
      const productRows = database.prepare(`
        SELECT id, business_id, name, sku, unit_price, stock_quantity, low_stock_threshold, is_archived, created_at, updated_at
        FROM product WHERE business_id = ? AND id IN (${placeholders})
      `).all(business.id, ...productIds) as unknown as ProductRow[];
      const productsById = new Map(productRows.map((product) => [product.id.toLowerCase(), product]));
      const missingProductId = normalizedItems.find((item) => !productsById.has(item.productId))?.productId;
      if (missingProductId) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Satu atau lebih produk tidak ditemukan.', { productId: missingProductId });

      const archivedProductId = normalizedItems.find((item) => productsById.get(item.productId)!.is_archived !== 0)?.productId;
      if (archivedProductId) throw new ApiError(409, 'PRODUCT_ARCHIVED', 'Produk yang diarsipkan tidak dapat dijual.', { productId: archivedProductId });

      const insufficientItems = normalizedItems.flatMap((item) => {
        const product = productsById.get(item.productId)!;
        return product.stock_quantity < item.quantity
          ? [{ productId: item.productId, available: product.stock_quantity, requested: item.quantity }]
          : [];
      });
      if (insufficientItems.length > 0) {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Stok tidak mencukupi untuk menyelesaikan transaksi.', { items: insufficientItems });
      }

      let totalAmount = 0;
      const snapshots: TransactionItemSnapshot[] = normalizedItems.map((item) => {
        const product = productsById.get(item.productId)!;
        const lineTotal = product.unit_price * item.quantity;
        if (!Number.isSafeInteger(lineTotal)) throw new ApiError(422, 'AMOUNT_OUT_OF_RANGE', 'Nilai transaksi melebihi batas bilangan aman.');
        totalAmount += lineTotal;
        if (!Number.isSafeInteger(totalAmount)) throw new ApiError(422, 'AMOUNT_OUT_OF_RANGE', 'Nilai transaksi melebihi batas bilangan aman.');
        return {
          productId: product.id,
          productName: product.name,
          quantity: item.quantity,
          unitPrice: product.unit_price,
          lineTotal,
        };
      });

      database.prepare(`
        INSERT INTO sales_transaction (id, business_id, status, currency, total_amount, created_by_user_id, created_at, voided_at, void_reason)
        VALUES (?, ?, 'COMPLETED', 'IDR', ?, ?, ?, NULL, NULL)
      `).run(transactionId, business.id, totalAmount, userId, createdAt);

      const insertItem = database.prepare(`
        INSERT INTO transaction_item (id, business_id, transaction_id, product_id, item_order, product_name, quantity, unit_price, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateStock = database.prepare(`
        UPDATE product SET stock_quantity = stock_quantity - ?, updated_at = ?
        WHERE business_id = ? AND id = ? AND is_archived = 0 AND stock_quantity >= ?
      `);
      const insertMovement = database.prepare(`
        INSERT INTO stock_movement (id, business_id, product_id, movement_type, quantity_delta, reason, transaction_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?, ?)
      `);

      snapshots.forEach((item, itemOrder) => {
        const product = productsById.get(item.productId.toLowerCase())!;
        insertItem.run(randomUUID(), business.id, transactionId, product.id, itemOrder, item.productName, item.quantity, item.unitPrice, item.lineTotal);
        const update = updateStock.run(item.quantity, createdAt, business.id, product.id, item.quantity);
        if (Number(update.changes) !== 1) {
          const current = findProduct(database, business.id, product.id);
          throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Stok berubah sebelum transaksi dapat diselesaikan.', {
            items: [{ productId: product.id, available: current?.stock_quantity ?? 0, requested: item.quantity }],
          });
        }
        insertMovement.run(randomUUID(), business.id, product.id, -item.quantity, `Penjualan ${transactionId}`, transactionId, userId, createdAt);
      });

      const body: { data: TransactionCreated } = { data: {
        id: transactionId,
        status: 'COMPLETED',
        createdAt,
        currency: 'IDR',
        items: snapshots,
        totalAmount,
      } };
      database.prepare(`
        INSERT INTO idempotency_record (id, business_id, idempotency_key, request_hash, transaction_id, response_body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), business.id, idempotencyKey, requestHash, transactionId, JSON.stringify(body), createdAt);
      return body;
    });

    response.status(201).json(result);
  });

  businessRouter.post('/transactions/:id/void', (request, response) => {
    const business = requireBusiness(database, request);
    const userId = requireUserId(request);
    const { id } = parseInput(idParamSchema, request.params);
    const { reason } = parseInput(voidTransactionSchema, request.body);
    const voidedAt = nowIso();

    const result = withImmediateTransaction(database, () => {
      const transaction = findTransaction(database, business.id, id);
      if (!transaction) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'Transaksi tidak ditemukan.');
      if (transaction.status === 'VOIDED') throw new ApiError(409, 'TRANSACTION_ALREADY_VOIDED', 'Transaksi sudah dibatalkan.');

      const updated = database.prepare(`
        UPDATE sales_transaction SET status = 'VOIDED', voided_at = ?, void_reason = ?
        WHERE business_id = ? AND id = ? AND status = 'COMPLETED'
      `).run(voidedAt, reason, business.id, id);
      if (Number(updated.changes) !== 1) throw new ApiError(409, 'TRANSACTION_ALREADY_VOIDED', 'Transaksi sudah dibatalkan.');

      const items = database.prepare(`
        SELECT product_id, quantity FROM transaction_item WHERE business_id = ? AND transaction_id = ? ORDER BY item_order ASC
      `).all(business.id, id) as unknown as Array<{ product_id: string; quantity: number }>;
      const addStock = database.prepare(`UPDATE product SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE business_id = ? AND id = ?`);
      const insertMovement = database.prepare(`
        INSERT INTO stock_movement (id, business_id, product_id, movement_type, quantity_delta, reason, transaction_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, 'VOID', ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        const updatedProduct = addStock.run(item.quantity, voidedAt, business.id, item.product_id);
        if (Number(updatedProduct.changes) !== 1) throw new ApiError(500, 'STOCK_RESTORE_FAILED', 'Stok transaksi tidak dapat dipulihkan.');
        insertMovement.run(randomUUID(), business.id, item.product_id, item.quantity, reason, id, userId, voidedAt);
      }
      const voidedTransaction = findTransaction(database, business.id, id);
      if (!voidedTransaction) throw new ApiError(500, 'TRANSACTION_NOT_FOUND_AFTER_VOID', 'Transaksi tidak dapat dibaca setelah dibatalkan.');
      return mapTransactionDetail(database, voidedTransaction) satisfies VoidResult;
    });
    response.json({ data: result });
  });

  businessRouter.post('/assistant/summaries', async (request, response) => {
    const business = requireBusiness(database, request);
    const businessId = request.businessId;
    if (!businessId) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'Usaha tidak ditemukan.');
    if (business.id !== businessId) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'Usaha tidak ditemukan.');
    const filter = parseInput(reportFilterSchema, request.body);
    const period = periodBounds(filter.from, filter.to, business.time_zone, true);
    const report = calculateReport(database, business, filter.from, filter.to, period.startAt!, period.endAt!);
    if (report.transactionCount === 0) {
      response.json({ data: {
        period: { from: filter.from, to: filter.to, timeZone: business.time_zone },
        summary: 'Belum ada transaksi pada periode yang dipilih.',
        dataStatus: 'INSUFFICIENT_DATA',
        highlights: [],
      } });
      return;
    }
    if (!options.aiSummaryProvider) {
      throw new ApiError(503, 'AI_SUMMARY_NOT_CONFIGURED', 'Penyedia ringkasan AI belum dikonfigurasi.');
    }
    let summary: z.infer<typeof aiSummaryOutputSchema>;
    try {
      const generated = await options.aiSummaryProvider.summarize({
        businessName: business.name,
        timeZone: business.time_zone,
        from: filter.from,
        to: filter.to,
        startAt: period.startAt!,
        endAt: period.endAt!,
        totalRevenue: report.totalRevenue,
        transactionCount: report.transactionCount,
        unitsSold: report.unitsSold,
      });
      summary = parseInput(aiSummaryOutputSchema, generated);
    } catch {
      throw new ApiError(503, 'AI_SUMMARY_UNAVAILABLE', 'Ringkasan belum tersedia. Coba lagi nanti.');
    }
    response.json({ data: {
      period: { from: filter.from, to: filter.to, timeZone: business.time_zone },
      summary: summary.summary,
      dataStatus: report.transactionCount > 0 ? 'READY' : 'INSUFFICIENT_DATA',
      highlights: summary.highlights,
    } });
  });

  app.use('/api/businesses/:businessId', businessRouter);
  app.use((request, response, next) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const isBusinessPath = pathname === '/api/businesses' || pathname.startsWith('/api/businesses/');
    if (pathname.startsWith('/api/') && !isBusinessPath) {
      sendApiError(response, 404, 'BUSINESS_PATH_REQUIRED', 'Gunakan endpoint di bawah /api/businesses/{businessId}.');
      return;
    }
    next();
  });
  app.use((_request, response) => {
    sendApiError(response, 404, 'NOT_FOUND', 'Endpoint tidak ditemukan.');
  });
  app.use(errorHandler);
  return app;
}

function getAuthJwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Autentikasi server belum dikonfigurasi.');
  }
  return secret;
}

function assertAllowedAuthOrigin(request: Request): void {
  if (!getAllowedAppOrigin(request)) {
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin permintaan tidak diizinkan.');
  }
}

function appCorsMiddleware(request: Request, response: Response, next: (error?: unknown) => void): void {
  const originHeader = request.get('origin');
  const allowedOrigin = originHeader ? isAllowedAppOriginValue(originHeader) : undefined;
  if (allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.vary('Origin');
  }

  if (request.method === 'OPTIONS') {
    if (originHeader && !allowedOrigin) {
      sendApiError(response, 403, 'ORIGIN_NOT_ALLOWED', 'Origin permintaan tidak diizinkan.');
      return;
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Authorization, Idempotency-Key');
    response.vary('Access-Control-Request-Method');
    response.vary('Access-Control-Request-Headers');
    response.status(204).end();
    return;
  }
  next();
}

function persistAuthSession(database: SqliteDatabase, userId: string, session: AuthSession): void {
  database.prepare(`
    INSERT INTO auth_session (jti, user_id, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).run(session.jti, userId, session.expiresAt, session.issuedAt);
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  };
}

function setSessionCookie(response: Response, token: string): void {
  response.cookie(AUTH_SESSION_COOKIE_NAME, token, {
    ...sessionCookieOptions(),
    maxAge: AUTH_SESSION_TTL_MS,
  });
}

function requireUserId(request: Request): string {
  if (!request.userId) throw new ApiError(401, 'UNAUTHENTICATED', 'Token autentikasi diperlukan.');
  return request.userId;
}

function requireBusiness(database: SqliteDatabase, request: Request): BusinessRow {
  const userId = requireUserId(request);
  const businessId = request.businessId;
  if (!businessId) throw new ApiError(404, 'BUSINESS_PATH_REQUIRED', 'Gunakan endpoint di bawah /api/businesses/{businessId}.');
  const business = findBusinessForUser(database, userId);
  if (!business) throw new ApiError(403, 'BUSINESS_MEMBERSHIP_REQUIRED', 'Akun tidak memiliki keanggotaan pemilik usaha yang aktif.');
  if (business.id !== businessId) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'Usaha tidak ditemukan.');
  return business;
}

function findBusinessForUser(database: SqliteDatabase, userId: string): BusinessRow | undefined {
  return database.prepare(`
    SELECT b.id, b.name, b.currency, b.time_zone, b.created_at
    FROM business_membership bm
    JOIN business b ON b.id = bm.business_id
    WHERE bm.user_id = ? AND bm.is_active = 1 AND bm.role = 'OWNER'
  `).get(userId) as BusinessRow | undefined;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Data permintaan tidak valid.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message, code: issue.code })),
    });
  }
  return parsed.data;
}

function makePagination(page: number, pageSize: number, totalItems: number): Pagination {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}

function mapBusiness(business: BusinessRow) {
  return {
    id: business.id,
    name: business.name,
    currency: business.currency,
    timeZone: business.time_zone,
    createdAt: business.created_at,
  };
}

function mapProduct(product: ProductRow): ProductResponse {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    sellingPrice: product.unit_price,
    currency: 'IDR',
    stockQuantity: product.stock_quantity,
    minStock: product.low_stock_threshold,
    isArchived: product.is_archived === 1,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
  };
}

function findProduct(database: SqliteDatabase, businessId: string, productId: string): ProductRow | undefined {
  return database.prepare(`
    SELECT id, business_id, name, sku, unit_price, stock_quantity, low_stock_threshold, is_archived, created_at, updated_at
    FROM product WHERE business_id = ? AND id = ?
  `).get(businessId, productId) as ProductRow | undefined;
}

function findTransaction(database: SqliteDatabase, businessId: string, id: string): TransactionRow | undefined {
  return database.prepare(`
    SELECT id, business_id, status, currency, total_amount, created_by_user_id, created_at, voided_at, void_reason
    FROM sales_transaction WHERE business_id = ? AND id = ?
  `).get(businessId, id) as TransactionRow | undefined;
}

function mapTransactionListItem(transaction: TransactionListRow) {
  return {
    id: transaction.id,
    status: transaction.status,
    createdAt: transaction.created_at,
    currency: transaction.currency,
    totalAmount: transaction.total_amount,
    voidedAt: transaction.voided_at,
    voidReason: transaction.void_reason,
  };
}

function mapTransactionDetail(database: SqliteDatabase, transaction: TransactionRow): TransactionDetail {
  const rows = database.prepare(`
    SELECT product_id, product_name, quantity, unit_price, line_total
    FROM transaction_item WHERE business_id = ? AND transaction_id = ? ORDER BY item_order ASC
  `).all(transaction.business_id, transaction.id) as unknown as TransactionItemRow[];
  return {
    id: transaction.id,
    status: transaction.status,
    createdAt: transaction.created_at,
    currency: transaction.currency,
    items: rows.map((item) => ({
      productId: item.product_id,
      productName: item.product_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      lineTotal: item.line_total,
    })),
    totalAmount: transaction.total_amount,
    voidedAt: transaction.voided_at,
    voidReason: transaction.void_reason,
  };
}

function calculateReport(
  database: SqliteDatabase,
  business: BusinessRow,
  from: string,
  to: string,
  startAt: string,
  endAt: string,
) {
  const dayCount = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'day' }).days;
  if (dayCount > 366) throw new ApiError(422, 'DATE_RANGE_TOO_LARGE', 'Rentang laporan maksimal 366 hari.');

  const sqlStartAt = normalizeSqlTimestamp(startAt);
  const sqlEndAt = normalizeSqlTimestamp(endAt);
  const totals = database.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS gross_revenue, COUNT(*) AS transaction_count
    FROM sales_transaction
    WHERE business_id = ? AND status = 'COMPLETED' AND created_at >= ? AND created_at < ?
  `).get(business.id, sqlStartAt, sqlEndAt) as { gross_revenue: number; transaction_count: number };
  const units = database.prepare(`
    SELECT COALESCE(SUM(ti.quantity), 0) AS units_sold
    FROM transaction_item ti
    JOIN sales_transaction t ON t.business_id = ti.business_id AND t.id = ti.transaction_id
    WHERE t.business_id = ? AND t.status = 'COMPLETED' AND t.created_at >= ? AND t.created_at < ?
  `).get(business.id, sqlStartAt, sqlEndAt) as { units_sold: number };
  assertSafeAggregate(totals.gross_revenue);
  assertSafeAggregate(units.units_sold);

  const dailyRows = database.prepare(`
    SELECT created_at, total_amount FROM sales_transaction
    WHERE business_id = ? AND status = 'COMPLETED' AND created_at >= ? AND created_at < ?
  `).all(business.id, sqlStartAt, sqlEndAt) as unknown as Array<{ created_at: string; total_amount: number }>;
  const dailyTotals = new Map<string, { totalRevenue: number; transactionCount: number }>();
  for (const row of dailyRows) {
    const localDate = Temporal.Instant.from(row.created_at).toZonedDateTimeISO(business.time_zone).toPlainDate().toString();
    const previous = dailyTotals.get(localDate) ?? { totalRevenue: 0, transactionCount: 0 };
    const totalRevenue = previous.totalRevenue + row.total_amount;
    const transactionCount = previous.transactionCount + 1;
    assertSafeAggregate(totalRevenue);
    assertSafeAggregate(transactionCount);
    dailyTotals.set(localDate, { totalRevenue, transactionCount });
  }
  const startDate = Temporal.PlainDate.from(from);
  const dailyRevenue = Array.from({ length: dayCount }, (_unused, index) => {
    const date = startDate.add({ days: index }).toString();
    const daily = dailyTotals.get(date) ?? { totalRevenue: 0, transactionCount: 0 };
    return { date, totalRevenue: daily.totalRevenue, transactionCount: daily.transactionCount };
  });

  const topRows = database.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, SUM(ti.quantity) AS quantity_sold, SUM(ti.line_total) AS revenue
    FROM transaction_item ti
    JOIN sales_transaction t ON t.business_id = ti.business_id AND t.id = ti.transaction_id
    JOIN product p ON p.business_id = ti.business_id AND p.id = ti.product_id
    WHERE t.business_id = ? AND t.status = 'COMPLETED' AND t.created_at >= ? AND t.created_at < ?
    GROUP BY p.id, p.name
    ORDER BY quantity_sold DESC, revenue DESC, p.name COLLATE NOCASE ASC
    LIMIT 5
  `).all(business.id, sqlStartAt, sqlEndAt) as unknown as Array<{
    product_id: string;
    product_name: string;
    quantity_sold: number;
    revenue: number;
  }>;
  const topProducts = topRows.map((product) => {
    assertSafeAggregate(product.quantity_sold);
    assertSafeAggregate(product.revenue);
    return { productId: product.product_id, productName: product.product_name, quantitySold: product.quantity_sold, revenue: product.revenue };
  });

  return {
    totalRevenue: totals.gross_revenue,
    transactionCount: totals.transaction_count,
    unitsSold: units.units_sold,
    dailyRevenue,
    topProducts,
    period: { from, to, startAt, endAt, timeZone: business.time_zone },
  };
}

function assertSafeAggregate(value: number): void {
  if (!Number.isSafeInteger(value)) throw new ApiError(422, 'AGGREGATE_OUT_OF_RANGE', 'Hasil agregat melebihi batas bilangan aman.');
}

function normalizeSqlTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
