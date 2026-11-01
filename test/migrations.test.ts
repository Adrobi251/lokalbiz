import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';

interface WorkerOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface MigrationWorker {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  completion: Promise<WorkerOutcome>;
}

function startMigrationWorker(databasePath: string, startPath: string): MigrationWorker {
  const workerPath = fileURLToPath(new URL('./migration-worker.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, databasePath, startPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolved = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    if (!readyResolved && stdout.includes('READY\n')) {
      readyResolved = true;
      resolveReady();
    }
  });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const completion = new Promise<WorkerOutcome>((resolve) => {
    child.once('error', (error) => {
      if (!readyResolved) rejectReady(error);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code, signal) => {
      if (!readyResolved) rejectReady(new Error(`Migration worker berhenti sebelum READY: ${stderr}`));
      resolve({ code, signal, stdout, stderr });
    });
  });

  return { child, ready, completion };
}

test('proses serentak mengaktifkan WAL dan menginisialisasi skema SQLite tanpa konflik', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lokalbiz-concurrent-migration-'));
  const databasePath = join(directory, 'shared.sqlite');
  const startPath = join(directory, 'start');
  const workers = Array.from({ length: 6 }, () => startMigrationWorker(databasePath, startPath));

  try {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(workers.map((worker) => worker.ready)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Worker tidak mencapai barrier tepat waktu.')), 10_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    writeFileSync(startPath, 'start');
    const outcomes = await Promise.all(workers.map((worker) => worker.completion));
    for (const outcome of outcomes) {
      assert.equal(outcome.code, 0, outcome.stderr || `Worker exit signal: ${outcome.signal}`);
      const resultLine = outcome.stdout.split('\n').find((line) => line.startsWith('RESULT:'));
      assert.ok(resultLine, `Worker tidak mengembalikan status skema: ${outcome.stdout}`);
      assert.deepEqual(JSON.parse(resultLine.slice('RESULT:'.length)), { userVersion: 4, integrity: 'ok', journalMode: 'wal' });
    }

    const database = createDatabase(databasePath);
    try {
      const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
      const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name);
      assert.equal(version.user_version, 4);
      assert.equal(integrity.integrity_check, 'ok');
      assert.ok(tables.includes('business'));
      assert.ok(tables.includes('app_user'));
      assert.ok(tables.includes('auth_session'));
      assert.ok(tables.includes('auth_rate_limit_bucket'));
    } finally {
      database.close();
    }
  } finally {
    if (!existsSync(startPath)) writeFileSync(startPath, 'release');
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM');
    }
    await Promise.all(workers.map((worker) => worker.completion));
    rmSync(directory, { recursive: true, force: true });
  }
});
