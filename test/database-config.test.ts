import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfiguredDatabase, getDatabaseConfig } from '../src/database-config.js';
import { createMysqlDatabase } from '../src/mysql-db.js';

test('SQLite tetap menjadi driver default dan memakai path default yang sama', () => {
  assert.deepEqual(getDatabaseConfig({}), {
    driver: 'sqlite',
    databasePath: './data/lokalbiz.sqlite',
  });
});

test('SQLite tetap memakai DATABASE_PATH yang dipilih', () => {
  assert.deepEqual(getDatabaseConfig({ DATABASE_PATH: './data/test.sqlite' }), {
    driver: 'sqlite',
    databasePath: './data/test.sqlite',
  });
});

test('driver yang tidak dikenal atau kosong gagal tanpa fallback', () => {
  assert.throws(() => getDatabaseConfig({ DB_DRIVER: 'postgres' }), /DB_DRIVER/);
  assert.throws(() => getDatabaseConfig({ DB_DRIVER: '' }), /DB_DRIVER/);
});

test('MySQL memerlukan user dan nama database', () => {
  assert.throws(() => getDatabaseConfig({ DB_DRIVER: 'mysql', MYSQL_USER: 'root' }), /MYSQL_DATABASE/);
  assert.throws(() => getDatabaseConfig({ DB_DRIVER: 'mysql', MYSQL_DATABASE: 'lokalbiz' }), /MYSQL_USER/);
});

test('MySQL menerima kredensial lokal dengan password kosong dan memvalidasi port', () => {
  assert.deepEqual(getDatabaseConfig({
    DB_DRIVER: 'mysql',
    MYSQL_USER: 'root',
    MYSQL_DATABASE: 'lokalbiz',
  }), {
    driver: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'lokalbiz',
  });
  assert.throws(() => getDatabaseConfig({
    DB_DRIVER: 'mysql',
    MYSQL_USER: 'root',
    MYSQL_DATABASE: 'lokalbiz',
    MYSQL_PORT: 'not-a-port',
  }), /MYSQL_PORT/);
});

test('MySQL menerima hanya host loopback yang didukung', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const config = getDatabaseConfig({
      DB_DRIVER: 'mysql',
      MYSQL_USER: 'root',
      MYSQL_DATABASE: 'lokalbiz',
      MYSQL_HOST: host,
    });
    assert.equal(config.driver, 'mysql');
    if (config.driver === 'mysql') assert.equal(config.host, host);
  }
});

test('MySQL menolak host remote dari konfigurasi aplikasi dan factory', async () => {
  for (const host of ['mysql.example.com', '203.0.113.10', 'localhost.example']) {
    assert.throws(() => getDatabaseConfig({
      DB_DRIVER: 'mysql',
      MYSQL_USER: 'root',
      MYSQL_DATABASE: 'lokalbiz',
      MYSQL_HOST: host,
    }), /MYSQL_HOST.*loopback/);
  }

  await assert.rejects(createMysqlDatabase({
    host: 'mysql.example.com',
    port: 3306,
    user: 'root',
    password: '',
    database: 'lokalbiz',
  }), /MYSQL_HOST.*loopback/);
});

test('koneksi MySQL yang gagal tidak membuat file SQLite fallback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lokalbiz-no-fallback-'));
  const sqlitePath = join(directory, 'must-not-exist.sqlite');
  try {
    await assert.rejects(createConfiguredDatabase({
      DB_DRIVER: 'mysql',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '1',
      MYSQL_USER: 'root',
      MYSQL_PASSWORD: 'test-only-password',
      MYSQL_DATABASE: 'lokalbiz_test',
      DATABASE_PATH: sqlitePath,
    }));
    assert.equal(existsSync(sqlitePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
