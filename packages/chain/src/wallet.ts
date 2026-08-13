import { formatEther, type Address } from 'viem';
import { fromRaw, logger, type AppConfig } from '@4gent/core';
import { erc20Abi } from './abis.js';
import type { ChainClients } from './clients.js';
import { multicall, unwrapOr } from './multicall.js';

const log = logger('chain:wallet');

export interface TokenBalance {
  token: Address;
  raw: bigint;
  decimals: number;
  amount: number;
}

/**
 * Read-only view of the agent's holdings. Nothing here signs; the wallet's job
 * on the read path is purely to answer "what do we actually own on chain".
 */
export class Wallet {
  constructor(
    private readonly clients: ChainClients,
    private readonly config: AppConfig,
  ) {}

  get address(): Address {
    if (!this.clients.address) {
      throw new Error('No wallet address configured — set WALLET_PRIVATE_KEY or WALLET_ADDRESS');
    }
    return this.clients.address;
  }

  get canSign(): boolean {
    return this.clients.walletClient !== null && this.clients.account !== null;
  }

  async nativeBalance(): Promise<{ raw: bigint; bnb: number }> {
    const raw = await this.clients.publicClient.getBalance({ address: this.address });
    return { raw, bnb: Number(formatEther(raw)) };
  }

  async tokenBalance(token: Address, decimals: number): Promise<TokenBalance> {
    const raw = await this.clients.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.address],
    });
    return { token, raw, decimals, amount: fromRaw(raw, decimals) };
  }

  /** Batched balances for the whole universe in a single round trip. */
  async tokenBalances(tokens: readonly { address: Address; decimals: number }[]): Promise<Map<Address, TokenBalance>> {
    const results = await multicall<bigint>(
      this.clients.publicClient,
      tokens.map((t) => ({
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.address],
      })),
    );
    const out = new Map<Address, TokenBalance>();
    tokens.forEach((t, i) => {
      const raw = unwrapOr(results[i], 0n);
      out.set(t.address, { token: t.address, raw, decimals: t.decimals, amount: fromRaw(raw, t.decimals) });
    });
    return out;
  }

  async allowance(token: Address, spender: Address): Promise<bigint> {
    return this.clients.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.address, spender],
    });
  }

  /**
   * Gas solvency check. BNB fees are small but a wallet at zero native balance
   * silently converts every trade into a failed transaction.
   */
  async assertGasSolvent(minBnb = 0.01): Promise<void> {
    const { bnb } = await this.nativeBalance();
    if (bnb < minBnb) {
      throw new Error(`Wallet holds ${bnb.toFixed(5)} BNB, below the ${minBnb} BNB gas floor`);
    }
    log.debug({ bnb }, 'gas balance ok');
  }

  /** Paper mode never needs a signer; live mode refuses to start without one. */
  assertSignerForMode(): void {
    if (this.config.mode === 'live' && !this.canSign) {
      throw new Error('Live mode requires a signing wallet');
    }
  }
}
