#!/usr/bin/env tsx
import 'dotenv/config';
import { desc } from 'drizzle-orm';
import { loadConfig, round } from '@4gent/core';
import { closeDb, getDb, navHistory, positions, reasoningLog, trades } from '@4gent/db';
import { MetricsService } from '@4gent/portfolio';

/**
 * Read-only database inspector.
 *
 *   pnpm tsx scripts/db-inspect.ts positions
 *   pnpm tsx scripts/db-inspect.ts trades 20
 *   pnpm tsx scripts/db-inspect.ts reasoning 5
 *   pnpm tsx scripts/db-inspect.ts performance
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = getDb(config.databasePath);
  const [command = 'summary', arg] = process.argv.slice(2);
  const limit = Number(arg ?? 10);

  switch (command) {
    case 'positions': {
      const rows = await db.select().from(positions).orderBy(desc(positions.openedAt)).limit(limit);
      console.table(
        rows.map((r) => ({
          symbol: r.symbol,
          status: r.status,
          qty: round(r.quantity, 6),
          entry: round(r.avgEntryPrice, 6),
          basis: round(r.costBasis, 2),
          stop: round(r.hardStopPrice, 6),
          strategy: r.strategy,
        })),
      );
      break;
    }
    case 'trades': {
      const rows = await db.select().from(trades).orderBy(desc(trades.executedAt)).limit(limit);
      console.table(
        rows.map((r) => ({
          when: new Date(r.executedAt).toISOString(),
          symbol: r.symbol,
          side: r.side,
          price: round(r.fillPrice, 6),
          notional: round(r.notional, 2),
          pnl: r.realizedPnl === null ? '' : round(r.realizedPnl, 2),
          mode: r.mode,
        })),
      );
      break;
    }
    case 'reasoning': {
      const rows = await db.select().from(reasoningLog).orderBy(desc(reasoningLog.startedAt)).limit(limit);
      for (const row of rows) {
        console.log(`\n--- cycle ${row.id} @ ${new Date(row.startedAt).toISOString()} (${row.model})`);
        console.log(`tokens in/out/cached: ${row.inputTokens}/${row.outputTokens}/${row.cachedTokens}`);
        if (row.validationError) console.log(`validation error: ${row.validationError}`);
        console.log(`decisions: ${JSON.stringify(row.parsedDecisions)}`);
        console.log(`note: ${row.portfolioNote}`);
      }
      break;
    }
    case 'nav': {
      const rows = await db.select().from(navHistory).orderBy(desc(navHistory.recordedAt)).limit(limit);
      console.table(
        rows.map((r) => ({
          when: new Date(r.recordedAt).toISOString(),
          nav: round(r.nav, 2),
          cash: round(r.cash, 2),
          positions: round(r.positionsValue, 2),
          unrealized: round(r.unrealizedPnl, 2),
        })),
      );
      break;
    }
    case 'performance': {
      const report = await new MetricsService(db).report();
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    default:
      console.log('Usage: db-inspect.ts <positions|trades|reasoning|nav|performance> [limit]');
  }

  closeDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
