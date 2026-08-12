import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '@4gent/core';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

const log = logger('db');

let instance: Db | null = null;
let raw: Database.Database | null = null;

/**
 * Opens (or returns) the process-wide database handle.
 *
 * WAL plus a busy timeout gives the dashboard a consistent read snapshot while
 * the trading loops write, without ever blocking the execution path.
 */
export function getDb(path: string): Db {
  if (instance) return instance;
  mkdirSync(dirname(path), { recursive: true });
  raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  instance = drizzle(raw, { schema });
  log.info({ path }, 'database opened');
  return instance;
}

export function getRawDb(): Database.Database {
  if (!raw) throw new Error('Database not initialised — call getDb(path) first');
  return raw;
}

export function closeDb(): void {
  raw?.close();
  raw = null;
  instance = null;
}

/** Synchronous transaction wrapper. better-sqlite3 is sync by design. */
export function transaction<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction(fn as (tx: unknown) => T)(db as never) as T;
}
