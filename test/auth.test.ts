import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { jwtVerify, SignJWT } from 'jose';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { createDatabase, nowIso, type SqliteDatabase } from '../src/db.js';

const authSecret = 'test-secret-with-at-least-thirty-two-bytes';
const appOrigin = 'http://localhost:5173';
process.env.AUTH_JWT_SECRET = authSecret;
process.env.APP_ORIGINS = appOrigin;
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
const secretKey = new TextEncoder().encode(authSecret);

type Json = any;
type AuthUser = { id: string; email: string };

interface AuthTestContext {
  database: SqliteDatabase;
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

interface SessionCookie {
  name: string;
  value: string;
  pair: string;
  attributes: string[];
}

async function createContext(databasePath = ':memory:'): Promise<AuthTestContext> {
  const database = createDatabase(databasePath);
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
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}

async function request(
  context: AuthTestContext,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    csrfToken?: string;
  } = {},
): Promise<{ response: Response; body: Json }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin) headers.Origin = options.origin;
  if (options.csrfToken !== undefined) headers['X-CSRF-Token'] = options.csrfToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${context.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as Json : null };
}

function assertError(result: { response: Response; body: Json }, status: number, code: string): void {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert.equal(typeof result.body.error.message, 'string');
}

function assertAuthUser(body: Json, email: string): AuthUser {
  assert.deepEqual(Object.keys(body).sort(), ['data']);
  assert.deepEqual(Object.keys(body.data).sort(), ['user']);
  assert.deepEqual(Object.keys(body.data.user).sort(), ['email', 'id']);
  assert.equal(typeof body.data.user.id, 'string');
  assert.ok(body.data.user.id.length > 0);
  assert.equal(body.data.user.email, email);
  return { id: body.data.user.id, email: body.data.user.email };
}

function setCookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
}

function parseSetCookie(response: Response): SessionCookie {
  const header = setCookieHeader(response);
  assert.ok(header, 'Respons harus menyertakan Set-Cookie.');
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  assert.ok(separator > 0, `Format Set-Cookie tidak valid: ${header}`);
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    pair,
    attributes: attributes.map((attribute) => attribute.toLowerCase()),
  };
}

function assertSessionCookie(response: Response, secure = process.env.NODE_ENV === 'production'): SessionCookie {
  const cookie = parseSetCookie(response);
  assert.equal(cookie.name, 'lokalbiz_session');
  assert.ok(cookie.value.length > 0);
  assert.ok(cookie.attributes.includes('httponly'));
  assert.ok(cookie.attributes.includes('samesite=lax'));
  assert.ok(cookie.attributes.includes('path=/'));
  assert.equal(cookie.attributes.includes('secure'), secure);
  return cookie;
}

function assertDeletedSessionCookie(response: Response, secure = process.env.NODE_ENV === 'production'): void {
  const cookie = parseSetCookie(response);
  assert.equal(cookie.name, 'lokalbiz_session');
  assert.equal(cookie.value, '');
  assert.ok(cookie.attributes.includes('httponly'));
  assert.ok(cookie.attributes.includes('samesite=lax'));
  assert.ok(cookie.attributes.includes('path=/'));
  assert.ok(cookie.attributes.includes('max-age=0'));
  assert.equal(cookie.attributes.includes('secure'), secure);
}

async function assertIssuedToken(cookie: SessionCookie, userId: string) {
  const verified = await jwtVerify(cookie.value, secretKey, { algorithms: ['HS256'] });
  assert.equal(verified.protectedHeader.alg, 'HS256');
  assert.equal(verified.payload.sub, userId);
  assert.equal(typeof verified.payload.jti, 'string');
  assert.ok((verified.payload.jti as string).length > 0);
  assert.ok(typeof verified.payload.iat === 'number');
  assert.ok(typeof verified.payload.exp === 'number');
  assert.equal(verified.payload.exp - verified.payload.iat, 12 * 60 * 60);
  return verified.payload;
}

