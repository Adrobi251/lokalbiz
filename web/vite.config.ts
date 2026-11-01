import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['API_PROXY_TARGET', 'PREVIEW_ALLOWED_HOSTS']);
  const target = getLoopbackProxyTarget(env.API_PROXY_TARGET || 'http://127.0.0.1:3000');
  const allowedHosts = (env.PREVIEW_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const proxy = {
    '/api': {
      target,
      changeOrigin: true,
    },
  };

  return {
    envPrefix: [],
    plugins: [react()],
    server: { host: '127.0.0.1', proxy },
    preview: { host: '127.0.0.1', proxy, allowedHosts },
  };
});

function getLoopbackProxyTarget(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('API_PROXY_TARGET harus berupa URL HTTP loopback.');
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('API_PROXY_TARGET hanya boleh menunjuk ke HTTP loopback tanpa path.');
  }
  return url.origin;
}
