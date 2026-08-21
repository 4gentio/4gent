import { describe, expect, it } from 'vitest';
import type { AssetView, MarketSnapshot } from '@4gent/data';
import { MemecoinMomentumStrategy } from '../src/memecoinMomentum.js';
import { MomentumStrategy } from '../src/momentum.js';
import { NavReversionStrategy } from '../src/navReversion.js';
import { PairsStrategy } from '../src/pairs.js';
import { StrategyRegistry } from '../src/registry.js';

function asset(overrides: Partial<AssetView> = {}): AssetView {
  return {
    symbol: 'bNVDA',
    assetClass: 'bstock',
    price: 100,
    depthUsd: 250_000,
    sector: 'semis',
    change: { m5: 0.1, m30: 0.4, h4: 2.5 },
    trend: { ema9: 101, ema21: 99, rsi14: 58, vol20: 0.01 },
    ...overrides,
  };
}

function snapshot(assets: AssetView[], overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    takenAt: Date.now(),
    blockNumber: '1',
    mode: 'paper',
    session: { us: 'open', easternTime: '11:00', minutesToChange: 300 },
    account: {
      nav: 10_000, cash: 8_000, positionsValue: 2_000, investedPct: 20,
      bstockExposurePct: 20, memecoinExposurePct: 0, openPositions: 1,
      realizedPnlToday: 0, unrealizedPnl: 0, dayReturnPct: 0,
    },
    limits: {
      maxPositionPct: 5, maxBstockExposurePct: 60, maxMemecoinExposurePct: 15,
      maxTotalInvestedPct: 80, maxOpenPositions: 12, remainingRiskBudgetPct: 60, closeOnly: false,
    },
    positions: [], assets, recentTrades: [], memory: [], alerts: [], strategyNotes: {},
    ...overrides,
  };
}

describe('NavReversionStrategy', () => {
  const strategy = new NavReversionStrategy();

  it('flags a discount to NAV as bullish during the regular session', () => {
    const ctx = strategy.annotate(
      snapshot([asset({ nav: { underlying: 'NVDA', referencePrice: 101, deviationBps: -120, actionable: true, referenceFresh: true } })]),
    );
    expect(ctx.signals).toHaveLength(1);
    expect(ctx.signals[0]!.score).toBeGreaterThan(0);
  });

  it('flags a premium as bearish', () => {
    const ctx = strategy.annotate(
      snapshot([asset({ nav: { underlying: 'NVDA', referencePrice: 99, deviationBps: 130, actionable: true, referenceFresh: true } })]),
    );
    expect(ctx.signals[0]!.score).toBeLessThan(0);
  });

  it('emits nothing outside the regular session', () => {
    const ctx = strategy.annotate(
      snapshot(
        [asset({ nav: { underlying: 'NVDA', referencePrice: 101, deviationBps: -300, actionable: false, referenceFresh: true } })],
        { session: { us: 'closed', easternTime: '02:00', minutesToChange: 120 } },
      ),
    );
    expect(ctx.signals).toHaveLength(0);
    expect(ctx.notes.join(' ')).toMatch(/closed/);
  });

  it('discards a stale reference quote', () => {
    const ctx = strategy.annotate(
      snapshot([asset({ nav: { underlying: 'NVDA', referencePrice: 101, deviationBps: -200, actionable: false, referenceFresh: false } })]),
    );
    expect(ctx.signals).toHaveLength(0);
    expect(ctx.notes.join(' ')).toMatch(/stale/);
  });

  it('treats an implausible deviation as a data fault, not an opportunity', () => {
    const ctx = strategy.annotate(
      snapshot([asset({ nav: { underlying: 'NVDA', referencePrice: 101, deviationBps: -4_000, actionable: true, referenceFresh: true } })]),
    );
    expect(ctx.signals).toHaveLength(0);
    expect(ctx.notes.join(' ')).toMatch(/data fault/);
  });

  it('will not trade a deviation it cannot exit', () => {
    const ctx = strategy.annotate(
      snapshot([asset({ depthUsd: 1_000, nav: { underlying: 'NVDA', referencePrice: 101, deviationBps: -200, actionable: true, referenceFresh: true } })]),
    );
    expect(ctx.signals).toHaveLength(0);
  });
});

