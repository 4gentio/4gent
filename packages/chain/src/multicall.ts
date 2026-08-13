import type { Abi, Address, PublicClient } from 'viem';
import { FailClosedError, logger } from '@4gent/core';

const log = logger('chain:multicall');

export interface Call<TAbi extends Abi = Abi> {
  address: Address;
  abi: TAbi;
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Batched read via Multicall3 with per-call failure isolation. One reverting
 * pool must not blind the agent to every other pool in the same batch, so we
 * always use `allowFailure` and surface partial results.
 */
export async function multicall<T = unknown>(
  client: PublicClient,
  calls: readonly Call[],
  opts: { blockNumber?: bigint; batchSize?: number } = {},
): Promise<CallResult<T>[]> {
  if (calls.length === 0) return [];
  const results = await client.multicall({
    contracts: calls as never,
    allowFailure: true,
    batchSize: opts.batchSize ?? 1024,
    ...(opts.blockNumber ? { blockNumber: opts.blockNumber } : {}),
  });

  return results.map((r, i) => {
    if (r.status === 'success') return { ok: true, value: r.result as T };
    const call = calls[i]!;
    const message = r.error instanceof Error ? r.error.message : String(r.error);
    log.debug({ address: call.address, fn: call.functionName, message }, 'multicall leg failed');
    return { ok: false, error: message };
  });
}

/** Variant that fails closed if any leg reverted. Use on the execution path. */
export async function multicallStrict<T = unknown>(
  client: PublicClient,
  calls: readonly Call[],
  opts: { blockNumber?: bigint } = {},
): Promise<T[]> {
  const results = await multicall<T>(client, calls, opts);
  const failures = results
    .map((r, i) => (r.ok ? null : `${calls[i]!.functionName}@${calls[i]!.address}: ${r.error}`))
    .filter(Boolean);
  if (failures.length > 0) {
    throw new FailClosedError(`Multicall had ${failures.length} failing leg(s): ${failures.join('; ')}`);
  }
  return results.map((r) => (r as { ok: true; value: T }).value);
}

export function unwrapOr<T>(result: CallResult<T> | undefined, fallback: T): T {
  return result && result.ok ? result.value : fallback;
}

/** Reads a batch at a single pinned block so every value shares one snapshot. */
export async function multicallAtHead<T = unknown>(
  client: PublicClient,
  calls: readonly Call[],
): Promise<{ blockNumber: bigint; results: CallResult<T>[] }> {
  const blockNumber = await client.getBlockNumber();
  const results = await multicall<T>(client, calls, { blockNumber });
  return { blockNumber, results };
}
