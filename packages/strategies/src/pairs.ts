import type { AssetSpec, Symbol_ } from '@4gent/core';
import type { AssetView, MarketSnapshot } from '@4gent/data';
import { normalizeScore, type Guardrails, type Signal, type Strategy, type StrategyContext } from './types.js';

export interface PairsOptions {
  /** Minimum dispersion within a cohort before relative value is meaningful. */
  minDispersionPct: number;
  /** Cohorts smaller than this cannot support a relative view. */
  minCohortSize: number;
  maxExposurePct: number;
}

export const DEFAULT_PAIRS_OPTIONS: PairsOptions = {
  minDispersionPct: 1.5,
  minCohortSize: 2,
  maxExposurePct: 25,
};

/**
 * Sector-relative value.
 *
 * Rather than taking an outright view, this ranks names inside a sector cohort
 * and expresses a preference for the leader over the laggard. It is the only
 * strategy here that produces a paired bullish and bearish signal, which gives
 * the brain a way to rotate exposure without changing gross risk.
 */
export class PairsStrategy implements Strategy {
  readonly name = 'sector_relative_value';

  readonly guardrails: Guardrails;

  constructor(private readonly options: PairsOptions = DEFAULT_PAIRS_OPTIONS) {
    this.guardrails = {
      maxExposurePct: options.maxExposurePct,
      allowedHorizons: ['swing', 'position'],
      suggestedStopPct: 7,
      requiresRegularSession: true,
    };
  }

  universe(assets: readonly AssetSpec[]): Symbol_[] {
    const cohorts = new Map<string, Symbol_[]>();
    for (const asset of assets) {
      if (asset.assetClass !== 'bstock' || !asset.sector) continue;
      const list = cohorts.get(asset.sector) ?? [];
      list.push(asset.symbol);
      cohorts.set(asset.sector, list);
    }
    return [...cohorts.values()].filter((c) => c.length >= this.options.minCohortSize).flat();
  }

  annotate(snapshot: MarketSnapshot): StrategyContext {
    const signals: Signal[] = [];
    const notes: string[] = [];

    const cohorts = new Map<string, AssetView[]>();
    for (const asset of snapshot.assets) {
      if (asset.assetClass !== 'bstock' || !asset.sector) continue;
      if (asset.change.h4 === null) continue;
      const list = cohorts.get(asset.sector) ?? [];
      list.push(asset);
      cohorts.set(asset.sector, list);
    }

    for (const [sector, members] of cohorts) {
      if (members.length < this.options.minCohortSize) continue;

      const ranked = [...members].sort((a, b) => (b.change.h4 ?? 0) - (a.change.h4 ?? 0));
      const leader = ranked[0]!;
      const laggard = ranked[ranked.length - 1]!;
      const dispersion = (leader.change.h4 ?? 0) - (laggard.change.h4 ?? 0);

      if (dispersion < this.options.minDispersionPct) {
        notes.push(
          `${sector}: dispersion of ${dispersion.toFixed(2)}% is inside the noise band; no relative view.`,
        );
        continue;
      }

      const strength = normalizeScore(dispersion, this.options.minDispersionPct * 4);
      const confidence = Math.min(1, dispersion / (this.options.minDispersionPct * 3));

      signals.push({
        symbol: leader.symbol,
        strategy: this.name,
        score: strength,
        confidence,
        note: `${leader.symbol} leads the ${sector} cohort by ${dispersion.toFixed(2)}% over 4h; prefer it for added exposure.`,
        detail: { sector, role: 'leader', dispersionPct: dispersion, h4ChangePct: leader.change.h4 },
      });

      signals.push({
        symbol: laggard.symbol,
        strategy: this.name,
        score: -strength,
        confidence,
        note: `${laggard.symbol} lags the ${sector} cohort by ${dispersion.toFixed(2)}% over 4h; prefer reducing it before adding elsewhere.`,
        detail: { sector, role: 'laggard', dispersionPct: dispersion, h4ChangePct: laggard.change.h4 },
      });
    }

    return { name: this.name, signals, notes, guardrails: this.guardrails };
  }
}
