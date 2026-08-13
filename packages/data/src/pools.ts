import type { PublicClient } from 'viem';
import {
  fromRaw,
  logger,
  now,
  reservesToPrice,
  sqrtPriceX96ToPrice,
  v2AmountOut,
  type AssetSpec,
  type PoolSpec,
  type PriceObservation,
} from '@4gent/core';
import { multicall, pancakeV2PairAbi, pancakeV3PoolAbi, unwrapOr, type Call } from '@4gent/chain';

const log = logger('data:pools');

interface V3Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
}

export interface PoolState {
  symbol: string;
  pool: PoolSpec;
  price: number;
  liquidity: bigint;
  reserve0?: bigint;
  reserve1?: bigint;
  tick?: number;
  sqrtPriceX96?: bigint;
  depthUsd: number;
  blockNumber: bigint;
  observedAt: number;
  healthy: boolean;
  note?: string;
}

/**
 * Reads every configured pool in one multicall batch pinned to a single block.
 * A mixed v2/v3 universe is normal: bStocks live on concentrated-liquidity
 * pools, while most memecoins only ever get a v2 pair.
 */
export class PoolReader {
  constructor(private readonly client: PublicClient) {}

  async readAll(assets: readonly AssetSpec[]): Promise<PoolState[]> {
    if (assets.length === 0) return [];
    const blockNumber = await this.client.getBlockNumber();

    const calls: Call[] = [];
    const layout: { asset: AssetSpec; offset: number; legs: number }[] = [];

    for (const asset of assets) {
      const offset = calls.length;
      if (asset.pool.version === 'v3') {
        calls.push(
          { address: asset.pool.address, abi: pancakeV3PoolAbi, functionName: 'slot0' },
          { address: asset.pool.address, abi: pancakeV3PoolAbi, functionName: 'liquidity' },
        );
        layout.push({ asset, offset, legs: 2 });
      } else {
        calls.push({ address: asset.pool.address, abi: pancakeV2PairAbi, functionName: 'getReserves' });
        layout.push({ asset, offset, legs: 1 });
      }
    }

    const results = await multicall(this.client, calls, { blockNumber });
    const states: PoolState[] = [];

    for (const { asset, offset } of layout) {
      try {
        states.push(
          asset.pool.version === 'v3'
            ? this.decodeV3(asset, results, offset, blockNumber)
            : this.decodeV2(asset, results, offset, blockNumber),
        );
      } catch (error) {
        log.warn({ symbol: asset.symbol, err: String(error) }, 'pool read failed');
        states.push({
          symbol: asset.symbol,
          pool: asset.pool,
          price: 0,
          liquidity: 0n,
          depthUsd: 0,
          blockNumber,
          observedAt: now(),
          healthy: false,
          note: String(error),
        });
      }
    }
    return states;
  }

  private decodeV3(
    asset: AssetSpec,
    results: ReturnType<typeof multicall> extends Promise<infer R> ? R : never,
    offset: number,
    blockNumber: bigint,
  ): PoolState {
    const slot0Raw = results[offset];
    const liquidityRaw = results[offset + 1];
    if (!slot0Raw?.ok) throw new Error(`slot0 unavailable: ${slot0Raw?.ok === false ? slot0Raw.error : 'missing'}`);

    const tuple = slot0Raw.value as readonly [bigint, number, ...unknown[]];
    const slot0: V3Slot0 = { sqrtPriceX96: tuple[0], tick: tuple[1] };
    const liquidity = unwrapOr(liquidityRaw, 0n) as bigint;

    const rawPrice = sqrtPriceX96ToPrice(
      slot0.sqrtPriceX96,
      asset.pool.token0Decimals,
      asset.pool.token1Decimals,
    );
    // sqrtPriceX96 always encodes token1/token0. Invert when the traded asset
    // is token1 so the price is consistently "quote units per asset unit".
    const price = asset.pool.assetIsToken0 ? rawPrice : rawPrice === 0 ? 0 : 1 / rawPrice;

    return {
      symbol: asset.symbol,
      pool: asset.pool,
      price,
      liquidity,
      tick: slot0.tick,
      sqrtPriceX96: slot0.sqrtPriceX96,
      depthUsd: estimateV3Depth(liquidity, price, asset.pool),
      blockNumber,
      observedAt: now(),
      healthy: price > 0 && liquidity > 0n,
    };
  }

