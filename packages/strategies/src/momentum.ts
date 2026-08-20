import type { AssetSpec, Symbol_ } from '@4gent/core';
import type { AssetView, MarketSnapshot } from '@4gent/data';
import { normalizeScore, type Guardrails, type Signal, type Strategy, type StrategyContext } from './types.js';

export interface MomentumOptions {
  /** Minimum 4h move required before a trend is considered established. */
  minTrendPct: number;
  /** RSI above this is treated as extended rather than strong. */
  rsiOverbought: number;
  /** RSI below this is treated as capitulation rather than weakness. */
  rsiOversold: number;
  maxExposurePct: number;
}

export const DEFAULT_MOMENTUM_OPTIONS: MomentumOptions = {
  minTrendPct: 1.2,
  rsiOverbought: 72,
  rsiOversold: 28,
  maxExposurePct: 40,
};

/**
 * bStock multi-timeframe momentum.
 *
 * Requires agreement across timeframes: the fast/slow EMA relationship supplies
 * structure, the 4h change supplies direction, and RSI is used only to veto —
 * an extended reading downgrades an otherwise valid signal rather than creating
 * a contrarian one. Chasing an exhausted move is the dominant failure mode of a
 * naive momentum rule, so it is priced in here rather than left to the model.
 */
export class MomentumStrategy implements Strategy {
  readonly name = 'bstock_momentum';

  readonly guardrails: Guardrails;

  constructor(private readonly options: MomentumOptions = DEFAULT_MOMENTUM_OPTIONS) {
    this.guardrails = {
      maxExposurePct: options.maxExposurePct,
      allowedHorizons: ['swing', 'position'],
      suggestedStopPct: 8,
      requiresRegularSession: false,
    };
  }

  universe(assets: readonly AssetSpec[]): Symbol_[] {
    return assets.filter((a) => a.assetClass === 'bstock').map((a) => a.symbol);
  }

  annotate(snapshot: MarketSnapshot): StrategyContext {
    const signals: Signal[] = [];
    const notes: string[] = [];

    for (const asset of snapshot.assets) {
      if (asset.assetClass !== 'bstock') continue;
      const evaluated = this.evaluate(asset);
      if (!evaluated) continue;
      signals.push(evaluated);
    }

    if (signals.length === 0) {
      notes.push('No bStock shows multi-timeframe trend agreement right now.');
    }
    if (snapshot.session.us !== 'open') {
      notes.push(
        `Underlying market is ${snapshot.session.us}; bStock trends can continue but liquidity is thinner and gaps are more likely.`,
      );
    }

    return { name: this.name, signals, notes, guardrails: this.guardrails };
  }

  private evaluate(asset: AssetView): Signal | null {
    const { ema9, ema21, rsi14 } = asset.trend;
    const h4 = asset.change.h4;
    if (ema9 === null || ema21 === null || h4 === null) return null;

    const structure = (ema9 - ema21) / ema21;
    const structureAgrees = Math.sign(structure) === Math.sign(h4);
    if (!structureAgrees) return null;
    if (Math.abs(h4) < this.options.minTrendPct) return null;

    let score = normalizeScore(h4, this.options.minTrendPct * 4);
    let confidence = Math.min(1, Math.abs(h4) / (this.options.minTrendPct * 3));
    const reasons: string[] = [
      `${asset.symbol} 4h ${h4 > 0 ? '+' : ''}${h4.toFixed(2)}% with EMA9 ${ema9 > ema21 ? 'above' : 'below'} EMA21`,
    ];

    // RSI vetoes an extended move rather than reversing the signal.
    if (rsi14 !== null) {
      if (score > 0 && rsi14 > this.options.rsiOverbought) {
        score *= 0.4;
        confidence *= 0.5;
        reasons.push(`RSI ${rsi14.toFixed(0)} is extended, so the entry is late`);
      } else if (score < 0 && rsi14 < this.options.rsiOversold) {
        score *= 0.4;
        confidence *= 0.5;
        reasons.push(`RSI ${rsi14.toFixed(0)} suggests capitulation rather than fresh weakness`);
      } else {
        reasons.push(`RSI ${rsi14.toFixed(0)} confirms`);
      }
    }

    // A pool too thin to exit is not a tradable trend.
    if (asset.depthUsd < 15_000) {
      confidence *= 0.4;
      reasons.push('depth is thin for the size this signal would justify');
    }

    return {
      symbol: asset.symbol,
      strategy: this.name,
      score,
      confidence,
      note: `${reasons.join('; ')}.`,
      detail: {
        h4ChangePct: h4,
        emaSpreadPct: structure * 100,
        rsi14,
        depthUsd: asset.depthUsd,
      },
    };
  }
}
