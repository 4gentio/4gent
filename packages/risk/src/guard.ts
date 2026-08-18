import {
  logger,
  now,
  RiskRejectionError,
  toRaw,
  type AppConfig,
  type AssetSpec,
  type Decision,
  type Order,
  type Position,
  type Quote,
  type Symbol_,
  type Universe,
} from '@4gent/core';
import type { Db } from '@4gent/db';
import { BreakerRegistry } from './breakers.js';
import { KillSwitch } from './killswitch.js';
import { hardStopPrice, sizePosition, sizeReduction, slippageCapFor, type PortfolioState } from './sizing.js';

const log = logger('risk:guard');

export interface GuardContext {
  state: PortfolioState;
  depthBySymbol: ReadonlyMap<Symbol_, number>;
  reasoningCycleId: number | null;
}

export interface PlannedOrder {
  order: Order;
  decision: Decision;
  asset: AssetSpec;
  notional: number;
  hardStop: number;
  clamps: string[];
}

export interface RejectedDecision {
  decision: Decision;
  rule: string;
  reason: string;
}

export interface RiskPlan {
  orders: PlannedOrder[];
  rejected: RejectedDecision[];
  closeOnly: boolean;
}

/**
 * The risk layer's public surface: decisions in, executable orders out.
 *
 * Nothing downstream of this class is allowed to alter a size, a slippage cap,
 * or a stop level. If a value can move money, it is decided here.
 */
export class RiskGuard {
  /** Quotes older than this are refused; mirrors QUOTE_STALENESS_MS. */
  private readonly quoteStalenessMs = 20_000;

  constructor(
    private readonly config: AppConfig,
    private readonly universe: Universe,
    private readonly breakers: BreakerRegistry,
    private readonly killSwitch: KillSwitch,
    private readonly db: Db,
  ) {}

  async plan(decisions: readonly Decision[], ctx: GuardContext): Promise<RiskPlan> {
    if (this.killSwitch.isEngaged) {
      throw new RiskRejectionError('kill_switch', 'Kill switch is engaged; no orders may be planned');
    }

    const closeOnly = await this.breakers.closeOnly();
    const orders: PlannedOrder[] = [];
    const rejected: RejectedDecision[] = [];

    const openCount = ctx.state.positions.filter((p) => p.status === 'open').length;
    let projectedOpen = openCount;

    for (const decision of decisions) {
      if (decision.action === 'hold') continue;

      const asset = this.universe.get(decision.symbol);
      if (!asset || !asset.enabled) {
        rejected.push({ decision, rule: 'unknown_symbol', reason: `${decision.symbol} is not tradable` });
        continue;
      }

      if (closeOnly && (decision.action === 'open_long' || decision.action === 'add')) {
        rejected.push({ decision, rule: 'close_only', reason: 'a circuit breaker is active' });
        continue;
      }

      const mark = ctx.state.marks.get(decision.symbol);
      if (mark === undefined || !(mark > 0)) {
        rejected.push({ decision, rule: 'no_price', reason: 'no fresh mark price available' });
        continue;
      }

      const position = ctx.state.positions.find((p) => p.symbol === decision.symbol && p.status === 'open');

      if (decision.action === 'open_long' || decision.action === 'add') {
        if (decision.action === 'open_long' && projectedOpen >= this.config.risk.maxOpenPositions) {
          rejected.push({
            decision,
            rule: 'max_open_positions',
            reason: `already holding ${openCount} of a maximum ${this.config.risk.maxOpenPositions} positions`,
          });
          continue;
        }

        const sized = sizePosition(
          { decision, assetClass: asset.assetClass, price: mark, depthUsd: ctx.depthBySymbol.get(decision.symbol) ?? 0 },
          ctx.state,
          this.config.risk,
        );
        if (!sized.ok) {
          rejected.push({ decision, rule: sized.rule, reason: sized.reason });
          continue;
        }

        orders.push({
          order: this.buildBuy(asset, sized.notional, decision, ctx.reasoningCycleId),
          decision,
          asset,
          notional: sized.notional,
          hardStop: hardStopPrice(mark, asset.assetClass, this.config.risk),
          clamps: sized.clamps,
        });
        if (decision.action === 'open_long') projectedOpen += 1;
        continue;
      }

      if (!position) {
        rejected.push({ decision, rule: 'no_position', reason: `no open position in ${decision.symbol}` });
        continue;
      }

      if (decision.action === 'close') {
        orders.push({
          order: this.buildSell(asset, position.quantityRaw, decision, ctx.reasoningCycleId, 'close'),
          decision,
          asset,
          notional: position.quantity * mark,
          hardStop: position.hardStopPrice,
          clamps: [],
        });
        continue;
      }

      // reduce
      const sized = sizeReduction(decision, position, mark, this.config.risk);
      if (!sized.ok) {
        rejected.push({ decision, rule: sized.rule, reason: sized.reason });
        continue;
      }
      const fraction = Math.min(1, sized.notional / (position.quantity * mark));
      const quantityRaw =
        fraction >= 0.999
          ? position.quantityRaw
          : (position.quantityRaw * BigInt(Math.round(fraction * 10_000))) / 10_000n;

      orders.push({
        order: this.buildSell(asset, quantityRaw, decision, ctx.reasoningCycleId, 'reduce'),
        decision,
        asset,
        notional: sized.notional,
        hardStop: position.hardStopPrice,
        clamps: sized.clamps,
      });
    }

    if (rejected.length > 0) {
      log.info({ rejected: rejected.map((r) => `${r.decision.symbol}:${r.rule}`) }, 'decisions rejected by risk');
    }
    return { orders, rejected, closeOnly };
  }

