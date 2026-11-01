import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { SQLInputValue } from 'node:sqlite';
import type { DatabaseClient, DatabaseRow, DatabaseStatement } from './db-client.js';

export interface MysqlDatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertMysqlLoopbackHost(host: string): void {
  if (!loopbackHosts.has(host.toLowerCase())) {
    throw new Error('MYSQL_HOST hanya boleh berupa alamat loopback (127.0.0.1, localhost, atau ::1); koneksi MySQL remote tidak didukung.');
  }
}

interface MysqlExecutor {
  execute(sql: string, parameters?: unknown[]): Promise<[unknown, unknown]>;
}

const migrations = [
  { version: 1, path: '../migrations/mysql/001_init.sql' },
  { version: 2, path: '../migrations/mysql/002_auth_users.sql' },
  { version: 3, path: '../migrations/mysql/003_auth_sessions.sql' },
  { version: 4, path: '../migrations/mysql/004_auth_rate_limits.sql' },
] as const;

class MysqlDatabaseClient implements DatabaseClient {
  readonly dialect = 'mysql' as const;

  constructor(
    private readonly pool: Pool,
    private readonly executor: MysqlExecutor,
    private readonly transactionScoped = false,
    private readonly connection?: PoolConnection,
  ) {}

  prepare(sql: string): DatabaseStatement {
    return {
      get: async (...parameters: SQLInputValue[]) => {
        const [rows] = await this.executor.execute(sql, parameters as unknown[]);
        return (rows as RowDataPacket[])[0] as DatabaseRow | undefined;
      },
      all: async (...parameters: SQLInputValue[]) => {
        const [rows] = await this.executor.execute(sql, parameters as unknown[]);
        return rows as DatabaseRow[];
      },
      run: async (...parameters: SQLInputValue[]) => {
        const [result] = await this.executor.execute(sql, parameters as unknown[]);
        return { changes: Number((result as ResultSetHeader).affectedRows) };
      },
    };
  }

  async transaction<T>(action: (transaction: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.transactionScoped) throw new Error('Transaksi database bersarang tidak didukung.');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const connection = this.connection ?? await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const transaction = new MysqlDatabaseClient(this.pool, connection as unknown as MysqlExecutor, true, connection);
        const result = await action(transaction);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // Pertahankan error awal jika koneksi sudah kehilangan transaksi.
        }
        if (attempt === 2 || !isRetryableTransactionError(error)) throw error;
      } finally {
        if (!this.connection) connection.release();
      }
    }
    throw new Error('Transaksi MySQL gagal setelah retry deadlock.');
  }

  async withAdvisoryLock<T>(key: string, action: (database: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.transactionScoped || this.connection) throw new Error('Advisory lock harus dimulai di luar transaksi.');
    const connection = await this.pool.getConnection();
    const lockName = `lokalbiz:${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
    let lockAcquired = false;
    try {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
      if (Number((rows as RowDataPacket[])[0]?.acquired) !== 1) {
        throw new Error('Tidak dapat memperoleh advisory lock MySQL dalam 30 detik.');
      }
      lockAcquired = true;
      const lockedDatabase = new MysqlDatabaseClient(this.pool, connection as unknown as MysqlExecutor, false, connection);
      return await action(lockedDatabase);
    } finally {
      if (lockAcquired) {
        try {
          await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        } catch (error) {
          connection.destroy();
          throw error;
        }
      }
      connection.release();
    }
  }

  async close(): Promise<void> {
    if (this.transactionScoped || this.connection) throw new Error('Koneksi transaksi tidak dapat ditutup langsung.');
    await this.pool.end();
  }
}

export async function createMysqlDatabase(config: MysqlDatabaseConfig): Promise<DatabaseClient> {
  assertMysqlLoopbackHost(config.host);
  const pool = createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 10,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
  });

  try {
    await migrateMysql(pool, config.database);
    return new MysqlDatabaseClient(pool, pool as unknown as MysqlExecutor);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function migrateMysql(pool: Pool, databaseName: string): Promise<void> {
  const connection = await pool.getConnection();
  const lockName = `lokalbiz-migrations:${createHash('sha256').update(databaseName).digest('hex').slice(0, 32)}`;
  let lockAcquired = false;
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT NOT NULL PRIMARY KEY,
        applied_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `);
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
    const acquired = (lockRows as RowDataPacket[])[0]?.acquired;
    if (Number(acquired) !== 1) throw new Error('Tidak dapat memperoleh lock migrasi MySQL dalam 30 detik.');
    lockAcquired = true;

    const [versionRows] = await connection.execute('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = new Set((versionRows as RowDataPacket[]).map((row) => Number(row.version)));
    let version = appliedVersions.size ? Math.max(...appliedVersions) : 0;
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      if (version !== migration.version - 1) {
        throw new Error(`Tidak dapat menerapkan migrasi MySQL ${migration.version} dari versi skema ${version}.`);
      }
      const sql = readFileSync(new URL(migration.path, import.meta.url), 'utf8');
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await connection.query(statement);
      }
      await connection.execute('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [migration.version, new Date().toISOString()]);
      appliedVersions.add(migration.version);
      version = migration.version;
    }
  } finally {
    if (lockAcquired) {
      try {
        await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
      } finally {
        connection.release();
      }
    } else {
      connection.release();
    }
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}
