import { z } from 'zod';

/**
 * Every value crossing a trust boundary — LLM output, HTTP response, RPC
 * decode — is parsed here first. Nothing downstream accepts `any`.
 */

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'expected a 20-byte hex address')
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const hexSchema = z.string().regex(/^0x[a-fA-F0-9]*$/) as z.ZodType<`0x${string}`>;

export const assetClassSchema = z.enum(['bstock', 'memecoin', 'quote']);
export const dexVersionSchema = z.enum(['v3', 'v2']);
export const timeHorizonSchema = z.enum(['scalp', 'swing', 'position']);
export const convictionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export const decisionActionSchema = z.enum(['open_long', 'close', 'reduce', 'add', 'hold']);

// --- Brain output contract --------------------------------------------------

export const decisionSchema = z
  .object({
    action: decisionActionSchema,
    symbol: z.string().min(1).max(24),
    conviction: convictionSchema,
    size_pct_of_available: z.number().min(0).max(100),
    time_horizon: timeHorizonSchema,
    thesis: z.string().min(1).max(400),
    invalidation: z.string().min(1).max(300),
  })
  .strict();

export const brainResponseSchema = z
  .object({
    decisions: z.array(decisionSchema).max(12),
    portfolio_note: z.string().max(800).default(''),
  })
  .strict();

export type Decision = z.infer<typeof decisionSchema>;
export type BrainResponse = z.infer<typeof brainResponseSchema>;

/** Haiku triage verdict for a memecoin that passed deterministic checks. */
export const triageVerdictSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'uncertain']),
    risk_score: z.number().min(0).max(100),
    flags: z.array(z.string().max(120)).max(10),
    rationale: z.string().max(500),
  })
  .strict();

export type TriageVerdict = z.infer<typeof triageVerdictSchema>;

/** Haiku sentiment classification for a news/social item. */
export const sentimentSchema = z
  .object({
    label: z.enum(['bullish', 'bearish', 'neutral']),
    strength: z.number().min(0).max(1),
    summary: z.string().max(240),
  })
  .strict();

export type Sentiment = z.infer<typeof sentimentSchema>;

// --- External API responses -------------------------------------------------

export const stooqQuoteSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  time: z.string(),
  close: z.coerce.number().positive(),
});

export const yahooQuoteSchema = z.object({
  quoteResponse: z.object({
    result: z.array(
      z.object({
        symbol: z.string(),
        regularMarketPrice: z.number().positive(),
        regularMarketTime: z.number().int(),
        marketState: z.string().optional(),
      }),
    ),
  }),
});

export const telegramSendResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
});

// --- Universe configuration -------------------------------------------------

export const poolSpecSchema = z.object({
  address: addressSchema,
  version: dexVersionSchema,
  feeTier: z.number().int().positive().optional(),
  token0: addressSchema,
  token1: addressSchema,
  token0Decimals: z.number().int().min(0).max(36),
  token1Decimals: z.number().int().min(0).max(36),
  assetIsToken0: z.boolean(),
});

export const assetSpecSchema = z.object({
  symbol: z.string().min(1).max(24),
  assetClass: assetClassSchema,
  address: addressSchema,
  decimals: z.number().int().min(0).max(36),
  pool: poolSpecSchema,
  underlying: z.string().max(12).optional(),
  navRatio: z.number().positive().default(1),
  sector: z.string().max(32).optional(),
  enabled: z.boolean().default(true),
});

export const universeSchema = z.object({
  quote: assetSpecSchema.omit({ pool: true, underlying: true, navRatio: true }).extend({
    pool: poolSpecSchema.optional(),
  }),
  assets: z.array(assetSpecSchema),
});

export type UniverseConfig = z.infer<typeof universeSchema>;
