import { resolve } from 'node:path';
import 'dotenv/config';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadConfig, logger } from '@4gent/core';
import { closeDb, getDb } from './client.js';

const log = logger('db:migrate');

export function runMigrations(databasePath: string, migrationsFolder = resolve('drizzle')): void {
  const db = getDb(databasePath);
  migrate(db, { migrationsFolder });
  log.info({ databasePath, migrationsFolder }, 'migrations applied');
}

const isEntrypoint = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');
if (isEntrypoint) {
  const config = loadConfig();
  runMigrations(config.databasePath);
  closeDb();
}
