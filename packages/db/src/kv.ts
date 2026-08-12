import { eq } from 'drizzle-orm';
import { now } from '@4gent/core';
import type { Db } from './client.js';
import { kv } from './schema.js';

/** Small durable key/value store for cursors, peaks and other loop state. */
export async function kvGet<T>(db: Db, key: string): Promise<T | undefined> {
  const rows = await db.select().from(kv).where(eq(kv.key, key)).limit(1);
  return rows[0]?.value as T | undefined;
}

export async function kvSet<T>(db: Db, key: string, value: T): Promise<void> {
  await db
    .insert(kv)
    .values({ key, value: value as never, updatedAt: now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: value as never, updatedAt: now() } });
}

export async function kvDelete(db: Db, key: string): Promise<void> {
  await db.delete(kv).where(eq(kv.key, key));
}
