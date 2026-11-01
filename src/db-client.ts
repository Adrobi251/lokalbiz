import type { SQLInputValue } from 'node:sqlite';
import type { SqliteDatabase } from './db.js';

export type DatabaseRow = Record<string, unknown>;

export interface DatabaseStatement {
  get(...parameters: SQLInputValue[]): Promise<DatabaseRow | undefined>;
  all(...parameters: SQLInputValue[]): Promise<DatabaseRow[]>;
  run(...parameters: SQLInputValue[]): Promise<{ changes: number }>;
}

export interface DatabaseClient {
  readonly dialect: 'sqlite' | 'mysql';
  prepare(sql: string): DatabaseStatement;
  transaction<T>(action: (transaction: DatabaseClient) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(key: string, action: (database: DatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

class SqliteDatabaseClient implements DatabaseClient {
  readonly dialect = 'sqlite' as const;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly mutex: AsyncMutex,
    private readonly transactionScoped = false,
  ) {}

  prepare(sql: string): DatabaseStatement {
    const statement = this.database.prepare(sql);
    const execute = <T>(action: () => T): Promise<T> => this.transactionScoped
      ? Promise.resolve(action())
      : this.mutex.runExclusive(action);

    return {
      get: (...parameters) => execute(() => statement.get(...parameters) as DatabaseRow | undefined),
      all: (...parameters) => execute(() => statement.all(...parameters) as DatabaseRow[]),
      run: (...parameters) => execute(() => ({ changes: Number(statement.run(...parameters).changes) })),
    };
  }

  async transaction<T>(action: (transaction: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.transactionScoped) throw new Error('Transaksi database bersarang tidak didukung.');
    return this.mutex.runExclusive(async () => {
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        const result = await action(new SqliteDatabaseClient(this.database, this.mutex, true));
        this.database.exec('COMMIT;');
        return result;
      } catch (error) {
        try {
          this.database.exec('ROLLBACK;');
        } catch {
          // Pertahankan error awal jika transaksi sudah ditutup oleh SQLite.
        }
        throw error;
      }
    });
  }

  async withAdvisoryLock<T>(_key: string, action: (database: DatabaseClient) => Promise<T>): Promise<T> {
    return action(this);
  }

  async close(): Promise<void> {
    if (this.transactionScoped) throw new Error('Koneksi transaksi tidak dapat ditutup langsung.');
    await this.mutex.runExclusive(() => this.database.close());
  }
}

export function createSqliteDatabaseClient(database: SqliteDatabase): DatabaseClient {
  return new SqliteDatabaseClient(database, new AsyncMutex());
}
