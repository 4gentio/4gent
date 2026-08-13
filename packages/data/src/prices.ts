import { desc, eq, gte } from 'drizzle-orm';
import {
  FailClosedError,
  isStale,
  logger,
  now,
  type AssetSpec,
  type PriceObservation,
  type Symbol_,
} from '@4gent/core';
import { observations, type Db } from '@4gent/db';
import { PoolReader, toObservation, type PoolState } from './pools.js';

const log = logger('data:prices');

export interface PriceSnapshot {
  bySymbol: Map<Symbol_, PriceObservation>;
  states: Map<Symbol_, PoolState>;
  blockNumber: bigint;
  takenAt: number;
  unhealthy: Symbol_[];
}

/**
 * Owns the in-memory price cache and its durable observation trail.
 *
 * Consumers ask this service for a price rather than hitting the chain, which
 * keeps the number of RPC round trips proportional to the price loop rather
 * than to the number of strategies.
 */
export class PriceService {
  private readonly cache = new Map<Symbol_, PriceObservation>();
  private readonly states = new Map<Symbol_, PoolState>();
  private lastBlock = 0n;
  private lastRefresh = 0;

  constructor(
    private readonly reader: PoolReader,
    private readonly db: Db,
    private readonly maxAgeMs = 60_000,
  ) {}

  async refresh(assets: readonly AssetSpec[], persist = true): Promise<PriceSnapshot> {
    const states = await this.reader.readAll(assets);
    const unhealthy: Symbol_[] = [];
    let blockNumber = this.lastBlock;

    for (const state of states) {
      this.states.set(state.symbol, state);
      if (state.blockNumber > blockNumber) blockNumber = state.blockNumber;
      if (!state.healthy) {
        unhealthy.push(state.symbol);
        continue;
      }
      this.cache.set(state.symbol, toObservation(state));
    }

    if (persist && states.length > 0) {
      const rows = states
        .filter((s) => s.healthy)
        .map((s) => ({
          symbol: s.symbol,
          price: s.price,
          depthUsd: s.depthUsd,
          blockNumber: s.blockNumber.toString(),
          source: s.pool.version === 'v3' ? 'pool_v3' : 'pool_v2',
          observedAt: s.observedAt,
        }));
      if (rows.length > 0) await this.db.insert(observations).values(rows);
    }

    this.lastBlock = blockNumber;
    this.lastRefresh = now();
    if (unhealthy.length > 0) log.warn({ unhealthy }, 'pools reported unhealthy state');

    return {
      bySymbol: new Map(this.cache),
      states: new Map(this.states),
      blockNumber,
      takenAt: this.lastRefresh,
      unhealthy,
    };
  }

  /** Cached price. Returns undefined rather than a stale number. */
  get(symbol: Symbol_): PriceObservation | undefined {
    const obs = this.cache.get(symbol);
    if (!obs) return undefined;
    return isStale(obs.timestamp, this.maxAgeMs) ? undefined : obs;
  }

  /** Fails closed — used anywhere a wrong price would move real money. */
  require(symbol: Symbol_): PriceObservation {
    const obs = this.get(symbol);
    if (!obs) throw new FailClosedError(`No fresh price for ${symbol}`);
    return obs;
  }

  state(symbol: Symbol_): PoolState | undefined {
    return this.states.get(symbol);
  }

  markPrices(): Map<Symbol_, number> {
    const out = new Map<Symbol_, number>();
    for (const [symbol, obs] of this.cache) {
      if (!isStale(obs.timestamp, this.maxAgeMs)) out.set(symbol, obs.price);
    }
    return out;
  }

  get lastRefreshedAt(): number {
    return this.lastRefresh;
  }

  /** Historical observations, used to backfill candles after a restart. */
  async recentObservations(symbol: Symbol_, sinceMs: number): Promise<PriceObservation[]> {
    const rows = await this.db
      .select()
      .from(observations)
      .where(eq(observations.symbol, symbol))
      .orderBy(desc(observations.observedAt))
      .limit(5_000);
    return rows
      .filter((r) => r.observedAt >= sinceMs)
      .map((r) => ({
        symbol: r.symbol,
        price: r.price,
        blockNumber: BigInt(r.blockNumber),
        timestamp: r.observedAt,
        depthUsd: r.depthUsd,
        source: r.source as PriceObservation['source'],
      }))
      .reverse();
  }

  /** Trim the observation trail; candles are the durable record. */
  async pruneObservations(olderThanMs: number): Promise<void> {
    const cutoff = now() - olderThanMs;
    await this.db.delete(observations).where(gte(observations.observedAt, 0)).limit?.(0);
    // drizzle's sqlite delete has no limit(); express the cutoff directly.
    await this.db.run?.(`DELETE FROM observations WHERE observed_at < ${cutoff}` as never);
  }
}
