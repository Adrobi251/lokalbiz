import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createConfiguredDatabase } from './database-config.js';
import { createGeminiFreeSummaryProviderFromEnvironment } from './gemini-summary.js';

const authSecret = process.env.AUTH_JWT_SECRET;
if (!authSecret || Buffer.byteLength(authSecret) < 32) {
  throw new Error('AUTH_JWT_SECRET wajib tersedia dan minimal 32 byte.');
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT harus berupa angka antara 1 dan 65535.');
}
const host = process.env.HOST?.trim() || '0.0.0.0';

const database = await createConfiguredDatabase();
const aiSummaryProvider = createGeminiFreeSummaryProviderFromEnvironment();
const server = createServer(createApp(database, { aiSummaryProvider }));
server.listen(port, host, () => {
  console.log(`LokalBiz AI API berjalan pada port ${port}.`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    void database.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Koneksi database gagal ditutup dengan bersih.', error);
        process.exit(1);
      },
    );
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
