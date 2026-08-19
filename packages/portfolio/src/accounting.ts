import { and, eq, gte } from 'drizzle-orm';
import {
  blendCostBasis,
  dayKey,
  fromRaw,
  logger,
  now,
  realizedPnl as computeRealizedPnl,
  type AssetSpec,
  type FillResult,
  type NavPoint,
  type Order,
  type Position,
  type Symbol_,
  type Universe,
} from '@4gent/core';
import { navHistory, positions, trades, type Db } from '@4gent/db';

const log = logger('portfolio:accounting');

export interface RecordFillInput {
  order: Order;
  asset: AssetSpec;
  fill: FillResult;
  /** Stop level assigned by the risk layer at open. */
  hardStopPrice: number;
  thesis: string;
  invalidation: string;
  timeHorizon: Position['timeHorizon'];
  conviction: Position['conviction'];
}

export interface RecordFillResult {
  positionId: number | null;
  tradeId: number;
  realizedPnl: number | null;
  closed: boolean;
}

/**
 * Position and PnL bookkeeping.
 *
 * Cost basis is a running average on adds; realised PnL on a close or reduce is
 * measured against that average. Fees and gas are charged to realised PnL at
 * the moment they are incurred rather than amortised, so the reported number is
 * always what the wallet actually experienced.
 */
export class PortfolioAccountant {
  constructor(
    private readonly db: Db,
    private readonly universe: Universe,
  ) {}

  async openPositions(): Promise<Position[]> {
    const rows = await this.db.select().from(positions).where(eq(positions.status, 'open'));
    return rows.map(rowToPosition);
  }

  async positionFor(symbol: Symbol_): Promise<Position | undefined> {
    const rows = await this.db
      .select()
      .from(positions)
      .where(and(eq(positions.symbol, symbol), eq(positions.status, 'open')))
      .limit(1);
    return rows[0] ? rowToPosition(rows[0]) : undefined;
  }

  async recordFill(input: RecordFillInput): Promise<RecordFillResult> {
    const { order, asset, fill } = input;
    const timestamp = now();
    const quantity = fromRaw(order.side === 'buy' ? fill.amountOut : fill.amountIn, asset.decimals);
    const notional = quantity * fill.fillPrice;
    const costs = fill.feeQuote + fill.gasQuote;

    if (order.side === 'buy') {
      const existing = await this.positionFor(order.symbol);
      let positionId: number;

      if (existing) {
        const blended = blendCostBasis(existing.quantity, existing.avgEntryPrice, quantity, fill.fillPrice);
        await this.db
          .update(positions)
          .set({
            quantityRaw: (existing.quantityRaw + (order.side === 'buy' ? fill.amountOut : 0n)).toString(),
            quantity: blended.quantity,
            avgEntryPrice: blended.avgEntryPrice,
            costBasis: existing.costBasis + notional + costs,
            conviction: input.conviction,
            thesis: input.thesis,
            invalidation: input.invalidation,
            updatedAt: timestamp,
          })
          .where(eq(positions.id, existing.id));
        positionId = existing.id;
      } else {
        const inserted = await this.db
          .insert(positions)
          .values({
            symbol: order.symbol,
            assetClass: asset.assetClass,
            quantityRaw: fill.amountOut.toString(),
            quantity,
            avgEntryPrice: fill.fillPrice,
            costBasis: notional + costs,
            hardStopPrice: input.hardStopPrice,
            strategy: order.strategy,
            thesis: input.thesis,
            invalidation: input.invalidation,
            timeHorizon: input.timeHorizon,
            conviction: input.conviction,
            status: 'open',
            openedAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: positions.id });
        positionId = inserted[0]!.id;
      }

      const tradeId = await this.insertTrade(input, positionId, quantity, notional, null, timestamp);
      log.info({ symbol: order.symbol, quantity, price: fill.fillPrice }, 'buy recorded');
      return { positionId, tradeId, realizedPnl: null, closed: false };
    }

    // Sell path: realise against the average cost basis.
    const existing = await this.positionFor(order.symbol);
    if (!existing) {
      log.error({ symbol: order.symbol }, 'sell fill with no open position — recording as orphan trade');
      const tradeId = await this.insertTrade(input, null, quantity, notional, null, timestamp);
      return { positionId: null, tradeId, realizedPnl: null, closed: false };
    }

    const closedQty = Math.min(quantity, existing.quantity);
    const pnl = computeRealizedPnl(closedQty, existing.avgEntryPrice, fill.fillPrice, costs);
    const remainingRaw = existing.quantityRaw - fill.amountIn;
    const fullyClosed = remainingRaw <= 0n || closedQty >= existing.quantity * 0.999;

    if (fullyClosed) {
      await this.db
        .update(positions)
        .set({ status: 'closed', quantityRaw: '0', quantity: 0, updatedAt: timestamp, closedAt: timestamp })
        .where(eq(positions.id, existing.id));
    } else {
      const remaining = existing.quantity - closedQty;
      await this.db
        .update(positions)
        .set({
          quantityRaw: remainingRaw.toString(),
          quantity: remaining,
          costBasis: remaining * existing.avgEntryPrice,
          updatedAt: timestamp,
        })
        .where(eq(positions.id, existing.id));
    }

    const tradeId = await this.insertTrade(input, existing.id, quantity, notional, pnl, timestamp);
    log.info({ symbol: order.symbol, closedQty, pnl, fullyClosed }, 'sell recorded');
    return { positionId: existing.id, tradeId, realizedPnl: pnl, closed: fullyClosed };
  }

