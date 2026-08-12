/**
 * Deterministic numeric helpers. Every value that ends up on-chain is a bigint;
 * every value the brain reads is a plain number. These functions are the only
 * sanctioned bridge between the two representations.
 */

export const BPS_DENOMINATOR = 10_000n;

/** Multiply a raw amount by a basis-point fraction, rounding down. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps)) throw new TypeError(`bps must be an integer, got ${bps}`);
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Reduce an amount by `bps` (used for minAmountOut from a slippage cap). */
export function subtractBps(amount: bigint, bps: number): bigint {
  return amount - applyBps(amount, bps);
}

/** Increase an amount by `bps` (used for maxAmountIn on exact-out routes). */
export function addBps(amount: bigint, bps: number): bigint {
  return amount + applyBps(amount, bps);
}

/** Signed difference between two prices expressed in basis points of `base`. */
export function bpsDiff(value: number, base: number): number {
  if (base === 0) return 0;
  return ((value - base) / base) * 10_000;
}

/** Convert a raw token amount into a decimal number. Precision-safe to 1e-12. */
export function fromRaw(raw: bigint, decimals: number): number {
  if (decimals === 0) return Number(raw);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const value = Number(whole) + Number(frac) / Number(base);
  return negative ? -value : value;
}

/** Convert a decimal number into a raw token amount, truncating excess digits. */
export function toRaw(value: number, decimals: number): bigint {
  if (!Number.isFinite(value)) throw new TypeError(`toRaw received ${value}`);
  const negative = value < 0;
  const abs = Math.abs(value);
  const [whole = '0', frac = ''] = abs.toFixed(Math.min(decimals, 18)).split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return negative ? -raw : raw;
}

/**
 * PancakeSwap v3 encodes price as sqrt(token1/token0) in Q64.96 fixed point.
 * Returns the price of token0 denominated in token1, decimal-adjusted.
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  const Q96 = 2n ** 96n;
  // Scale before squaring so we keep precision without floating through 2^192.
  const SCALE = 10n ** 18n;
  const scaled = (sqrtPriceX96 * SCALE) / Q96;
  const ratio = Number(scaled) / 1e18;
  const price = ratio * ratio;
  return price * 10 ** (token0Decimals - token1Decimals);
}

/** Price of token0 in token1 from v2 reserves, decimal-adjusted. */
export function reservesToPrice(
  reserve0: bigint,
  reserve1: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  if (reserve0 === 0n) return 0;
  const r0 = fromRaw(reserve0, token0Decimals);
  const r1 = fromRaw(reserve1, token1Decimals);
  return r0 === 0 ? 0 : r1 / r0;
}

/** Constant-product output for a v2 pool, given a fee in basis points. */
export function v2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInAfterFee = amountIn * BigInt(10_000 - feeBps);
  const numerator = amountInAfterFee * reserveOut;
  const denominator = reserveIn * 10_000n + amountInAfterFee;
  return numerator / denominator;
}

/** Price impact of a fill relative to the pre-trade mid, in basis points. */
export function priceImpactBps(executionPrice: number, midPrice: number): number {
  if (midPrice === 0) return 0;
  return Math.abs(bpsDiff(executionPrice, midPrice));
}

/**
 * Weighted-average cost basis update on an add. Returns the new average entry
 * price and the new total quantity.
 */
export function blendCostBasis(
  existingQty: number,
  existingAvg: number,
  addQty: number,
  addPrice: number,
): { quantity: number; avgEntryPrice: number } {
  const quantity = existingQty + addQty;
  if (quantity <= 0) return { quantity: 0, avgEntryPrice: 0 };
  const avgEntryPrice = (existingQty * existingAvg + addQty * addPrice) / quantity;
  return { quantity, avgEntryPrice };
}

/** Realised PnL for a partial or full close against an average cost basis. */
export function realizedPnl(
  closedQty: number,
  avgEntryPrice: number,
  exitPrice: number,
  fees: number,
): number {
  return closedQty * (exitPrice - avgEntryPrice) - fees;
}

/** Unrealised PnL for an open position at a mark price. */
export function unrealizedPnl(qty: number, avgEntryPrice: number, markPrice: number): number {
  return qty * (markPrice - avgEntryPrice);
}

/** Maximum peak-to-trough decline of a NAV series, as a positive fraction. */
export function maxDrawdown(series: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = (peak - value) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/** Simple (not annualised) return series from a NAV series. */
export function returnsFromNav(series: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]!;
    const curr = series[i]!;
    out.push(prev === 0 ? 0 : (curr - prev) / prev);
  }
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, dp = 6): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
