import {
  FailClosedError,
  logger,
  now,
  round,
  RiskRejectionError,
  type AppConfig,
  type AssetSpec,
  type Decision,
  type Order,
  type Position,
  type Symbol_,
  type Universe,
} from '@4gent/core';
import { assertChainHealthy, type ChainClients, type Wallet } from '@4gent/chain';
import type { Db } from '@4gent/db';
import {
  CandleBuilder,
  PriceService,
  SafetyTriage,
  SnapshotBuilder,
  toObservation,
  type MarketSnapshot,
} from '@4gent/data';
import type { Reasoner } from '@4gent/brain';
import { BreakerRegistry, evaluateStops, KillSwitch, type RiskGuard, type PlannedOrder } from '@4gent/risk';
import type { ExecutionEngine } from '@4gent/execution';
import type { PortfolioAccountant, Reconciler } from '@4gent/portfolio';
import type { StrategyRegistry } from '@4gent/strategies';
import type { Alerter } from './alerts.js';
import { Loop } from './loop.js';
import { Watchdog } from './watchdog.js';

const log = logger('keeper:orchestrator');

export interface OrchestratorDeps {
  config: AppConfig;
  db: Db;
  universe: Universe;
  clients: ChainClients;
  wallet: Wallet;
  prices: PriceService;
  candles: CandleBuilder;
  snapshots: SnapshotBuilder;
  safety: SafetyTriage;
  strategies: StrategyRegistry;
  reasoner: Reasoner;
  guard: RiskGuard;
  breakers: BreakerRegistry;
  killSwitch: KillSwitch;
  engine: ExecutionEngine;
  accountant: PortfolioAccountant;
  reconciler: Reconciler;
  alerter: Alerter;
}

/**
 * Wires the three independent loops together and owns the shared runtime state
 * between them.
 *
 * The loops are deliberately not coupled: the price loop keeps marks and stops
 * current at high frequency, the reasoning loop is slow and expensive, and the
 * reconciliation loop is the only one allowed to declare that the ledger is
 * wrong. A failure in one degrades the agent rather than stopping it, except
 * where fail-closed rules say otherwise.
 */
export class Orchestrator {
  private readonly loops: Loop[] = [];
  private readonly watchdog: Watchdog;
  private cash = 0;
  private paused = false;
  private pauseReason: string | null = null;
  private lastSnapshot: MarketSnapshot | null = null;
  private bnbPrice = 0;

  constructor(private readonly deps: OrchestratorDeps) {
    this.watchdog = new Watchdog(deps.db, deps.config, deps.alerter);
  }

  async start(): Promise<void> {
    const { config, deps } = { config: this.deps.config, deps: this.deps };

    deps.killSwitch.install();
    deps.killSwitch.onEngage(async (reason) => {
      await deps.alerter.send({ level: 'critical', title: 'Kill switch engaged', body: `Reason: ${reason}` });
      await this.stop();
    });

    await assertChainHealthy(deps.clients);
    deps.wallet.assertSignerForMode();
    this.cash = await deps.reconciler.cashOnChain().catch(() => 0);

    this.loops.push(
      new Loop(
        { name: 'price', intervalMs: config.loops.priceMs, jitterPct: config.loops.jitterPct, runOnStart: true },
        () => this.priceTick(),
        deps.db,
      ),
      new Loop(
        { name: 'reasoning', intervalMs: config.loops.reasoningMs, jitterPct: config.loops.jitterPct },
        () => this.reasoningTick(),
        deps.db,
      ),
      new Loop(
        { name: 'reconcile', intervalMs: config.loops.reconcileMs, jitterPct: config.loops.jitterPct },
        () => this.reconcileTick(),
        deps.db,
      ),
    );

    for (const loop of this.loops) loop.start();

    setInterval(() => void this.watchdog.check(), config.loops.priceMs * 4).unref();

    await deps.alerter.send({
      level: 'info',
      title: `4gent started in ${config.mode} mode`,
      body: `Universe: ${deps.universe.enabled().length} assets. Cash: ${this.cash.toFixed(2)}.`,
    });
    log.info({ mode: config.mode, cash: this.cash }, 'orchestrator started');
  }

  async stop(): Promise<void> {
    log.warn('orchestrator stopping');
    await Promise.all(this.loops.map((l) => l.stop()));
    await this.deps.engine.drain().catch(() => undefined);
    await this.deps.candles.flush().catch(() => undefined);
    log.warn('orchestrator stopped');
  }

  // --- Price loop -----------------------------------------------------------

  /**
   * High-frequency loop. Refreshes marks, folds them into candles, updates NAV,
   * evaluates drawdown breakers, and — critically — enforces stops without
   * waiting for the model's next opinion.
   */
  private async priceTick(): Promise<void> {
    const { prices, candles, universe, accountant, breakers, alerter } = this.deps;

    const snapshot = await prices.refresh(universe.enabled());
    await candles.ingest([...snapshot.bySymbol.values()]);

    const marks = prices.markPrices();
    const navPoint = await accountant.markToMarket(marks, this.cash);

    const tripped = await breakers.evaluateDrawdown({ nav: navPoint.nav });
    for (const breaker of tripped) {
      await alerter.breakerTripped(breaker.id, breaker.reason ?? 'threshold breached');
    }

    await this.enforceStops(marks);
  }