  private async insertTrade(
    input: RecordFillInput,
    positionId: number | null,
    quantity: number,
    notional: number,
    pnl: number | null,
    timestamp: number,
  ): Promise<number> {
    const inserted = await this.db
      .insert(trades)
      .values({
        positionId,
        symbol: input.order.symbol,
        side: input.order.side,
        fillPrice: input.fill.fillPrice,
        quantity,
        quantityRaw: (input.order.side === 'buy' ? input.fill.amountOut : input.fill.amountIn).toString(),
        notional,
        feeQuote: input.fill.feeQuote,
        gasQuote: input.fill.gasQuote,
        slippageBps: input.fill.slippageBps,
        priceImpactBps: input.fill.slippageBps,
        realizedPnl: pnl,
        txHash: input.fill.txHash,
        mode: input.fill.mode,
        strategy: input.order.strategy,
        reasoningCycleId: input.order.reasoningCycleId,
        executedAt: timestamp,
      })
      .returning({ id: trades.id });
    return inserted[0]!.id;
  }

  // --- Valuation ------------------------------------------------------------

  async markToMarket(marks: ReadonlyMap<Symbol_, number>, cash: number): Promise<NavPoint> {
    const open = await this.openPositions();
    let positionsValue = 0;
    let unrealized = 0;

    for (const p of open) {
      const mark = marks.get(p.symbol) ?? p.avgEntryPrice;
      const value = p.quantity * mark;
      positionsValue += value;
      unrealized += value - p.costBasis;
    }

    const realizedToDate = await this.realizedPnlSince(0);
    const point: NavPoint = {
      timestamp: now(),
      nav: cash + positionsValue,
      cash,
      positionsValue,
      unrealizedPnl: unrealized,
      realizedPnlToDate: realizedToDate,
    };

    await this.db.insert(navHistory).values({
      nav: point.nav,
      cash: point.cash,
      positionsValue: point.positionsValue,
      unrealizedPnl: point.unrealizedPnl,
      realizedPnlToDate: point.realizedPnlToDate,
      recordedAt: point.timestamp,
    });

    return point;
  }

  async realizedPnlSince(sinceMs: number): Promise<number> {
    const rows = await this.db.select().from(trades).where(gte(trades.executedAt, sinceMs));
    return rows.reduce((acc, t) => acc + (t.realizedPnl ?? 0), 0);
  }

  async realizedPnlToday(at = now()): Promise<number> {
    const startOfDay = Date.parse(`${dayKey(at)}T00:00:00.000Z`);
    return this.realizedPnlSince(startOfDay);
  }

  /** NAV at the first observation of the current UTC day, for day-return. */
  async navAtDayOpen(at = now()): Promise<number> {
    const startOfDay = Date.parse(`${dayKey(at)}T00:00:00.000Z`);
    const rows = await this.db
      .select()
      .from(navHistory)
      .where(gte(navHistory.recordedAt, startOfDay))
      .orderBy(navHistory.recordedAt)
      .limit(1);
    return rows[0]?.nav ?? 0;
  }

  async navSeries(sinceMs: number): Promise<NavPoint[]> {
    const rows = await this.db
      .select()
      .from(navHistory)
      .where(gte(navHistory.recordedAt, sinceMs))
      .orderBy(navHistory.recordedAt);
    return rows.map((r) => ({
      timestamp: r.recordedAt,
      nav: r.nav,
      cash: r.cash,
      positionsValue: r.positionsValue,
      unrealizedPnl: r.unrealizedPnl,
      realizedPnlToDate: r.realizedPnlToDate,
    }));
  }
}

function rowToPosition(row: typeof positions.$inferSelect): Position {
  return {
    id: row.id,
    symbol: row.symbol,
    assetClass: row.assetClass,
    quantityRaw: BigInt(row.quantityRaw),
    quantity: row.quantity,
    avgEntryPrice: row.avgEntryPrice,
    costBasis: row.costBasis,
    openedAt: row.openedAt,
    updatedAt: row.updatedAt,
    strategy: row.strategy,
    thesis: row.thesis,
    invalidation: row.invalidation,
    timeHorizon: row.timeHorizon,
    conviction: row.conviction as Position['conviction'],
    hardStopPrice: row.hardStopPrice,
    status: row.status,
  };
}

export { rowToPosition };
