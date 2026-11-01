import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createDatabase, type SqliteDatabase, nowIso } from '../src/db.js';
import { createTestBearerToken } from './auth-fixtures.js';

const authSecret = 'test-secret-with-at-least-thirty-two-bytes';
process.env.AUTH_JWT_SECRET = authSecret;

interface TestContext {
  database: SqliteDatabase;
  server: Server;
  baseUrl: string;
  businessId: string;
  token: string;
  close: () => Promise<void>;
}

async function createContext(): Promise<TestContext> {
  const database = createDatabase(':memory:');
  const businessId = randomUUID();
  const timestamp = nowIso();
  database.prepare(`
    INSERT INTO business (id, name, currency, time_zone, created_at) VALUES (?, ?, 'IDR', 'UTC', ?)
  `).run(businessId, 'Warung Tes', timestamp);
  database.prepare(`
    INSERT INTO business_membership (id, business_id, user_id, role, is_active, created_at)
    VALUES (?, ?, 'owner-1', 'OWNER', 1, ?)
  `).run(randomUUID(), businessId, timestamp);

  const token = await createTestBearerToken(database, 'owner-1');
  const server = createServer(createApp(database));
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

async function call(context: TestContext, path: string, options: { method?: string; body?: unknown; idempotencyKey?: string; token?: string; businessId?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token ?? context.token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const suffix = path.slice('/api'.length);
  const routeSuffix = suffix === '/forecasts/sales' ? '/inventory/forecasts'
    : suffix === '/alerts' ? '/inventory/alerts'
      : suffix;
  const tenantPath = path.startsWith('/api/businesses/')
    ? path
    : `/api/businesses/${options.businessId ?? context.businessId}${routeSuffix}`;
  const response = await fetch(`${context.baseUrl}${tenantPath}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() as any };
}

async function createProduct(context: TestContext, name: string, initialStock: number, sellingPrice = 1_500): Promise<{ id: string; name: string }> {
  const { response, body } = await call(context, '/api/products', {
    method: 'POST',
    body: { name, sellingPrice, initialStock },
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

function utcDateRange(): { from: string; to: string } {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

test('penjualan atomik menghitung snapshot harga dan retry dengan key sama mengembalikan transaksi pertama', async () => {
  const context = await createContext();
  try {
    const product = await createProduct(context, 'Kopi', 8, 2_500);
    const payload = { items: [{ productId: product.id, quantity: 3 }] };
    const first = await call(context, '/api/transactions', { method: 'POST', body: payload, idempotencyKey: 'sale-1' });
    const retry = await call(context, '/api/transactions', { method: 'POST', body: payload, idempotencyKey: 'sale-1' });

    assert.equal(first.response.status, 201);
    assert.equal(retry.response.status, 201);
    assert.deepEqual(retry.body, first.body);
    assert.equal(first.body.data.status, 'COMPLETED');
    assert.equal(first.body.data.totalAmount, 7_500);
    assert.equal(first.body.data.items[0].productName, 'Kopi');
    assert.equal(first.body.data.items[0].unitPrice, 2_500);
    assert.equal(context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(product.id)?.stock_quantity, 5);
    assert.equal(context.database.prepare('SELECT reason FROM stock_movement WHERE product_id = ? AND movement_type = \'INITIAL\'').get(product.id)?.reason, 'INITIAL_STOCK');
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get()?.count, 1);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM stock_movement WHERE movement_type = 'SALE'").get()?.count, 1);
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM idempotency_record').get()?.count, 1);

    const { from, to } = utcDateRange();
    const report = await call(context, `/api/reports/sales?from=${from}&to=${to}`);
    assert.equal(report.body.data.totalRevenue, 7_500);
    assert.equal(report.body.data.transactionCount, 1);
    assert.equal(report.body.data.dailyRevenue[0].date, from);
    assert.equal(report.body.data.dailyRevenue[0].totalRevenue, 7_500);
    assert.equal(report.body.data.dailyRevenue[0].transactionCount, 1);
    assert.equal(report.body.data.topProducts[0].productName, 'Kopi');
    assert.equal(report.body.data.topProducts[0].quantitySold, 3);
  } finally {
    await context.close();
  }
});

test('stok kurang pada salah satu item membatalkan seluruh transaksi tanpa perubahan parsial', async () => {
  const context = await createContext();
  try {
    const available = await createProduct(context, 'Barang cukup', 5);
    const empty = await createProduct(context, 'Barang habis', 0);
    const { response, body } = await call(context, '/api/transactions', {
      method: 'POST',
      idempotencyKey: 'sale-insufficient',
      body: { items: [{ productId: available.id, quantity: 4 }, { productId: empty.id, quantity: 1 }] },
    });

    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'INSUFFICIENT_STOCK');
    assert.deepEqual(body.error.details.items, [{ productId: empty.id, available: 0, requested: 1 }]);
    assert.equal(context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(available.id)?.stock_quantity, 5);
    assert.equal(context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(empty.id)?.stock_quantity, 0);
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get()?.count, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM stock_movement WHERE movement_type = 'SALE'").get()?.count, 0);
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM idempotency_record').get()?.count, 0);
  } finally {
    await context.close();
  }
});

test('key idempotensi yang sama dengan payload berbeda ditolak tanpa penjualan kedua', async () => {
  const context = await createContext();
  try {
    const firstProduct = await createProduct(context, 'Teh', 6);
    const secondProduct = await createProduct(context, 'Gula', 6);
    const first = await call(context, '/api/transactions', {
      method: 'POST', body: { items: [{ productId: firstProduct.id, quantity: 1 }] }, idempotencyKey: 'reused-key',
    });
    const second = await call(context, '/api/transactions', {
      method: 'POST', body: { items: [{ productId: secondProduct.id, quantity: 1 }] }, idempotencyKey: 'reused-key',
    });

    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 409);
    assert.equal(second.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(firstProduct.id)?.stock_quantity, 5);
    assert.equal(context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(secondProduct.id)?.stock_quantity, 6);
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM sales_transaction').get()?.count, 1);
  } finally {
    await context.close();
  }
});

test('penyesuaian stok menetapkan jumlah akhir dan mencatat alasan serta delta', async () => {
  const context = await createContext();
  try {
    const product = await createProduct(context, 'Tepung', 2);
    const adjusted = await call(context, `/api/products/${product.id}/stock-adjustments`, {
      method: 'POST', body: { newQuantity: 5, reason: 'Hitung stok rak' },
    });
    const noChange = await call(context, `/api/products/${product.id}/stock-adjustments`, {
      method: 'POST', body: { newQuantity: 5, reason: 'Tidak berubah' },
    });

    assert.equal(adjusted.response.status, 201);
    assert.equal(adjusted.body.data.stockQuantity, 5);
    assert.equal(adjusted.body.data.movement.previousQuantity, 2);
    assert.equal(adjusted.body.data.movement.quantityDelta, 3);
    assert.equal(adjusted.body.data.movement.newQuantity, 5);
    assert.equal(adjusted.body.data.movement.reason, 'Hitung stok rak');
    assert.equal(noChange.response.status, 422);
    assert.equal(noChange.body.error.code, 'NO_STOCK_CHANGE');
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM stock_movement WHERE movement_type = 'ADJUSTMENT'").get()?.count, 1);
  } finally {
    await context.close();
  }
});

test('void satu kali memulihkan stok, mempertahankan snapshot, dan mengecualikan transaksi dari laporan', async () => {
  const context = await createContext();
  try {
    const product = await createProduct(context, 'Susu', 5, 4_000);
    const sale = await call(context, '/api/transactions', {
      method: 'POST', body: { items: [{ productId: product.id, quantity: 2 }] }, idempotencyKey: 'sale-to-void',
    });
    const transactionId = sale.body.data.id as string;

    await call(context, `/api/products/${product.id}`, { method: 'PATCH', body: { name: 'Susu baru', sellingPrice: 5_000, isArchived: true } });
    const voided = await call(context, `/api/transactions/${transactionId}/void`, { method: 'POST', body: { reason: 'Salah input kasir' } });
    const secondVoid = await call(context, `/api/transactions/${transactionId}/void`, { method: 'POST', body: { reason: 'Alasan kedua' } });
    const detail = await call(context, `/api/transactions/${transactionId}`);
    const { from, to } = utcDateRange();
    const reports = await call(context, `/api/reports/sales?from=${from}&to=${to}`);

    assert.equal(voided.response.status, 200);
    assert.equal(voided.body.data.status, 'VOIDED');
    assert.equal(voided.body.data.voidReason, 'Salah input kasir');
    assert.ok(voided.body.data.voidedAt);
    assert.deepEqual(voided.body.data.items, [{ productId: product.id, productName: 'Susu', quantity: 2, unitPrice: 4_000, lineTotal: 8_000 }]);
    assert.equal(secondVoid.response.status, 409);
    assert.equal(secondVoid.body.error.code, 'TRANSACTION_ALREADY_VOIDED');
    assert.equal(context.database.prepare('SELECT stock_quantity FROM product WHERE id = ?').get(product.id)?.stock_quantity, 5);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM stock_movement WHERE movement_type = 'VOID'").get()?.count, 1);
    assert.equal(detail.body.data.items[0].productName, 'Susu');
    assert.equal(detail.body.data.items[0].unitPrice, 4_000);
    assert.equal(detail.body.data.status, 'VOIDED');
    assert.equal(reports.body.data.totalRevenue, 0);
    assert.equal(reports.body.data.transactionCount, 0);
  } finally {
    await context.close();
  }
});

test('batas laporan from inklusif dan to eksklusif menurut zona usaha', async () => {
  const context = await createContext();
  try {
    const { from, to } = utcDateRange();
    const startId = randomUUID();
    const endId = randomUUID();
    const insert = context.database.prepare(`
      INSERT INTO sales_transaction (id,business_id,status,currency,total_amount,created_by_user_id,created_at,voided_at,void_reason)
      VALUES (?,?,'COMPLETED','IDR',?,'owner-1',?,NULL,NULL)
    `);
    insert.run(startId, context.businessId, 1_000, `${from}T00:00:00.000Z`);
    insert.run(endId, context.businessId, 2_000, `${to}T00:00:00.000Z`);
    const report = await call(context, `/api/reports/sales?from=${from}&to=${to}`);

    assert.equal(report.response.status, 200);
    assert.equal(report.body.data.totalRevenue, 1_000);
    assert.equal(report.body.data.transactionCount, 1);
    assert.equal(report.body.data.dailyRevenue[0].totalRevenue, 1_000);
    assert.equal(report.body.data.dailyRevenue[0].transactionCount, 1);
  } finally {
    await context.close();
  }
});

test('rentang laporan lebih dari 366 hari ditolak sebelum query agregat', async () => {
  const context = await createContext();
  try {
    const originalPrepare = context.database.prepare.bind(context.database);
    let aggregateQueryCount = 0;
    context.database.prepare = ((sql: string) => {
      if (/\bFROM\s+(?:sales_transaction|transaction_item)\b/i.test(sql)) aggregateQueryCount += 1;
      return originalPrepare(sql);
    }) as typeof context.database.prepare;

    const report = await call(context, '/api/reports/sales?from=2025-01-01&to=2026-01-03');

    assert.equal(report.response.status, 422);
    assert.equal(report.body.error.code, 'DATE_RANGE_TOO_LARGE');
    assert.equal(aggregateQueryCount, 0);
  } finally {
    await context.close();
  }
});

test('produk dipaginasi dan dicari; prediksi menampilkan status data dan no recent sales', async () => {
  const context = await createContext();
  try {
    await createProduct(context, 'Kopi Arabika', 2);
    await createProduct(context, 'Kopi Robusta', 3);
    await createProduct(context, 'Teh Hijau', 4);
    const page = await call(context, '/api/products?search=kopi&page=1&pageSize=1');
    assert.equal(page.response.status, 200);
    assert.equal(page.body.data.length, 1);
    assert.equal(page.body.pagination.totalItems, 2);
    assert.equal(page.body.pagination.totalPages, 2);
    assert.equal(page.body.data[0].sellingPrice, 1_500);
    assert.equal(page.body.data[0].minStock, 5);

    const noSales = await createProduct(context, 'Tidak Terjual', 5);
    context.database.prepare('UPDATE product SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * 86_400_000).toISOString(), noSales.id);
    const forecast = await call(context, '/api/inventory/forecasts?windowDays=30');
    const noSalesItem = forecast.body.data.items.find((item: any) => item.productId === noSales.id);
    const newItem = forecast.body.data.items.find((item: any) => item.productId === page.body.data[0].id);
    assert.equal(noSalesItem.productName, 'Tidak Terjual');
    assert.equal(noSalesItem.stockQuantity, 5);
    assert.equal(noSalesItem.status, 'NO_RECENT_SALES');
    assert.equal(noSalesItem.averageUnitsPerDay, 0);
    assert.equal(noSalesItem.estimatedDaysRemaining, null);
    assert.equal(noSalesItem.from, forecast.body.data.from);
    assert.equal(noSalesItem.to, forecast.body.data.to);
    assert.equal(newItem.insufficientData, true);
    assert.equal(newItem.estimatedDaysRemaining, null);
    assert.ok(forecast.body.data.from);
    assert.ok(forecast.body.data.to);

    const outsiderToken = await createTestBearerToken(context.database, 'outsider');
    const forbidden = await call(context, '/api/products', { token: outsiderToken });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.error.code, 'BUSINESS_MEMBERSHIP_REQUIRED');
  } finally {
    await context.close();
  }
});

test('ringkasan assistant mengembalikan dataStatus ketika belum ada transaksi', async () => {
  const context = await createContext();
  try {
    const { from, to } = utcDateRange();
    const summary = await call(context, `/api/businesses/${context.businessId}/assistant/summaries`, {
      method: 'POST', body: { from, to },
    });
    assert.equal(summary.response.status, 200);
    assert.equal(summary.body.data.dataStatus, 'INSUFFICIENT_DATA');
    assert.equal(summary.body.data.period.from, from);
    assert.equal(summary.body.data.period.to, to);
    assert.deepEqual(summary.body.data.highlights, []);
  } finally {
    await context.close();
  }
});
