import { z } from 'zod';
import { brainResponseSchema, logger, type BrainResponse, type Decision } from '@4gent/core';

const log = logger('brain:parse');

export interface ParseSuccess {
  ok: true;
  value: BrainResponse;
  repaired: boolean;
}

export interface ParseFailure {
  ok: false;
  error: string;
  /** Feedback string suitable for a single repair round trip. */
  hint: string;
}

export type ParseOutcome = ParseSuccess | ParseFailure;

/**
 * Extracts and validates the decision object from a model response.
 *
 * Models occasionally wrap JSON in a fence or add a leading sentence despite
 * instructions. We tolerate that shape-level noise because it is cosmetic, but
 * anything that fails the schema is a hard failure that triggers exactly one
 * repair attempt and then a fail-closed hold.
 */
export function parseBrainResponse(raw: string): ParseOutcome {
  const candidate = extractJsonObject(raw);
  if (!candidate) {
    return {
      ok: false,
      error: 'no JSON object found in response',
      hint: 'Your response contained no parseable JSON object. Return only the JSON object, starting with { and ending with }.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.text);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON: ${String(error)}`,
      hint: `Your JSON did not parse (${String(error)}). Return a single valid JSON object with no trailing commas or comments.`,
    };
  }

  const result = brainResponseSchema.safeParse(parsed);
  if (!result.success) {
    const issues = formatIssues(result.error);
    log.warn({ issues }, 'brain response failed schema validation');
    return {
      ok: false,
      error: issues,
      hint: `Your JSON did not match the required schema:\n${issues}`,
    };
  }

  return { ok: true, value: result.data, repaired: candidate.repaired };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `- ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

/** Finds the outermost balanced JSON object, ignoring braces inside strings. */
function extractJsonObject(raw: string): { text: string; repaired: boolean } | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return { text: trimmed, repaired: false };

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return { text: fence[1].trim(), repaired: true };

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { text: trimmed.slice(start, i + 1), repaired: true };
    }
  }
  return null;
}

export interface SanitizeResult {
  accepted: Decision[];
  discarded: { decision: Decision; reason: string }[];
}

/**
 * Post-schema semantic filtering. The schema proves the shape; this proves the
 * decision refers to something the agent can actually act on.
 */
export function sanitizeDecisions(
  response: BrainResponse,
  ctx: { knownSymbols: Set<string>; openSymbols: Set<string>; closeOnly: boolean },
): SanitizeResult {
  const accepted: Decision[] = [];
  const discarded: { decision: Decision; reason: string }[] = [];
  const seen = new Set<string>();

  for (const decision of response.decisions) {
    const symbol = decision.symbol;

    if (!ctx.knownSymbols.has(symbol)) {
      discarded.push({ decision, reason: `unknown symbol "${symbol}"` });
      continue;
    }
    if (seen.has(symbol)) {
      discarded.push({ decision, reason: 'duplicate decision for symbol' });
      continue;
    }
    if (ctx.closeOnly && (decision.action === 'open_long' || decision.action === 'add')) {
      discarded.push({ decision, reason: 'close-only mode is active' });
      continue;
    }
    if ((decision.action === 'close' || decision.action === 'reduce' || decision.action === 'add') && !ctx.openSymbols.has(symbol)) {
      discarded.push({ decision, reason: `no open position in ${symbol}` });
      continue;
    }
    if (decision.action === 'open_long' && ctx.openSymbols.has(symbol)) {
      discarded.push({ decision, reason: 'position already open; use add instead' });
      continue;
    }
    if ((decision.action === 'open_long' || decision.action === 'add') && decision.size_pct_of_available <= 0) {
      discarded.push({ decision, reason: 'zero size on an opening action' });
      continue;
    }

    seen.add(symbol);
    accepted.push(decision);
  }

  if (discarded.length > 0) {
    log.info({ discarded: discarded.map((d) => `${d.decision.symbol}: ${d.reason}`) }, 'decisions discarded');
  }
  return { accepted, discarded };
}

/** Actionable decisions only — holds are recorded but never routed. */
export function actionable(decisions: readonly Decision[]): Decision[] {
  return decisions.filter((d) => d.action !== 'hold');
}
