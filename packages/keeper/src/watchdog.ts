import { formatDuration, logger, now, type AppConfig, type LoopName } from '@4gent/core';
import { heartbeats, type Db } from '@4gent/db';
import type { Alerter } from './alerts.js';

const log = logger('keeper:watchdog');

export interface LoopHealth {
  loop: LoopName;
  lastRunAt: number;
  lastSuccessAt: number;
  ageMs: number;
  consecutiveFailures: number;
  stalled: boolean;
  note: string | null;
}

/**
 * Supervises the supervisors.
 *
 * A loop that throws is loud and easy to notice. A loop that silently stops
 * being scheduled — a swallowed rejection, a timer cleared by a bug, an
 * unhandled await — is the dangerous case, because the agent keeps running with
 * positions open and no one watching them. The watchdog exists solely to make
 * that case noisy.
 */
export class Watchdog {
  private readonly expectations = new Map<LoopName, number>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly alerter: Alerter,
  ) {
    this.expectations.set('price', config.loops.priceMs);
    this.expectations.set('reasoning', config.loops.reasoningMs);
    this.expectations.set('reconcile', config.loops.reconcileMs);
  }

  async check(): Promise<LoopHealth[]> {
    const rows = await this.db.select().from(heartbeats);
    const at = now();
    const health: LoopHealth[] = [];

    for (const row of rows) {
      const loop = row.loop as LoopName;
      const expected = this.expectations.get(loop);
      if (expected === undefined) continue;

      const ageMs = at - row.lastSuccessAt;
      const stalled = ageMs > expected * this.config.loops.watchdogStallMultiplier;

      health.push({
        loop,
        lastRunAt: row.lastRunAt,
        lastSuccessAt: row.lastSuccessAt,
        ageMs,
        consecutiveFailures: row.consecutiveFailures,
        stalled,
        note: row.note,
      });

      if (stalled) {
        log.error(
          { loop, ageMs, expected, note: row.note },
          'loop has not succeeded within its stall window',
        );
        await this.alerter.loopStalled(loop, ageMs);
      } else if (row.consecutiveFailures >= 3) {
        await this.alerter.send(
          {
            level: 'warn',
            title: `Loop "${loop}" is failing repeatedly`,
            body: `${row.consecutiveFailures} consecutive failures. Last error: ${row.note ?? 'unknown'}`,
          },
          { dedupeKey: `failing:${loop}`, cooldownMs: 15 * 60_000 },
        );
      }
    }

    return health;
  }

  /** True when every supervised loop is inside its stall window. */
  async healthy(): Promise<boolean> {
    return (await this.check()).every((h) => !h.stalled);
  }

  static describe(health: readonly LoopHealth[]): string {
    if (health.length === 0) return 'no heartbeats recorded yet';
    return health
      .map((h) => `${h.loop}: ${h.stalled ? 'STALLED' : 'ok'} (${formatDuration(h.ageMs)} since success)`)
      .join(', ');
  }
}
