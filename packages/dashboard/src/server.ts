import { serve } from '@hono/node-server';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { logger, publicConfig, round, type AppConfig } from '@4gent/core';
import {
  alertLog,
  decisionOutcomes,
  heartbeats,
  navHistory,
  positions,
  reasoningLog,
  trades,
  type Db,
} from '@4gent/db';
import { MetricsService } from '@4gent/portfolio';
import { INDEX_HTML } from './ui.js';

const log = logger('dashboard');

export interface DashboardOptions {
  config: AppConfig;
  db: Db;
  /** Live orchestrator status, injected so the dashboard stays read-only. */
  status: () => Record<string, unknown>;
}

export interface DashboardHandle {
  close: () => Promise<void>;
  port: number;
}

/**
 * Read-only operator view.
 *
 * There are no mutating endpoints, by design. Everything that can change the
 * agent's behaviour goes through the config, the ops scripts, or the kill
 * switch file — never through an HTTP request that could be reached by anything
 * that finds the port.
 */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const { config, db, status } = options;
  const metrics = new MetricsService(db);
  const app = new Hono();

  app.get('/', (c) => c.html(INDEX_HTML));

  app.get('/api/status', async (c) =>
    c.json({
      status: status(),
      config: publicConfig(config),
      heartbeats: await db.select().from(heartbeats),
      serverTime: Date.now(),
    }),
  );

  app.get('/api/positions', async (c) => {
    const rows = await db.select().from(positions).orderBy(desc(positions.openedAt)).limit(100);
    return c.json(
      rows.map((r) => ({
        ...r,
        quantity: round(r.quantity, 8),
        avgEntryPrice: round(r.avgEntryPrice, 8),
        costBasis: round(r.costBasis, 2),
      })),
    );
  });

  app.get('/api/trades', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const rows = await db.select().from(trades).orderBy(desc(trades.executedAt)).limit(limit);
    return c.json(rows);
  });

  app.get('/api/nav', async (c) => {
    const rows = await db.select().from(navHistory).orderBy(desc(navHistory.recordedAt)).limit(500);
    return c.json(rows.reverse());
  });

  app.get('/api/performance', async (c) => c.json(await metrics.report()));

  app.get('/api/reasoning', async (c) => {
    const limit = Number(c.req.query('limit') ?? 20);
    const rows = await db.select().from(reasoningLog).orderBy(desc(reasoningLog.startedAt)).limit(limit);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        model: r.model,
        decisions: r.parsedDecisions,
        portfolioNote: r.portfolioNote,
        validationError: r.validationError,
        tokens: { input: r.inputTokens, output: r.outputTokens, cached: r.cachedTokens },
        latencyMs: r.latencyMs,
      })),
    );
  });

  app.get('/api/reasoning/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const rows = await db.select().from(reasoningLog).where(eq(reasoningLog.id, id)).limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(row);
  });

  app.get('/api/outcomes', async (c) => {
    const rows = await db.select().from(decisionOutcomes).orderBy(desc(decisionOutcomes.createdAt)).limit(100);
    return c.json(rows);
  });

  app.get('/api/alerts', async (c) => {
    const rows = await db.select().from(alertLog).orderBy(desc(alertLog.createdAt)).limit(100);
    return c.json(rows);
  });

  app.get('/healthz', (c) => c.text('ok'));

  const server = serve({ fetch: app.fetch, port: config.dashboard.port, hostname: config.dashboard.host });
  log.info(
    { url: `http://${config.dashboard.host}:${config.dashboard.port}` },
    'dashboard listening',
  );

  return {
    port: config.dashboard.port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