  /**
   * Force-closes positions whose stop or stated invalidation has been hit. This
   * runs on the price loop rather than the reasoning loop because a memecoin can
   * complete an entire round trip inside one five-minute reasoning interval.
   */
  private async enforceStops(marks: ReadonlyMap<Symbol_, number>): Promise<void> {
    const { accountant, guard, universe, alerter } = this.deps;
    if (this.paused || this.deps.killSwitch.isEngaged) return;

    const open = await accountant.openPositions();
    const triggers = evaluateStops(open, { marks });

    for (const trigger of triggers) {
      const asset = universe.get(trigger.symbol);
      const position = open.find((p) => p.symbol === trigger.symbol);
      if (!asset || !position) continue;

      const order = guard.buildForcedExit(asset, position, `${trigger.reason}: ${trigger.detail}`);
      try {
        await this.executeOrder(order, asset, position, {
          thesis: `Forced exit (${trigger.reason})`,
          invalidation: 'n/a',
          timeHorizon: position.timeHorizon,
          conviction: position.conviction,
          hardStopPrice: position.hardStopPrice,
        });
        await alerter.send({
          level: 'warn',
          title: `Stop triggered on ${trigger.symbol}`,
          body: trigger.detail,
        });
      } catch (error) {
        log.error({ symbol: trigger.symbol, err: String(error) }, 'forced exit failed');
        await alerter.send({
          level: 'error',
          title: `Forced exit FAILED on ${trigger.symbol}`,
          body: String(error),
        });
      }
    }
  }

  // --- Reasoning loop -------------------------------------------------------

  private async reasoningTick(): Promise<void> {
    const { config, universe, prices, snapshots, strategies, reasoner, guard, accountant, breakers, safety } = this.deps;

    if (this.deps.killSwitch.isEngaged) {
      log.warn('kill switch engaged; skipping reasoning cycle');
      return;
    }
    if (this.paused) {
      log.warn({ reason: this.pauseReason }, 'trading paused; skipping reasoning cycle');
      return;
    }

    // Fail closed on stale market data rather than reasoning over it.
    const staleness = now() - prices.lastRefreshedAt;
    if (staleness > config.loops.priceMs * 4) {
      throw new FailClosedError(`Price data is ${Math.round(staleness / 1000)}s stale; refusing to reason`);
    }

    const positions = await accountant.openPositions();
    const safetyBySymbol = await this.safetyMap(universe.memecoins());

    const baseSnapshot = await snapshots.build({
      positions,
      cash: this.cash,
      realizedPnlToday: await accountant.realizedPnlToday(),
      navAtOpen: await accountant.navAtDayOpen(),
      closeOnly: await breakers.closeOnly(),
      alerts: await this.activeAlerts(),
      safetyBySymbol,
    });

    const annotations = strategies.annotate(baseSnapshot);
    const snapshot: MarketSnapshot = { ...baseSnapshot, strategyNotes: annotations.notes };
    this.lastSnapshot = snapshot;

    const result = await reasoner.runCycle({
      snapshot,
      knownSymbols: new Set(snapshot.assets.map((a) => a.symbol)),
      openSymbols: new Set(positions.map((p) => p.symbol)),
    });

    if (result.heldOnFailure) {
      await this.deps.alerter.send({
        level: 'error',
        title: 'Reasoning cycle failed validation twice',
        body: 'The agent is holding all positions for this cycle.',
      });
      return;
    }

    const plan = await guard.plan(result.decisions, {
      state: { nav: this.navFrom(snapshot), cash: this.cash, positions, marks: prices.markPrices() },
      depthBySymbol: new Map(snapshot.assets.map((a) => [a.symbol, a.depthUsd])),
      reasoningCycleId: result.cycleId,
    });

    log.info(
      { cycleId: result.cycleId, orders: plan.orders.length, rejected: plan.rejected.length },
      'risk plan produced',
    );

    for (const planned of plan.orders) {
      await this.executePlanned(planned, positions).catch(async (error) => {
        log.error({ symbol: planned.order.symbol, err: String(error) }, 'order execution failed');
        await this.deps.alerter.send({
          level: 'error',
          title: `Order failed: ${planned.order.side} ${planned.order.symbol}`,
          body: String(error),
        });
      });
    }
  }

  private async executePlanned(planned: PlannedOrder, positions: readonly Position[]): Promise<void> {
    const position = positions.find((p) => p.symbol === planned.order.symbol);
    await this.executeOrder(planned.order, planned.asset, position, {
      thesis: planned.decision.thesis,
      invalidation: planned.decision.invalidation,
      timeHorizon: planned.decision.time_horizon,
      conviction: planned.decision.conviction,
      hardStopPrice: planned.hardStop,
    });
  }

