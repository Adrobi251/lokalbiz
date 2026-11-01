import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalViteEnvironment, getLocalApiProxyTarget } from '../scripts/local-config.mjs';

test('local proxy selalu memakai loopback dan PORT, bukan API_PROXY_TARGET dari environment', () => {
  assert.equal(getLocalApiProxyTarget('4321'), 'http://127.0.0.1:4321');
  assert.throws(() => getLocalApiProxyTarget('http://evil.example'), /PORT/);
  const environment = createLocalViteEnvironment({ API_PROXY_TARGET: 'https://evil.example', PORT: '4321' }, '4321');
  assert.equal(environment.API_PROXY_TARGET, 'http://127.0.0.1:4321');
});

test('PORT lokal hanya menerima angka dalam rentang port TCP', () => {
  assert.throws(() => getLocalApiProxyTarget('0'), /PORT/);
  assert.throws(() => getLocalApiProxyTarget('65536'), /PORT/);
  assert.throws(() => getLocalApiProxyTarget('3000/evil.example'), /PORT/);
});

test('launcher tidak meneruskan VITE_* termasuk service-role key atau API base override', () => {
  const environment = createLocalViteEnvironment({
    VITE_API_BASE_URL: 'https://evil.example',
    VITE_API_KEY: 'secret',
    VITE_PRIVATE_TOKEN: 'secret',
    VITE_PRIVATE_KEY: 'secret',
    VITE_DB_URL: 'mysql://user:password@localhost/db',
    VITE_SUPABASE_SERVICE_ROLE_KEY: 'secret',
    GEMINI_API_KEY: 'secret',
    VITE_PUBLIC_MODE: 'local',
    PATH: '/usr/bin',
  }, '3000');
  assert.equal(environment.VITE_API_BASE_URL, undefined);
  assert.equal(environment.VITE_API_KEY, undefined);
  assert.equal(environment.VITE_PRIVATE_TOKEN, undefined);
  assert.equal(environment.VITE_PRIVATE_KEY, undefined);
  assert.equal(environment.VITE_DB_URL, undefined);
  assert.equal(environment.VITE_SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(environment.GEMINI_API_KEY, undefined);
  assert.equal(environment.VITE_PUBLIC_MODE, undefined);
  assert.equal(environment.PATH, '/usr/bin');
});
