import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build, resolveConfig } from '../web/node_modules/vite/dist/node/index.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
const configFile = resolve(webRoot, 'vite.config.ts');

function setEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function inDirectory<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

function javascriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(path) : entry.isFile() && path.endsWith('.js') ? [path] : [];
  });
}

test('dev and preview only proxy to loopback and reject external targets', async () => {
  const envDir = mkdtempSync(join(tmpdir(), 'lokalbiz-vite-config-'));
  const envFile = join(envDir, '.env.development');
  try {
    writeFileSync(envFile, 'API_PROXY_TARGET=http://127.0.0.1:4312\n');
    await inDirectory(envDir, async () => {
      const restore = setEnvironment({ API_PROXY_TARGET: undefined });
      try {
        const config = await resolveConfig({ root: webRoot, envDir, configFile }, 'serve');
        assert.equal(config.server.host, '127.0.0.1');
        assert.equal(config.preview.host, '127.0.0.1');
        assert.equal((config.server.proxy as Record<string, { target: string }>)['/api'].target, 'http://127.0.0.1:4312');
        assert.equal((config.preview.proxy as Record<string, { target: string }>)['/api'].target, 'http://127.0.0.1:4312');
      } finally {
        restore();
      }

      writeFileSync(envFile, 'API_PROXY_TARGET=https://external.invalid\n');
      await assert.rejects(resolveConfig({ root: webRoot, envDir, configFile }, 'serve'), /API_PROXY_TARGET.*HTTP loopback/);

      const restoreExternal = setEnvironment({ API_PROXY_TARGET: 'https://external.invalid' });
      try {
        await assert.rejects(resolveConfig({ root: webRoot, envDir, configFile }, 'serve'), /API_PROXY_TARGET.*HTTP loopback/);
      } finally {
        restoreExternal();
      }
    });
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
});

test('production bundle excludes VITE secrets and API origins from process env and web env files', async () => {
  const envDir = mkdtempSync(join(tmpdir(), 'lokalbiz-vite-bundle-'));
  const outputDir = join(envDir, 'bundle');
  const fileSecret = 'FILE_SUPABASE_SERVICE_ROLE_SENTINEL';
  const processSecret = 'PROCESS_SUPABASE_SERVICE_ROLE_SENTINEL';
  const fileOrigin = 'https://file-api-origin.invalid';
  const processOrigin = 'https://process-api-origin.invalid';
  const envFile = join(envDir, '.env.production');
  try {
    mkdirSync(outputDir);
    writeFileSync(envFile, [
      'API_PROXY_TARGET=http://127.0.0.1:3000',
      `VITE_SUPABASE_SERVICE_ROLE_KEY=${fileSecret}`,
      `VITE_API_BASE_URL=${fileOrigin}`,
      '',
    ].join('\n'));

    const restore = setEnvironment({
      API_PROXY_TARGET: 'http://127.0.0.1:3000',
      VITE_SUPABASE_SERVICE_ROLE_KEY: processSecret,
      VITE_API_BASE_URL: processOrigin,
    });
    try {
      await inDirectory(envDir, () => build({
        root: webRoot,
        envDir,
        configFile,
        mode: 'production',
        build: { outDir: outputDir, emptyOutDir: true },
      }));
    } finally {
      restore();
    }

    const files = javascriptFiles(outputDir);
    assert.ok(files.length > 0, 'Vite build harus menghasilkan bundle JavaScript.');
    const bundle = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    assert.ok(bundle.includes('/api'), 'bundle harus memakai path API same-origin.');
    for (const value of [fileSecret, processSecret, fileOrigin, processOrigin, 'VITE_SUPABASE_SERVICE_ROLE_KEY']) {
      assert.equal(bundle.includes(value), false, `Bundle tidak boleh memuat ${value}.`);
    }
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
});
