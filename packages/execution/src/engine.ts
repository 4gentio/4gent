import type { AssetSpec, FillResult, Order, Quote, Side } from '@4gent/core';

/**
 * The interface both engines implement.
 *
 * Paper and live are behind one contract so that the keeper, risk layer, and
 * accounting never branch on execution mode. Switching a host from paper to
 * live changes which class is constructed and nothing else.
 */
export interface ExecutionEngine {
  readonly mode: 'paper' | 'live';
  quote(asset: AssetSpec, side: Side, amountIn: bigint): Promise<Quote>;
  execute(order: Order, asset: AssetSpec): Promise<FillResult>;
  /** Ensures the router can move `amount` of `token`. No-op in paper mode. */
  ensureAllowance(token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<void>;
  /** Drains anything in flight so the process can exit cleanly. */
  drain(timeoutMs?: number): Promise<void>;
}

export class ExecutionError extends Error {
  readonly stage: 'quote' | 'simulate' | 'sign' | 'submit' | 'confirm' | 'decode';
  readonly retryable: boolean;

  constructor(stage: ExecutionError['stage'], message: string, retryable = false) {
    super(message);
    this.name = 'ExecutionError';
    this.stage = stage;
    this.retryable = retryable;
  }
}