async function register(
  context: AuthTestContext,
  email: string,
  password = 'Pass1234',
  origin: string | null = appOrigin,
): Promise<{ user: AuthUser; cookie: SessionCookie }> {
  const result = await request(context, '/api/auth/register', {
    method: 'POST',
    origin,
    body: { email, password },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return {
    user: assertAuthUser(result.body, email.trim().toLowerCase()),
    cookie: assertSessionCookie(result.response),
  };
}

async function getCsrfToken(context: AuthTestContext, cookie: string): Promise<string> {
  const result = await request(context, '/api/auth/csrf', { cookie, origin: appOrigin });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body).sort(), ['data']);
  assert.deepEqual(Object.keys(result.body.data).sort(), ['csrfToken']);
  assert.match(result.body.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  return result.body.data.csrfToken;
}

test('register mengembalikan user saja, memasang cookie HttpOnly, dan menerbitkan JWT/jti 12 jam', async () => {
  const context = await createContext();
  try {
    const result = await request(context, '/api/auth/register', {
      method: 'POST',
      origin: appOrigin,
      body: { email: '  QA.User@Example.COM  ', password: 'Pass1234' },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    const user = assertAuthUser(result.body, 'qa.user@example.com');
    const cookie = assertSessionCookie(result.response);
    await assertIssuedToken(cookie, user.id);

    const current = await request(context, '/api/businesses/current', { cookie: cookie.pair });
    assertError(current, 404, 'BUSINESS_NOT_FOUND');
    assert.match(await getCsrfToken(context, cookie.pair), /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await context.close();
  }
});

test('flags cookie sama di HTTP lokal dan Secure hanya saat production', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    for (const [nodeEnv, secure] of [['development', false], ['production', true]] as const) {
      process.env.NODE_ENV = nodeEnv;
      const context = await createContext();
      try {
        const result = await request(context, '/api/auth/register', {
          method: 'POST',
          origin: appOrigin,
          body: { email: `${nodeEnv}@example.com`, password: 'Pass1234' },
        });
        assert.equal(result.response.status, 201, JSON.stringify(result.body));
        assertSessionCookie(result.response, secure);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('register dan login menolak Origin yang tidak diizinkan atau tidak ada', async () => {
  const context = await createContext();
  try {
    const deniedRegister = await request(context, '/api/auth/register', {
      method: 'POST',
      origin: 'https://attacker.example',
      body: { email: 'denied@example.com', password: 'Pass1234' },
    });
    assertError(deniedRegister, 403, 'ORIGIN_NOT_ALLOWED');

    const missingOrigin = await request(context, '/api/auth/register', {
      method: 'POST',
      origin: null,
      body: { email: 'missing-origin@example.com', password: 'Pass1234' },
    });
    assertError(missingOrigin, 403, 'ORIGIN_NOT_ALLOWED');

    const registered = await register(context, 'origin-check@example.com');
    const deniedLogin = await request(context, '/api/auth/login', {
      method: 'POST',
      origin: 'https://attacker.example',
      body: { email: registered.user.email, password: 'Pass1234' },
    });
    assertError(deniedLogin, 403, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await context.close();
  }
});

test('login menormalisasi email dan menerbitkan sesi untuk user yang sama', async () => {
  const context = await createContext();
  try {
    const registered = await register(context, '  Sign.In@Example.COM ');
    const login = await request(context, '/api/auth/login', {
      method: 'POST',
      origin: appOrigin,
      body: { email: ' SIGN.IN@example.com  ', password: 'Pass1234' },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.body));
    const user = assertAuthUser(login.body, 'sign.in@example.com');
    assert.equal(user.id, registered.user.id);
    const cookie = assertSessionCookie(login.response);
    await assertIssuedToken(cookie, registered.user.id);
    assert.match(await getCsrfToken(context, cookie.pair), /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await context.close();
  }
});

test('register memvalidasi email/password dan menolak email duplikat setelah normalisasi', async () => {
  const context = await createContext();
  try {
    const invalidEmail = await request(context, '/api/auth/register', {
      method: 'POST', origin: appOrigin, body: { email: 'not-an-email', password: 'Pass1234' },
    });
    assertError(invalidEmail, 422, 'VALIDATION_ERROR');

    const shortPassword = await request(context, '/api/auth/register', {
      method: 'POST', origin: appOrigin, body: { email: 'short@example.com', password: '1234567' },
    });
    assertError(shortPassword, 422, 'VALIDATION_ERROR');

    await register(context, '  Duplicate@Example.com ');
    const duplicate = await request(context, '/api/auth/register', {
      method: 'POST', origin: appOrigin, body: { email: 'duplicate@example.com', password: 'Pass1234' },
    });
    assertError(duplicate, 409, 'EMAIL_ALREADY_REGISTERED');
  } finally {
    await context.close();
  }
});

test('login menyamakan error untuk email tidak dikenal dan password salah', async () => {
  const context = await createContext();
  try {
    await register(context, 'known@example.com');
    const wrongPassword = await request(context, '/api/auth/login', {
      method: 'POST', origin: appOrigin, body: { email: 'known@example.com', password: 'Wrong1234' },
    });
    const unknownEmail = await request(context, '/api/auth/login', {
      method: 'POST', origin: appOrigin, body: { email: 'unknown@example.com', password: 'Pass1234' },
    });
    assertError(wrongPassword, 401, 'INVALID_CREDENTIALS');
    assertError(unknownEmail, 401, 'INVALID_CREDENTIALS');
    assert.equal(wrongPassword.body.error.message, unknownEmail.body.error.message);
  } finally {
    await context.close();
  }
});

test('mutasi cookie-auth menolak CSRF hilang/salah dan Origin salah, lalu menerima token valid', async () => {
  const context = await createContext();
  try {
    const registered = await register(context, 'csrf@example.com');
    const csrfToken = await getCsrfToken(context, registered.cookie.pair);
    const body = { name: 'Warung CSRF', timeZone: 'Asia/Jakarta' };

    const missing = await request(context, '/api/businesses', {
      method: 'POST', cookie: registered.cookie.pair, origin: appOrigin, body,
    });
    assertError(missing, 403, 'CSRF_TOKEN_INVALID');

    const wrong = await request(context, '/api/businesses', {
      method: 'POST', cookie: registered.cookie.pair, origin: appOrigin, csrfToken: 'wrong-token', body,
    });
    assertError(wrong, 403, 'CSRF_TOKEN_INVALID');

    const deniedOrigin = await request(context, '/api/businesses', {
      method: 'POST', cookie: registered.cookie.pair, origin: 'https://attacker.example', csrfToken, body,
    });
    assertError(deniedOrigin, 403, 'ORIGIN_NOT_ALLOWED');

    const created = await request(context, '/api/businesses', {
      method: 'POST', cookie: registered.cookie.pair, origin: appOrigin, csrfToken, body,
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.name, body.name);
  } finally {
    await context.close();
  }
});

test('cookie berisi JWT yang kedaluwarsa ditolak oleh route terlindungi', async () => {
  const context = await createContext();
  try {
    const registered = await register(context, 'expiry@example.com');
    const now = Math.floor(Date.now() / 1_000);
    const expiredToken = await new SignJWT({ csrf: 'x'.repeat(43) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(registered.user.id)
      .setJti(randomUUID())
      .setIssuedAt(now - 12 * 60 * 60 - 1)
      .setExpirationTime(now - 1)
      .sign(secretKey);
    const current = await request(context, '/api/businesses/current', {
      cookie: `lokalbiz_session=${expiredToken}`,
    });
    assertError(current, 401, 'INVALID_TOKEN');
  } finally {
    await context.close();
  }
});

test('cookie auth mengisolasi usaha antar user', async () => {
  const context = await createContext();
  try {
    const first = await register(context, 'owner.one@example.com');
    const second = await register(context, 'owner.two@example.com');
    const firstBusinessId = randomUUID();
    const secondBusinessId = randomUUID();
    const createdAt = nowIso();
    const insertBusiness = context.database.prepare(`
      INSERT INTO business (id, name, currency, time_zone, created_at)
      VALUES (?, ?, 'IDR', ?, ?)
    `);
    const insertMembership = context.database.prepare(`
      INSERT INTO business_membership (id, business_id, user_id, role, is_active, created_at)
      VALUES (?, ?, ?, 'OWNER', 1, ?)
    `);
    insertBusiness.run(firstBusinessId, 'Usaha satu', 'UTC', createdAt);
    insertBusiness.run(secondBusinessId, 'Usaha dua', 'Asia/Jakarta', createdAt);
    insertMembership.run(randomUUID(), firstBusinessId, first.user.id, createdAt);
    insertMembership.run(randomUUID(), secondBusinessId, second.user.id, createdAt);

    const secondCurrent = await request(context, '/api/businesses/current', { cookie: second.cookie.pair });
    assert.equal(secondCurrent.response.status, 200, JSON.stringify(secondCurrent.body));
    assert.equal(secondCurrent.body.data.id, secondBusinessId);
    const foreignProducts = await request(context, `/api/businesses/${firstBusinessId}/products`, { cookie: second.cookie.pair });
    const foreignTransactions = await request(context, `/api/businesses/${firstBusinessId}/transactions`, { cookie: second.cookie.pair });
    assertError(foreignProducts, 404, 'BUSINESS_NOT_FOUND');
    assertError(foreignTransactions, 404, 'BUSINESS_NOT_FOUND');
  } finally {
    await context.close();
  }
});

test('logout mewajibkan Origin/CSRF, menghapus cookie, mencabut sesi sebelum expiry, dan bertahan setelah server restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lokalbiz-auth-revoke-'));
  const databasePath = join(directory, 'auth.sqlite');
  let context: AuthTestContext | undefined = await createContext(databasePath);
  try {
    const registered = await register(context, 'logout@example.com');
    const tokenClaims = await assertIssuedToken(registered.cookie, registered.user.id);
    assert.ok(typeof tokenClaims.exp === 'number' && tokenClaims.exp > Math.floor(Date.now() / 1_000) + 60);
    const csrfToken = await getCsrfToken(context, registered.cookie.pair);

    const missingCsrf = await request(context, '/api/auth/logout', {
      method: 'POST', cookie: registered.cookie.pair, origin: appOrigin,
    });
    assertError(missingCsrf, 403, 'CSRF_TOKEN_INVALID');

    const deniedOrigin = await request(context, '/api/auth/logout', {
      method: 'POST', cookie: registered.cookie.pair, origin: 'https://attacker.example', csrfToken,
    });
    assertError(deniedOrigin, 403, 'ORIGIN_NOT_ALLOWED');

    const logout = await request(context, '/api/auth/logout', {
      method: 'POST', cookie: registered.cookie.pair, origin: appOrigin, csrfToken,
    });
    assert.equal(logout.response.status, 204);
    assert.equal(logout.body, null);
    assertDeletedSessionCookie(logout.response);

    const revokedImmediately = await request(context, '/api/businesses/current', { cookie: registered.cookie.pair });
    assertError(revokedImmediately, 401, 'INVALID_TOKEN');

    await context.close();
    context = undefined;
    context = await createContext(databasePath);
    const revokedAfterRestart = await request(context, '/api/businesses/current', { cookie: registered.cookie.pair });
    assertError(revokedAfterRestart, 401, 'INVALID_TOKEN');
  } finally {
    if (context) await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
