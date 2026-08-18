import { eq } from 'drizzle-orm';
import { dayKey, HOUR, logger, now, weekKey, type AppConfig } from '@4gent/core';
import { breakers, kvGet, kvSet, type Db } from '@4gent/db';

const log = logger('risk:breakers');

export type BreakerId = 'daily_drawdown' | 'weekly_drawdown' | 'reconciliation' | 'manual';

export interface BreakerState {
  id: BreakerId;
  tripped: boolean;
  reason: string | null;
  trippedAt: number | null;
  expiresAt: number | null;
}

export interface DrawdownInput {
  nav: number;
  at?: number;
}

/**
 * Drawdown circuit breakers.
 *
 * Peaks are tracked per UTC day and per ISO week and persisted, so a restart
 * mid-drawdown does not reset the reference high and quietly re-arm the agent.
 * A tripped breaker puts the whole system into close-only mode; it does not
 * liquidate, because forced selling into the move that caused the drawdown is
 * usually the worst available action.
 */
export class BreakerRegistry {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  async state(id: BreakerId): Promise<BreakerState> {
    const rows = await this.db.select().from(breakers).where(eq(breakers.id, id)).limit(1);
    const row = rows[0];
    if (!row) return { id, tripped: false, reason: null, trippedAt: null, expiresAt: null };

    // Auto-clear once the cooldown has elapsed.
    if (row.tripped && row.expiresAt !== null && row.expiresAt <= now()) {
      await this.reset(id, 'cooldown elapsed');
      return { id, tripped: false, reason: null, trippedAt: null, expiresAt: null };
    }
    return {
      id,
      tripped: row.tripped,
      reason: row.reason,
      trippedAt: row.trippedAt,
      expiresAt: row.expiresAt,
    };
  }

  async anyTripped(): Promise<BreakerState[]> {
    const ids: BreakerId[] = ['daily_drawdown', 'weekly_drawdown', 'reconciliation', 'manual'];
    const states = await Promise.all(ids.map((id) => this.state(id)));
    return states.filter((s) => s.tripped);
  }

  /** True when new risk is forbidden. Closes and reduces remain permitted. */
  async closeOnly(): Promise<boolean> {
    return (await this.anyTripped()).length > 0;
  }

  async trip(id: BreakerId, reason: string, cooldownHours?: number): Promise<BreakerState> {
    const hours = cooldownHours ?? this.config.risk.breakerCooldownHours;
    const trippedAt = now();
    const expiresAt = trippedAt + hours * HOUR;

    await this.db
      .insert(breakers)
      .values({ id, tripped: true, reason, trippedAt, expiresAt })
      .onConflictDoUpdate({ target: breakers.id, set: { tripped: true, reason, trippedAt, expiresAt } });

    log.error({ id, reason, cooldownHours: hours }, 'circuit breaker tripped — entering close-only mode');
    return { id, tripped: true, reason, trippedAt, expiresAt };
  }

  async reset(id: BreakerId, note = 'manual reset'): Promise<void> {
    await this.db
      .insert(breakers)
      .values({ id, tripped: false, reason: note, trippedAt: null, expiresAt: null })
      .onConflictDoUpdate({ target: breakers.id, set: { tripped: false, reason: note, trippedAt: null, expiresAt: null } });
    log.warn({ id, note }, 'circuit breaker reset');
  }

  /**
   * Evaluates both drawdown breakers against the current NAV, updating the
   * tracked peaks. Call once per price loop.
   */
  async evaluateDrawdown(input: DrawdownInput): Promise<BreakerState[]> {
    const at = input.at ?? now();
    const tripped: BreakerState[] = [];

    const daily = await this.evaluateWindow('daily', dayKey(at), input.nav, this.config.risk.dailyDrawdownBreakerPct);
    if (daily) tripped.push(daily);

    const weekly = await this.evaluateWindow('weekly', weekKey(at), input.nav, this.config.risk.weeklyDrawdownBreakerPct);
    if (weekly) tripped.push(weekly);

    return tripped;
  }

  private async evaluateWindow(
    window: 'daily' | 'weekly',
    periodKey: string,
    nav: number,
    thresholdPct: number,
  ): Promise<BreakerState | null> {
    const storeKey = `peak_nav:${window}`;
    const stored = await kvGet<{ period: string; peak: number }>(this.db, storeKey);

    // A new period always resets the peak to the current NAV.
    if (!stored || stored.period !== periodKey) {
      await kvSet(this.db, storeKey, { period: periodKey, peak: nav });
      return null;
    }

    if (nav > stored.peak) {
      await kvSet(this.db, storeKey, { period: periodKey, peak: nav });
      return null;
    }

    const drawdownPct = stored.peak > 0 ? ((stored.peak - nav) / stored.peak) * 100 : 0;
    if (drawdownPct < thresholdPct) return null;

    const id: BreakerId = window === 'daily' ? 'daily_drawdown' : 'weekly_drawdown';
    const current = await this.state(id);
    if (current.tripped) return null;

    return this.trip(
      id,
      `${window} drawdown ${drawdownPct.toFixed(2)}% breached the ${thresholdPct}% limit (peak ${stored.peak.toFixed(2)}, now ${nav.toFixed(2)})`,
      window === 'weekly' ? this.config.risk.breakerCooldownHours * 3 : undefined,
    );
  }

  /** Current tracked peak, for the dashboard and snapshot alerts. */
  async peaks(): Promise<{ daily: number | null; weekly: number | null }> {
    const daily = await kvGet<{ peak: number }>(this.db, 'peak_nav:daily');
    const weekly = await kvGet<{ peak: number }>(this.db, 'peak_nav:weekly');
    return { daily: daily?.peak ?? null, weekly: weekly?.peak ?? null };
  }
}
