import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMysqlTestConfig } from './mysql-test-config.js';

test('konfigurasi MySQL kerja tidak mengaktifkan tes integrasi', () => {
  assert.equal(getMysqlTestConfig({
    MYSQL_HOST: 'production.example',
    MYSQL_PORT: '3306',
    MYSQL_DATABASE: 'lokalbiz',
    MYSQL_USER: 'app',
    MYSQL_PASSWORD: 'work-password',
  }), undefined);
});

test('konfigurasi tes hanya menggunakan MYSQL_TEST_* dan default loopback', () => {
  assert.deepEqual(getMysqlTestConfig({
    MYSQL_HOST: 'production.example',
    MYSQL_DATABASE: 'lokalbiz',
    MYSQL_USER: 'app',
    MYSQL_PASSWORD: 'work-password',
    MYSQL_TEST_DATABASE: 'lokalbiz_test',
    MYSQL_TEST_USER: 'test_user',
  }), {
    host: '127.0.0.1',
    port: 3306,
    user: 'test_user',
    password: '',
    database: 'lokalbiz_test',
  });
});

test('MySQL test guard menolak host non-loopback dan skema tanpa penanda test', () => {
  assert.throws(() => getMysqlTestConfig({
    MYSQL_TEST_HOST: 'db.example',
    MYSQL_TEST_DATABASE: 'lokalbiz_test',
    MYSQL_TEST_USER: 'test_user',
  }), /loopback/);
  assert.throws(() => getMysqlTestConfig({
    MYSQL_TEST_DATABASE: 'lokalbiz',
    MYSQL_TEST_USER: 'test_user',
  }), /khusus tes/);
});

test('MySQL test guard menolak port yang tidak valid', () => {
  assert.throws(() => getMysqlTestConfig({
    MYSQL_TEST_DATABASE: 'lokalbiz_test',
    MYSQL_TEST_USER: 'test_user',
    MYSQL_TEST_PORT: '3306/other',
  }), /MYSQL_TEST_PORT/);
});
