import type { AssetSpec, Symbol_ } from '@4gent/core';
import type { MarketSnapshot } from '@4gent/data';

/**
 * Strategies do not trade.
 *
 * Each one reads the snapshot and returns signals and constraints. The brain
 * synthesises across them and the risk layer enforces the constraints. This
 * separation is what lets a new strategy be added without touching any code
 * that can move money.
 */
export interface Signal {
  symbol: Symbol_;
  strategy: string;
  /** -1 (strongly bearish) to +1 (strongly bullish). */
  score: number;
  /** 0 to 1: how much of the evidence this strategy needs was actually present. */
  confidence: number;
  /** One line the brain reads verbatim. */
  note: string;
  /** Structured evidence, kept out of the prompt unless it is decision-relevant. */
  detail?: Record<string, number | string | boolean | null>;
}

export interface Guardrails {
  /** Ceiling on this strategy's combined exposure, as a percentage of NAV. */
  maxExposurePct: number;
  /** Horizons this strategy is willing to hold for. */
  allowedHorizons: ('scalp' | 'swing' | 'position')[];
  /** Hard stop distance appropriate to this strategy, in percent. */
  suggestedStopPct: number;
  /** Sessions in which the strategy may open new risk. */
  requiresRegularSession: boolean;
}

export interface StrategyContext {
  name: string;
  signals: Signal[];
  notes: string[];
  guardrails: Guardrails;
}

export interface Strategy {
  readonly name: string;
  readonly guardrails: Guardrails;
  /** Symbols this strategy is willing to express a view on. */
  universe(assets: readonly AssetSpec[]): Symbol_[];
  /** Produces signals from the assembled snapshot. */
  annotate(snapshot: MarketSnapshot): StrategyContext;
}

/** Clamp a raw magnitude into the -1..1 signal range with a soft knee. */
export function normalizeScore(value: number, saturateAt: number): number {
  if (saturateAt <= 0) return 0;
  const ratio = value / saturateAt;
  return Math.max(-1, Math.min(1, Math.tanh(ratio)));
}
