import 'dotenv/config';
import { logger } from '@4gent/core';
import { startDashboard } from '@4gent/dashboard';
import { boot } from './wiring.js';

const log = logger('agent:main');

/**
 * Entrypoint. Boots the runtime, starts the loops, and holds the process open
 * until a signal or the kill switch takes it down.
 */
async function main(): Promise<void> {
  const offline = process.argv.includes('--offline');
  const runtime = await boot({ offline });

  log.info(
    {
      mode: runtime.config.mode,
      universe: runtime.universe.enabled().length,
      offline,
    },
    'booting 4gent',
  );

  await runtime.orchestrator.start();

  let dashboard: { close: () => Promise<void> } | null = null;
  if (runtime.config.dashboard.enabled) {
    dashboard = await startDashboard({
      config: runtime.config,
      db: runtime.db,
      status: () => runtime.orchestrator.status,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ signal }, 'shutting down');
    await dashboard?.close().catch(() => undefined);
    await runtime.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: String(error) }, 'uncaught exception — shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
