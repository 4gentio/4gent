import { desc } from 'drizzle-orm';
import {
  DAY,
  logger,
  now,
  round,
  type AppConfig,
  type AssetSpec,
  type CandleInterval,
  type MarketSession,
  type Position,
  type Symbol_,
  type Universe,
} from '@4gent/core';
import { decisionOutcomes, trades, type Db } from '@4gent/db';
import { CandleBuilder, changePct, closes, ema, realizedVol, rsi } from './candles.js';
import { computeNavDeviation, EquityPriceService, type NavDeviation } from './equity.js';
import { marketSession } from './marketHours.js';
import type { PriceService } from './prices.js';

const log = logger('data:snapshot');

export interface AssetView {
  symbol: Symbol_;
  assetClass: AssetSpec['assetClass'];
  price: number;
  depthUsd: number;
  sector?: string;
  change: { m5: number | null; m30: number | null; h4: number | null };
  trend: { ema9: number | null; ema21: number | null; rsi14: number | null; vol20: number | null };
  nav?: {
    underlying: string;
    referencePrice: number;
    deviationBps: number;
    actionable: boolean;
    referenceFresh: boolean;
  };
  safety?: { verdict: string; riskScore: number; sellTaxBps: number | null };
}

export interface PositionView {
  symbol: Symbol_;
  assetClass: string;
  quantity: number;
  avgEntryPrice: number;
  markPrice: number;
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  pctOfNav: number;
  hardStopPrice: number;
  distanceToStopPct: number;
  ageHours: number;
  thesis: string;
  invalidation: string;
  timeHorizon: string;
  conviction: number;
  strategy: string;
}

export interface MemoryEntry {
  cycleId: number;
  symbol: string;
  action: string;
  conviction: number;
  thesis: string;
  outcome: string;
  pnl: number | null;
  agoHours: number;
}

export interface MarketSnapshot {
  takenAt: number;
  blockNumber: string;
  mode: string;
  session: { us: MarketSession; easternTime: string; minutesToChange: number };
  account: {
    nav: number;
    cash: number;
    positionsValue: number;
    investedPct: number;
    bstockExposurePct: number;
    memecoinExposurePct: number;
    openPositions: number;
    realizedPnlToday: number;
    unrealizedPnl: number;
    dayReturnPct: number;
  };
  limits: {
    maxPositionPct: number;
    maxBstockExposurePct: number;
    maxMemecoinExposurePct: number;
    maxTotalInvestedPct: number;
    maxOpenPositions: number;
    remainingRiskBudgetPct: number;
    closeOnly: boolean;
  };
  positions: PositionView[];
  assets: AssetView[];
  recentTrades: {
    symbol: string;
    side: string;
    price: number;
    notional: number;
    pnl: number | null;
    agoHours: number;
  }[];
  memory: MemoryEntry[];
  alerts: string[];
  strategyNotes: Record<string, string[]>;
}

export interface SnapshotInputs {
  config: AppConfig;
  universe: Universe;
  prices: PriceService;
  candles: CandleBuilder;
  equity: EquityPriceService;
  db: Db;
}

export interface SnapshotContext {
  positions: readonly Position[];
  cash: number;
  realizedPnlToday: number;
  navAtOpen: number;
  closeOnly: boolean;
  alerts: readonly string[];
  strategyNotes?: Record<string, string[]>;
  safetyBySymbol?: Map<Symbol_, { verdict: string; riskScore: number; sellTaxBps: number | null }>;
}

/**
 * Assembles the one object the reasoning layer sees.
 *
 * The token budget is the binding constraint: every field here has to earn its
 * place, numbers are rounded to a decision-relevant precision, and long tails
 * (full candle arrays, raw pool state) are summarised into indicators rather
 * than shipped verbatim.
 */
export class SnapshotBuilder {
  constructor(private readonly inputs: SnapshotInputs) {}

