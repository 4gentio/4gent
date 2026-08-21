import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache, type Decision, type Position, type RiskLimits } from '@4gent/core';
import { exposureByClass, hardStopPrice, sizePosition, sizeReduction, slippageCapFor, type PortfolioState } from '../src/sizing.js';

resetConfigCache();
const LIMITS: RiskLimits = loadConfig({}, true).risk;

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    symbol: 'bTSLA',
    assetClass: 'bstock',
    quantityRaw: 10n ** 18n,
    quantity: 10,
    avgEntryPrice: 100,
    costBasis: 1_000,
    openedAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    strategy: 'brain_open',
    thesis: 't',
    invalidation: 'i',
    timeHorizon: 'swing',
    conviction: 3,
    hardStopPrice: 92,
    status: 'open',
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'open_long',
    symbol: 'bNVDA',
    conviction: 5,
    size_pct_of_available: 100,
    time_horizon: 'swing',
    thesis: 't',
    invalidation: 'i',
    ...overrides,
  };
}

const emptyState = (nav = 10_000, cash = 10_000): PortfolioState => ({
  nav,
  cash,
  positions: [],
  marks: new Map([['bNVDA', 200], ['bTSLA', 100]]),
});

describe('sizePosition', () => {
  it('caps a maximum-conviction request at the per-position limit', () => {
    const out = sizePosition(
      { decision: decision(), assetClass: 'bstock', price: 200, depthUsd: 1_000_000 },
      emptyState(),
      LIMITS,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.notional).toBeCloseTo(500); // 5% of 10,000 NAV
      expect(out.clamps).toContain('max_position_pct');
    }
  });

  it('scales size down with conviction', () => {
    const high = sizePosition(
      { decision: decision({ conviction: 5, size_pct_of_available: 4 }), assetClass: 'bstock', price: 200, depthUsd: 1e6 },
      emptyState(),
      LIMITS,
    );
    const low = sizePosition(
      { decision: decision({ conviction: 1, size_pct_of_available: 4 }), assetClass: 'bstock', price: 200, depthUsd: 1e6 },
      emptyState(),
      LIMITS,
    );
    expect(high.ok && low.ok && high.notional > low.notional).toBe(true);
  });

  it('refuses a symbol already at the per-position cap', () => {
    const state: PortfolioState = {
      ...emptyState(),
      positions: [position({ symbol: 'bNVDA', quantity: 5, avgEntryPrice: 200 })],
    };
    const out = sizePosition(
      { decision: decision(), assetClass: 'bstock', price: 200, depthUsd: 1e6 },
      state,
      LIMITS,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rule).toBe('max_position');
  });

  it('enforces the memecoin asset-class cap', () => {
    const state: PortfolioState = {
      nav: 10_000,
      cash: 10_000,
      positions: [position({ symbol: 'DOGEBNB', assetClass: 'memecoin', quantity: 1_490, avgEntryPrice: 1 })],
      marks: new Map([['DOGEBNB', 1], ['PEPEBNB', 1]]),
    };
    const out = sizePosition(
      { decision: decision({ symbol: 'PEPEBNB' }), assetClass: 'memecoin', price: 1, depthUsd: 1e6 },
      state,
      LIMITS,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rule).toBe('asset_class_cap');
  });

  it('clamps against available pool depth', () => {
    const out = sizePosition(
      { decision: decision(), assetClass: 'bstock', price: 200, depthUsd: 400 },
      emptyState(),
      LIMITS,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.notional).toBeCloseTo(100);
      expect(out.clamps).toContain('pool_depth');
    }
  });

  it('rejects dust-sized orders where costs dominate', () => {
    const out = sizePosition(
      { decision: decision({ size_pct_of_available: 0.05 }), assetClass: 'bstock', price: 200, depthUsd: 1e6 },
      emptyState(),
      LIMITS,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rule).toBe('min_trade_size');
  });

  it('never spends more cash than is available', () => {
    const out = sizePosition(
      { decision: decision(), assetClass: 'bstock', price: 200, depthUsd: 1e6 },
      { ...emptyState(100_000, 300), positions: [] },
      LIMITS,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.notional).toBeLessThanOrEqual(300);
  });

  it('refuses to size without a price', () => {
    const out = sizePosition(
      { decision: decision(), assetClass: 'bstock', price: 0, depthUsd: 1e6 },
      emptyState(),
      LIMITS,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rule).toBe('price_unavailable');
  });
});

describe('sizeReduction', () => {
  it('sizes a partial reduce off the existing position', () => {
    const out = sizeReduction(decision({ action: 'reduce', size_pct_of_available: 50 }), position(), 100, LIMITS);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.notional).toBeCloseTo(500);
  });

  it('promotes a dust reduce on a small position into a full close', () => {
    const small = position({ quantity: 0.4 });
    const out = sizeReduction(decision({ action: 'reduce', size_pct_of_available: 10 }), small, 100, LIMITS);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.clamps).toContain('promoted_to_full_close');
  });
});

describe('stops and caps', () => {
  it('gives memecoins a wider stop than bStocks', () => {
    expect(hardStopPrice(100, 'memecoin', LIMITS)).toBeLessThan(hardStopPrice(100, 'bstock', LIMITS));
  });

  it('gives memecoins a wider slippage cap', () => {
    expect(slippageCapFor('memecoin', LIMITS)).toBeGreaterThan(slippageCapFor('bstock', LIMITS));
  });

  it('sums exposure by asset class at mark', () => {
    const state: PortfolioState = {
      nav: 10_000,
      cash: 5_000,
      positions: [position({ quantity: 10, symbol: 'bTSLA' })],
      marks: new Map([['bTSLA', 110]]),
    };
    expect(exposureByClass(state).bstock).toBeCloseTo(1_100);
  });
});
