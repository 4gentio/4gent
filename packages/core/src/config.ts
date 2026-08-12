import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { addressSchema } from './schemas.js';

/**
 * The single source of truth for every tunable in 4gent.
 *
 * Two rules govern this file:
 *   1. Risk limits live here, not in a prompt. The reasoning layer never sees
 *      a mutable handle to this object.
 *   2. Secrets are read from the environment and never written anywhere else.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v.toLowerCase() === 'true' || v === '1'));

const num = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().finite());

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int());

const str = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v));

const envSchema = z.object({
  EXECUTION_MODE: z.enum(['paper', 'live']).default('paper'),
  LIVE_CONFIRMATION_FILE: str('.LIVE_CONFIRMED'),
  LIVE_CONFIRMATION_PHRASE: str('I understand 4gent will trade real funds'),
  KILL_SWITCH_FILE: str('.KILL_SWITCH'),

  BNB_RPC_PRIMARY: str('https://bsc-dataseed.bnbchain.org'),
  BNB_RPC_FALLBACK: str('https://bsc-dataseed1.defibit.io'),
  CHAIN_ID: int(56),
  WALLET_PRIVATE_KEY: z.string().optional(),
  WALLET_ADDRESS: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_REASONING: str('claude-sonnet-4-6'),
  MODEL_CLASSIFY: str('claude-haiku-4-5'),
  BRAIN_MAX_TOKENS: int(4096),
  BRAIN_TEMPERATURE: num(0.2),

  DATABASE_PATH: str('./data/4gent.db'),

  PRICE_LOOP_MS: int(15_000),
  REASONING_LOOP_MS: int(300_000),
  REASONING_LOOP_ACTIVE_MS: int(60_000),
  RECONCILE_LOOP_MS: int(600_000),
  LOOP_JITTER_PCT: num(15),
  WATCHDOG_STALL_MULTIPLIER: num(4),

  MAX_POSITION_PCT: num(5),
  MAX_BSTOCK_EXPOSURE_PCT: num(60),
  MAX_MEMECOIN_EXPOSURE_PCT: num(15),
  MAX_TOTAL_INVESTED_PCT: num(80),
  MAX_OPEN_POSITIONS: int(12),
  DAILY_DRAWDOWN_BREAKER_PCT: num(6),
  WEEKLY_DRAWDOWN_BREAKER_PCT: num(12),
  BREAKER_COOLDOWN_HOURS: num(24),
  HARD_STOP_BSTOCK_PCT: num(8),
  HARD_STOP_MEMECOIN_PCT: num(20),
  MIN_TRADE_USD: num(25),

  SLIPPAGE_CAP_BSTOCK_BPS: int(60),
  SLIPPAGE_CAP_MEMECOIN_BPS: int(300),
  MAX_PRICE_IMPACT_BPS: int(500),
  QUOTE_STALENESS_MS: int(20_000),

  MAX_BUY_TAX_BPS: int(500),
  MAX_SELL_TAX_BPS: int(500),
  MIN_LIQUIDITY_USD: num(25_000),
  MIN_TOKEN_AGE_MINUTES: num(30),
  MIN_HOLDER_COUNT: int(250),

  EQUITY_PRICE_PROVIDER: z.enum(['stooq', 'yahoo']).default('stooq'),
  EQUITY_PRICE_STALE_MS: int(120_000),
  NAV_DEVIATION_TRIGGER_BPS: num(75),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  ALERTS_ENABLED: bool(false),

  DASHBOARD_ENABLED: bool(true),
  DASHBOARD_PORT: int(8787),
  DASHBOARD_HOST: str('127.0.0.1'),

  LOG_LEVEL: str('info'),
  LOG_PRETTY: bool(false),
});

export interface RiskLimits {
  readonly maxPositionPct: number;
  readonly maxBstockExposurePct: number;
  readonly maxMemecoinExposurePct: number;
  readonly maxTotalInvestedPct: number;
  readonly maxOpenPositions: number;
  readonly dailyDrawdownBreakerPct: number;
  readonly weeklyDrawdownBreakerPct: number;
  readonly breakerCooldownHours: number;
  readonly hardStopBstockPct: number;
  readonly hardStopMemecoinPct: number;
  readonly minTradeUsd: number;
  readonly slippageCapBstockBps: number;
  readonly slippageCapMemecoinBps: number;
  readonly maxPriceImpactBps: number;
}

export interface AppConfig {
  readonly mode: 'paper' | 'live';
  readonly liveConfirmationFile: string;
  readonly liveConfirmationPhrase: string;
  readonly killSwitchFile: string;
  readonly chain: {
    readonly id: number;
    readonly rpcPrimary: string;
    readonly rpcFallback: string;
    readonly privateKey?: `0x${string}`;
    readonly address?: `0x${string}`;
  };
  readonly anthropic: {
    readonly apiKey?: string;
    readonly reasoningModel: string;
    readonly classifyModel: string;
    readonly maxTokens: number;
    readonly temperature: number;
  };
  readonly databasePath: string;
  readonly loops: {
    readonly priceMs: number;
    readonly reasoningMs: number;
    readonly reasoningActiveMs: number;
    readonly reconcileMs: number;
    readonly jitterPct: number;
    readonly watchdogStallMultiplier: number;
  };
  readonly risk: RiskLimits;
  readonly safety: {
    readonly maxBuyTaxBps: number;
    readonly maxSellTaxBps: number;
    readonly minLiquidityUsd: number;
    readonly minTokenAgeMinutes: number;
    readonly minHolderCount: number;
  };
  readonly equity: {
    readonly provider: 'stooq' | 'yahoo';
    readonly staleMs: number;
    readonly navDeviationTriggerBps: number;
  };
  readonly alerts: {
    readonly enabled: boolean;
    readonly telegramBotToken?: string;
    readonly telegramChatId?: string;
  };
  readonly dashboard: {
    readonly enabled: boolean;
    readonly port: number;
    readonly host: string;
  };
  readonly log: { readonly level: string; readonly pretty: boolean };
}

function normalisePrivateKey(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(withPrefix)) {
    throw new Error('WALLET_PRIVATE_KEY must be a 32-byte hex string');
  }
  return withPrefix as `0x${string}`;
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, force = false): AppConfig {
  if (cached && !force) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const e = parsed.data;

  const config: AppConfig = {
    mode: e.EXECUTION_MODE,
    liveConfirmationFile: e.LIVE_CONFIRMATION_FILE,
    liveConfirmationPhrase: e.LIVE_CONFIRMATION_PHRASE,
    killSwitchFile: e.KILL_SWITCH_FILE,
    chain: {
      id: e.CHAIN_ID,
      rpcPrimary: e.BNB_RPC_PRIMARY,
      rpcFallback: e.BNB_RPC_FALLBACK,
      privateKey: normalisePrivateKey(e.WALLET_PRIVATE_KEY),
      address: e.WALLET_ADDRESS ? addressSchema.parse(e.WALLET_ADDRESS) : undefined,
    },
    anthropic: {
      apiKey: e.ANTHROPIC_API_KEY,
      reasoningModel: e.MODEL_REASONING,
      classifyModel: e.MODEL_CLASSIFY,
      maxTokens: e.BRAIN_MAX_TOKENS,
      temperature: e.BRAIN_TEMPERATURE,
    },
    databasePath: e.DATABASE_PATH,
    loops: {
      priceMs: e.PRICE_LOOP_MS,
      reasoningMs: e.REASONING_LOOP_MS,
      reasoningActiveMs: e.REASONING_LOOP_ACTIVE_MS,
      reconcileMs: e.RECONCILE_LOOP_MS,
      jitterPct: e.LOOP_JITTER_PCT,
      watchdogStallMultiplier: e.WATCHDOG_STALL_MULTIPLIER,
    },
    risk: Object.freeze({
      maxPositionPct: e.MAX_POSITION_PCT,
      maxBstockExposurePct: e.MAX_BSTOCK_EXPOSURE_PCT,
      maxMemecoinExposurePct: e.MAX_MEMECOIN_EXPOSURE_PCT,
      maxTotalInvestedPct: e.MAX_TOTAL_INVESTED_PCT,
      maxOpenPositions: e.MAX_OPEN_POSITIONS,
      dailyDrawdownBreakerPct: e.DAILY_DRAWDOWN_BREAKER_PCT,
      weeklyDrawdownBreakerPct: e.WEEKLY_DRAWDOWN_BREAKER_PCT,
      breakerCooldownHours: e.BREAKER_COOLDOWN_HOURS,
      hardStopBstockPct: e.HARD_STOP_BSTOCK_PCT,
      hardStopMemecoinPct: e.HARD_STOP_MEMECOIN_PCT,
      minTradeUsd: e.MIN_TRADE_USD,
      slippageCapBstockBps: e.SLIPPAGE_CAP_BSTOCK_BPS,
      slippageCapMemecoinBps: e.SLIPPAGE_CAP_MEMECOIN_BPS,
      maxPriceImpactBps: e.MAX_PRICE_IMPACT_BPS,
    }),
    safety: {
      maxBuyTaxBps: e.MAX_BUY_TAX_BPS,
      maxSellTaxBps: e.MAX_SELL_TAX_BPS,
      minLiquidityUsd: e.MIN_LIQUIDITY_USD,
      minTokenAgeMinutes: e.MIN_TOKEN_AGE_MINUTES,
      minHolderCount: e.MIN_HOLDER_COUNT,
    },
    equity: {
      provider: e.EQUITY_PRICE_PROVIDER,
      staleMs: e.EQUITY_PRICE_STALE_MS,
      navDeviationTriggerBps: e.NAV_DEVIATION_TRIGGER_BPS,
    },
    alerts: {
      enabled: e.ALERTS_ENABLED,
      telegramBotToken: e.TELEGRAM_BOT_TOKEN,
      telegramChatId: e.TELEGRAM_CHAT_ID,
    },
    dashboard: { enabled: e.DASHBOARD_ENABLED, port: e.DASHBOARD_PORT, host: e.DASHBOARD_HOST },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
  };

  validateInvariants(config);
  cached = Object.freeze(config);
  return cached;
}

/** Structural checks that a per-field schema cannot express. */
function validateInvariants(c: AppConfig): void {
  const r = c.risk;
  if (r.maxPositionPct > r.maxTotalInvestedPct) {
    throw new Error('MAX_POSITION_PCT cannot exceed MAX_TOTAL_INVESTED_PCT');
  }
  if (r.maxBstockExposurePct + r.maxMemecoinExposurePct < r.maxPositionPct) {
    throw new Error('Asset-class caps are smaller than a single max position');
  }
  if (r.dailyDrawdownBreakerPct >= r.weeklyDrawdownBreakerPct) {
    throw new Error('Daily drawdown breaker must trip before the weekly breaker');
  }
  if (r.slippageCapBstockBps > r.maxPriceImpactBps) {
    throw new Error('bStock slippage cap exceeds the global price-impact ceiling');
  }
  if (c.mode === 'live' && !c.chain.privateKey) {
    throw new Error('Live mode requires WALLET_PRIVATE_KEY');
  }
}

