import Anthropic from '@anthropic-ai/sdk';
import {
  FailClosedError,
  logger,
  now,
  sentimentSchema,
  triageVerdictSchema,
  withRetry,
  type AppConfig,
  type Sentiment,
  type TriageVerdict,
} from '@4gent/core';
import { SENTIMENT_SYSTEM_PROMPT, TRIAGE_SYSTEM_PROMPT } from './prompts.js';

const log = logger('brain:client');

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  model: string;
  stopReason: string | null;
}

/** Narrow surface so tests can substitute a deterministic fake. */
export interface ReasoningClient {
  complete(args: {
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    cacheSystem?: boolean;
  }): Promise<CompletionResult>;
}

/**
 * Anthropic-backed reasoning client.
 *
 * The system prompt is marked as a cache breakpoint: it is several thousand
 * tokens, identical on every cycle, and the agent reasons on a five-minute
 * cadence, so caching removes most of the per-cycle input cost.
 */
export class AnthropicClient implements ReasoningClient {
  private readonly sdk: Anthropic;

  constructor(private readonly config: AppConfig) {
    if (!config.anthropic.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required to run the reasoning layer');
    }
    this.sdk = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 0, timeout: 120_000 });
  }

  async complete(args: {
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    cacheSystem?: boolean;
  }): Promise<CompletionResult> {
    const model = args.model ?? this.config.anthropic.reasoningModel;
    const startedAt = now();

    const response = await withRetry(
      () =>
        this.sdk.messages.create({
          model,
          max_tokens: args.maxTokens ?? this.config.anthropic.maxTokens,
          temperature: args.temperature ?? this.config.anthropic.temperature,
          system: args.cacheSystem === false
            ? args.system
            : [{ type: 'text' as const, text: args.system, cache_control: { type: 'ephemeral' as const } }],
          messages: [{ role: 'user', content: args.user }],
        }),
      {
        attempts: 3,
        baseMs: 1_000,
        maxMs: 15_000,
        onRetry: (err, attempt) => log.warn({ attempt, err: String(err) }, 'anthropic call failed, retrying'),
      },
    ).catch((error) => {
      throw new FailClosedError('Reasoning model unreachable', error);
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const usage = response.usage;
    return {
      text,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      latencyMs: now() - startedAt,
      model,
      stopReason: response.stop_reason ?? null,
    };
  }
}

/**
 * Cheap classification tasks run on the small model. These are advisory only —
 * nothing they return can unblock a hard safety rule.
 */
export class Classifier {
  constructor(
    private readonly client: ReasoningClient,
    private readonly config: AppConfig,
  ) {}

  async classify(evidence: unknown): Promise<TriageVerdict> {
    const result = await this.client.complete({
      system: TRIAGE_SYSTEM_PROMPT,
      user: `# Evidence\n${JSON.stringify(evidence, bigintReplacer)}`,
      model: this.config.anthropic.classifyModel,
      maxTokens: 512,
      temperature: 0,
    });
    return triageVerdictSchema.parse(extractJson(result.text));
  }

  async sentiment(text: string): Promise<Sentiment> {
    const result = await this.client.complete({
      system: SENTIMENT_SYSTEM_PROMPT,
      user: text.slice(0, 4_000),
      model: this.config.anthropic.classifyModel,
      maxTokens: 256,
      temperature: 0,
    });
    return sentimentSchema.parse(extractJson(result.text));
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('classifier returned no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Deterministic stand-in used by tests and by `--offline` dry runs. */
export class StaticReasoningClient implements ReasoningClient {
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async complete(): Promise<CompletionResult> {
    const text = this.responses[Math.min(this.index, this.responses.length - 1)] ?? '{"decisions":[],"portfolio_note":""}';
    this.index += 1;
    return {
      text,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      latencyMs: 0,
      model: 'static',
      stopReason: 'end_turn',
    };
  }
}
