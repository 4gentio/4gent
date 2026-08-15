import { desc, eq } from 'drizzle-orm';
import {
  bpsDiff,
  isStale,
  logger,
  now,
  stooqQuoteSchema,
  withRetry,
  yahooQuoteSchema,
  type AppConfig,
  type AssetSpec,
  type EquityQuote,
} from '@4gent/core';
import { equityQuotes, type Db } from '@4gent/db';
import { marketSession } from './marketHours.js';

const log = logger('data:equity');

interface CacheEntry {
  quote: EquityQuote;
  expiresAt: number;
}

/**
 * Reference prices for the equities underlying each bStock.
 *
 * Providers are free-tier and occasionally flaky, so every response is schema
 * checked and every quote carries the time we fetched it. Consumers must decide
 * what to do with a stale quote; this service never silently extrapolates.
 */
export class EquityPriceService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(ticker: string): Promise<EquityQuote | undefined> {
    const key = ticker.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.quote;

    try {
      const quote = await withRetry(() => this.fetchQuote(key), { attempts: 3, baseMs: 300 });
      this.cache.set(key, { quote, expiresAt: now() + Math.floor(this.config.equity.staleMs / 2) });
      await this.db.insert(equityQuotes).values({
        ticker: key,
        price: quote.price,
        provider: quote.provider,
        quotedAt: quote.quotedAt,
        fetchedAt: quote.fetchedAt,
      });
      return quote;
    } catch (error) {
      log.warn({ ticker: key, err: String(error) }, 'equity quote fetch failed, falling back to last stored');
      return this.lastStored(key);
    }
  }

  /** Batched fetch for the whole bStock universe. */
  async getMany(tickers: readonly string[]): Promise<Map<string, EquityQuote>> {
    const out = new Map<string, EquityQuote>();
    const settled = await Promise.allSettled(tickers.map((t) => this.get(t)));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) out.set(tickers[i]!.toUpperCase(), r.value);
    });
    return out;
  }

  private async fetchQuote(ticker: string): Promise<EquityQuote> {
    return this.config.equity.provider === 'yahoo' ? this.fetchYahoo(ticker) : this.fetchStooq(ticker);
  }

  private async fetchStooq(ticker: string): Promise<EquityQuote> {
    const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2c&h&e=csv`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`stooq responded ${res.status}`);
    const text = await res.text();
    const [, dataLine] = text.trim().split('\n');
    if (!dataLine) throw new Error('stooq returned no data row');
    const [symbol, date, time, close] = dataLine.split(',');
    const parsed = stooqQuoteSchema.parse({ symbol, date, time, close });
    const quotedAt = Date.parse(`${parsed.date}T${parsed.time}Z`);
    return {
      ticker,
      price: parsed.close,
      quotedAt: Number.isNaN(quotedAt) ? now() : quotedAt,
      fetchedAt: now(),
      provider: 'stooq',
      currency: 'USD',
    };
  }

  private async fetchYahoo(ticker: string): Promise<EquityQuote> {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
    const res = await this.fetchImpl(url, {
      headers: { 'user-agent': '4gent/0.1' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`yahoo responded ${res.status}`);
    const parsed = yahooQuoteSchema.parse(await res.json());
    const result = parsed.quoteResponse.result[0];
    if (!result) throw new Error(`yahoo returned no quote for ${ticker}`);
    return {
      ticker,
      price: result.regularMarketPrice,
      quotedAt: result.regularMarketTime * 1000,
      fetchedAt: now(),
      provider: 'yahoo',
      currency: 'USD',
    };
  }

  private async lastStored(ticker: string): Promise<EquityQuote | undefined> {
    const rows = await this.db
      .select()
      .from(equityQuotes)
      .where(eq(equityQuotes.ticker, ticker))
      .orderBy(desc(equityQuotes.fetchedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      ticker: row.ticker,
      price: row.price,
      quotedAt: row.quotedAt,
      fetchedAt: row.fetchedAt,
      provider: `${row.provider}:cached`,
      currency: 'USD',
    };
  }

  isFresh(quote: EquityQuote): boolean {
    return !isStale(quote.fetchedAt, this.config.equity.staleMs);
  }
}

export interface NavDeviation {
  symbol: string;
  underlying: string;
  poolPrice: number;
  referencePrice: number;
  /** Signed: positive means the token trades rich to the underlying. */
  deviationBps: number;
  session: ReturnType<typeof marketSession>['session'];
  referenceFresh: boolean;
  /** Only true during the regular session with a fresh reference quote. */
  actionable: boolean;
}

/**
 * Compares a bStock's pool price to the NAV implied by its underlying equity.
 *
 * `navRatio` handles tokens that do not represent exactly one share. Outside the
 * regular session the deviation is reported but never marked actionable.
 */
export function computeNavDeviation(
  asset: AssetSpec,
  poolPrice: number,
  quote: EquityQuote | undefined,
  opts: { triggerBps: number; staleMs: number; at?: number },
): NavDeviation | null {
  if (!asset.underlying) return null;
  const at = opts.at ?? now();
  const session = marketSession(at).session;

  if (!quote || poolPrice <= 0) {
    return {
      symbol: asset.symbol,
      underlying: asset.underlying,
      poolPrice,
      referencePrice: 0,
      deviationBps: 0,
      session,
      referenceFresh: false,
      actionable: false,
    };
  }

  const referencePrice = quote.price * (asset.navRatio ?? 1);
  const deviationBps = bpsDiff(poolPrice, referencePrice);
  const referenceFresh = !isStale(quote.fetchedAt, opts.staleMs, at);

  return {
    symbol: asset.symbol,
    underlying: asset.underlying,
    poolPrice,
    referencePrice,
    deviationBps,
    session,
    referenceFresh,
    actionable: session === 'open' && referenceFresh && Math.abs(deviationBps) >= opts.triggerBps,
  };
}
