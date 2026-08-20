import { eq } from 'drizzle-orm';
import {
  logger,
  now,
  telegramSendResponseSchema,
  withRetry,
  type AppConfig,
} from '@4gent/core';
import { alertLog, type Db } from '@4gent/db';

const log = logger('keeper:alerts');

export type AlertLevel = 'info' | 'warn' | 'error' | 'critical';

export interface Alert {
  level: AlertLevel;
  title: string;
  body?: string;
}

const LEVEL_PREFIX: Record<AlertLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  critical: 'CRITICAL',
};

/**
 * Operator notifications.
 *
 * Every alert is written to the database first and delivered second. A Telegram
 * outage must never lose the record that a breaker tripped, and delivery
 * failures are never allowed to propagate into the trading path.
 */
export class Alerter {
  private readonly enabled: boolean;
  private readonly suppressUntil = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.enabled = Boolean(
      config.alerts.enabled && config.alerts.telegramBotToken && config.alerts.telegramChatId,
    );
    if (config.alerts.enabled && !this.enabled) {
      log.warn('alerts enabled but Telegram credentials are incomplete; falling back to log-only');
    }
  }

  async send(alert: Alert, opts: { dedupeKey?: string; cooldownMs?: number } = {}): Promise<void> {
    if (opts.dedupeKey) {
      const until = this.suppressUntil.get(opts.dedupeKey) ?? 0;
      if (until > now()) return;
      this.suppressUntil.set(opts.dedupeKey, now() + (opts.cooldownMs ?? 15 * 60_000));
    }

    const inserted = await this.db
      .insert(alertLog)
      .values({
        level: alert.level,
        channel: this.enabled ? 'telegram' : 'log',
        title: alert.title,
        body: alert.body ?? '',
        delivered: false,
        createdAt: now(),
      })
      .returning({ id: alertLog.id });

    const line = `[${LEVEL_PREFIX[alert.level]}] ${alert.title}${alert.body ? `\n${alert.body}` : ''}`;
    if (alert.level === 'critical' || alert.level === 'error') log.error(line);
    else if (alert.level === 'warn') log.warn(line);
    else log.info(line);

    if (!this.enabled) return;

    try {
      await withRetry(() => this.deliver(line), { attempts: 3, baseMs: 500 });
      const id = inserted[0]?.id;
      if (id !== undefined) {
        await this.db.update(alertLog).set({ delivered: true }).where(eq(alertLog.id, id));
      }
    } catch (error) {
      // Deliberately swallowed: alerting must never break trading.
      log.error({ err: String(error) }, 'alert delivery failed');
    }
  }

  private async deliver(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.config.alerts.telegramBotToken}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.alerts.telegramChatId,
        text: text.slice(0, 4_000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = telegramSendResponseSchema.parse(await res.json());
    if (!parsed.ok) throw new Error(parsed.description ?? 'telegram rejected the message');
  }

  // --- Convenience wrappers used across the keeper --------------------------

  async tradeFilled(args: {
    symbol: string;
    side: string;
    price: number;
    notional: number;
    pnl: number | null;
    mode: string;
  }): Promise<void> {
    const pnlLine = args.pnl === null ? '' : `\nRealised: ${args.pnl >= 0 ? '+' : ''}${args.pnl.toFixed(2)}`;
    await this.send({
      level: 'info',
      title: `${args.side.toUpperCase()} ${args.symbol} @ ${args.price.toPrecision(6)} (${args.mode})`,
      body: `Notional: ${args.notional.toFixed(2)}${pnlLine}`,
    });
  }

  async breakerTripped(id: string, reason: string): Promise<void> {
    await this.send(
      { level: 'critical', title: `Circuit breaker tripped: ${id}`, body: reason },
      { dedupeKey: `breaker:${id}`, cooldownMs: 60 * 60_000 },
    );
  }

  async loopStalled(loop: string, sinceMs: number): Promise<void> {
    await this.send(
      {
        level: 'error',
        title: `Loop "${loop}" has stalled`,
        body: `No successful run for ${Math.round(sinceMs / 1000)}s.`,
      },
      { dedupeKey: `stall:${loop}`, cooldownMs: 10 * 60_000 },
    );
  }

  async dailySummary(body: string): Promise<void> {
    await this.send({ level: 'info', title: 'Daily summary', body });
  }
}
