#!/usr/bin/env tsx
import 'dotenv/config';
import { fromRaw, loadConfig, Universe } from '@4gent/core';
import { createChainClients, Wallet } from '@4gent/chain';
import { resolve } from 'node:path';

/**
 * Pre-flight funding report. Run this before arming live mode.
 *
 *   pnpm tsx scripts/fund-check.ts
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const universe = Universe.fromFile(resolve('config/universe.json'));
  const clients = createChainClients(config);
  const wallet = new Wallet(clients, config);

  const native = await wallet.nativeBalance();
  const balances = await wallet.tokenBalances([
    { address: universe.quoteAsset.address, decimals: universe.quoteAsset.decimals },
    ...universe.enabled().map((a) => ({ address: a.address, decimals: a.decimals })),
  ]);

  const quote = balances.get(universe.quoteAsset.address);

  console.log(`Address:  ${wallet.address}`);
  console.log(`Mode:     ${config.mode}`);
  console.log(`Signer:   ${wallet.canSign ? 'loaded' : 'ABSENT'}`);
  console.log('');
  console.log(`BNB (gas):  ${native.bnb.toFixed(6)}${native.bnb < 0.01 ? '   <-- BELOW GAS FLOOR' : ''}`);
  console.log(`${universe.quoteAsset.symbol}:       ${(quote?.amount ?? 0).toFixed(2)}`);
  console.log('');
  console.log('Token holdings:');
  for (const asset of universe.enabled()) {
    const balance = balances.get(asset.address);
    if (!balance || balance.raw === 0n) continue;
    console.log(`  ${asset.symbol.padEnd(10)} ${fromRaw(balance.raw, asset.decimals).toFixed(6)}`);
  }

  if (native.bnb < 0.01) {
    console.error('\nWallet is below the gas floor; transactions will fail.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
