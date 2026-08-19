import { decodeEventLog, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import {
  assertLiveArmed,
  bpsDiff,
  fromRaw,
  logger,
  now,
  PANCAKE_V2_ROUTER,
  PANCAKE_V3_ROUTER,
  sleep,
  type AppConfig,
  type AssetSpec,
  type FillResult,
  type Order,
  type Quote,
  type Side,
  type Universe,
} from '@4gent/core';
import {
  erc20Abi,
  pancakeV2RouterAbi,
  pancakeV3RouterAbi,
  type GasStrategy,
  type NonceManager,
} from '@4gent/chain';
import type { PriceService } from '@4gent/data';
import type { ApprovalManager } from './approvals.js';
import { ExecutionError, type ExecutionEngine } from './engine.js';
import { minOutFor, type Quoter } from './quoter.js';

const log = logger('exec:live');

export interface LiveEngineDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  quoter: Quoter;
  prices: PriceService;
  universe: Universe;
  approvals: ApprovalManager;
  nonces: NonceManager;
  gas: GasStrategy;
  config: AppConfig;
  /** Price of BNB in quote units, for converting gas into accounting terms. */
  bnbPriceProvider: () => number;
}

/**
 * Live execution.
 *
 * The pipeline is fixed and every stage can abort the trade:
 *   quote -> minOut -> approve -> simulate -> sign -> submit -> confirm -> decode
 *
 * The simulate step is not optional. An `eth_call` against the real router at
 * the real block catches fee-on-transfer surprises, insufficient allowance, and
 * router reverts before a signature is ever produced.
 */
export class LiveEngine implements ExecutionEngine {
  readonly mode = 'live' as const;
  private inflight = 0;
  private draining = false;

  constructor(private readonly deps: LiveEngineDeps) {
    assertLiveArmed(deps.config);
    if (!deps.walletClient.account) throw new Error('Live engine requires a signing account');
  }

  async quote(asset: AssetSpec, side: Side, amountIn: bigint): Promise<Quote> {
    return this.deps.quoter.quote(asset, side, amountIn);
  }

