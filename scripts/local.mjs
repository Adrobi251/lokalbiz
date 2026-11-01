import { accessSync, readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalViteEnvironment } from './local-config.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteEntrypoint = resolve(projectRoot, 'web/node_modules/vite/bin/vite.js');
try {
  accessSync(viteEntrypoint, constants.R_OK);
} catch {
  console.error('Dependensi web belum terpasang. Jalankan: npm install --prefix web');
  process.exit(1);
}

function readProjectSetting(name) {
  if (process.env[name] !== undefined) return process.env[name];
  try {
    for (const line of readFileSync(resolve(projectRoot, '.env'), 'utf8').split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator < 0 || line.slice(0, separator).trim() !== name) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '').trim();
      }
      return value;
    }
  } catch {
    // The API's optional env-file flag handles a missing project .env.
  }
  return undefined;
}

const apiPort = readProjectSetting('PORT') || '3000';
const webEnvironment = createLocalViteEnvironment(process.env, apiPort);

const children = [];
let shuttingDown = false;
let exitCode = 0;

function start(command, arguments_, options) {
  const child = spawn(command, arguments_, { stdio: 'inherit', ...options });
  children.push(child);
  child.once('error', (error) => {
    if (shuttingDown) return;
    console.error('Proses lokal gagal dimulai.', error);
    void shutdown(1);
  });
  child.once('close', (code, signal) => {
    if (shuttingDown) return;
    console.error(`Proses lokal berhenti (code=${code}, signal=${signal}). Menutup proses lainnya.`);
    void shutdown(code ?? 1);
  });
  return child;
}

start(process.execPath, [
  '--env-file-if-exists=.env',
  '--import', 'tsx',
  'src/server.ts',
], {
  cwd: projectRoot,
  env: { ...process.env, HOST: '127.0.0.1', LOCAL_GEMINI_SUMMARY_ENABLED: 'false' },
});

start(process.execPath, [viteEntrypoint, '--host', '127.0.0.1', '--strictPort'], {
  cwd: resolve(projectRoot, 'web'),
  env: webEnvironment,
});

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  const forceKill = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 5_000);
  forceKill.unref();

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolveClose) => child.once('close', resolveClose))));
  clearTimeout(forceKill);
  process.exit(exitCode);
}