  private decodeV2(
    asset: AssetSpec,
    results: ReturnType<typeof multicall> extends Promise<infer R> ? R : never,
    offset: number,
    blockNumber: bigint,
  ): PoolState {
    const raw = results[offset];
    if (!raw?.ok) throw new Error(`getReserves unavailable: ${raw?.ok === false ? raw.error : 'missing'}`);
    const [reserve0, reserve1] = raw.value as readonly [bigint, bigint, number];

    const priceToken0 = reservesToPrice(
      reserve0,
      reserve1,
      asset.pool.token0Decimals,
      asset.pool.token1Decimals,
    );
    const price = asset.pool.assetIsToken0 ? priceToken0 : priceToken0 === 0 ? 0 : 1 / priceToken0;

    const quoteReserve = asset.pool.assetIsToken0 ? reserve1 : reserve0;
    const quoteDecimals = asset.pool.assetIsToken0 ? asset.pool.token1Decimals : asset.pool.token0Decimals;

    return {
      symbol: asset.symbol,
      pool: asset.pool,
      price,
      liquidity: reserve0 + reserve1,
      reserve0,
      reserve1,
      depthUsd: estimateV2Depth(reserve0, reserve1, asset.pool),
      blockNumber,
      observedAt: now(),
      healthy: price > 0 && reserve0 > 0n && reserve1 > 0n,
      note: `quoteReserve=${fromRaw(quoteReserve, quoteDecimals).toFixed(2)}`,
    };
  }
}

/**
 * Quote-asset notional absorbable within roughly 100 bps.
 *
 * For v3 this is an approximation from active liquidity rather than a full tick
 * walk; it is used for position sizing sanity, never for pricing a fill.
 */
export function estimateV3Depth(liquidity: bigint, price: number, pool: PoolSpec): number {
  if (liquidity === 0n || price <= 0) return 0;
  const decimals = pool.assetIsToken0 ? pool.token1Decimals : pool.token0Decimals;
  const l = fromRaw(liquidity, Math.round((decimals + 18) / 2));
  // dx ~= L * (1/sqrt(Pa) - 1/sqrt(Pb)); for a +/-1% band this reduces to ~0.5% of L*sqrt(P).
  return Math.max(0, l * Math.sqrt(price) * 0.005);
}

/** Exact for constant product: the input that moves price by 100 bps. */
export function estimateV2Depth(reserve0: bigint, reserve1: bigint, pool: PoolSpec): number {
  const quoteReserve = pool.assetIsToken0 ? reserve1 : reserve0;
  const decimals = pool.assetIsToken0 ? pool.token1Decimals : pool.token0Decimals;
  const reserve = fromRaw(quoteReserve, decimals);
  // (1 + x/R)^2 = 1.01  =>  x = R * (sqrt(1.01) - 1)
  return reserve * (Math.sqrt(1.01) - 1);
}

/** Local v2 output simulation used by the paper engine and safety triage. */
export function simulateV2Swap(
  state: PoolState,
  amountIn: bigint,
  direction: 'buy' | 'sell',
  feeBps = 25,
): bigint {
  if (state.reserve0 === undefined || state.reserve1 === undefined) return 0n;
  const assetIsToken0 = state.pool.assetIsToken0;
  const assetReserve = assetIsToken0 ? state.reserve0 : state.reserve1;
  const quoteReserve = assetIsToken0 ? state.reserve1 : state.reserve0;
  return direction === 'buy'
    ? v2AmountOut(amountIn, quoteReserve, assetReserve, feeBps)
    : v2AmountOut(amountIn, assetReserve, quoteReserve, feeBps);
}

export function toObservation(state: PoolState): PriceObservation {
  return {
    symbol: state.symbol,
    price: state.price,
    blockNumber: state.blockNumber,
    timestamp: state.observedAt,
    depthUsd: state.depthUsd,
    source: state.pool.version === 'v3' ? 'pool_v3' : 'pool_v2',
  };
}