  /** Forced exit built by the stop watcher, bypassing the reasoning layer. */
  buildForcedExit(asset: AssetSpec, position: Position, reason: string): Order {
    return {
      symbol: asset.symbol,
      assetClass: asset.assetClass,
      side: 'sell',
      amountIn: position.quantityRaw,
      tokenIn: asset.address,
      tokenOut: this.universe.quoteAsset.address,
      minAmountOut: 0n,
      slippageBps: slippageCapFor(asset.assetClass, this.config.risk),
      strategy: 'risk_stop',
      reasoningCycleId: null,
      reason,
    };
  }

  /**
   * Final pre-flight check against a live quote. This runs after sizing, right
   * before signing, and is the only place that sees the actual expected fill.
   */
  assertQuoteAcceptable(quote: Quote, asset: AssetSpec): void {
    const cap = slippageCapFor(asset.assetClass, this.config.risk);
    if (quote.priceImpactBps > this.config.risk.maxPriceImpactBps) {
      throw new RiskRejectionError(
        'price_impact',
        `${asset.symbol} price impact ${quote.priceImpactBps.toFixed(0)}bps exceeds the ${this.config.risk.maxPriceImpactBps}bps ceiling`,
      );
    }
    if (quote.priceImpactBps > cap) {
      throw new RiskRejectionError(
        'slippage_cap',
        `${asset.symbol} price impact ${quote.priceImpactBps.toFixed(0)}bps exceeds the ${cap}bps ${asset.assetClass} cap`,
      );
    }
    const age = now() - quote.quotedAt;
    if (age > this.quoteStalenessMs) {
      throw new RiskRejectionError('stale_quote', `quote is ${age}ms old`);
    }
  }

  private buildBuy(
    asset: AssetSpec,
    notional: number,
    decision: Decision,
    cycleId: number | null,
  ): Order {
    return {
      symbol: asset.symbol,
      assetClass: asset.assetClass,
      side: 'buy',
      amountIn: toRaw(notional, this.universe.quoteAsset.decimals),
      tokenIn: this.universe.quoteAsset.address,
      tokenOut: asset.address,
      minAmountOut: 0n,
      slippageBps: slippageCapFor(asset.assetClass, this.config.risk),
      strategy: decision.action === 'add' ? 'brain_add' : 'brain_open',
      reasoningCycleId: cycleId,
      reason: decision.thesis,
    };
  }

  private buildSell(
    asset: AssetSpec,
    quantityRaw: bigint,
    decision: Decision,
    cycleId: number | null,
    kind: 'close' | 'reduce',
  ): Order {
    return {
      symbol: asset.symbol,
      assetClass: asset.assetClass,
      side: 'sell',
      amountIn: quantityRaw,
      tokenIn: asset.address,
      tokenOut: this.universe.quoteAsset.address,
      minAmountOut: 0n,
      slippageBps: slippageCapFor(asset.assetClass, this.config.risk),
      strategy: `brain_${kind}`,
      reasoningCycleId: cycleId,
      reason: decision.thesis,
    };
  }
}
