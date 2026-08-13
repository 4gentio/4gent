import { parseGwei, type PublicClient } from 'viem';
import { logger } from '@4gent/core';

const log = logger('chain:gas');

/**
 * BNB Chain gas policy.
 *
 * Fees are cheap in absolute terms, so the objective is not to minimise cost —
 * it is to avoid a swap sitting unmined while the pool moves against us. We
 * therefore bid a modest premium over the network price and escalate hard on
 * replacement.
 */
export interface GasPolicy {
  /** Floor bid, protects against RPCs reporting an unrealistically low price. */
  minGasPriceGwei: number;
  /** Absolute ceiling; above this we would rather not trade at all. */
  maxGasPriceGwei: number;
  /** Premium applied to the network price on first submission, in bps. */
  premiumBps: number;
  /** Multiplier applied per bump-and-replace attempt. BSC requires >= 1.1x. */
  replacementMultiplier: number;
  /** Attempts before the tx is abandoned and the trade is failed closed. */
  maxReplacements: number;
  /** Headroom added to the estimated gas limit, in bps. */
  gasLimitBufferBps: number;
}

export const DEFAULT_GAS_POLICY: GasPolicy = {
  minGasPriceGwei: 1,
  maxGasPriceGwei: 15,
  premiumBps: 1_500,
  replacementMultiplier: 1.15,
  maxReplacements: 3,
  gasLimitBufferBps: 2_500,
};

export interface GasQuote {
  gasPrice: bigint;
  gasPriceGwei: number;
  source: 'network' | 'floor' | 'ceiling';
}

function gweiToWei(gwei: number): bigint {
  return parseGwei(gwei.toFixed(9) as `${number}`);
}

export class GasStrategy {
  constructor(
    private readonly client: PublicClient,
    readonly policy: GasPolicy = DEFAULT_GAS_POLICY,
  ) {}

  /** Legacy pricing: BSC still settles on gasPrice rather than EIP-1559 tips. */
  async quote(): Promise<GasQuote> {
    const network = await this.client.getGasPrice();
    const withPremium = network + (network * BigInt(this.policy.premiumBps)) / 10_000n;
    const floor = gweiToWei(this.policy.minGasPriceGwei);
    const ceiling = gweiToWei(this.policy.maxGasPriceGwei);

    if (withPremium < floor) {
      return { gasPrice: floor, gasPriceGwei: this.policy.minGasPriceGwei, source: 'floor' };
    }
    if (withPremium > ceiling) {
      log.warn(
        { networkGwei: Number(network) / 1e9, ceiling: this.policy.maxGasPriceGwei },
        'network gas above ceiling — clamping',
      );
      return { gasPrice: ceiling, gasPriceGwei: this.policy.maxGasPriceGwei, source: 'ceiling' };
    }
    return { gasPrice: withPremium, gasPriceGwei: Number(withPremium) / 1e9, source: 'network' };
  }

  /** Bid for attempt N of a bump-and-replace sequence. */
  bump(previous: bigint, attempt: number): bigint {
    const multiplier = this.policy.replacementMultiplier ** Math.max(1, attempt);
    const bumped = BigInt(Math.ceil(Number(previous) * multiplier));
    const ceiling = gweiToWei(this.policy.maxGasPriceGwei * 2);
    return bumped > ceiling ? ceiling : bumped;
  }

  /** Adds headroom to an estimate so a borderline swap does not run out of gas. */
  bufferGasLimit(estimate: bigint): bigint {
    return estimate + (estimate * BigInt(this.policy.gasLimitBufferBps)) / 10_000n;
  }

  /** Converts a gas bill into quote-asset terms for trade accounting. */
  gasCostInQuote(gasUsed: bigint, gasPrice: bigint, bnbPriceInQuote: number): number {
    const wei = gasUsed * gasPrice;
    return (Number(wei) / 1e18) * bnbPriceInQuote;
  }

  async estimateSwapCost(bnbPriceInQuote: number, gasLimit = 260_000n): Promise<number> {
    const { gasPrice } = await this.quote();
    return this.gasCostInQuote(gasLimit, gasPrice, bnbPriceInQuote);
  }
}
