#!/usr/bin/env tsx
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '@4gent/core';

/**
 * Writes the live-mode confirmation file.
 *
 * Arming live trading intentionally requires a human at a keyboard: setting
 * EXECUTION_MODE=live alone does nothing without this file.
 *
 *   pnpm tsx scripts/arm-live.ts
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const path = resolve(process.cwd(), config.liveConfirmationFile);

  console.log('Live-mode checklist:');
  console.log('  1. Paper soak has run for at least 72 hours with clean reconciliation.');
  console.log('  2. Wallet holds gas and quote-asset balance you can afford to lose.');
  console.log('  3. Risk caps in .env reviewed and understood.');
  console.log('  4. Telegram alerts configured and a test message received.');
  console.log('  5. You know where the kill switch is:', config.killSwitchFile);
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type the confirmation phrase exactly:\n  "${config.liveConfirmationPhrase}"\n> `);
  rl.close();

  if (answer.trim() !== config.liveConfirmationPhrase) {
    console.error('Phrase did not match. Live mode NOT armed.');
    process.exit(1);
  }

  writeFileSync(path, config.liveConfirmationPhrase, 'utf8');
  console.log(`\nArmed. Confirmation file written to ${path}`);
  console.log('Remove this file to disarm live trading.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
