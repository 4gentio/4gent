import { eq } from 'drizzle-orm';
import { formatDuration, jitter, logger, now, sleep, type LoopName } from '@4gent/core';
import { heartbeats, type Db } from '@4gent/db';

const log = logger('keeper:loop');

export interface LoopOptions {
  name: LoopName;
  intervalMs: number;
  jitterPct: number;
  /** Runs immediately on start rather than waiting a full interval. */
  runOnStart?: boolean;
  /** Consecutive failures before the loop escalates to the watchdog. */
  failureThreshold?: number;
  onError?: (error: unknown, consecutiveFailures: number) => void | Promise<void>;
}

/**
 * A supervised, self-scheduling loop.
 *
 * Each loop writes a heartbeat on every tick, jitters its own interval so the
 * three loops do not synchronise into RPC bursts, and reschedules from the end
 * of the previous run rather than on a fixed clock — a slow reasoning cycle
 * delays the next one instead of stacking on top of it.
 */
export class Loop {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private currentRun: Promise<void> | null = null;

  constructor(
    private readonly options: LoopOptions,
    private readonly task: () => Promise<void>,
    private readonly db: Db,
  ) {}

  get name(): LoopName {
    return this.options.name;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    log.info(
      { loop: this.options.name, interval: formatDuration(this.options.intervalMs) },
      'loop started',
    );
    const delay = this.options.runOnStart ? 0 : this.nextDelay();
    this.schedule(delay);
  }

  async stop(drainMs = 30_000): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.currentRun) {
      await Promise.race([this.currentRun, sleep(drainMs)]);
    }
    log.info({ loop: this.options.name }, 'loop stopped');
  }

  /** Runs the task once, out of band. Used by ops scripts and the dashboard. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentRun = this.tick().finally(() => {
        this.currentRun = null;
        this.schedule(this.nextDelay());
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private nextDelay(): number {
    return jitter(this.options.intervalMs, this.options.jitterPct);
  }

  private async tick(): Promise<void> {
    const startedAt = now();
    await this.heartbeat({ lastRunAt: startedAt });

    try {
      await this.task();
      this.consecutiveFailures = 0;
      await this.heartbeat({ lastRunAt: startedAt, lastSuccessAt: now(), consecutiveFailures: 0, note: null });
      log.debug({ loop: this.options.name, tookMs: now() - startedAt }, 'loop tick complete');
    } catch (error) {
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      await this.heartbeat({
        lastRunAt: startedAt,
        consecutiveFailures: this.consecutiveFailures,
        note: message.slice(0, 500),
      });
      log.error(
        { loop: this.options.name, consecutiveFailures: this.consecutiveFailures, err: message },
        'loop tick failed',
      );
      await this.options.onError?.(error, this.consecutiveFailures);
    }
  }

  private async heartbeat(patch: {
    lastRunAt?: number;
    lastSuccessAt?: number;
    consecutiveFailures?: number;
    note?: string | null;
  }): Promise<void> {
    const timestamp = now();
    await this.db
      .insert(heartbeats)
      .values({
        loop: this.options.name,
        lastRunAt: patch.lastRunAt ?? timestamp,
        lastSuccessAt: patch.lastSuccessAt ?? 0,
        consecutiveFailures: patch.consecutiveFailures ?? 0,
        note: patch.note ?? null,
      })
      .onConflictDoUpdate({
        target: heartbeats.loop,
        set: {
          ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
          ...(patch.lastSuccessAt !== undefined ? { lastSuccessAt: patch.lastSuccessAt } : {}),
          ...(patch.consecutiveFailures !== undefined ? { consecutiveFailures: patch.consecutiveFailures } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
        },
      });
  }

  static async read(db: Db, loop: LoopName) {
    const rows = await db.select().from(heartbeats).where(eq(heartbeats.loop, loop)).limit(1);
    return rows[0] ?? null;
  }
}
