import { and, eq } from 'drizzle-orm';
import type { Address, Hex, PublicClient } from 'viem';
import { logger, now } from '@4gent/core';
import { pendingTxs, type Db } from '@4gent/db';

const log = logger('chain:nonce');

/**
 * Nonce allocation with crash-safe bookkeeping.
 *
 * Every allocated nonce is written to `pending_txs` before the transaction is
 * broadcast. On restart we reconcile that table against the chain, which is
 * what makes a mid-swap crash recoverable instead of a double-send.
 */
export class NonceManager {
  private next: number | null = null;
  private readonly inflight = new Set<number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: PublicClient,
    private readonly db: Db,
    private readonly address: Address,
  ) {}

  /** Serialise allocation so two concurrent orders cannot claim one nonce. */
  async allocate(kind: 'swap' | 'approve' | 'transfer', symbol?: string): Promise<number> {
    const task = this.queue.then(() => this.allocateInner(kind, symbol));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async allocateInner(kind: 'swap' | 'approve' | 'transfer', symbol?: string): Promise<number> {
    if (this.next === null) await this.resync();
    const nonce = this.next!;
    this.next = nonce + 1;
    this.inflight.add(nonce);
    log.debug({ nonce, kind, symbol }, 'nonce allocated');
    return nonce;
  }

  /** Re-read the chain's pending nonce. Called at boot and after any failure. */
  async resync(): Promise<number> {
    const pending = await this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
    this.next = pending;
    log.info({ address: this.address, nonce: pending }, 'nonce resynced from chain');
    return pending;
  }

  async record(nonce: number, txHash: Hex, kind: 'swap' | 'approve' | 'transfer', payload: unknown, gasPriceWei: bigint, symbol?: string): Promise<void> {
    await this.db
      .insert(pendingTxs)
      .values({
        nonce,
        txHash,
        kind,
        symbol: symbol ?? null,
        payload: payload as never,
        status: 'pending',
        gasPriceWei: gasPriceWei.toString(),
        attempts: 1,
        submittedAt: now(),
      })
      .onConflictDoNothing();
  }

  async markReplaced(oldHash: Hex, newHash: Hex, nonce: number, gasPriceWei: bigint, payload: unknown): Promise<void> {
    await this.db
      .update(pendingTxs)
      .set({ status: 'replaced', resolvedAt: now() })
      .where(eq(pendingTxs.txHash, oldHash));
    await this.db.insert(pendingTxs).values({
      nonce,
      txHash: newHash,
      kind: 'swap',
      payload: payload as never,
      status: 'pending',
      gasPriceWei: gasPriceWei.toString(),
      attempts: 2,
      submittedAt: now(),
    });
  }

  async resolve(txHash: Hex, status: 'confirmed' | 'failed', nonce?: number): Promise<void> {
    await this.db
      .update(pendingTxs)
      .set({ status, resolvedAt: now() })
      .where(eq(pendingTxs.txHash, txHash));
    if (nonce !== undefined) this.inflight.delete(nonce);
  }

  /**
   * Boot-time recovery: every row still marked pending is checked against the
   * chain. Confirmed transactions are settled; anything the chain never saw is
   * released so its nonce can be reused.
   */
  async recoverPending(): Promise<{ confirmed: number; failed: number; dropped: number }> {
    const rows = await this.db.select().from(pendingTxs).where(eq(pendingTxs.status, 'pending'));
    let confirmed = 0;
    let failed = 0;
    let dropped = 0;

    for (const row of rows) {
      try {
        const receipt = await this.client.getTransactionReceipt({ hash: row.txHash as Hex });
        const status = receipt.status === 'success' ? 'confirmed' : 'failed';
        await this.resolve(row.txHash as Hex, status, row.nonce);
        if (status === 'confirmed') confirmed += 1;
        else failed += 1;
      } catch {
        await this.db
          .update(pendingTxs)
          .set({ status: 'failed', resolvedAt: now() })
          .where(and(eq(pendingTxs.txHash, row.txHash), eq(pendingTxs.status, 'pending')));
        dropped += 1;
      }
    }

    await this.resync();
    if (rows.length > 0) log.warn({ confirmed, failed, dropped }, 'recovered pending transactions');
    return { confirmed, failed, dropped };
  }

  get inflightCount(): number {
    return this.inflight.size;
  }
}
