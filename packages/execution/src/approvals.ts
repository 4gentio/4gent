import { eq, and } from 'drizzle-orm';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { logger, now } from '@4gent/core';
import { erc20Abi, type NonceManager, type GasStrategy } from '@4gent/chain';
import { approvals, type Db } from '@4gent/db';

const log = logger('exec:approvals');

/**
 * Exact-amount approvals only.
 *
 * Infinite approval is the convenient default and a standing invitation: a
 * router exploit would drain everything the wallet holds. The cost of doing it
 * properly on BNB Chain is a few cents of gas per trade.
 */
export class ApprovalManager {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly db: Db,
    private readonly nonces: NonceManager,
    private readonly gas: GasStrategy,
    private readonly owner: Address,
  ) {}

  async ensure(token: Address, spender: Address, amount: bigint): Promise<void> {
    const current = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.owner, spender],
    });

    if (current >= amount) {
      log.debug({ token, spender, current: current.toString() }, 'allowance sufficient');
      return;
    }

    // Some tokens (USDT among them) refuse a non-zero to non-zero change.
    if (current > 0n) await this.submitApproval(token, spender, 0n);
    await this.submitApproval(token, spender, amount);
  }

  private async submitApproval(token: Address, spender: Address, amount: bigint): Promise<Hex> {
    const nonce = await this.nonces.allocate('approve');
    const { gasPrice } = await this.gas.quote();

    const hash = await this.walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
      account: this.walletClient.account!,
      chain: this.walletClient.chain,
      nonce,
      gasPrice,
    });

    await this.nonces.record(nonce, hash, 'approve', { token, spender, amount: amount.toString() }, gasPrice);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
    await this.nonces.resolve(hash, receipt.status === 'success' ? 'confirmed' : 'failed', nonce);

    if (receipt.status !== 'success') {
      throw new Error(`approval transaction ${hash} reverted`);
    }

    await this.db
      .insert(approvals)
      .values({ token, spender, amountRaw: amount.toString(), txHash: hash, updatedAt: now() })
      .onConflictDoUpdate({
        target: [approvals.token, approvals.spender],
        set: { amountRaw: amount.toString(), txHash: hash, updatedAt: now() },
      });

    log.info({ token, spender, amount: amount.toString(), hash }, 'approval confirmed');
    return hash;
  }

  /** Cached view of what we believe is approved, for the dashboard. */
  async recorded(token: Address, spender: Address): Promise<bigint> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.token, token), eq(approvals.spender, spender)))
      .limit(1);
    return rows[0] ? BigInt(rows[0].amountRaw) : 0n;
  }

  /** Revokes every recorded approval. Used by the emergency exit script. */
  async revokeAll(): Promise<number> {
    const rows = await this.db.select().from(approvals);
    let revoked = 0;
    for (const row of rows) {
      if (BigInt(row.amountRaw) === 0n) continue;
      try {
        await this.submitApproval(row.token as Address, row.spender as Address, 0n);
        revoked += 1;
      } catch (error) {
        log.error({ token: row.token, err: String(error) }, 'failed to revoke approval');
      }
    }
    return revoked;
  }
}
