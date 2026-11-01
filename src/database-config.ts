import { createDatabase } from './db.js';
import { createSqliteDatabaseClient, type DatabaseClient } from './db-client.js';
import { assertMysqlLoopbackHost, createMysqlDatabase, type MysqlDatabaseConfig } from './mysql-db.js';

export type DatabaseConfig =
  | { driver: 'sqlite'; databasePath: string }
  | ({ driver: 'mysql' } & MysqlDatabaseConfig);

export function getDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const driver = environment.DB_DRIVER === undefined ? 'sqlite' : environment.DB_DRIVER.trim().toLowerCase();
  if (driver === 'sqlite') {
    const databasePath = environment.DATABASE_PATH === undefined ? './data/lokalbiz.sqlite' : environment.DATABASE_PATH.trim();
    if (!databasePath) throw new Error('DATABASE_PATH tidak boleh kosong saat DB_DRIVER=sqlite.');
    return { driver, databasePath };
  }
  if (driver !== 'mysql') throw new Error('DB_DRIVER harus berupa sqlite atau mysql.');

  const user = requiredEnvironmentValue(environment, 'MYSQL_USER');
  const database = requiredEnvironmentValue(environment, 'MYSQL_DATABASE');
  const host = environment.MYSQL_HOST === undefined ? '127.0.0.1' : environment.MYSQL_HOST.trim();
  if (!host) throw new Error('MYSQL_HOST tidak boleh kosong.');
  assertMysqlLoopbackHost(host);
  const portText = environment.MYSQL_PORT === undefined ? '3306' : environment.MYSQL_PORT.trim();
  if (!/^[1-9]\d*$/.test(portText)) throw new Error('MYSQL_PORT harus berupa angka antara 1 dan 65535.');
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error('MYSQL_PORT harus berupa angka antara 1 dan 65535.');

  return {
    driver,
    host,
    port,
    user,
    password: environment.MYSQL_PASSWORD ?? '',
    database,
  };
}

export async function createConfiguredDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<DatabaseClient> {
  const config = getDatabaseConfig(environment);
  if (config.driver === 'sqlite') {
    return createSqliteDatabaseClient(createDatabase(config.databasePath));
  }
  return createMysqlDatabase(config);
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} wajib diisi saat DB_DRIVER=mysql.`);
  return value;
}
