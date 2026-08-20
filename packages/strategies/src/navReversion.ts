import type { AssetSpec, Symbol_ } from '@4gent/core';
import type { MarketSnapshot } from '@4gent/data';
import { normalizeScore, type Guardrails, type Signal, type Strategy, type StrategyContext } from './types.js';

export interface NavReversionOptions {
  /** Deviation at which the signal saturates, in bps. */
  saturationBps: number;
  /** Minimum pool depth required before a deviation is tradable. */
  minDepthUsd: number;
  /** Deviations beyond this are treated as broken data, not opportunity. */
  absurdityBps: number;
  maxExposurePct: number;
}

export const DEFAULT_NAV_OPTIONS: NavReversionOptions = {
  saturationBps: 250,
  minDepthUsd: 20_000,
  absurdityBps: 1_500,
  maxExposurePct: 35,
};

/**
 * bStock NAV mean-reversion.
 *
 * The premise is narrow and therefore reliable: while the underlying equity is
 * trading, a tokenized claim on that equity should track it. When it does not,
 * there is a mechanical convergence path.
 *
 * Two guards matter more than the signal itself. Deviation outside the regular
 * session is discarded rather than traded, because the pool is legitimately
 * pricing overnight risk. And an implausibly large deviation is treated as a
 * data fault — a stale reference quote or a broken pool — not as free money.
 */
export class NavReversionStrategy implements Strategy {
  readonly name = 'bstock_nav_reversion';

  readonly guardrails: Guardrails;

  constructor(private readonly options: NavReversionOptions = DEFAULT_NAV_OPTIONS) {
    this.guardrails = {
      maxExposurePct: options.maxExposurePct,
      allowedHorizons: ['scalp', 'swing'],
      suggestedStopPct: 6,
      requiresRegularSession: true,
    };
  }

  universe(assets: readonly AssetSpec[]): Symbol_[] {
    return assets.filter((a) => a.assetClass === 'bstock' && a.underlying).map((a) => a.symbol);
  }

  annotate(snapshot: MarketSnapshot): StrategyContext {
    const signals: Signal[] = [];
    const notes: string[] = [];

    if (snapshot.session.us !== 'open') {
      notes.push(
        `US session is ${snapshot.session.us}; NAV deviations are expected and not treated as signal.`,
      );
      return { name: this.name, signals, notes, guardrails: this.guardrails };
    }

    for (const asset of snapshot.assets) {
      if (asset.assetClass !== 'bstock' || !asset.nav) continue;
      const { deviationBps, referenceFresh, referencePrice, underlying } = asset.nav;

      if (!referenceFresh) {
        notes.push(`${asset.symbol}: reference quote for ${underlying} is stale; deviation ignored.`);
        continue;
      }
      if (Math.abs(deviationBps) > this.options.absurdityBps) {
        notes.push(
          `${asset.symbol}: deviation of ${deviationBps.toFixed(0)}bps is implausible; treating as a data fault.`,
        );
        continue;
      }
      if (asset.depthUsd < this.options.minDepthUsd) {
        notes.push(
          `${asset.symbol}: only ${Math.round(asset.depthUsd)} of depth, below the ${this.options.minDepthUsd} floor for a convergence trade.`,
        );
        continue;
      }

      // A discount to NAV is bullish, so the sign inverts.
      const score = normalizeScore(-deviationBps, this.options.saturationBps);
      const magnitude = Math.abs(deviationBps);
      const confidence = Math.min(1, magnitude / this.options.saturationBps) * (asset.nav.actionable ? 1 : 0.5);

      if (magnitude < 25) continue;

      signals.push({
        symbol: asset.symbol,
        strategy: this.name,
        score,
        confidence,
        note:
          deviationBps < 0
            ? `${asset.symbol} trades ${Math.abs(deviationBps).toFixed(0)}bps below ${underlying} NAV (${referencePrice}) with the session open.`
            : `${asset.symbol} trades ${deviationBps.toFixed(0)}bps above ${underlying} NAV (${referencePrice}); rich, favour reducing.`,
        detail: {
          deviationBps,
          referencePrice,
          depthUsd: asset.depthUsd,
          minutesToClose: snapshot.session.minutesToChange,
          actionable: asset.nav.actionable,
        },
      });
    }

    if (snapshot.session.minutesToChange <= 20) {
      notes.push('Under 20 minutes to the US close; convergence may not complete before the session ends.');
    }

    return { name: this.name, signals, notes, guardrails: this.guardrails };
  }
}
