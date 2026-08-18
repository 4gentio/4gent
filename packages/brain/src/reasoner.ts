import { eq } from 'drizzle-orm';
import {
  logger,
  now,
  type AppConfig,
  type Decision,
  type Symbol_,
} from '@4gent/core';
import { decisionOutcomes, reasoningLog, type Db } from '@4gent/db';
import { fitToBudget, serializeSnapshot, type MarketSnapshot } from '@4gent/data';
import type { ReasoningClient } from './client.js';
import { actionable, parseBrainResponse, sanitizeDecisions } from './parse.js';
import { buildUserPrompt, hashPrompt, SYSTEM_PROMPT } from './prompts.js';

const log = logger('brain:reasoner');

export interface CycleInput {
  snapshot: MarketSnapshot;
  knownSymbols: Set<Symbol_>;
  openSymbols: Set<Symbol_>;
  operatorNote?: string;
}

export interface CycleResult {
  cycleId: number;
  decisions: Decision[];
  discarded: { decision: Decision; reason: string }[];
  portfolioNote: string;
  /** True when the model failed validation twice and the agent held. */
  heldOnFailure: boolean;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; latencyMs: number };
}

/**
 * One reasoning cycle, start to finish.
 *
 * The contract with the rest of the system is narrow on purpose: this returns
 * validated intent and nothing else. It has no access to the wallet, the router
 * or the risk limits, so a compromised or confused model cannot do more than
 * propose a trade that the next layer will refuse.
 */
export class Reasoner {
  constructor(
    private readonly client: ReasoningClient,
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  async runCycle(input: CycleInput): Promise<CycleResult> {
    const snapshot = fitToBudget(input.snapshot);
    const startedAt = now();

    const firstUser = buildUserPrompt({ snapshot, operatorNote: input.operatorNote });
    const promptHash = hashPrompt(SYSTEM_PROMPT, firstUser);

    const inserted = await this.db
      .insert(reasoningLog)
      .values({
        model: this.config.anthropic.reasoningModel,
        promptHash,
        systemPrompt: SYSTEM_PROMPT,
        snapshot: snapshot as never,
        rawResponse: '',
        startedAt,
      })
      .returning({ id: reasoningLog.id });
    const cycleId = inserted[0]!.id;

    let completion = await this.client.complete({ system: SYSTEM_PROMPT, user: firstUser });
    let parsed = parseBrainResponse(completion.text);
    let validationError: string | null = null;
    let usage = { ...toUsage(completion) };

    // Exactly one repair attempt, with the validation error fed back verbatim.
    if (!parsed.ok) {
      validationError = parsed.error;
      log.warn({ cycleId, error: parsed.error }, 'first response invalid, attempting repair');
      const repairUser = buildUserPrompt({
        snapshot,
        operatorNote: input.operatorNote,
        repairHint: parsed.hint,
      });
      const retry = await this.client.complete({ system: SYSTEM_PROMPT, user: repairUser });
      usage = mergeUsage(usage, toUsage(retry));
      completion = { ...retry, text: retry.text };
      parsed = parseBrainResponse(retry.text);
    }

    if (!parsed.ok) {
      // Fail closed: two invalid responses means the agent holds everything.
      log.error({ cycleId, error: parsed.error }, 'reasoning failed validation twice — holding');
      await this.db
        .update(reasoningLog)
        .set({
          rawResponse: completion.text,
          validationError: `${validationError ?? ''}\n---\n${parsed.error}`.trim(),
          parsedDecisions: [] as never,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          latencyMs: usage.latencyMs,
          completedAt: now(),
        })
        .where(eq(reasoningLog.id, cycleId));
      return {
        cycleId,
        decisions: [],
        discarded: [],
        portfolioNote: '',
        heldOnFailure: true,
        usage,
      };
    }

    const { accepted, discarded } = sanitizeDecisions(parsed.value, {
      knownSymbols: input.knownSymbols,
      openSymbols: input.openSymbols,
      closeOnly: snapshot.limits.closeOnly,
    });

    await this.db
      .update(reasoningLog)
      .set({
        rawResponse: completion.text,
        parsedDecisions: accepted as never,
        portfolioNote: parsed.value.portfolio_note,
        validationError,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        latencyMs: usage.latencyMs,
        completedAt: now(),
      })
      .where(eq(reasoningLog.id, cycleId));

    await this.recordIntent(cycleId, accepted, discarded);

    log.info(
      {
        cycleId,
        accepted: accepted.length,
        discarded: discarded.length,
        cached: usage.cachedTokens,
        latencyMs: usage.latencyMs,
      },
      'reasoning cycle complete',
    );

    return {
      cycleId,
      decisions: accepted,
      discarded,
      portfolioNote: parsed.value.portfolio_note,
      heldOnFailure: false,
      usage,
    };
  }

  /**
   * Writes every decision to the outcome ledger, including discarded ones.
   * Recording rejections is what lets the rolling memory show the model that a
   * particular kind of proposal keeps getting refused.
   */
  private async recordIntent(
    cycleId: number,
    accepted: readonly Decision[],
    discarded: readonly { decision: Decision; reason: string }[],
  ): Promise<void> {
    const rows = [
      ...actionable(accepted).map((d) => ({
        reasoningCycleId: cycleId,
        symbol: d.symbol,
        action: d.action,
        conviction: d.conviction,
        thesis: d.thesis,
        invalidation: d.invalidation,
        outcome: 'open' as const,
        rejectionReason: null,
        createdAt: now(),
      })),
      ...discarded.map((d) => ({
        reasoningCycleId: cycleId,
        symbol: d.decision.symbol,
        action: d.decision.action,
        conviction: d.decision.conviction,
        thesis: d.decision.thesis,
        invalidation: d.decision.invalidation,
        outcome: 'rejected' as const,
        rejectionReason: d.reason,
        createdAt: now(),
      })),
    ];
    if (rows.length > 0) await this.db.insert(decisionOutcomes).values(rows);
  }

  /** Called by the portfolio layer when a position originating here closes. */
  async resolveOutcome(
    cycleId: number,
    symbol: Symbol_,
    result: { entryPrice: number; exitPrice: number; pnl: number },
  ): Promise<void> {
    const outcome = result.pnl > 0 ? 'win' : result.pnl < 0 ? 'loss' : 'flat';
    await this.db
      .update(decisionOutcomes)
      .set({ ...result, outcome, resolvedAt: now() })
      .where(eq(decisionOutcomes.reasoningCycleId, cycleId));
    log.debug({ cycleId, symbol, outcome, pnl: result.pnl }, 'decision outcome resolved');
  }

  /** Snapshot serialisation used by the dashboard's cycle detail view. */
  static serialize(snapshot: MarketSnapshot): string {
    return serializeSnapshot(snapshot);
  }
}

function toUsage(c: { inputTokens: number; outputTokens: number; cachedTokens: number; latencyMs: number }) {
  return {
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cachedTokens: c.cachedTokens,
    latencyMs: c.latencyMs,
  };
}

function mergeUsage(a: ReturnType<typeof toUsage>, b: ReturnType<typeof toUsage>) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}
