import { createHmac } from 'node:crypto';
import type { DatabaseClient } from './db-client.js';

export const AUTH_RATE_LIMITS = Object.freeze({
  registerPerIp: { limit: 5, windowSeconds: 60 * 60 },
  loginPerIp: { limit: 30, windowSeconds: 15 * 60 },
  loginPerEmailAndIp: { limit: 10, windowSeconds: 15 * 60 },
});

type AuthRateLimitRequest =
  | { action: 'register'; clientIp: string; secret: string; nowMs?: number }
  | { action: 'login'; clientIp: string; email: string; secret: string; nowMs?: number };

interface RateLimitBucket {
  scope: string;
  identity: string;
  limit: number;
  windowSeconds: number;
}

interface BucketState {
  request_count: number;
  expires_at: number;
}

export function consumeAuthRateLimit(
  database: DatabaseClient,
  request: AuthRateLimitRequest,
): Promise<number | undefined> {
  const buckets: RateLimitBucket[] = request.action === 'register'
    ? [{ scope: 'register:ip', identity: request.clientIp, ...AUTH_RATE_LIMITS.registerPerIp }]
    : [
      { scope: 'login:ip', identity: request.clientIp, ...AUTH_RATE_LIMITS.loginPerIp },
      {
        scope: 'login:email-ip',
        identity: `${request.email}\u0000${request.clientIp}`,
        ...AUTH_RATE_LIMITS.loginPerEmailAndIp,
      },
    ];
  const nowSeconds = Math.floor((request.nowMs ?? Date.now()) / 1_000);

  return database.transaction(async (transaction) => {
    await transaction.prepare('DELETE FROM auth_rate_limit_bucket WHERE expires_at <= ?').run(nowSeconds);
    let retryAfterSeconds = 0;
    for (const bucket of buckets) {
      const bucketHash = createHmac('sha256', request.secret)
        .update(`${bucket.scope}\u0000${bucket.identity}`)
        .digest('hex');
      const expiresAt = nowSeconds + bucket.windowSeconds;
      const state = transaction.dialect === 'sqlite'
        ? await consumeSqliteBucket(transaction, bucket, bucketHash, nowSeconds, expiresAt)
        : await consumeMysqlBucket(transaction, bucket, bucketHash, nowSeconds, expiresAt);
      if (state.request_count > bucket.limit) {
        retryAfterSeconds = Math.max(retryAfterSeconds, state.expires_at - nowSeconds);
      }
    }
    return retryAfterSeconds > 0 ? retryAfterSeconds : undefined;
  });
}

async function consumeSqliteBucket(
  database: DatabaseClient,
  bucket: RateLimitBucket,
  bucketHash: string,
  nowSeconds: number,
  expiresAt: number,
): Promise<BucketState> {
  const row = await database.prepare(`
    INSERT INTO auth_rate_limit_bucket (bucket_hash, window_started_at, request_count, expires_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(bucket_hash) DO UPDATE SET
      window_started_at = CASE
        WHEN auth_rate_limit_bucket.expires_at <= excluded.window_started_at THEN excluded.window_started_at
        ELSE auth_rate_limit_bucket.window_started_at
      END,
      request_count = CASE
        WHEN auth_rate_limit_bucket.expires_at <= excluded.window_started_at THEN 1
        WHEN auth_rate_limit_bucket.request_count < ? THEN auth_rate_limit_bucket.request_count + 1
        ELSE auth_rate_limit_bucket.request_count
      END,
      expires_at = CASE
        WHEN auth_rate_limit_bucket.expires_at <= excluded.window_started_at THEN excluded.expires_at
        ELSE auth_rate_limit_bucket.expires_at
      END
    RETURNING request_count, expires_at
  `).get(bucketHash, nowSeconds, expiresAt, bucket.limit + 1) as BucketState | undefined;
  if (!row || typeof row.request_count !== 'number' || typeof row.expires_at !== 'number') {
    throw new Error('Database tidak mengembalikan data bucket rate-limit.');
  }
  return row;
}

async function consumeMysqlBucket(
  database: DatabaseClient,
  bucket: RateLimitBucket,
  bucketHash: string,
  nowSeconds: number,
  expiresAt: number,
): Promise<BucketState> {
  await database.prepare(`
    INSERT INTO auth_rate_limit_bucket (bucket_hash, window_started_at, request_count, expires_at)
    VALUES (?, ?, 1, ?)
    ON DUPLICATE KEY UPDATE bucket_hash = bucket_hash
  `).run(bucketHash, nowSeconds, expiresAt);
  const row = await database.prepare(`
    SELECT request_count, expires_at FROM auth_rate_limit_bucket WHERE bucket_hash = ? FOR UPDATE
  `).get(bucketHash) as BucketState | undefined;
  if (!row) throw new Error('Database tidak mengembalikan data bucket rate-limit.');

  let requestCount = Number(row.request_count);
  let bucketExpiresAt = Number(row.expires_at);
  if (bucketExpiresAt <= nowSeconds) {
    requestCount = 1;
    bucketExpiresAt = expiresAt;
    await database.prepare(`
      UPDATE auth_rate_limit_bucket SET window_started_at = ?, request_count = ?, expires_at = ? WHERE bucket_hash = ?
    `).run(nowSeconds, requestCount, bucketExpiresAt, bucketHash);
  } else if (requestCount < bucket.limit + 1) {
    requestCount += 1;
    await database.prepare('UPDATE auth_rate_limit_bucket SET request_count = ? WHERE bucket_hash = ?').run(requestCount, bucketHash);
  }
  return { request_count: requestCount, expires_at: bucketExpiresAt };
}
