import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth.js';

test('hash password memakai salt acak dan verifikasi memakai perbandingan yang aman', async () => {
  const password = 'correct-horse-battery';
  const firstHash = await hashPassword(password);
  const secondHash = await hashPassword(password);

  assert.match(firstHash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(firstHash, password);
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword(password, firstHash), true);
  assert.equal(await verifyPassword('incorrect-password', firstHash), false);
  assert.equal(await verifyPassword(password, 'unsupported$format'), false);
});