  /**
   * Single funnel for every fill, whether it originated from the model or from
   * a forced stop. Quote acceptability is re-checked here against the live
   * quote, immediately before execution.
   */
  private async executeOrder(
    order: Order,
    asset: AssetSpec,
    position: Position | undefined,
    meta: {
      thesis: string;
      invalidation: string;
      timeHorizon: Position['timeHorizon'];
      conviction: Position['conviction'];
      hardStopPrice: number;
    },
  ): Promise<void> {
    const { engine, guard, accountant, alerter } = this.deps;

    const quote = await engine.quote(asset, order.side, order.amountIn);
    try {
      guard.assertQuoteAcceptable(quote, asset);
    } catch (error) {
      if (error instanceof RiskRejectionError) {
        log.warn({ symbol: order.symbol, rule: error.rule, err: error.message }, 'order rejected at pre-flight');
        return;
      }
      throw error;
    }

    const fill = await engine.execute(order, asset);
    const recorded = await accountant.recordFill({
      order,
      asset,
      fill,
      hardStopPrice: meta.hardStopPrice,
      thesis: meta.thesis,
      invalidation: meta.invalidation,
      timeHorizon: meta.timeHorizon,
      conviction: meta.conviction,
    });

    // Cash moves in the opposite direction to the token.
    const notional = order.side === 'buy'
      ? Number(order.amountIn) / 10 ** this.deps.universe.quoteAsset.decimals
      : Number(fill.amountOut) / 10 ** this.deps.universe.quoteAsset.decimals;
    this.cash += order.side === 'buy' ? -notional : notional;
    this.cash -= fill.gasQuote;

    await alerter.tradeFilled({
      symbol: order.symbol,
      side: order.side,
      price: fill.fillPrice,
      notional,
      pnl: recorded.realizedPnl,
      mode: fill.mode,
    });

    if (recorded.closed && order.reasoningCycleId !== null && position) {
      await this.deps.reasoner.resolveOutcome(order.reasoningCycleId, order.symbol, {
        entryPrice: position.avgEntryPrice,
        exitPrice: fill.fillPrice,
        pnl: recorded.realizedPnl ?? 0,
      });
    }
  }

  // --- Reconciliation loop --------------------------------------------------

  private async reconcileTick(): Promise<void> {
    const { reconciler, prices, breakers, alerter } = this.deps;
    const result = await reconciler.run(prices.markPrices());

    this.cash = result.cash;

    if (result.shouldPause) {
      this.paused = true;
      this.pauseReason = result.summary;
      await breakers.trip('reconciliation', `Ledger drift: ${result.summary}`, 1);
      await alerter.send({
        level: 'critical',
        title: 'Reconciliation drift — trading paused',
        body: result.summary,
      });
      return;
    }

    if (this.paused && this.pauseReason?.startsWith('Ledger drift')) {
      this.paused = false;
      this.pauseReason = null;
      await breakers.reset('reconciliation', 'drift resolved');
      await alerter.send({ level: 'info', title: 'Reconciliation clean — trading resumed' });
    }
  }

  // --- Helpers --------------------------------------------------------------

  private async safetyMap(memecoins: readonly AssetSpec[]) {
    const map = new Map<Symbol_, { verdict: string; riskScore: number; sellTaxBps: number | null }>();
    for (const asset of memecoins) {
      const cached = await this.deps.safety.cached(asset.address as `0x${string}`);
      if (cached) {
        map.set(asset.symbol, {
          verdict: cached.verdict,
          riskScore: cached.riskScore,
          sellTaxBps: cached.evidence.sellTaxBps,
        });
      }
    }
    return map;
  }

  private async activeAlerts(): Promise<string[]> {
    const alerts: string[] = [];
    for (const breaker of await this.deps.breakers.anyTripped()) {
      alerts.push(`Breaker "${breaker.id}" is active: ${breaker.reason}`);
    }
    const health = await this.watchdog.check();
    for (const loop of health.filter((h) => h.stalled)) {
      alerts.push(`Loop "${loop.loop}" has stalled.`);
    }
    if (this.paused) alerts.push(`Trading is paused: ${this.pauseReason}`);
    return alerts;
  }

  private navFrom(snapshot: MarketSnapshot): number {
    return snapshot.account.nav;
  }

  get status() {
    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      cash: round(this.cash, 2),
      killSwitch: this.deps.killSwitch.isEngaged,
      loops: this.loops.map((l) => ({ name: l.name, running: l.isRunning })),
      lastSnapshotAt: this.lastSnapshot?.takenAt ?? null,
    };
  }

  /** Manual trigger used by the ops scripts and the dashboard. */
  async runLoopOnce(name: 'price' | 'reasoning' | 'reconcile'): Promise<void> {
    const loop = this.loops.find((l) => l.name === name);
    if (!loop) throw new Error(`Unknown loop "${name}"`);
    await loop.runOnce();
  }
}
