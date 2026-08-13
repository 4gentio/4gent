import { and, asc, desc, eq, gte } from 'drizzle-orm';
import {
  CANDLE_INTERVAL_MS,
  floorTo,
  logger,
  type Candle,
  type CandleInterval,
  type PriceObservation,
  type Symbol_,
} from '@4gent/core';
import { candles, type Db } from '@4gent/db';

const log = logger('data:candles');

const INTERVALS: CandleInterval[] = ['1m', '5m', '1h'];

/**
 * Builds OHLC series locally from pool observations.
 *
 * There is no candle endpoint for a PancakeSwap pool, so the agent constructs
 * its own. Buckets are held in memory and flushed on close, which keeps the
 * write rate at one row per symbol per interval rather than one per poll.
 */
export class CandleBuilder {
  private readonly open = new Map<string, Candle>();

  constructor(private readonly db: Db) {}

  private key(symbol: Symbol_, interval: CandleInterval, openTime: number): string {
    return `${symbol}:${interval}:${openTime}`;
  }

  /** Fold a batch of observations into the open buckets, flushing closed ones. */
  async ingest(obs: readonly PriceObservation[]): Promise<Candle[]> {
    const closed: Candle[] = [];

    for (const o of obs) {
      if (!(o.price > 0)) continue;
      for (const interval of INTERVALS) {
        const bucketMs = CANDLE_INTERVAL_MS[interval];
        const openTime = floorTo(o.timestamp, bucketMs);
        const key = this.key(o.symbol, interval, openTime);
        const existing = this.open.get(key);

        if (existing) {
          existing.high = Math.max(existing.high, o.price);
          existing.low = Math.min(existing.low, o.price);
          existing.close = o.price;
          existing.samples += 1;
          continue;
        }

        // A new bucket implies every older bucket for this symbol/interval is done.
        for (const [k, candle] of this.open) {
          if (k.startsWith(`${o.symbol}:${interval}:`) && candle.openTime < openTime) {
            closed.push(candle);
            this.open.delete(k);
          }
        }

        this.open.set(key, {
          symbol: o.symbol,
          interval,
          openTime,
          open: o.price,
          high: o.price,
          low: o.price,
          close: o.price,
          samples: 1,
          volumeQuote: 0,
        });
      }
    }

    if (closed.length > 0) await this.persist(closed);
    return closed;
  }

  /** Force-flush every open bucket. Called on graceful shutdown. */
  async flush(): Promise<number> {
    const pending = [...this.open.values()];
    this.open.clear();
    if (pending.length > 0) await this.persist(pending);
    return pending.length;
  }

  private async persist(batch: readonly Candle[]): Promise<void> {
    await this.db
      .insert(candles)
      .values(
        batch.map((c) => ({
          symbol: c.symbol,
          interval: c.interval,
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          samples: c.samples,
          volumeQuote: c.volumeQuote,
        })),
      )
      .onConflictDoUpdate({
        target: [candles.symbol, candles.interval, candles.openTime],
        set: {
          high: candles.high,
          low: candles.low,
          close: candles.close,
          samples: candles.samples,
        },
      });
    log.debug({ count: batch.length }, 'candles persisted');
  }

  /** Most recent `limit` closed candles, oldest first. */
  async history(symbol: Symbol_, interval: CandleInterval, limit = 120): Promise<Candle[]> {
    const rows = await this.db
      .select()
      .from(candles)
      .where(and(eq(candles.symbol, symbol), eq(candles.interval, interval)))
      .orderBy(desc(candles.openTime))
      .limit(limit);
    return rows.reverse().map(rowToCandle);
  }

  async since(symbol: Symbol_, interval: CandleInterval, sinceMs: number): Promise<Candle[]> {
    const rows = await this.db
      .select()
      .from(candles)
      .where(and(eq(candles.symbol, symbol), eq(candles.interval, interval), gte(candles.openTime, sinceMs)))
      .orderBy(asc(candles.openTime));
    return rows.map(rowToCandle);
  }

  /** Current, still-forming bucket. Strategies use it for the live close. */
  current(symbol: Symbol_, interval: CandleInterval): Candle | undefined {
    for (const [key, candle] of this.open) {
      if (key.startsWith(`${symbol}:${interval}:`)) return candle;
    }
    return undefined;
  }
}

function rowToCandle(r: {
  symbol: string;
  interval: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number;
  volumeQuote: number;
}): Candle {
  return {
    symbol: r.symbol,
    interval: r.interval as CandleInterval,
    openTime: r.openTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    samples: r.samples,
    volumeQuote: r.volumeQuote,
  };
}

// --- Indicators computed on the local series -------------------------------

export function sma(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) acc = values[i]! * k + acc * (1 - k);
  return acc;
}

export function rsi(values: readonly number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const delta = values[i]! - values[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

/** Annualisation-free realised volatility of close-to-close returns. */
export function realizedVol(values: readonly number[], period = 20): number | null {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1]!;
    if (prev > 0) rets.push(Math.log(slice[i]! / prev));
  }
  if (rets.length === 0) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

export function closes(series: readonly Candle[]): number[] {
  return series.map((c) => c.close);
}

/** Percentage change across the last `bars` candles. */
export function changePct(series: readonly Candle[], bars: number): number | null {
  if (series.length < bars + 1) return null;
  const from = series[series.length - 1 - bars]!.close;
  const to = series[series.length - 1]!.close;
  return from === 0 ? null : ((to - from) / from) * 100;
}
