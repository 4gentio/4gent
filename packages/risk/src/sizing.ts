import {
  clamp,
  logger,
  type AssetClass,
  type Conviction,
  type Decision,
  type Position,
  type RiskLimits,
  type Symbol_,
} from '@4gent/core';

const log = logger('risk:sizing');

export interface PortfolioState {
  nav: number;
  cash: number;
  positions: readonly Position[];
  marks: ReadonlyMap<Symbol_, number>;
}

export interface SizingRequest {
  decision: Decision;
  assetClass: AssetClass;
  price: number;
  /** Depth available in the pool, used as an upper bound on notional. */
  depthUsd: number;
}

export type SizingOutcome =
  | { ok: true; notional: number; clamps: string[] }
  | { ok: false; reason: string; rule: string };

/**
 * Conviction curve.
 *
 * Deliberately sub-linear at the top: a conviction of 5 is worth roughly twice
 * a conviction of 1, not five times. The model is good at ranking ideas and bad
 * at calibrating how much better its best idea is than its second best.
 */
const CONVICTION_SCALE: Record<Conviction, number> = {
  1: 0.35,
  2: 0.55,
  3: 0.75,
  4: 0.9,
  5: 1.0,
};

/** Depth fraction we are willing to consume in one order. */
const MAX_DEPTH_FRACTION = 0.25;

export function exposureByClass(state: PortfolioState): Record<AssetClass, number> {
  const totals: Record<AssetClass, number> = { bstock: 0, memecoin: 0, quote: 0 };
  for (const p of state.positions) {
    const mark = state.marks.get(p.symbol) ?? p.avgEntryPrice;
    totals[p.assetClass] += p.quantity * mark;
  }
  return totals;
}

export function investedValue(state: PortfolioState): number {
  const totals = exposureByClass(state);
  return totals.bstock + totals.memecoin;
}

/**
 * Turns a proposed size percentage into a quote-asset notional, clamped by every
 * applicable limit. Returns the binding clamps so they can be logged and shown
 * back to the model in the next cycle's memory.
 */
export function sizePosition(
  req: SizingRequest,
  state: PortfolioState,
  limits: RiskLimits,
): SizingOutcome {
  const { decision, assetClass, price, depthUsd } = req;
  const clamps: string[] = [];

  if (!(price > 0)) return { ok: false, reason: 'no valid mark price', rule: 'price_unavailable' };
  if (state.nav <= 0) return { ok: false, reason: 'NAV is zero or negative', rule: 'nav_unavailable' };

  const convictionFactor = CONVICTION_SCALE[decision.conviction] ?? 0.5;
  const requestedPct = clamp(decision.size_pct_of_available, 0, 100) / 100;

  // Step 1: the model's proposal against deployable cash, scaled by conviction.
  let notional = state.cash * requestedPct * convictionFactor;

  // Step 2: per-position cap, measured against NAV and inclusive of any existing
  // exposure to the same symbol.
  const existing = state.positions.find((p) => p.symbol === decision.symbol);
  const existingValue = existing ? existing.quantity * (state.marks.get(decision.symbol) ?? price) : 0;
  const perPositionCap = state.nav * (limits.maxPositionPct / 100);
  const perPositionHeadroom = perPositionCap - existingValue;
  if (perPositionHeadroom <= 0) {
    return { ok: false, reason: `already at the ${limits.maxPositionPct}% per-position cap`, rule: 'max_position' };
  }
  if (notional > perPositionHeadroom) {
    notional = perPositionHeadroom;
    clamps.push('max_position_pct');
  }

  // Step 3: asset-class exposure cap.
  const exposure = exposureByClass(state);
  const classCapPct =
    assetClass === 'memecoin' ? limits.maxMemecoinExposurePct : limits.maxBstockExposurePct;
  const classHeadroom = state.nav * (classCapPct / 100) - exposure[assetClass];
  if (classHeadroom <= 0) {
    return { ok: false, reason: `${assetClass} exposure is at its ${classCapPct}% cap`, rule: 'asset_class_cap' };
  }
  if (notional > classHeadroom) {
    notional = classHeadroom;
    clamps.push('asset_class_cap');
  }

  // Step 4: total deployed capital cap.
  const totalHeadroom = state.nav * (limits.maxTotalInvestedPct / 100) - investedValue(state);
  if (totalHeadroom <= 0) {
    return { ok: false, reason: `portfolio is at the ${limits.maxTotalInvestedPct}% invested cap`, rule: 'max_invested' };
  }
  if (notional > totalHeadroom) {
    notional = totalHeadroom;
    clamps.push('max_total_invested');
  }

  // Step 5: never spend cash we do not have.
  if (notional > state.cash) {
    notional = state.cash;
    clamps.push('available_cash');
  }

  // Step 6: liquidity. Consuming a large share of a pool guarantees bad fills
  // on the way in and worse ones on the way out.
  const depthCap = depthUsd * MAX_DEPTH_FRACTION;
  if (depthUsd > 0 && notional > depthCap) {
    notional = depthCap;
    clamps.push('pool_depth');
  }

  // Step 7: dust floor. Below this, gas and slippage dominate the expected edge.
  if (notional < limits.minTradeUsd) {
    return {
      ok: false,
      reason: `sized notional ${notional.toFixed(2)} is below the ${limits.minTradeUsd} minimum`,
      rule: 'min_trade_size',
    };
  }

  if (clamps.length > 0) {
    log.info({ symbol: decision.symbol, notional, clamps }, 'position size clamped');
  }
  return { ok: true, notional, clamps };
}

/** Reduce sizing: a percentage of the existing position, floored at the dust limit. */
export function sizeReduction(
  decision: Decision,
  position: Position,
  markPrice: number,
  limits: RiskLimits,
): SizingOutcome {
  const pct = clamp(decision.size_pct_of_available, 0, 100) / 100;
  const quantity = position.quantity * pct;
  const notional = quantity * markPrice;

  if (notional < limits.minTradeUsd) {
    // Reducing by a dust amount is worse than not reducing; close instead.
    const fullValue = position.quantity * markPrice;
    if (fullValue <= limits.minTradeUsd * 2) {
      return { ok: true, notional: fullValue, clamps: ['promoted_to_full_close'] };
    }
    return { ok: false, reason: 'reduction below the minimum trade size', rule: 'min_trade_size' };
  }
  return { ok: true, notional, clamps: [] };
}

/**
 * Hard stop level set at entry. Memecoins get a wider band in percentage terms
 * because their normal volatility would otherwise stop every position out on
 * noise — the compensating control is a much smaller position.
 */
export function hardStopPrice(entryPrice: number, assetClass: AssetClass, limits: RiskLimits): number {
  const stopPct = assetClass === 'memecoin' ? limits.hardStopMemecoinPct : limits.hardStopBstockPct;
  return entryPrice * (1 - stopPct / 100);
}

export function slippageCapFor(assetClass: AssetClass, limits: RiskLimits): number {
  return assetClass === 'memecoin' ? limits.slippageCapMemecoinBps : limits.slippageCapBstockBps;
}
