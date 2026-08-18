import type { Address, PublicClient } from 'viem';
import {
  FailClosedError,
  fromRaw,
  logger,
  now,
  PANCAKE_V2_ROUTER,
  PANCAKE_V3_QUOTER,
  priceImpactBps,
  type AssetSpec,
  type Quote,
  type RouteLeg,
  type Side,
  type Universe,
} from '@4gent/core';
import { pancakeV2RouterAbi, pancakeV3QuoterAbi } from '@4gent/chain';
import type { PriceService } from '@4gent/data';

const log = logger('exec:quoter');

/**
 * Exact-in quoting across both PancakeSwap versions.
 *
 * v3 quotes come from the Quoter's `eth_call` simulation rather than a local
 * tick walk — the on-chain quoter is the same maths the router will run, so its
 * answer is the one that matters.
 */
export class Quoter {
  constructor(
    private readonly client: PublicClient,
    private readonly universe: Universe,
    private readonly prices: PriceService,
  ) {}

  async quote(asset: AssetSpec, side: Side, amountIn: bigint): Promise<Quote> {
    if (amountIn <= 0n) throw new FailClosedError(`Cannot quote a non-positive amount for ${asset.symbol}`);

    const quoteToken = this.universe.quoteAsset.address;
    const tokenIn = side === 'buy' ? quoteToken : (asset.address as Address);
    const tokenOut = side === 'buy' ? (asset.address as Address) : quoteToken;

    const amountOut =
      asset.pool.version === 'v3'
        ? await this.quoteV3(tokenIn, tokenOut, amountIn, asset.pool.feeTier ?? 500)
        : await this.quoteV2(tokenIn, tokenOut, amountIn);

    if (amountOut <= 0n) throw new FailClosedError(`${asset.symbol} quote returned zero output`);

    const inDecimals = side === 'buy' ? this.universe.quoteAsset.decimals : asset.decimals;
    const outDecimals = side === 'buy' ? asset.decimals : this.universe.quoteAsset.decimals;
    const amountInDec = fromRaw(amountIn, inDecimals);
    const amountOutDec = fromRaw(amountOut, outDecimals);

    // Always expressed as quote units per asset unit, regardless of direction.
    const executionPrice = side === 'buy' ? amountInDec / amountOutDec : amountOutDec / amountInDec;
    const midPrice = this.prices.get(asset.symbol)?.price ?? executionPrice;

    const route: RouteLeg[] = [
      {
        pool: asset.pool.address,
        version: asset.pool.version,
        feeTier: asset.pool.feeTier,
        tokenIn,
        tokenOut,
      },
    ];

    const quote: Quote = {
      symbol: asset.symbol,
      amountIn,
      amountOut,
      executionPrice,
      midPrice,
      priceImpactBps: priceImpactBps(executionPrice, midPrice),
      route,
      quotedAt: now(),
    };

    log.debug(
      { symbol: asset.symbol, side, executionPrice, impactBps: quote.priceImpactBps },
      'quote produced',
    );
    return quote;
  }

  private async quoteV3(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<bigint> {
    // The quoter is nonpayable by design; simulate rather than call.
    const { result } = await this.client.simulateContract({
      address: PANCAKE_V3_QUOTER,
      abi: pancakeV3QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    return (result as readonly bigint[])[0] ?? 0n;
  }

  private async quoteV2(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const amounts = (await this.client.readContract({
      address: PANCAKE_V2_ROUTER,
      abi: pancakeV2RouterAbi,
      functionName: 'getAmountsOut',
      args: [amountIn, [tokenIn, tokenOut]],
    })) as readonly bigint[];
    return amounts[amounts.length - 1] ?? 0n;
  }
}

/** minAmountOut for a quote under a slippage cap. */
export function minOutFor(quote: Quote, slippageBps: number): bigint {
  return quote.amountOut - (quote.amountOut * BigInt(slippageBps)) / 10_000n;
}
