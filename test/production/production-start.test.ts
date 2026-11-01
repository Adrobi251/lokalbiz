import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(child: ChildProcess): Promise<string> {
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server tidak siap: ${output}`)), 10_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    };
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('LokalBiz AI API berjalan pada port')) finish();
    });
    child.stderr?.on('data', (chunk: string) => { output += chunk; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => finish(new Error(`Server berhenti sebelum siap (code=${code}, signal=${signal}): ${output}`)));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

test('npm start menjalankan build produksi dan menerapkan semua migrasi SQL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lokalbiz-production-start-'));
  const databasePath = join(directory, 'production.sqlite');
  const port = await availablePort();
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCommand, ['run', 'start'], {
    cwd: projectRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      AUTH_JWT_SECRET: 'production-smoke-secret-with-32-bytes',
      DATABASE_PATH: databasePath,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const output = await waitForReady(child);
    assert.match(output, new RegExp(`port ${port}\\.`));

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
      const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name);
      assert.equal(version.user_version, 4);
      assert.equal(integrity.integrity_check, 'ok');
      assert.ok(tables.includes('auth_session'));
      assert.ok(tables.includes('auth_rate_limit_bucket'));
    } finally {
      database.close();
    }
  } finally {
    await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
