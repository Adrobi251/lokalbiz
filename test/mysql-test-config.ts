import type { MysqlDatabaseConfig } from '../src/mysql-db.js';

export function getMysqlTestConfig(environment: NodeJS.ProcessEnv): MysqlDatabaseConfig | undefined {
  const database = environment.MYSQL_TEST_DATABASE?.trim();
  const user = environment.MYSQL_TEST_USER?.trim();
  if (!database && !user) return undefined;
  if (!database || !user) throw new Error('MYSQL_TEST_DATABASE dan MYSQL_TEST_USER harus diatur bersama.');

  const host = environment.MYSQL_TEST_HOST?.trim() || '127.0.0.1';
  if (!['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())) {
    throw new Error('MYSQL_TEST_HOST harus menunjuk ke loopback agar tes tidak menyentuh database jarak jauh.');
  }
  if (!/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)tests?(?:_|$)/i.test(database)) {
    throw new Error('MYSQL_TEST_DATABASE harus berupa nama skema khusus tes yang memiliki penanda test.');
  }

  const portText = environment.MYSQL_TEST_PORT ?? '3306';
  if (!/^\d+$/.test(portText)) throw new Error('MYSQL_TEST_PORT harus berupa angka antara 1 dan 65535.');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MYSQL_TEST_PORT harus berupa angka antara 1 dan 65535.');
  }

  return {
    host,
    port,
    user,
    password: environment.MYSQL_TEST_PASSWORD ?? '',
    database,
  };
}
