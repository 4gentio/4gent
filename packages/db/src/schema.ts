import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * SQLite is deliberate: the agent is a single-writer process on one box, and an
 * embedded DB removes an entire class of "the database was unreachable" failure
 * modes from the trading path.
 *
 * Conventions:
 *  - timestamps are unix milliseconds stored as integers
 *  - raw token amounts are stored as decimal strings (bigint-safe)
 *  - decimal-adjusted values are stored as reals for querying/aggregation
 */

const ts = (name: string) => integer(name).notNull();

export const positions = sqliteTable(
  'positions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    assetClass: text('asset_class', { enum: ['bstock', 'memecoin', 'quote'] }).notNull(),
    quantityRaw: text('quantity_raw').notNull().default('0'),
    quantity: real('quantity').notNull().default(0),
    avgEntryPrice: real('avg_entry_price').notNull().default(0),
    costBasis: real('cost_basis').notNull().default(0),
    hardStopPrice: real('hard_stop_price').notNull().default(0),
    strategy: text('strategy').notNull().default('unattributed'),
    thesis: text('thesis').notNull().default(''),
    invalidation: text('invalidation').notNull().default(''),
    timeHorizon: text('time_horizon', { enum: ['scalp', 'swing', 'position'] }).notNull().default('swing'),
    conviction: integer('conviction').notNull().default(3),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    openedAt: ts('opened_at'),
    updatedAt: ts('updated_at'),
    closedAt: integer('closed_at'),
  },
  (t) => ({
    openSymbolIdx: uniqueIndex('positions_open_symbol_idx')
      .on(t.symbol)
      .where(sql`${t.status} = 'open'`),
    statusIdx: index('positions_status_idx').on(t.status),
  }),
);

export const trades = sqliteTable(
  'trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    positionId: integer('position_id').references(() => positions.id),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    fillPrice: real('fill_price').notNull(),
    quantity: real('quantity').notNull(),
    quantityRaw: text('quantity_raw').notNull(),
    notional: real('notional').notNull(),
    feeQuote: real('fee_quote').notNull().default(0),
    gasQuote: real('gas_quote').notNull().default(0),
    slippageBps: real('slippage_bps').notNull().default(0),
    priceImpactBps: real('price_impact_bps').notNull().default(0),
    realizedPnl: real('realized_pnl'),
    txHash: text('tx_hash'),
    mode: text('mode', { enum: ['paper', 'live'] }).notNull(),
    strategy: text('strategy').notNull().default('unattributed'),
    reasoningCycleId: integer('reasoning_cycle_id'),
    executedAt: ts('executed_at'),
  },
  (t) => ({
    symbolIdx: index('trades_symbol_idx').on(t.symbol),
    executedIdx: index('trades_executed_idx').on(t.executedAt),
    txIdx: uniqueIndex('trades_tx_idx').on(t.txHash).where(sql`${t.txHash} IS NOT NULL`),
  }),
);

export const candles = sqliteTable(
  'candles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    interval: text('interval', { enum: ['1m', '5m', '1h'] }).notNull(),
    openTime: ts('open_time'),
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    samples: integer('samples').notNull().default(0),
    volumeQuote: real('volume_quote').notNull().default(0),
  },
  (t) => ({
    bucketIdx: uniqueIndex('candles_bucket_idx').on(t.symbol, t.interval, t.openTime),
    lookupIdx: index('candles_lookup_idx').on(t.symbol, t.interval, t.openTime),
  }),
);

export const observations = sqliteTable(
  'observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    price: real('price').notNull(),
    depthUsd: real('depth_usd').notNull().default(0),
    blockNumber: text('block_number').notNull(),
    source: text('source').notNull(),
    observedAt: ts('observed_at'),
  },
  (t) => ({ symbolTimeIdx: index('observations_symbol_time_idx').on(t.symbol, t.observedAt) }),
);

export const equityQuotes = sqliteTable(
  'equity_quotes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticker: text('ticker').notNull(),
    price: real('price').notNull(),
    provider: text('provider').notNull(),
    quotedAt: ts('quoted_at'),
    fetchedAt: ts('fetched_at'),
  },
  (t) => ({ tickerIdx: index('equity_quotes_ticker_idx').on(t.ticker, t.fetchedAt) }),
);

export const navHistory = sqliteTable(
  'nav_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    nav: real('nav').notNull(),
    cash: real('cash').notNull(),
    positionsValue: real('positions_value').notNull(),
    unrealizedPnl: real('unrealized_pnl').notNull(),
    realizedPnlToDate: real('realized_pnl_to_date').notNull(),
    recordedAt: ts('recorded_at'),
  },
  (t) => ({ recordedIdx: index('nav_history_recorded_idx').on(t.recordedAt) }),
);

export const reasoningLog = sqliteTable(
  'reasoning_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    model: text('model').notNull(),
    promptHash: text('prompt_hash').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    snapshot: text('snapshot', { mode: 'json' }).notNull(),
    rawResponse: text('raw_response').notNull(),
    parsedDecisions: text('parsed_decisions', { mode: 'json' }),
    portfolioNote: text('portfolio_note').default(''),
    actionsTaken: text('actions_taken', { mode: 'json' }),
    inputTokens: integer('input_tokens').default(0),
    outputTokens: integer('output_tokens').default(0),
    cachedTokens: integer('cached_tokens').default(0),
    latencyMs: integer('latency_ms').default(0),
    validationError: text('validation_error'),
    startedAt: ts('started_at'),
    completedAt: integer('completed_at'),
  },
  (t) => ({ startedIdx: index('reasoning_started_idx').on(t.startedAt) }),
);

