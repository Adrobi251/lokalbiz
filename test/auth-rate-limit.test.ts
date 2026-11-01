import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AUTH_RATE_LIMITS, consumeAuthRateLimit } from '../src/auth-rate-limit.js';
import { createDatabase, type SqliteDatabase, nowIso } from '../src/db.js';
import { createSqliteDatabaseClient } from '../src/db-client.js';

const authSecret = 'test-secret-with-at-least-thirty-two-bytes';
const appOrigin = 'http://localhost:5173';
process.env.AUTH_JWT_SECRET = authSecret;
process.env.APP_ORIGINS = appOrigin;

interface TestContext {
  database: SqliteDatabase;
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

async function createContext(databasePath = ':memory:', trustProxyHops?: string): Promise<TestContext> {
  const database = createDatabase(databasePath);
  const previousTrustProxyHops = process.env.TRUST_PROXY_HOPS;
  if (trustProxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = trustProxyHops;
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(database);
  } finally {
    if (previousTrustProxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = previousTrustProxyHops;
  }
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    database,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}

async function authRequest(
  context: TestContext,
  endpoint: 'register' | 'login',
  email: string,
  password = 'Pass1234',
  forwardedFor?: string,
): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = { Origin: appOrigin, 'Content-Type': 'application/json' };
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
  const response = await fetch(`${context.baseUrl}/api/auth/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as any : null };
}

function assertRateLimited(result: { response: Response; body: any }): void {
  assert.equal(result.response.status, 429, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'AUTH_RATE_LIMITED');
  assert.equal(typeof result.body.error.message, 'string');
  assert.match(result.response.headers.get('retry-after') ?? '', /^\d+$/);
  assert.ok(Number(result.response.headers.get('retry-after')) > 0);
}

test('batas daftar 5 per IP per jam tetap berlaku setelah database dibuka ulang', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lokalbiz-auth-rate-'));
  const databasePath = join(directory, 'auth.sqlite');
  let context = await createContext(databasePath);
  try {
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.registerPerIp.limit; attempt += 1) {
      const result = await authRequest(context, 'register', `owner-${attempt}@example.com`);
      assert.equal(result.response.status, 201, JSON.stringify(result.body));
    }
    await context.close();
    context = await createContext(databasePath);
    const result = await authRequest(context, 'register', 'sixth-owner@example.com');
    assertRateLimited(result);
    assert.equal(
      (context.database.prepare('SELECT COUNT(*) AS count FROM app_user').get() as { count: number }).count,
      AUTH_RATE_LIMITS.registerPerIp.limit,
    );
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('login membatasi percobaan berulang untuk email dan IP yang sama dengan 429', async () => {
  const context = await createContext();
  const email = 'known@example.com';
  try {
    context.database.prepare(`
      INSERT INTO app_user (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)
    `).run(randomUUID(), email, 'malformed-test-hash', nowIso());

    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.loginPerEmailAndIp.limit; attempt += 1) {
      const result = await authRequest(context, 'login', email);
      assert.equal(result.response.status, 401, JSON.stringify(result.body));
      assert.equal(result.body.error.code, 'INVALID_CREDENTIALS');
    }

    assertRateLimited(await authRequest(context, 'login', email));
  } finally {
    await context.close();
  }
});

test('batas IP login bekerja lintas identitas dan fixed window ter-reset saat kedaluwarsa', async () => {
  const database = createSqliteDatabaseClient(createDatabase(':memory:'));
  const nowMs = 1_800_000_000_000;
  const clientIp = '198.51.100.25';
  try {
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.loginPerIp.limit; attempt += 1) {
      const retryAfter = await consumeAuthRateLimit(database, {
        action: 'login',
        clientIp,
        email: `user-${attempt}@example.com`,
        secret: authSecret,
        nowMs,
      });
      assert.equal(retryAfter, undefined);
    }

    const limited = await consumeAuthRateLimit(database, {
      action: 'login',
      clientIp,
      email: 'new-identity@example.com',
      secret: authSecret,
      nowMs,
    });
    assert.ok(limited && limited > 0 && limited <= AUTH_RATE_LIMITS.loginPerIp.windowSeconds);

    const afterWindow = await consumeAuthRateLimit(database, {
      action: 'login',
      clientIp,
      email: 'new-identity@example.com',
      secret: authSecret,
      nowMs: nowMs + AUTH_RATE_LIMITS.loginPerIp.windowSeconds * 1_000,
    });
    assert.equal(afterWindow, undefined);
  } finally {
    await database.close();
  }
});

test('email daftar duplikat tetap dihitung terhadap batas IP', async () => {
  const context = await createContext();
  try {
    const first = await authRequest(context, 'register', 'reused@example.com');
    assert.equal(first.response.status, 201, JSON.stringify(first.body));

    for (let attempt = 1; attempt < AUTH_RATE_LIMITS.registerPerIp.limit; attempt += 1) {
      const duplicate = await authRequest(context, 'register', 'reused@example.com');
      assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));
      assert.equal(duplicate.body.error.code, 'EMAIL_ALREADY_REGISTERED');
    }

    assertRateLimited(await authRequest(context, 'register', 'new-owner@example.com'));
    assert.equal(
      (context.database.prepare('SELECT COUNT(*) AS count FROM app_user').get() as { count: number }).count,
      1,
    );
  } finally {
    await context.close();
  }
});

test('login sukses memakai bucket email dan IP yang sama dengan email ternormalisasi', async () => {
  const context = await createContext();
  const email = 'normalized@example.com';
  try {
    const registered = await authRequest(context, 'register', email);
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));

    const successfulLogin = await authRequest(context, 'login', email);
    assert.equal(successfulLogin.response.status, 200, JSON.stringify(successfulLogin.body));

    for (let attempt = 1; attempt < AUTH_RATE_LIMITS.loginPerEmailAndIp.limit; attempt += 1) {
      const failedLogin = await authRequest(context, 'login', email.toUpperCase(), 'WrongPass123');
      assert.equal(failedLogin.response.status, 401, JSON.stringify(failedLogin.body));
      assert.equal(failedLogin.body.error.code, 'INVALID_CREDENTIALS');
    }

    assertRateLimited(await authRequest(context, 'login', email));
  } finally {
    await context.close();
  }
});

test('X-Forwarded-For diabaikan saat TRUST_PROXY_HOPS tidak disetel', async () => {
  const context = await createContext();
  try {
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.registerPerIp.limit; attempt += 1) {
      const result = await authRequest(
        context,
        'register',
        `default-proxy-${attempt}@example.com`,
        'Pass1234',
        `198.51.100.${attempt + 1}`,
      );
      assert.equal(result.response.status, 201, JSON.stringify(result.body));
    }

    const result = await authRequest(
      context,
      'register',
      'default-proxy-over-limit@example.com',
      'Pass1234',
      '203.0.113.99',
    );
    assertRateLimited(result);
  } finally {
    await context.close();
  }
});

test('X-Forwarded-For menentukan IP hanya saat TRUST_PROXY_HOPS dikonfigurasi', async () => {
  const context = await createContext(':memory:', '1');
  const trustedClientIp = '198.51.100.27';
  try {
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.registerPerIp.limit; attempt += 1) {
      const result = await authRequest(
        context,
        'register',
        `trusted-proxy-${attempt}@example.com`,
        'Pass1234',
        trustedClientIp,
      );
      assert.equal(result.response.status, 201, JSON.stringify(result.body));
    }

    assertRateLimited(await authRequest(context, 'register', 'trusted-proxy-limited@example.com', 'Pass1234', trustedClientIp));
    const otherClient = await authRequest(context, 'register', 'trusted-proxy-other@example.com', 'Pass1234', '203.0.113.28');
    assert.equal(otherClient.response.status, 201, JSON.stringify(otherClient.body));
  } finally {
    await context.close();
  }
});
