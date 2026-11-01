import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createDatabase } from './db.js';
import { createGeminiFreeSummaryProviderFromEnvironment } from './gemini-summary.js';

const authSecret = process.env.AUTH_JWT_SECRET;
if (!authSecret || Buffer.byteLength(authSecret) < 32) {
  throw new Error('AUTH_JWT_SECRET wajib tersedia dan minimal 32 byte.');
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT harus berupa angka antara 1 dan 65535.');
}

const database = createDatabase();
const aiSummaryProvider = createGeminiFreeSummaryProviderFromEnvironment();
const server = createServer(createApp(database, { aiSummaryProvider }));
server.listen(port, '0.0.0.0', () => {
  console.log(`LokalBiz AI API berjalan pada port ${port}.`);
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
