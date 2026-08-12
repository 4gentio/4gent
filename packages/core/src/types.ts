/**
 * Domain vocabulary shared by every package. Nothing here imports from another
 * workspace package — `core` is the root of the dependency graph.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Ticker used throughout the system, e.g. "bTSLA" or "SHIBNB". */
export type Symbol_ = string;

export type AssetClass = 'bstock' | 'memecoin' | 'quote';

export type ExecutionMode = 'paper' | 'live';

export type DexVersion = 'v3' | 'v2';

export type Side = 'buy' | 'sell';

export type TimeHorizon = 'scalp' | 'swing' | 'position';

export type Conviction = 1 | 2 | 3 | 4 | 5;

export type DecisionAction = 'open_long' | 'close' | 'reduce' | 'add' | 'hold';

/** A tradable asset in the configured universe. */
export interface AssetSpec {
  symbol: Symbol_;
  assetClass: AssetClass;
  address: Address;
  decimals: number;
  /** Pool this asset is quoted against (always vs the quote asset). */
  pool: PoolSpec;
  /** For bStocks: the underlying equity ticker used for NAV comparison. */
  underlying?: string;
  /** Multiplier between one bStock token and one share of the underlying. */
  navRatio?: number;
  /** Free-form tag used for sector cohorts in the pairs strategy. */
  sector?: string;
  enabled: boolean;
}

export interface PoolSpec {
  address: Address;
  version: DexVersion;
  /** v3 only: fee tier in hundredths of a bip (e.g. 500 = 0.05%). */
  feeTier?: number;
  token0: Address;
  token1: Address;
  token0Decimals: number;
  token1Decimals: number;
  /** True when the traded asset is token0 and the quote asset is token1. */
  assetIsToken0: boolean;
}

/** A price observation taken directly from pool state. */
export interface PriceObservation {
  symbol: Symbol_;
  /** Price of one asset unit denominated in the quote asset. */
  price: number;
  /** Block the observation was read at. */
  blockNumber: bigint;
  /** Unix milliseconds the observation was recorded. */
  timestamp: number;
  /** Estimated depth (quote-asset notional) available within 100 bps. */
  depthUsd: number;
  source: 'pool_v3' | 'pool_v2' | 'paper';
}

export interface Candle {
  symbol: Symbol_;
  interval: CandleInterval;
  /** Bucket start, unix milliseconds. */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Number of observations folded into this bucket. */
  samples: number;
  /** Traded volume in quote units, when derivable from swap logs. */
  volumeQuote: number;
}

export type CandleInterval = '1m' | '5m' | '1h';

export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
};

export interface EquityQuote {
  ticker: string;
  price: number;
  /** Unix milliseconds the upstream provider stamped the quote. */
  quotedAt: number;
  /** Unix milliseconds we fetched it. */
  fetchedAt: number;
  provider: string;
  currency: 'USD';
}

export type MarketSession = 'pre' | 'open' | 'post' | 'closed' | 'holiday';

export interface Position {
  id: number;
  symbol: Symbol_;
  assetClass: AssetClass;
  /** Base units held (raw token amount, not decimal-adjusted). */
  quantityRaw: bigint;
  /** Decimal-adjusted quantity, for display and math. */
  quantity: number;
  /** Average entry price in quote units. */
  avgEntryPrice: number;
  /** Quote-asset notional currently at risk. */
  costBasis: number;
  openedAt: number;
  updatedAt: number;
  strategy: string;
  thesis: string;
  invalidation: string;
  timeHorizon: TimeHorizon;
  conviction: Conviction;
  /** Hard stop price computed at open by the risk layer. */
  hardStopPrice: number;
  status: 'open' | 'closed';
}

export interface Trade {
  id: number;
  symbol: Symbol_;
  side: Side;
  /** Realised fill price in quote units per asset unit. */
  fillPrice: number;
  quantity: number;
  quantityRaw: bigint;
  notional: number;
  feeQuote: number;
  gasQuote: number;
  txHash: Hex | null;
  mode: ExecutionMode;
  slippageBps: number;
  strategy: string;
  reasoningCycleId: number | null;
  executedAt: number;
  realizedPnl: number | null;
}

export interface NavPoint {
  timestamp: number;
  /** Total account value in quote units. */
  nav: number;
  cash: number;
  positionsValue: number;
  unrealizedPnl: number;
  realizedPnlToDate: number;
}

/** A single actionable instruction after risk has clamped the brain's proposal. */
export interface Order {
  symbol: Symbol_;
  assetClass: AssetClass;
  side: Side;
  /** Quote-asset notional to spend (buy) or asset units to sell. */
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
  minAmountOut: bigint;
  slippageBps: number;
  strategy: string;
  reasoningCycleId: number | null;
  reason: string;
}

export interface Quote {
  symbol: Symbol_;
  amountIn: bigint;
  amountOut: bigint;
  /** Implied execution price in quote units per asset unit. */
  executionPrice: number;
  /** Mid price from pool state at quote time. */
  midPrice: number;
  priceImpactBps: number;
  route: RouteLeg[];
  quotedAt: number;
}

export interface RouteLeg {
  pool: Address;
  version: DexVersion;
  feeTier?: number;
  tokenIn: Address;
  tokenOut: Address;
}

export interface FillResult {
  txHash: Hex | null;
  amountIn: bigint;
  amountOut: bigint;
  fillPrice: number;
  gasQuote: number;
  feeQuote: number;
  slippageBps: number;
  blockNumber: bigint | null;
  mode: ExecutionMode;
}

export type LoopName = 'price' | 'reasoning' | 'reconcile' | 'watchdog';

export interface Heartbeat {
  loop: LoopName;
  lastRunAt: number;
  lastSuccessAt: number;
  consecutiveFailures: number;
  note: string | null;
}

export class FailClosedError extends Error {
  readonly cause_: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FailClosedError';
    this.cause_ = cause;
  }
}

export class RiskRejectionError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = 'RiskRejectionError';
    this.rule = rule;
  }
}
