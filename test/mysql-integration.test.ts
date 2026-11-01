import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { createMysqlDatabase } from '../src/mysql-db.js';
import { getMysqlTestConfig } from './mysql-test-config.js';

const authSecret = 'mysql-integration-secret-with-at-least-32-bytes';
process.env.AUTH_JWT_SECRET = authSecret;
const testConfig = getMysqlTestConfig(process.env);

test('MySQL menjalankan migrasi paralel, query, transaksi, dan advisory lock', {
  skip: testConfig ? false : 'Atur MYSQL_TEST_DATABASE dan MYSQL_TEST_USER untuk mengaktifkan tes integrasi MySQL.',
}, async () => {
  assert.ok(testConfig);
  assert.ok(Number.isInteger(testConfig.port) && testConfig.port >= 1 && testConfig.port <= 65_535);

  const database = await createMysqlDatabase(testConfig);
  const userId = randomUUID();
  const email = `${randomUUID()}@test.invalid`;
  try {
    const version = await database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
    assert.equal(Number(version.version), 4);
    assert.equal(Number((await database.prepare('SELECT 1 AS value').get())?.value), 1);

    await assert.rejects(database.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO app_user (id, email, password_hash, created_at)
        VALUES (?, ?, 'test-hash', ?)
      `).run(userId, email, new Date().toISOString());
      throw new Error('rollback probe');
    }), /rollback probe/);
    assert.equal(await database.prepare('SELECT id FROM app_user WHERE id = ?').get(userId), undefined);

    let activeLocks = 0;
    let maximumConcurrentLocks = 0;
    await Promise.all([1, 2].map(() => database.withAdvisoryLock('integration-test-lock', async () => {
      activeLocks += 1;
      maximumConcurrentLocks = Math.max(maximumConcurrentLocks, activeLocks);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeLocks -= 1;
    })));
    assert.equal(maximumConcurrentLocks, 1);

    await assertConcurrentSkuUpdate(database);
    await assertConcurrentBusinessCreate(database);
  } finally {
    await database.close();
  }

  const reopened = await createMysqlDatabase(testConfig);
  try {
    const version = await reopened.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number };
    assert.equal(Number(version.version), 4);
  } finally {
    await reopened.close();
  }
});

async function assertConcurrentBusinessCreate(database: Awaited<ReturnType<typeof createMysqlDatabase>>): Promise<void> {
  const userId = randomUUID();
  const jti = randomUUID();
  const timestamp = new Date().toISOString();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + 3_600;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(authSecret));

  await database.transaction(async (transaction) => {
    await transaction.prepare(`
      INSERT INTO app_user (id, email, password_hash, created_at) VALUES (?, ?, 'test-hash', ?)
    `).run(userId, `${randomUUID()}@test.invalid`, timestamp);
    await transaction.prepare(`
      INSERT INTO auth_session (jti, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
    `).run(jti, userId, expiresAt, issuedAt);
  });

  const server = createServer(createApp(database));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    const results = await Promise.all([1, 2].map(async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/businesses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Usaha race test', timeZone: 'Asia/Jakarta' }),
      });
      return { status: response.status, body: await response.json() as any };
    }));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(results.find((result) => result.status === 409)?.body.error.code, 'BUSINESS_ALREADY_EXISTS');
    const membershipCount = await database.prepare('SELECT COUNT(*) AS count FROM business_membership WHERE user_id = ?').get(userId) as { count: number };
    assert.equal(Number(membershipCount.count), 1);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await database.transaction(async (transaction) => {
      const membership = await transaction.prepare('SELECT business_id FROM business_membership WHERE user_id = ?').get(userId) as { business_id: string } | undefined;
      await transaction.prepare('DELETE FROM business_membership WHERE user_id = ?').run(userId);
      if (membership) await transaction.prepare('DELETE FROM business WHERE id = ?').run(membership.business_id);
      await transaction.prepare('DELETE FROM app_user WHERE id = ?').run(userId);
    });
  }
}

async function assertConcurrentSkuUpdate(database: Awaited<ReturnType<typeof createMysqlDatabase>>): Promise<void> {
  const userId = randomUUID();
  const businessId = randomUUID();
  const productIds = [randomUUID(), randomUUID()];
  const jti = randomUUID();
  const email = `${randomUUID()}@test.invalid`;
  const timestamp = new Date().toISOString();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + 3_600;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(authSecret));

  await database.transaction(async (transaction) => {
    await transaction.prepare(`
      INSERT INTO app_user (id, email, password_hash, created_at) VALUES (?, ?, 'test-hash', ?)
    `).run(userId, email, timestamp);
    await transaction.prepare(`
      INSERT INTO auth_session (jti, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
    `).run(jti, userId, expiresAt, issuedAt);
    await transaction.prepare(`
      INSERT INTO business (id, name, currency, time_zone, created_at) VALUES (?, 'SKU race test', 'IDR', 'UTC', ?)
    `).run(businessId, timestamp);
    await transaction.prepare(`
      INSERT INTO business_membership (id, business_id, user_id, \`role\`, is_active, created_at)
      VALUES (?, ?, ?, 'OWNER', 1, ?)
    `).run(randomUUID(), businessId, userId, timestamp);
    for (const [index, productId] of productIds.entries()) {
      await transaction.prepare(`
        INSERT INTO product (id, business_id, name, sku, unit_price, stock_quantity, low_stock_threshold, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 100, 5, 1, 0, ?, ?)
      `).run(productId, businessId, `Produk race ${index}`, timestamp, timestamp);
    }
  });

  const server = createServer(createApp(database));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    const results = await Promise.all(productIds.map(async (productId) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/businesses/${businessId}/products/${productId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: 'RACE-SKU' }),
      });
      return { status: response.status, body: await response.json() as any };
    }));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(results.find((result) => result.status === 409)?.body.error.code, 'SKU_ALREADY_EXISTS');
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await database.transaction(async (transaction) => {
      await transaction.prepare('DELETE FROM product WHERE business_id = ?').run(businessId);
      await transaction.prepare('DELETE FROM business_membership WHERE business_id = ?').run(businessId);
      await transaction.prepare('DELETE FROM business WHERE id = ?').run(businessId);
      await transaction.prepare('DELETE FROM app_user WHERE id = ?').run(userId);
    });
  }
}
