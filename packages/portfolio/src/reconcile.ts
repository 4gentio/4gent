import { eq } from 'drizzle-orm';
import type { Address } from 'viem';
import {
  fromRaw,
  logger,
  now,
  round,
  type AppConfig,
  type Symbol_,
  type Universe,
} from '@4gent/core';
import type { Wallet } from '@4gent/chain';
import { positions, type Db } from '@4gent/db';
import type { PortfolioAccountant } from './accounting.js';

const log = logger('portfolio:reconcile');

export interface Discrepancy {
  symbol: Symbol_;
  kind: 'quantity_mismatch' | 'unknown_holding' | 'missing_holding';
  ledgerQuantity: number;
  chainQuantity: number;
  driftPct: number;
  valueUsd: number;
}

export interface ReconciliationResult {
  at: number;
  cash: number;
  checked: number;
  discrepancies: Discrepancy[];
  /** True when drift exceeded tolerance and trading should be paused. */
  shouldPause: boolean;
  summary: string;
}

/**
 * Periodic truth check between the ledger and the chain.
 *
 * The database is a model of reality, not reality. Anything that moves tokens
 * outside the agent — a manual transfer, a rebasing token, a partially
 * confirmed swap the agent gave up on — shows up here. Material drift pauses
 * trading rather than attempting an automatic correction, because silently
 * rewriting cost basis to match an unexplained balance destroys the audit trail.
 */
export class Reconciler {
  constructor(
    private readonly wallet: Wallet,
    private readonly accountant: PortfolioAccountant,
    private readonly universe: Universe,
    private readonly db: Db,
    private readonly config: AppConfig,
    /** Relative drift tolerated before pausing, as a fraction. */
    private readonly toleranceFraction = 0.01,
    /** Absolute drift below this quote-asset value is ignored as dust. */
    private readonly dustUsd = 5,
  ) {}

  async run(marks: ReadonlyMap<Symbol_, number>): Promise<ReconciliationResult> {
    const at = now();
    const open = await this.accountant.openPositions();
    const tracked = this.universe.enabled();

    const balances = await this.wallet.tokenBalances([
      { address: this.universe.quoteAsset.address as Address, decimals: this.universe.quoteAsset.decimals },
      ...tracked.map((a) => ({ address: a.address as Address, decimals: a.decimals })),
    ]);

    const cashBalance = balances.get(this.universe.quoteAsset.address as Address);
    const cash = cashBalance?.amount ?? 0;

    const discrepancies: Discrepancy[] = [];
    const ledgerBySymbol = new Map(open.map((p) => [p.symbol, p]));

    for (const asset of tracked) {
      const onChain = balances.get(asset.address as Address);
      const chainQuantity = onChain?.amount ?? 0;
      const ledger = ledgerBySymbol.get(asset.symbol);
      const ledgerQuantity = ledger?.quantity ?? 0;
      const mark = marks.get(asset.symbol) ?? ledger?.avgEntryPrice ?? 0;

      const diff = Math.abs(chainQuantity - ledgerQuantity);
      const valueUsd = diff * mark;
      if (valueUsd < this.dustUsd) continue;

      const base = Math.max(ledgerQuantity, chainQuantity);
      const driftPct = base > 0 ? (diff / base) * 100 : 100;

      const kind: Discrepancy['kind'] =
        ledgerQuantity === 0 ? 'unknown_holding' : chainQuantity === 0 ? 'missing_holding' : 'quantity_mismatch';

      discrepancies.push({
        symbol: asset.symbol,
        kind,
        ledgerQuantity: round(ledgerQuantity, 8),
        chainQuantity: round(chainQuantity, 8),
        driftPct: round(driftPct, 3),
        valueUsd: round(valueUsd, 2),
      });
    }

    const materialDrift = discrepancies.some(
      (d) => d.driftPct / 100 > this.toleranceFraction || d.valueUsd > this.config.risk.minTradeUsd * 4,
    );

    const summary =
      discrepancies.length === 0
        ? `Ledger matches chain across ${tracked.length} assets (cash ${cash.toFixed(2)})`
        : discrepancies
            .map((d) => `${d.symbol}: ledger ${d.ledgerQuantity} vs chain ${d.chainQuantity} (${d.driftPct}%)`)
            .join('; ');

    if (discrepancies.length > 0) {
      log.error({ discrepancies, shouldPause: materialDrift }, 'reconciliation found drift');
    } else {
      log.debug({ checked: tracked.length, cash }, 'reconciliation clean');
    }

    return { at, cash, checked: tracked.length, discrepancies, shouldPause: materialDrift, summary };
  }

  /**
   * Explicit, operator-initiated repair. Aligns the ledger quantity to the
   * chain while preserving average entry price, so realised PnL on the eventual
   * close still reflects the original entry.
   */
  async adoptChainQuantity(symbol: Symbol_, chainQuantity: number, chainQuantityRaw: bigint): Promise<void> {
    const position = await this.accountant.positionFor(symbol);
    if (!position) {
      log.warn({ symbol }, 'cannot adopt chain quantity: no open position');
      return;
    }
    await this.db
      .update(positions)
      .set({
        quantity: chainQuantity,
        quantityRaw: chainQuantityRaw.toString(),
        costBasis: chainQuantity * position.avgEntryPrice,
        updatedAt: now(),
      })
      .where(eq(positions.id, position.id));
    log.warn(
      { symbol, from: position.quantity, to: chainQuantity },
      'ledger quantity adopted from chain by operator action',
    );
  }

  /** Cash balance in quote units, read straight from the chain. */
  async cashOnChain(): Promise<number> {
    const balance = await this.wallet.tokenBalance(
      this.universe.quoteAsset.address as Address,
      this.universe.quoteAsset.decimals,
    );
    return fromRaw(balance.raw, this.universe.quoteAsset.decimals);
  }
}
