/** Time helpers. All internal timestamps are unix milliseconds, UTC. */

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function now(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncate a timestamp down to the start of its interval bucket. */
export function floorTo(timestamp: number, intervalMs: number): number {
  return timestamp - (timestamp % intervalMs);
}

export function isStale(timestamp: number, maxAgeMs: number, reference = Date.now()): boolean {
  return reference - timestamp > maxAgeMs;
}

/** Apply symmetric jitter of +/- pct to a base interval. */
export function jitter(baseMs: number, pct: number): number {
  const spread = baseMs * (pct / 100);
  return Math.max(250, Math.round(baseMs - spread + Math.random() * spread * 2));
}

/** UTC day key, e.g. "2026-08-12". Used for daily drawdown accounting. */
export function dayKey(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** ISO week key, e.g. "2026-W33". Used for the weekly breaker. */
export function weekKey(timestamp = Date.now()): string {
  const d = new Date(timestamp);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((target.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (ms < SECOND) return `${ms}ms`;
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(1)}s`;
  if (ms < HOUR) return `${(ms / MINUTE).toFixed(1)}m`;
  return `${(ms / HOUR).toFixed(1)}h`;
}

/**
 * Retry with exponential backoff and full jitter. Throws the last error once
 * attempts are exhausted — callers are expected to fail closed on that.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; maxMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 8_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      opts.onRetry?.(error, attempt);
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleep(Math.random() * backoff);
    }
  }
  throw lastError;
}