/**
 * Live mode is gated twice: the env flag AND a confirmation file whose contents
 * match the configured phrase. A stray `EXECUTION_MODE=live` cannot arm the
 * agent on its own.
 */
export function assertLiveArmed(c: AppConfig, cwd = process.cwd()): void {
  if (c.mode !== 'live') return;
  const path = resolve(cwd, c.liveConfirmationFile);
  if (!existsSync(path)) {
    throw new Error(`Live mode requires the confirmation file at ${path}`);
  }
  const contents = readFileSync(path, 'utf8').trim();
  if (contents !== c.liveConfirmationPhrase) {
    throw new Error(`Confirmation file must contain exactly: "${c.liveConfirmationPhrase}"`);
  }
}

export function killSwitchEngaged(c: AppConfig, cwd = process.cwd()): boolean {
  return existsSync(resolve(cwd, c.killSwitchFile));
}

/** Redacted view of the config, safe to log or serve from the dashboard. */
export function publicConfig(c: AppConfig): Record<string, unknown> {
  return {
    mode: c.mode,
    chainId: c.chain.id,
    walletAddress: c.chain.address ?? null,
    reasoningModel: c.anthropic.reasoningModel,
    classifyModel: c.anthropic.classifyModel,
    loops: c.loops,
    risk: c.risk,
    safety: c.safety,
    equity: c.equity,
    alertsEnabled: c.alerts.enabled,
  };
}

export function resetConfigCache(): void {
  cached = null;
}