  async build(ctx: SnapshotContext): Promise<MarketSnapshot> {
    const { config, universe, prices, candles, equity } = this.inputs;
    const takenAt = now();
    const session = marketSession(takenAt);

    const marks = prices.markPrices();
    const positionViews: PositionView[] = [];
    let positionsValue = 0;
    let bstockValue = 0;
    let memecoinValue = 0;

    for (const p of ctx.positions) {
      const markPrice = marks.get(p.symbol) ?? p.avgEntryPrice;
      const marketValue = p.quantity * markPrice;
      positionsValue += marketValue;
      if (p.assetClass === 'bstock') bstockValue += marketValue;
      if (p.assetClass === 'memecoin') memecoinValue += marketValue;

      positionViews.push({
        symbol: p.symbol,
        assetClass: p.assetClass,
        quantity: round(p.quantity, 6),
        avgEntryPrice: round(p.avgEntryPrice, 8),
        markPrice: round(markPrice, 8),
        costBasis: round(p.costBasis, 2),
        marketValue: round(marketValue, 2),
        unrealizedPnl: round(marketValue - p.costBasis, 2),
        unrealizedPnlPct: p.costBasis > 0 ? round(((marketValue - p.costBasis) / p.costBasis) * 100, 2) : 0,
        pctOfNav: 0,
        hardStopPrice: round(p.hardStopPrice, 8),
        distanceToStopPct:
          markPrice > 0 ? round(((markPrice - p.hardStopPrice) / markPrice) * 100, 2) : 0,
        ageHours: round((takenAt - p.openedAt) / 3_600_000, 1),
        thesis: p.thesis,
        invalidation: p.invalidation,
        timeHorizon: p.timeHorizon,
        conviction: p.conviction,
        strategy: p.strategy,
      });
    }

    const nav = ctx.cash + positionsValue;
    for (const view of positionViews) {
      view.pctOfNav = nav > 0 ? round((view.marketValue / nav) * 100, 2) : 0;
    }

    const assets = await this.buildAssetViews(ctx, marks);
    const recentTrades = await this.recentTrades(takenAt);
    const memory = await this.memory(takenAt);

    const investedPct = nav > 0 ? (positionsValue / nav) * 100 : 0;
    const unrealizedPnl = positionViews.reduce((a, v) => a + v.unrealizedPnl, 0);

    const snapshot: MarketSnapshot = {
      takenAt,
      blockNumber: String(prices.get(assets[0]?.symbol ?? '')?.blockNumber ?? 0n),
      mode: config.mode,
      session: {
        us: session.session,
        easternTime: session.easternTime,
        minutesToChange: session.minutesToChange,
      },
      account: {
        nav: round(nav, 2),
        cash: round(ctx.cash, 2),
        positionsValue: round(positionsValue, 2),
        investedPct: round(investedPct, 2),
        bstockExposurePct: nav > 0 ? round((bstockValue / nav) * 100, 2) : 0,
        memecoinExposurePct: nav > 0 ? round((memecoinValue / nav) * 100, 2) : 0,
        openPositions: positionViews.length,
        realizedPnlToday: round(ctx.realizedPnlToday, 2),
        unrealizedPnl: round(unrealizedPnl, 2),
        dayReturnPct: ctx.navAtOpen > 0 ? round(((nav - ctx.navAtOpen) / ctx.navAtOpen) * 100, 2) : 0,
      },
      limits: {
        maxPositionPct: config.risk.maxPositionPct,
        maxBstockExposurePct: config.risk.maxBstockExposurePct,
        maxMemecoinExposurePct: config.risk.maxMemecoinExposurePct,
        maxTotalInvestedPct: config.risk.maxTotalInvestedPct,
        maxOpenPositions: config.risk.maxOpenPositions,
        remainingRiskBudgetPct: round(Math.max(0, config.risk.maxTotalInvestedPct - investedPct), 2),
        closeOnly: ctx.closeOnly,
      },
      positions: positionViews,
      assets,
      recentTrades,
      memory,
      alerts: [...ctx.alerts],
      strategyNotes: ctx.strategyNotes ?? {},
    };

    log.debug({ assets: assets.length, positions: positionViews.length }, 'snapshot built');
    return snapshot;
  }

  private async buildAssetViews(
    ctx: SnapshotContext,
    marks: Map<Symbol_, number>,
  ): Promise<AssetView[]> {
    const { universe, prices, candles, equity, config } = this.inputs;
    const tradable = universe.enabled();
    const tickers = tradable.map((a) => a.underlying).filter(Boolean) as string[];
    const quotes = tickers.length > 0 ? await equity.getMany(tickers) : new Map();

    const views: AssetView[] = [];
    for (const asset of tradable) {
      const price = marks.get(asset.symbol) ?? 0;
      if (price <= 0) continue;

      const series5m = await candles.history(asset.symbol, '5m', 60);
      const series1h = await candles.history(asset.symbol, '1h', 24);
      const c5 = closes(series5m);

      let nav: AssetView['nav'];
      if (asset.underlying) {
        const deviation: NavDeviation | null = computeNavDeviation(
          asset,
          price,
          quotes.get(asset.underlying.toUpperCase()),
          { triggerBps: config.equity.navDeviationTriggerBps, staleMs: config.equity.staleMs },
        );
        if (deviation) {
          nav = {
            underlying: deviation.underlying,
            referencePrice: round(deviation.referencePrice, 4),
            deviationBps: round(deviation.deviationBps, 1),
            actionable: deviation.actionable,
            referenceFresh: deviation.referenceFresh,
          };
        }
      }

      views.push({
        symbol: asset.symbol,
        assetClass: asset.assetClass,
        price: round(price, 8),
        depthUsd: round(prices.state(asset.symbol)?.depthUsd ?? 0, 0),
        sector: asset.sector,
        change: {
          m5: roundOrNull(changePct(series5m, 1)),
          m30: roundOrNull(changePct(series5m, 6)),
          h4: roundOrNull(changePct(series1h, 4)),
        },
        trend: {
          ema9: roundOrNull(ema(c5, 9), 6),
          ema21: roundOrNull(ema(c5, 21), 6),
          rsi14: roundOrNull(rsi(c5, 14), 1),
          vol20: roundOrNull(realizedVol(c5, 20), 5),
        },
        nav,
        safety: ctx.safetyBySymbol?.get(asset.symbol),
      });
    }
    return views;
  }

