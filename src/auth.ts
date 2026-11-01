import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { SqliteDatabase } from './db.js';
import { ApiError, sendApiError } from './errors.js';

export const AUTH_SESSION_COOKIE_NAME = 'lokalbiz_session';
export const AUTH_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const AUTH_SESSION_TTL_MS = AUTH_SESSION_TTL_SECONDS * 1_000;

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_OPTIONS: ScryptOptions = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: 64 * 1024 * 1024,
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derivedKey = await deriveScryptKey(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, saltText, keyText, extra] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || cost !== String(SCRYPT_N) || blockSize !== String(SCRYPT_R)
    || parallelism !== String(SCRYPT_P) || !saltText || !keyText || extra !== undefined) {
    return false;
  }

  const salt = Buffer.from(saltText, 'base64url');
  const expectedKey = Buffer.from(keyText, 'base64url');
  if (salt.length !== SCRYPT_SALT_LENGTH || expectedKey.length !== SCRYPT_KEY_LENGTH
    || salt.toString('base64url') !== saltText || expectedKey.toString('base64url') !== keyText) {
    return false;
  }

  const actualKey = await deriveScryptKey(password, salt);
  return timingSafeEqual(actualKey, expectedKey);
}

export interface AuthSession {
  token: string;
  csrfToken: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

export async function createAuthSession(userId: string, secret: string): Promise<AuthSession> {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + AUTH_SESSION_TTL_SECONDS;
  const jti = randomUUID();
  const csrfToken = randomBytes(32).toString('base64url');
  const token = await new SignJWT({ csrf: csrfToken })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));
  return { token, csrfToken, jti, issuedAt, expiresAt };
}

function deriveScryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function getSessionCookie(request: Request): string | undefined {
  const cookieHeader = request.get('cookie');
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === AUTH_SESSION_COOKIE_NAME) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.origin === 'null') {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function configuredAppOrigins(): Set<string> {
  const values = (process.env.APP_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const origins = new Set<string>();
  for (const value of values) {
    const origin = normalizedOrigin(value);
    if (!origin) continue;
    const url = new URL(value);
    if (url.pathname === '/' && !url.search && !url.hash) origins.add(origin);
  }
  return origins;
}

export function getAllowedAppOrigin(request: Request): string | undefined {
  const rawOrigin = request.get('origin') ?? request.get('referer');
  if (!rawOrigin) return undefined;
  const origin = normalizedOrigin(rawOrigin);
  if (!origin || !configuredAppOrigins().has(origin)) return undefined;
  return origin;
}

export function isAllowedAppOriginValue(value: string): string | undefined {
  const origin = normalizedOrigin(value);
  if (!origin || !configuredAppOrigins().has(origin)) return undefined;
  return origin;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      businessId?: string;
      authMethod?: 'cookie' | 'bearer';
      authJti?: string;
      csrfToken?: string;
    }
  }
}

export function authenticate(database: SqliteDatabase): RequestHandler {
  return async (request, response, next) => {
    const cookieToken = getSessionCookie(request);
    const authorization = request.get('authorization');
    const token = cookieToken !== undefined
      ? cookieToken
      : authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';
    if (!token) {
      sendApiError(response, 401, 'UNAUTHENTICATED', 'Sesi autentikasi diperlukan.');
      return;
    }

    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      sendApiError(response, 503, 'AUTH_NOT_CONFIGURED', 'Autentikasi server belum dikonfigurasi.');
      return;
    }

    let payload;
    try {
      const verified = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
      payload = verified.payload;
    } catch {
      sendApiError(response, 401, 'INVALID_TOKEN', 'Sesi autentikasi tidak valid atau sudah kedaluwarsa.');
      return;
    }

    if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0 || payload.sub.length > 200) {
      sendApiError(response, 401, 'INVALID_TOKEN', 'Sesi autentikasi tidak valid.');
      return;
    }
    if (typeof payload.jti !== 'string') {
      sendApiError(response, 401, 'INVALID_TOKEN', 'Sesi autentikasi tidak valid.');
      return;
    }
    if (cookieToken !== undefined && (typeof payload.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.csrf))) {
      sendApiError(response, 401, 'INVALID_TOKEN', 'Sesi autentikasi tidak valid.');
      return;
    }

    const activeSession = database.prepare(`
      SELECT jti FROM auth_session
      WHERE jti = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(payload.jti, payload.sub, Math.floor(Date.now() / 1_000));
    if (!activeSession) {
      sendApiError(response, 401, 'INVALID_TOKEN', 'Sesi autentikasi tidak valid atau telah dicabut.');
      return;
    }

    request.authJti = payload.jti;
    request.userId = payload.sub;
    request.authMethod = cookieToken !== undefined ? 'cookie' : 'bearer';
    if (typeof payload.csrf === 'string') request.csrfToken = payload.csrf;
    next();
  };
}

export function requireCsrfForCookieMutations(request: Request, response: Response, next: NextFunction): void {
  if (request.authMethod !== 'cookie' || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    next();
    return;
  }
  if (!getAllowedAppOrigin(request)) {
    sendApiError(response, 403, 'ORIGIN_NOT_ALLOWED', 'Origin permintaan tidak diizinkan.');
    return;
  }

  const suppliedToken = request.get('x-csrf-token');
  const expectedToken = request.csrfToken;
  if (!suppliedToken || !expectedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    sendApiError(response, 403, 'CSRF_TOKEN_INVALID', 'Token CSRF tidak valid atau tidak tersedia.');
    return;
  }
  next();
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
