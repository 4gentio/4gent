import { desc, gte } from 'drizzle-orm';
import { DAY, maxDrawdown, returnsFromNav, round, type NavPoint } from '@4gent/core';
import { navHistory, trades, type Db } from '@4gent/db';

/**
 * Performance reporting. These numbers exist to be looked at by a human and by
 * the model's rolling memory, not to be traded on, so they favour legibility
 * over statistical sophistication.
 */
export interface PerformanceReport {
  navStart: number;
  navEnd: number;
  totalReturnPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRatePct: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  feesPaid: number;
  gasPaid: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  byStrategy: Record<string, { trades: number; pnl: number; winRatePct: number }>;
  bySymbol: Record<string, { trades: number; pnl: number }>;
}

export class MetricsService {
  constructor(private readonly db: Db) {}

  async report(sinceMs = Date.now() - 30 * DAY): Promise<PerformanceReport> {
    const navRows = await this.db
      .select()
      .from(navHistory)
      .where(gte(navHistory.recordedAt, sinceMs))
      .orderBy(navHistory.recordedAt);
    const tradeRows = await this.db.select().from(trades).where(gte(trades.executedAt, sinceMs));

    const navSeries = navRows.map((r) => r.nav);
    const navStart = navSeries[0] ?? 0;
    const navEnd = navSeries[navSeries.length - 1] ?? navStart;

    const closed = tradeRows.filter((t) => t.realizedPnl !== null);
    const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.realizedPnl ?? 0) < 0);

    const grossWin = wins.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.realizedPnl ?? 0), 0));

    const byStrategy: PerformanceReport['byStrategy'] = {};
    for (const t of closed) {
      const bucket = (byStrategy[t.strategy] ??= { trades: 0, pnl: 0, winRatePct: 0 });
      bucket.trades += 1;
      bucket.pnl += t.realizedPnl ?? 0;
    }
    for (const [name, bucket] of Object.entries(byStrategy)) {
      const strategyWins = closed.filter((t) => t.strategy === name && (t.realizedPnl ?? 0) > 0).length;
      bucket.pnl = round(bucket.pnl, 2);
      bucket.winRatePct = bucket.trades > 0 ? round((strategyWins / bucket.trades) * 100, 1) : 0;
    }

    const bySymbol: PerformanceReport['bySymbol'] = {};
    for (const t of closed) {
      const bucket = (bySymbol[t.symbol] ??= { trades: 0, pnl: 0 });
      bucket.trades += 1;
      bucket.pnl = round(bucket.pnl + (t.realizedPnl ?? 0), 2);
    }

    const sorted = [...closed].sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0));

    return {
      navStart: round(navStart, 2),
      navEnd: round(navEnd, 2),
      totalReturnPct: navStart > 0 ? round(((navEnd - navStart) / navStart) * 100, 2) : 0,
      realizedPnl: round(closed.reduce((a, t) => a + (t.realizedPnl ?? 0), 0), 2),
      unrealizedPnl: round(navRows[navRows.length - 1]?.unrealizedPnl ?? 0, 2),
      maxDrawdownPct: round(maxDrawdown(navSeries) * 100, 2),
      tradeCount: tradeRows.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRatePct: closed.length > 0 ? round((wins.length / closed.length) * 100, 1) : 0,
      avgWin: wins.length > 0 ? round(grossWin / wins.length, 2) : 0,
      avgLoss: losses.length > 0 ? round(grossLoss / losses.length, 2) : 0,
      profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
      feesPaid: round(tradeRows.reduce((a, t) => a + t.feeQuote, 0), 2),
      gasPaid: round(tradeRows.reduce((a, t) => a + t.gasQuote, 0), 2),
      bestTrade: sorted[0] ? { symbol: sorted[0].symbol, pnl: round(sorted[0].realizedPnl ?? 0, 2) } : null,
      worstTrade: sorted.at(-1) ? { symbol: sorted.at(-1)!.symbol, pnl: round(sorted.at(-1)!.realizedPnl ?? 0, 2) } : null,
      byStrategy,
      bySymbol,
    };
  }

  /** Daily NAV series collapsed to one point per UTC day, for charting. */
  async dailyNav(sinceMs = Date.now() - 90 * DAY): Promise<{ day: string; nav: number }[]> {
    const rows = await this.db
      .select()
      .from(navHistory)
      .where(gte(navHistory.recordedAt, sinceMs))
      .orderBy(navHistory.recordedAt);
    const byDay = new Map<string, number>();
    for (const row of rows) byDay.set(new Date(row.recordedAt).toISOString().slice(0, 10), row.nav);
    return [...byDay.entries()].map(([day, nav]) => ({ day, nav: round(nav, 2) }));
  }

  /** Sharpe-like ratio over the NAV point series. Unannualised on purpose. */
  static riskAdjusted(points: readonly NavPoint[]): number {
    const rets = returnsFromNav(points.map((p) => p.nav));
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const sd = Math.sqrt(variance);
    return sd === 0 ? 0 : round(mean / sd, 3);
  }

  async recentTrades(limit = 50) {
    return this.db.select().from(trades).orderBy(desc(trades.executedAt)).limit(limit);
  }
}
