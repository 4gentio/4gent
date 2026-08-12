import { describe, expect, it } from 'vitest';
import {
  addBps,
  applyBps,
  blendCostBasis,
  bpsDiff,
  fromRaw,
  maxDrawdown,
  priceImpactBps,
  realizedPnl,
  reservesToPrice,
  sqrtPriceX96ToPrice,
  subtractBps,
  toRaw,
  v2AmountOut,
} from './math.js';

describe('bps helpers', () => {
  it('applies and subtracts basis points without drift', () => {
    expect(applyBps(1_000_000n, 60)).toBe(6_000n);
    expect(subtractBps(1_000_000n, 60)).toBe(994_000n);
    expect(addBps(1_000_000n, 60)).toBe(1_006_000n);
  });

  it('rejects fractional bps so slippage caps stay auditable', () => {
    expect(() => applyBps(1n, 12.5)).toThrow(TypeError);
  });

  it('measures signed deviation from a base price', () => {
    expect(bpsDiff(101, 100)).toBeCloseTo(100);
    expect(bpsDiff(99, 100)).toBeCloseTo(-100);
    expect(bpsDiff(1, 0)).toBe(0);
  });
});

describe('raw <-> decimal conversion', () => {
  it('round-trips 18-decimal amounts', () => {
    expect(fromRaw(1_500_000_000_000_000_000n, 18)).toBeCloseTo(1.5);
    expect(toRaw(1.5, 18)).toBe(1_500_000_000_000_000_000n);
  });

  it('truncates rather than rounds up excess precision', () => {
    expect(toRaw(1.239999999, 4)).toBe(12_400n);
    expect(toRaw(0.00001, 4)).toBe(0n);
  });

  it('handles negatives symmetrically', () => {
    expect(fromRaw(-2_000_000n, 6)).toBeCloseTo(-2);
    expect(toRaw(-2, 6)).toBe(-2_000_000n);
  });
});

describe('pool price decoding', () => {
  it('decodes a Q64.96 sqrt price to a decimal-adjusted price', () => {
    // sqrtPriceX96 for a 1:1 pool with equal decimals.
    const oneToOne = 2n ** 96n;
    expect(sqrtPriceX96ToPrice(oneToOne, 18, 18)).toBeCloseTo(1, 6);
  });

  it('derives v2 price from reserves', () => {
    expect(reservesToPrice(10n * 10n ** 18n, 2_500n * 10n ** 18n, 18, 18)).toBeCloseTo(250);
    expect(reservesToPrice(0n, 1n, 18, 18)).toBe(0);
  });

  it('computes constant-product output net of fee', () => {
    const out = v2AmountOut(10n ** 18n, 1_000n * 10n ** 18n, 1_000n * 10n ** 18n, 25);
    expect(out).toBeGreaterThan(9n * 10n ** 17n);
    expect(out).toBeLessThan(10n ** 18n);
    expect(v2AmountOut(0n, 1n, 1n, 25)).toBe(0n);
  });
});

describe('accounting', () => {
  it('blends cost basis on an add', () => {
    const blended = blendCostBasis(10, 100, 10, 120);
    expect(blended.quantity).toBe(20);
    expect(blended.avgEntryPrice).toBeCloseTo(110);
  });

  it('nets fees out of realised pnl', () => {
    expect(realizedPnl(10, 100, 110, 5)).toBeCloseTo(95);
  });

  it('finds the deepest peak-to-trough decline', () => {
    expect(maxDrawdown([100, 120, 90, 130])).toBeCloseTo(0.25);
    expect(maxDrawdown([100, 101, 102])).toBe(0);
  });

  it('reports price impact as an absolute bps figure', () => {
    expect(priceImpactBps(99, 100)).toBeCloseTo(100);
    expect(priceImpactBps(101, 100)).toBeCloseTo(100);
  });
});
