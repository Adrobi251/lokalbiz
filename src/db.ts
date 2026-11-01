import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqliteDatabase = DatabaseSync;

const WAL_RETRY_LIMIT = 8;
const WAL_RETRY_BASE_DELAY_MS = 10;
const WAL_RETRY_MAX_DELAY_MS = 250;
const walRetryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function createDatabase(databasePath = process.env.DATABASE_PATH ?? './data/lokalbiz.sqlite'): SqliteDatabase {
  const resolvedPath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
  if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });

  const database = new DatabaseSync(resolvedPath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (resolvedPath !== ':memory:') enableWal(database);
  migrate(database);
  return database;
}

function enableWal(database: SqliteDatabase): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      if (result.journal_mode.toLowerCase() !== 'wal') {
        throw new Error(`SQLite tidak mengaktifkan mode WAL (mode: ${result.journal_mode}).`);
      }
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= WAL_RETRY_LIMIT) throw error;
      const delayMs = Math.min(WAL_RETRY_BASE_DELAY_MS * (2 ** attempt), WAL_RETRY_MAX_DELAY_MS);
      Atomics.wait(walRetryWait, 0, 0, delayMs);
    }
  }
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errorCode = (error as { errcode?: unknown }).errcode;
  return typeof errorCode === 'number' && ((errorCode & 0xff) === 5 || (errorCode & 0xff) === 6);
}

function migrate(database: SqliteDatabase): void {
  const migrations = [
    { version: 1, path: '../migrations/001_init.sql' },
    { version: 2, path: '../migrations/002_auth_users.sql' },
    { version: 3, path: '../migrations/003_auth_sessions.sql' },
    { version: 4, path: '../migrations/004_auth_rate_limits.sql' },
  ] as const;
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const currentVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (currentVersion >= latestVersion) return;

  withImmediateTransaction(database, () => {
    let version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (const migration of migrations) {
      if (version >= migration.version) continue;
      if (version !== migration.version - 1) {
        throw new Error(`Tidak dapat menerapkan migrasi ${migration.version} dari versi skema ${version}.`);
      }

      const sql = readFileSync(new URL(migration.path, import.meta.url), 'utf8');
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${migration.version};`);
      version = migration.version;
    }
  });
}

export function withImmediateTransaction<T>(database: SqliteDatabase, action: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = action();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original failure if SQLite has already closed the transaction.
    }
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