  async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    await this.deps.approvals.ensure(token, spender, amount);
  }

  async execute(order: Order, asset: AssetSpec): Promise<FillResult> {
    if (this.draining) throw new ExecutionError('submit', 'engine is draining; refusing new orders');
    this.inflight += 1;
    try {
      return await this.executeInner(order, asset);
    } finally {
      this.inflight -= 1;
    }
  }

  private async executeInner(order: Order, asset: AssetSpec): Promise<FillResult> {
    const router = asset.pool.version === 'v3' ? PANCAKE_V3_ROUTER : PANCAKE_V2_ROUTER;
    const account = this.deps.walletClient.account!;
    const recipient = account.address;

    const quote = await this.quote(asset, order.side, order.amountIn).catch((error) => {
      throw new ExecutionError('quote', String(error), true);
    });
    const minOut = minOutFor(quote, order.slippageBps);
    if (minOut <= 0n) throw new ExecutionError('quote', 'computed minOut of zero');

    await this.ensureAllowance(order.tokenIn, router, order.amountIn);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const request =
      asset.pool.version === 'v3'
        ? ({
            address: router,
            abi: pancakeV3RouterAbi,
            functionName: 'exactInputSingle' as const,
            args: [
              {
                tokenIn: order.tokenIn,
                tokenOut: order.tokenOut,
                fee: asset.pool.feeTier ?? 500,
                recipient,
                amountIn: order.amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0n,
              },
            ],
            account,
          } as const)
        : ({
            address: router,
            abi: pancakeV2RouterAbi,
            functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens' as const,
            args: [order.amountIn, minOut, [order.tokenIn, order.tokenOut], recipient, deadline],
            account,
          } as const);

    // Stage 1: simulate against the live chain state.
    await this.deps.publicClient.simulateContract(request as never).catch((error) => {
      throw new ExecutionError('simulate', `router simulation reverted: ${String(error)}`);
    });

    // Stage 2: gas and nonce.
    const gasEstimate = await this.deps.publicClient
      .estimateContractGas(request as never)
      .catch(() => 300_000n);
    const gasLimit = this.deps.gas.bufferGasLimit(gasEstimate);
    const { gasPrice } = await this.deps.gas.quote();
    const nonce = await this.deps.nonces.allocate('swap', order.symbol);

    // Stage 3: sign and broadcast.
    let hash: Hex;
    try {
      hash = await this.deps.walletClient.writeContract({
        ...(request as never),
        chain: this.deps.walletClient.chain,
        nonce,
        gas: gasLimit,
        gasPrice,
      });
    } catch (error) {
      await this.deps.nonces.resync();
      throw new ExecutionError('submit', `broadcast failed: ${String(error)}`, true);
    }

    await this.deps.nonces.record(
      nonce,
      hash,
      'swap',
      { symbol: order.symbol, side: order.side, amountIn: order.amountIn.toString(), minOut: minOut.toString() },
      gasPrice,
      order.symbol,
    );
    log.info({ symbol: order.symbol, side: order.side, hash, nonce }, 'swap broadcast');

    // Stage 4: confirm, replacing the transaction if it stalls.
    const receipt = await this.confirmOrReplace(hash, nonce, request, gasPrice, gasLimit, order);
    await this.deps.nonces.resolve(receipt.transactionHash, receipt.status === 'success' ? 'confirmed' : 'failed', nonce);

    if (receipt.status !== 'success') {
      throw new ExecutionError('confirm', `swap ${receipt.transactionHash} reverted on chain`);
    }

    // Stage 5: decode the actual fill from the transfer logs.
    const amountOut = this.decodeReceived(receipt.logs, order.tokenOut, recipient);
    if (amountOut <= 0n) throw new ExecutionError('decode', 'no inbound transfer found in receipt logs');

    const inDecimals = order.side === 'buy' ? this.deps.universe.quoteAsset.decimals : asset.decimals;
    const outDecimals = order.side === 'buy' ? asset.decimals : this.deps.universe.quoteAsset.decimals;
    const amountInDec = fromRaw(order.amountIn, inDecimals);
    const amountOutDec = fromRaw(amountOut, outDecimals);
    const fillPrice = order.side === 'buy' ? amountInDec / amountOutDec : amountOutDec / amountInDec;

    const gasQuote = this.deps.gas.gasCostInQuote(
      receipt.gasUsed,
      receipt.effectiveGasPrice ?? gasPrice,
      this.deps.bnbPriceProvider(),
    );
    const notional = order.side === 'buy' ? amountInDec : amountOutDec;

    const result: FillResult = {
      txHash: receipt.transactionHash,
      amountIn: order.amountIn,
      amountOut,
      fillPrice,
      gasQuote,
      feeQuote: (notional * (asset.pool.feeTier ?? 2_500)) / 1_000_000,
      slippageBps: Math.abs(bpsDiff(fillPrice, quote.midPrice)),
      blockNumber: receipt.blockNumber,
      mode: 'live',
    };

    log.info(
      { symbol: order.symbol, hash: receipt.transactionHash, fillPrice, gasQuote, slippageBps: result.slippageBps },
      'live fill confirmed',
    );
    return result;
  }

  /**
   * Waits for inclusion, bumping the gas price and resubmitting at the same
   * nonce if the transaction stalls. Replacement, not a second trade.
   */
  private async confirmOrReplace(
    hash: Hex,
    nonce: number,
    request: unknown,
    gasPrice: bigint,
    gasLimit: bigint,
    order: Order,
  ) {
    let currentHash = hash;
    let currentGas = gasPrice;

    for (let attempt = 0; attempt <= this.deps.gas.policy.maxReplacements; attempt += 1) {
      try {
        return await this.deps.publicClient.waitForTransactionReceipt({
          hash: currentHash,
          confirmations: 1,
          timeout: 45_000,
        });
      } catch {
        if (attempt === this.deps.gas.policy.maxReplacements) {
          throw new ExecutionError('confirm', `swap ${currentHash} never confirmed after ${attempt + 1} attempts`);
        }
        currentGas = this.deps.gas.bump(currentGas, attempt + 1);
        log.warn({ symbol: order.symbol, nonce, attempt, gasPriceGwei: Number(currentGas) / 1e9 }, 'bumping stalled swap');
        await sleep(1_000);

        const replacement = await this.deps.walletClient.writeContract({
          ...(request as never),
          chain: this.deps.walletClient.chain,
          nonce,
          gas: gasLimit,
          gasPrice: currentGas,
        });
        await this.deps.nonces.markReplaced(currentHash, replacement, nonce, currentGas, {
          symbol: order.symbol,
        });
        currentHash = replacement;
      }
    }
    throw new ExecutionError('confirm', 'exhausted replacement attempts');
  }

  /** Sums inbound ERC-20 transfers of `token` to `recipient` in a receipt. */
  private decodeReceived(logs: readonly { address: string; topics: readonly string[]; data: string }[], token: Address, recipient: Address): bigint {
    let total = 0n;
    for (const entry of logs) {
      if (entry.address.toLowerCase() !== token.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: erc20Abi,
          data: entry.data as Hex,
          topics: entry.topics as [Hex, ...Hex[]],
        });
        if (decoded.eventName !== 'Transfer') continue;
        const args = decoded.args as unknown as { to: Address; value: bigint };
        if (args.to.toLowerCase() === recipient.toLowerCase()) total += args.value;
      } catch {
        // Not a Transfer event we recognise; skip it.
      }
    }
    return total;
  }

  async drain(timeoutMs = 120_000): Promise<void> {
    this.draining = true;
    const deadline = now() + timeoutMs;
    while (this.inflight > 0 && now() < deadline) {
      log.info({ inflight: this.inflight }, 'draining in-flight swaps');
      await sleep(1_000);
    }
    if (this.inflight > 0) {
      log.error({ inflight: this.inflight }, 'drain timed out with swaps still in flight');
    }
  }
}