describe('MomentumStrategy', () => {
  const strategy = new MomentumStrategy();

  it('requires structure and direction to agree', () => {
    const agreeing = strategy.annotate(snapshot([asset()]));
    expect(agreeing.signals).toHaveLength(1);

    const conflicting = strategy.annotate(
      snapshot([asset({ trend: { ema9: 98, ema21: 101, rsi14: 55, vol20: 0.01 } })]),
    );
    expect(conflicting.signals).toHaveLength(0);
  });

  it('ignores moves inside the noise band', () => {
    const ctx = strategy.annotate(snapshot([asset({ change: { m5: 0, m30: 0.1, h4: 0.3 } })]));
    expect(ctx.signals).toHaveLength(0);
  });

  it('downgrades rather than reverses an overbought signal', () => {
    const normal = strategy.annotate(snapshot([asset()])).signals[0]!;
    const extended = strategy.annotate(
      snapshot([asset({ trend: { ema9: 101, ema21: 99, rsi14: 85, vol20: 0.01 } })]),
    ).signals[0]!;
    expect(extended.score).toBeGreaterThan(0);
    expect(extended.score).toBeLessThan(normal.score);
    expect(extended.note).toMatch(/extended/);
  });
});

describe('MemecoinMomentumStrategy', () => {
  const strategy = new MemecoinMomentumStrategy();
  const meme = (overrides: Partial<AssetView> = {}) =>
    asset({
      symbol: 'PEPEBNB',
      assetClass: 'memecoin',
      sector: undefined,
      change: { m5: 2, m30: 18, h4: 30 },
      safety: { verdict: 'pass', riskScore: 20, sellTaxBps: 100 },
      ...overrides,
    });

  it('signals on a clean burst from a token that passed triage', () => {
    const ctx = strategy.annotate(snapshot([meme()]));
    expect(ctx.signals).toHaveLength(1);
    expect(ctx.guardrails.allowedHorizons).toEqual(['scalp']);
  });

  it('refuses anything that has not passed safety triage', () => {
    const ctx = strategy.annotate(snapshot([meme({ safety: { verdict: 'uncertain', riskScore: 20, sellTaxBps: null } })]));
    expect(ctx.signals).toHaveLength(0);
    expect(ctx.notes.join(' ')).toMatch(/not tradable/);
  });

  it('refuses to chase a move that has already run', () => {
    const ctx = strategy.annotate(snapshot([meme({ change: { m5: 5, m30: 140, h4: 300 } })]));
    expect(ctx.signals).toHaveLength(0);
    expect(ctx.notes.join(' ')).toMatch(/exit liquidity/);
  });

  it('discounts a burst that is already fading', () => {
    const clean = strategy.annotate(snapshot([meme()])).signals[0]!;
    const fading = strategy.annotate(snapshot([meme({ change: { m5: -4, m30: 18, h4: 30 } })])).signals[0]!;
    expect(fading.confidence).toBeLessThan(clean.confidence);
  });
});

describe('PairsStrategy', () => {
  it('produces a paired leader and laggard view within a cohort', () => {
    const ctx = new PairsStrategy().annotate(
      snapshot([
        asset({ symbol: 'bAAPL', sector: 'big-tech', change: { m5: 0, m30: 1, h4: 3.5 } }),
        asset({ symbol: 'bMSFT', sector: 'big-tech', change: { m5: 0, m30: -1, h4: -1.2 } }),
      ]),
    );
    expect(ctx.signals).toHaveLength(2);
    expect(ctx.signals.find((s) => s.symbol === 'bAAPL')!.score).toBeGreaterThan(0);
    expect(ctx.signals.find((s) => s.symbol === 'bMSFT')!.score).toBeLessThan(0);
  });

  it('stays quiet when a cohort has not dispersed', () => {
    const ctx = new PairsStrategy().annotate(
      snapshot([
        asset({ symbol: 'bAAPL', sector: 'big-tech', change: { m5: 0, m30: 0, h4: 2.0 } }),
        asset({ symbol: 'bMSFT', sector: 'big-tech', change: { m5: 0, m30: 0, h4: 1.9 } }),
      ]),
    );
    expect(ctx.signals).toHaveLength(0);
  });
});

describe('StrategyRegistry', () => {
  it('aggregates signals into a per-symbol consensus', () => {
    const registry = new StrategyRegistry();
    const result = registry.annotate(
      snapshot([asset({ nav: { underlying: 'NVDA', referencePrice: 101, deviationBps: -150, actionable: true, referenceFresh: true } })]),
    );
    expect(result.consensus.get('bNVDA')!.contributors.length).toBeGreaterThan(1);
    expect(result.notes).toHaveProperty('bstock_nav_reversion');
  });

  it('isolates a throwing strategy instead of failing the cycle', () => {
    const broken = {
      name: 'broken',
      guardrails: { maxExposurePct: 0, allowedHorizons: [], suggestedStopPct: 0, requiresRegularSession: false },
      universe: () => [],
      annotate: () => {
        throw new Error('boom');
      },
    };
    const result = new StrategyRegistry([broken as never]).annotate(snapshot([asset()]));
    expect(result.notes.broken![0]).toMatch(/boom/);
  });
});
