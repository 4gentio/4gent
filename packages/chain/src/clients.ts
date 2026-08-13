import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { FailClosedError, logger, withRetry, type AppConfig } from '@4gent/core';
import { MULTICALL3 } from '@4gent/core';

const log = logger('chain:clients');

export interface ChainClients {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | null;
  readonly account: Account | null;
  readonly address: `0x${string}` | null;
  readonly chainId: number;
}

/**
 * A single fallback transport spanning the primary and backup RPCs. viem ranks
 * them by latency and rotates automatically, so a flaky dataseed degrades into
 * higher latency rather than a stalled loop.
 */
export function createChainClients(config: AppConfig): ChainClients {
  const transport = fallback(
    [
      http(config.chain.rpcPrimary, { batch: true, timeout: 10_000, retryCount: 2 }),
      http(config.chain.rpcFallback, { batch: true, timeout: 10_000, retryCount: 2 }),
    ],
    { rank: { interval: 60_000, sampleCount: 5 } },
  );

  const publicClient = createPublicClient({
    chain: bsc,
    transport,
    batch: { multicall: { batchSize: 1024, wait: 16 } },
  }) as PublicClient;

  let account: Account | null = null;
  let walletClient: WalletClient | null = null;

  if (config.chain.privateKey) {
    account = privateKeyToAccount(config.chain.privateKey);
    walletClient = createWalletClient({ account, chain: bsc, transport });
  }

  const address = account?.address ?? config.chain.address ?? null;
  log.info(
    { chainId: config.chain.id, address, signer: account ? 'loaded' : 'none' },
    'chain clients created',
  );

  return {
    publicClient,
    walletClient,
    account,
    address: address ? (address.toLowerCase() as `0x${string}`) : null,
    chainId: config.chain.id,
  };
}

export const MULTICALL3_ADDRESS = MULTICALL3;

/**
 * Health check used by the keeper before every trading decision. A chain whose
 * head has not advanced is treated as unreachable — stale state is worse than
 * no state.
 */
export async function assertChainHealthy(
  clients: ChainClients,
  opts: { maxBlockAgeMs?: number; expectedChainId?: number } = {},
): Promise<{ blockNumber: bigint; blockAgeMs: number }> {
  const maxBlockAgeMs = opts.maxBlockAgeMs ?? 30_000;
  try {
    const block = await withRetry(() => clients.publicClient.getBlock({ blockTag: 'latest' }), {
      attempts: 3,
      baseMs: 200,
    });
    const blockAgeMs = Date.now() - Number(block.timestamp) * 1000;
    if (blockAgeMs > maxBlockAgeMs) {
      throw new FailClosedError(`Chain head is ${Math.round(blockAgeMs / 1000)}s stale`);
    }
    const chainId = opts.expectedChainId ?? clients.chainId;
    const actual = await clients.publicClient.getChainId();
    if (actual !== chainId) {
      throw new FailClosedError(`RPC reports chainId ${actual}, expected ${chainId}`);
    }
    return { blockNumber: block.number, blockAgeMs };
  } catch (error) {
    if (error instanceof FailClosedError) throw error;
    throw new FailClosedError('Chain health check failed', error);
  }
}
