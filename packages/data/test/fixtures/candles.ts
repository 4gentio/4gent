import type { Candle } from '@4gent/core';

/** Deterministic synthetic series used by the indicator and strategy tests. */
export function buildSeries(
  symbol: string,
  closes: readonly number[],
  interval: Candle['interval'] = '5m',
  startMs = 1_755_000_000_000,
): Candle[] {
  const stepMs = interval === '1m' ? 60_000 : interval === '5m' ? 300_000 : 3_600_000;
  return closes.map((close, i) => {
    const prev = i === 0 ? close : closes[i - 1]!;
    return {
      symbol,
      interval,
      openTime: startMs + i * stepMs,
      open: prev,
      high: Math.max(prev, close) * 1.001,
      low: Math.min(prev, close) * 0.999,
      close,
      samples: 20,
      volumeQuote: 10_000 + i * 250,
    };
  });
}

/** A clean uptrend: every indicator should agree on direction. */
export const UPTREND = buildSeries(
  'bNVDA',
  Array.from({ length: 60 }, (_, i) => 100 + i * 0.8),
);

/** A clean downtrend. */
export const DOWNTREND = buildSeries(
  'bTSLA',
  Array.from({ length: 60 }, (_, i) => 300 - i * 1.2),
);

/** Range-bound chop: trend filters must not fire here. */
export const CHOP = buildSeries(
  'bAAPL',
  Array.from({ length: 60 }, (_, i) => 200 + Math.sin(i / 2) * 1.5),
);

/** A parabolic memecoin move followed by a sharp unwind. */
export const MEMECOIN_SPIKE = buildSeries(
  'PEPEBNB',
  [
    ...Array.from({ length: 30 }, () => 0.0000100),
    ...Array.from({ length: 12 }, (_, i) => 0.0000100 * (1 + i * 0.14)),
    ...Array.from({ length: 18 }, (_, i) => 0.0000236 * (1 - i * 0.03)),
  ],
  '1m',
);
