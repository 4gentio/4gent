import {
  bpsDiff,
  fromRaw,
  logger,
  now,
  type AssetSpec,
  type FillResult,
  type Order,
  type Quote,
  type Side,
  type Universe,
} from '@4gent/core';
import type { PriceService } from '@4gent/data';
import { ExecutionError, type ExecutionEngine } from './engine.js';
import { minOutFor, type Quoter } from './quoter.js';

const log = logger('exec:paper');

export interface PaperConfig {
  /** Extra slippage applied on top of the quote, modelling latency and MEV. */
  latencySlippageBps: number;
  /** Simulated gas cost per swap, in quote units. */
  gasCostQuote: number;
  /** Probability a swap "fails" so the failure path stays exercised. */
  failureRate: number;
  /** Pool fee applied to the notional, in bps. */
  poolFeeBps: number;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  latencySlippageBps: 8,
  gasCostQuote: 0.35,
  failureRate: 0,
  poolFeeBps: 25,
};

/**
 * Paper engine.
 *
 * It fills against real, live quotes rather than a synthetic price series, and
 * it writes to exactly the same tables as live execution. The point is that a
 * paper soak exercises every line of the accounting and risk path, so the only
 * untested difference when going live is the signature itself.
 */
export class PaperEngine implements ExecutionEngine {
  readonly mode = 'paper' as const;

  constructor(
    private readonly quoter: Quoter,
    private readonly prices: PriceService,
    private readonly universe: Universe,
    private readonly paperConfig: PaperConfig = DEFAULT_PAPER_CONFIG,
  ) {}

  async quote(asset: AssetSpec, side: Side, amountIn: bigint): Promise<Quote> {
    return this.quoter.quote(asset, side, amountIn);
  }

  async execute(order: Order, asset: AssetSpec): Promise<FillResult> {
    const quote = await this.quote(asset, order.side, order.amountIn);

    if (this.paperConfig.failureRate > 0 && Math.random() < this.paperConfig.failureRate) {
      throw new ExecutionError('submit', 'simulated transaction failure', true);
    }

    // Model the gap between quoting and landing on chain.
    const degraded =
      quote.amountOut - (quote.amountOut * BigInt(this.paperConfig.latencySlippageBps)) / 10_000n;
    const minOut = minOutFor(quote, order.slippageBps);
    if (degraded < minOut) {
      throw new ExecutionError(
        'confirm',
        `modelled fill ${degraded} below minOut ${minOut} at a ${order.slippageBps}bps cap`,
      );
    }

    const inDecimals = order.side === 'buy' ? this.universe.quoteAsset.decimals : asset.decimals;
    const outDecimals = order.side === 'buy' ? asset.decimals : this.universe.quoteAsset.decimals;
    const amountInDec = fromRaw(order.amountIn, inDecimals);
    const amountOutDec = fromRaw(degraded, outDecimals);
    const fillPrice = order.side === 'buy' ? amountInDec / amountOutDec : amountOutDec / amountInDec;

    const notional = order.side === 'buy' ? amountInDec : amountOutDec;
    const feeQuote = (notional * this.paperConfig.poolFeeBps) / 10_000;

    const result: FillResult = {
      txHash: null,
      amountIn: order.amountIn,
      amountOut: degraded,
      fillPrice,
      gasQuote: this.paperConfig.gasCostQuote,
      feeQuote,
      slippageBps: Math.abs(bpsDiff(fillPrice, quote.midPrice)),
      blockNumber: this.prices.get(asset.symbol)?.blockNumber ?? null,
      mode: 'paper',
    };

    log.info(
      {
        symbol: order.symbol,
        side: order.side,
        fillPrice: result.fillPrice,
        notional,
        slippageBps: result.slippageBps.toFixed(1),
      },
      'paper fill',
    );
    return result;
  }

  async ensureAllowance(): Promise<void> {
    // No approvals exist in paper mode; the live engine overrides this.
  }

  async drain(): Promise<void> {
    // Paper fills are synchronous; nothing is ever in flight.
  }
}
