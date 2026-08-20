import type { AssetSpec, Symbol_ } from '@4gent/core';
import type { MarketSnapshot } from '@4gent/data';
import { normalizeScore, type Guardrails, type Signal, type Strategy, type StrategyContext } from './types.js';

export interface MemecoinOptions {
  /** 30m move required to call it an expansion rather than noise. */
  minBurstPct: number;
  /** Above this, the move is late and the risk is being exit liquidity. */
  maxChasePct: number;
  minDepthUsd: number;
  /** Safety risk score above which the name is annotated but never favoured. */
  maxRiskScore: number;
  maxExposurePct: number;
}

export const DEFAULT_MEMECOIN_OPTIONS: MemecoinOptions = {
  minBurstPct: 8,
  maxChasePct: 60,
  minDepthUsd: 30_000,
  maxRiskScore: 40,
  maxExposurePct: 12,
};

/**
 * Memecoin momentum.
 *
 * Everything about this strategy is shaped by one fact: the distribution has a
 * fat left tail that the price series does not show in advance. So the edge is
 * not in prediction, it is in constraints — scalp horizon only, small size, a
 * hard requirement that the token already cleared safety triage, and an
 * explicit upper bound on how far into a move it will still enter.
 */
export class MemecoinMomentumStrategy implements Strategy {
  readonly name = 'memecoin_momentum';

  readonly guardrails: Guardrails;

  constructor(private readonly options: MemecoinOptions = DEFAULT_MEMECOIN_OPTIONS) {
    this.guardrails = {
      maxExposurePct: options.maxExposurePct,
      allowedHorizons: ['scalp'],
      suggestedStopPct: 20,
      requiresRegularSession: false,
    };
  }

  universe(assets: readonly AssetSpec[]): Symbol_[] {
    return assets.filter((a) => a.assetClass === 'memecoin').map((a) => a.symbol);
  }

  annotate(snapshot: MarketSnapshot): StrategyContext {
    const signals: Signal[] = [];
    const notes: string[] = [];

    for (const asset of snapshot.assets) {
      if (asset.assetClass !== 'memecoin') continue;

      if (!asset.safety || asset.safety.verdict !== 'pass') {
        notes.push(`${asset.symbol}: safety verdict is ${asset.safety?.verdict ?? 'unknown'}; not tradable.`);
        continue;
      }
      if (asset.safety.riskScore > this.options.maxRiskScore) {
        notes.push(
          `${asset.symbol}: risk score ${asset.safety.riskScore} exceeds the ${this.options.maxRiskScore} threshold for a momentum entry.`,
        );
        continue;
      }
      if (asset.depthUsd < this.options.minDepthUsd) {
        notes.push(`${asset.symbol}: ${Math.round(asset.depthUsd)} depth is too thin to exit cleanly.`);
        continue;
      }

      const burst = asset.change.m30;
      const recent = asset.change.m5;
      if (burst === null) continue;

      if (burst < this.options.minBurstPct) continue;

      if (burst > this.options.maxChasePct) {
        notes.push(
          `${asset.symbol}: up ${burst.toFixed(0)}% in 30m — past the ${this.options.maxChasePct}% chase limit, entering here is providing exit liquidity.`,
        );
        continue;
      }

      let score = normalizeScore(burst, this.options.maxChasePct / 2);
      let confidence = Math.min(1, burst / (this.options.minBurstPct * 3));
      const reasons = [`${asset.symbol} +${burst.toFixed(1)}% over 30m on a name that cleared safety triage`];

      // A move already rolling over is a failed breakout, not a continuation.
      if (recent !== null && recent < 0) {
        score *= 0.35;
        confidence *= 0.4;
        reasons.push(`last 5m is ${recent.toFixed(1)}%, so the burst is already fading`);
      }

      const vol = asset.trend.vol20;
      if (vol !== null && vol > 0.08) {
        confidence *= 0.6;
        reasons.push('realised volatility is extreme even by memecoin standards');
      }

      signals.push({
        symbol: asset.symbol,
        strategy: this.name,
        score,
        confidence,
        note: `${reasons.join('; ')}. Scalp only, tight invalidation.`,
        detail: {
          burst30mPct: burst,
          change5mPct: recent,
          depthUsd: asset.depthUsd,
          riskScore: asset.safety.riskScore,
          sellTaxBps: asset.safety.sellTaxBps,
        },
      });
    }

    if (snapshot.account.memecoinExposurePct >= snapshot.limits.maxMemecoinExposurePct * 0.8) {
      notes.push(
        `Memecoin exposure is at ${snapshot.account.memecoinExposurePct}% of a ${snapshot.limits.maxMemecoinExposurePct}% cap; little room remains.`,
      );
    }

    return { name: this.name, signals, notes, guardrails: this.guardrails };
  }
}
