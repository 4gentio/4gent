#!/usr/bin/env tsx
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { loadConfig, logger } from '@4gent/core';
import { KillSwitch } from '@4gent/risk';
import { boot } from '../apps/agent/src/wiring.js';

const log = logger('script:exit-all');

/**
 * Emergency liquidation.
 *
 * Engages the kill switch first so the running agent stops opening new risk,
 * then market-sells every open position through the normal execution path so
 * the exits are accounted for like any other trade.
 *
 *   pnpm tsx scripts/exit-all.ts --confirm
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const confirmed = process.argv.includes('--confirm');

  if (!confirmed) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `This will close EVERY open position in ${config.mode} mode. Type "exit all" to continue: `,
    );
    rl.close();
    if (answer.trim() !== 'exit all') {
      console.log('Aborted.');
      return;
    }
  }

  const flagPath = KillSwitch.writeFlag(config, 'emergency exit-all invoked');
  log.warn({ flagPath }, 'kill switch flag written');

  const runtime = await boot();
  const { orchestrator } = runtime;

  // Reuse the orchestrator's forced-exit path so accounting stays consistent.
  await orchestrator.runLoopOnce('price');
  log.warn('closing all positions');

  await runtime.shutdown();
  console.log(`\nDone. Kill switch flag remains at ${flagPath}; remove it manually to re-arm.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
