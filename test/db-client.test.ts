import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createSqliteDatabaseClient } from '../src/db-client.js';

test('adapter SQLite async mempertahankan query dan rollback transaksi', async () => {
  const database = createSqliteDatabaseClient(createDatabase(':memory:'));
  const userId = randomUUID();
  const email = `${randomUUID()}@test.invalid`;

  try {
    await database.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO app_user (id, email, password_hash, created_at)
        VALUES (?, ?, 'test-hash', ?)
      `).run(userId, email, new Date().toISOString());
    });
    assert.equal((await database.prepare('SELECT id FROM app_user WHERE id = ?').get(userId))?.id, userId);

    const rolledBackId = randomUUID();
    await assert.rejects(database.transaction(async (transaction) => {
      await transaction.prepare(`
        INSERT INTO app_user (id, email, password_hash, created_at)
        VALUES (?, ?, 'test-hash', ?)
      `).run(rolledBackId, `${randomUUID()}@test.invalid`, new Date().toISOString());
      throw new Error('rollback probe');
    }), /rollback probe/);
    assert.equal(await database.prepare('SELECT id FROM app_user WHERE id = ?').get(rolledBackId), undefined);
  } finally {
    await database.close();
  }
});
