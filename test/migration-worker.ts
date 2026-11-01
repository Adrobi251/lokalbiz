import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../src/db.ts';

const [databasePath, startPath] = process.argv.slice(2);
if (!databasePath || !startPath) throw new Error('Path database dan barrier wajib diberikan.');

process.stdout.write('READY\n');
while (!existsSync(startPath)) await delay(5);

const database = createDatabase(databasePath);
try {
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  if (integrity.integrity_check !== 'ok') throw new Error(`SQLite integrity_check: ${integrity.integrity_check}`);
  process.stdout.write(`RESULT:${JSON.stringify({ userVersion: version.user_version, integrity: integrity.integrity_check, journalMode: journal.journal_mode })}\n`);
} finally {
  database.close();
}
