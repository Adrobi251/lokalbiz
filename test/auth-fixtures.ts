import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SqliteDatabase } from '../src/db.js';

const authSecret = 'test-secret-with-at-least-thirty-two-bytes';

export async function createTestBearerToken(database: SqliteDatabase, userId: string): Promise<string> {
  const user = database.prepare('SELECT id FROM app_user WHERE id = ?').get(userId);
  if (!user) {
    database.prepare(`
      INSERT INTO app_user (id, email, password_hash, created_at)
      VALUES (?, ?, 'test-only-password-hash', ?)
    `).run(userId, `${randomUUID()}@test.invalid`, new Date().toISOString());
  }

  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + 2 * 60 * 60;
  const jti = randomUUID();
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(authSecret));
  database.prepare(`
    INSERT INTO auth_session (jti, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(jti, userId, expiresAt, issuedAt);
  return token;
}