  private async recentTrades(takenAt: number): Promise<MarketSnapshot['recentTrades']> {
    const rows = await this.inputs.db
      .select()
      .from(trades)
      .orderBy(desc(trades.executedAt))
      .limit(12);
    return rows.map((t) => ({
      symbol: t.symbol,
      side: t.side,
      price: round(t.fillPrice, 8),
      notional: round(t.notional, 2),
      pnl: t.realizedPnl === null ? null : round(t.realizedPnl, 2),
      agoHours: round((takenAt - t.executedAt) / 3_600_000, 1),
    }));
  }

  /**
   * The rolling memory. Feeding the agent its own recent hit rate is what turns
   * a stateless classifier into something that can notice it has been wrong
   * about the same setup three times in a row.
   */
  private async memory(takenAt: number, limit = 20): Promise<MemoryEntry[]> {
    const rows = await this.inputs.db
      .select()
      .from(decisionOutcomes)
      .orderBy(desc(decisionOutcomes.createdAt))
      .limit(limit);
    return rows
      .filter((r) => takenAt - r.createdAt < 7 * DAY)
      .map((r) => ({
        cycleId: r.reasoningCycleId,
        symbol: r.symbol,
        action: r.action,
        conviction: r.conviction,
        thesis: r.thesis,
        outcome: r.rejectionReason ? `rejected: ${r.rejectionReason}` : r.outcome,
        pnl: r.pnl === null ? null : round(r.pnl, 2),
        agoHours: round((takenAt - r.createdAt) / 3_600_000, 1),
      }));
  }
}

function roundOrNull(value: number | null, dp = 2): number | null {
  return value === null ? null : round(value, dp);
}

/**
 * Compact wire format for the prompt. JSON with two-space indentation costs
 * roughly a third more tokens than this for no interpretive benefit.
 */
export function serializeSnapshot(snapshot: MarketSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Rough token estimate (~3.6 chars/token for dense JSON) used to guard budget. */
export function estimateTokens(serialized: string): number {
  return Math.ceil(serialized.length / 3.6);
}

/**
 * Degrades a snapshot until it fits the budget, dropping the least
 * decision-relevant fields first. The agent should never fail a cycle purely
 * because the universe grew.
 */
export function fitToBudget(snapshot: MarketSnapshot, maxTokens = 6_000): MarketSnapshot {
  let candidate = snapshot;
  if (estimateTokens(serializeSnapshot(candidate)) <= maxTokens) return candidate;

  candidate = { ...candidate, memory: candidate.memory.slice(0, 10) };
  if (estimateTokens(serializeSnapshot(candidate)) <= maxTokens) return candidate;

  candidate = { ...candidate, recentTrades: candidate.recentTrades.slice(0, 5) };
  if (estimateTokens(serializeSnapshot(candidate)) <= maxTokens) return candidate;

  // Keep held names plus the most interesting untouched ones.
  const held = new Set(candidate.positions.map((p) => p.symbol));
  const ranked = [...candidate.assets].sort((a, b) => {
    if (held.has(a.symbol) !== held.has(b.symbol)) return held.has(a.symbol) ? -1 : 1;
    const aScore = Math.abs(a.nav?.deviationBps ?? 0) + Math.abs(a.change.m30 ?? 0) * 10;
    const bScore = Math.abs(b.nav?.deviationBps ?? 0) + Math.abs(b.change.m30 ?? 0) * 10;
    return bScore - aScore;
  });
  candidate = { ...candidate, assets: ranked.slice(0, Math.max(held.size, 12)) };

  log.warn({ tokens: estimateTokens(serializeSnapshot(candidate)) }, 'snapshot degraded to fit budget');
  return candidate;
}