/** Outcome attribution for the rolling memory the brain reads each cycle. */
export const decisionOutcomes = sqliteTable(
  'decision_outcomes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reasoningCycleId: integer('reasoning_cycle_id').notNull(),
    symbol: text('symbol').notNull(),
    action: text('action').notNull(),
    conviction: integer('conviction').notNull(),
    thesis: text('thesis').notNull(),
    invalidation: text('invalidation').notNull(),
    entryPrice: real('entry_price'),
    exitPrice: real('exit_price'),
    pnl: real('pnl'),
    outcome: text('outcome', { enum: ['open', 'win', 'loss', 'flat', 'rejected'] }).notNull().default('open'),
    rejectionReason: text('rejection_reason'),
    createdAt: ts('created_at'),
    resolvedAt: integer('resolved_at'),
  },
  (t) => ({ createdIdx: index('outcomes_created_idx').on(t.createdAt) }),
);

export const tokenSafety = sqliteTable(
  'token_safety',
  {
    address: text('address').primaryKey(),
    symbol: text('symbol').notNull(),
    verdict: text('verdict', { enum: ['pass', 'fail', 'uncertain'] }).notNull(),
    riskScore: real('risk_score').notNull().default(100),
    buyTaxBps: real('buy_tax_bps'),
    sellTaxBps: real('sell_tax_bps'),
    liquidityUsd: real('liquidity_usd'),
    holderCount: integer('holder_count'),
    ageMinutes: real('age_minutes'),
    sourceVerified: integer('source_verified', { mode: 'boolean' }),
    roundTripOk: integer('round_trip_ok', { mode: 'boolean' }),
    ownerPrivileges: text('owner_privileges', { mode: 'json' }),
    flags: text('flags', { mode: 'json' }),
    rationale: text('rationale').default(''),
    checkedAt: ts('checked_at'),
  },
  (t) => ({ verdictIdx: index('token_safety_verdict_idx').on(t.verdict) }),
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token').notNull(),
    spender: text('spender').notNull(),
    amountRaw: text('amount_raw').notNull(),
    txHash: text('tx_hash'),
    updatedAt: ts('updated_at'),
  },
  (t) => ({ pairIdx: uniqueIndex('approvals_pair_idx').on(t.token, t.spender) }),
);

/** Pending transactions, so a restart never re-broadcasts or double-sends. */
export const pendingTxs = sqliteTable(
  'pending_txs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    nonce: integer('nonce').notNull(),
    txHash: text('tx_hash').notNull(),
    kind: text('kind', { enum: ['swap', 'approve', 'transfer'] }).notNull(),
    symbol: text('symbol'),
    payload: text('payload', { mode: 'json' }),
    status: text('status', { enum: ['pending', 'confirmed', 'replaced', 'failed'] }).notNull().default('pending'),
    gasPriceWei: text('gas_price_wei'),
    attempts: integer('attempts').notNull().default(1),
    submittedAt: ts('submitted_at'),
    resolvedAt: integer('resolved_at'),
  },
  (t) => ({
    hashIdx: uniqueIndex('pending_tx_hash_idx').on(t.txHash),
    nonceIdx: index('pending_tx_nonce_idx').on(t.nonce),
  }),
);

export const heartbeats = sqliteTable('heartbeats', {
  loop: text('loop').primaryKey(),
  lastRunAt: ts('last_run_at'),
  lastSuccessAt: ts('last_success_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  note: text('note'),
});

export const breakers = sqliteTable('breakers', {
  id: text('id').primaryKey(),
  tripped: integer('tripped', { mode: 'boolean' }).notNull().default(false),
  reason: text('reason'),
  peakNav: real('peak_nav'),
  trippedAt: integer('tripped_at'),
  expiresAt: integer('expires_at'),
});

export const alertLog = sqliteTable(
  'alert_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level', { enum: ['info', 'warn', 'error', 'critical'] }).notNull(),
    channel: text('channel').notNull().default('telegram'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at'),
  },
  (t) => ({ createdIdx: index('alert_log_created_idx').on(t.createdAt) }),
);

/** Free-form durable key/value used for cursors and one-off runtime state. */
export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: ts('updated_at'),
});

export type PositionRow = typeof positions.$inferSelect;
export type NewPositionRow = typeof positions.$inferInsert;
export type TradeRow = typeof trades.$inferSelect;
export type NewTradeRow = typeof trades.$inferInsert;
export type CandleRow = typeof candles.$inferSelect;
export type NavRow = typeof navHistory.$inferSelect;
export type ReasoningRow = typeof reasoningLog.$inferSelect;
export type TokenSafetyRow = typeof tokenSafety.$inferSelect;
export type PendingTxRow = typeof pendingTxs.$inferSelect;
export type BreakerRow = typeof breakers.$inferSelect;
