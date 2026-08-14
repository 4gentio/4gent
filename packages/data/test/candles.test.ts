import { describe, expect, it } from 'vitest';
import { changePct, closes, ema, realizedVol, rsi, sma } from '../src/candles.js';
import { CHOP, DOWNTREND, MEMECOIN_SPIKE, UPTREND } from './fixtures/candles.js';

describe('moving averages', () => {
  it('returns null until the period is filled', () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
    expect(ema([1, 2, 3], 5)).toBeNull();
  });

  it('tracks a linear uptrend with the fast average above the slow one', () => {
    const c = closes(UPTREND);
    const fast = ema(c, 9)!;
    const slow = ema(c, 21)!;
    expect(fast).toBeGreaterThan(slow);
  });

  it('inverts on a downtrend', () => {
    const c = closes(DOWNTREND);
    expect(ema(c, 9)!).toBeLessThan(ema(c, 21)!);
  });

  it('keeps fast and slow averages close together in a range', () => {
    const c = closes(CHOP);
    const spread = Math.abs(ema(c, 9)! - ema(c, 21)!) / ema(c, 21)!;
    expect(spread).toBeLessThan(0.01);
  });
});

describe('rsi', () => {
  it('pins to 100 when there are no losing bars', () => {
    expect(rsi(closes(UPTREND), 14)).toBe(100);
  });

  it('reads deeply oversold on a monotonic decline', () => {
    expect(rsi(closes(DOWNTREND), 14)!).toBeLessThan(5);
  });

  it('sits mid-range in chop', () => {
    const value = rsi(closes(CHOP), 14)!;
    expect(value).toBeGreaterThan(20);
    expect(value).toBeLessThan(80);
  });
});

describe('realised volatility', () => {
  it('is near zero for a flat prefix and elevated after a spike', () => {
    const c = closes(MEMECOIN_SPIKE);
    const flat = realizedVol(c.slice(0, 25), 20)!;
    const spiky = realizedVol(c.slice(0, 45), 20)!;
    expect(flat).toBeLessThan(1e-9);
    expect(spiky).toBeGreaterThan(flat);
  });
});

describe('changePct', () => {
  it('measures the move across a lookback window', () => {
    expect(changePct(UPTREND, 10)).toBeGreaterThan(0);
    expect(changePct(DOWNTREND, 10)).toBeLessThan(0);
    expect(changePct(UPTREND, 999)).toBeNull();
  });
});
