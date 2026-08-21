import { resolve } from 'node:path';
import {
  assertLiveArmed,
  initLogger,
  loadConfig,
  logger,
  PANCAKE_V3_ROUTER,
  Universe,
  type AppConfig,
} from '@4gent/core';
import { closeDb, getDb, runMigrations, type Db } from '@4gent/db';
import { createChainClients, GasStrategy, NonceManager, Wallet, type ChainClients } from '@4gent/chain';
import {
  CandleBuilder,
  EquityPriceService,
  PoolReader,
  PriceService,
  SafetyTriage,
  SnapshotBuilder,
} from '@4gent/data';
import { AnthropicClient, Classifier, Reasoner, StaticReasoningClient, type ReasoningClient } from '@4gent/brain';
import { BreakerRegistry, KillSwitch, RiskGuard } from '@4gent/risk';
import { ApprovalManager, LiveEngine, PaperEngine, Quoter, type ExecutionEngine } from '@4gent/execution';
import { PortfolioAccountant, Reconciler } from '@4gent/portfolio';
import { StrategyRegistry } from '@4gent/strategies';
import { Alerter, Orchestrator } from '@4gent/keeper';

const log = logger('agent:wiring');

export interface Runtime {
  config: AppConfig;
  db: Db;
  universe: Universe;
  clients: ChainClients;
  orchestrator: Orchestrator;
  shutdown: () => Promise<void>;
}

export interface BootOptions {
  /** Skip the Anthropic client and use a fixed response set. */
  offline?: boolean;
  universePath?: string;
  cwd?: string;
}

/**
 * Composition root.
 *
 * Every dependency is constructed exactly once, here, and passed down. No
 * module reaches for a singleton or reads process.env on its own, which is what
 * makes the whole graph substitutable in tests and in the ops scripts.
 */
export async function boot(options: BootOptions = {}): Promise<Runtime> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig();
  initLogger(config.log);

  if (config.mode === 'live') {
    assertLiveArmed(config, cwd);
    log.warn('LIVE MODE ARMED — this process will sign and broadcast real transactions');
  }

  runMigrations(config.databasePath);
  const db = getDb(config.databasePath);

  const universe = Universe.fromFile(options.universePath ?? resolve(cwd, 'config/universe.json'));
  const clients = createChainClients(config);
  const wallet = new Wallet(clients, config);

  const poolReader = new PoolReader(clients.publicClient);
  const prices = new PriceService(poolReader, db, config.loops.priceMs * 4);
  const candles = new CandleBuilder(db);
  const equity = new EquityPriceService(config, db);

  const reasoningClient: ReasoningClient = options.offline
    ? new StaticReasoningClient(['{"decisions":[],"portfolio_note":"offline dry run"}'])
    : new AnthropicClient(config);
  const classifier = new Classifier(reasoningClient, config);
  const safety = new SafetyTriage(clients.publicClient, db, config, classifier);

  const snapshots = new SnapshotBuilder({ config, universe, prices, candles, equity, db });
  const strategies = new StrategyRegistry();
  const reasoner = new Reasoner(reasoningClient, db, config);

  const breakers = new BreakerRegistry(db, config);
  const killSwitch = new KillSwitch(config, cwd);
  const guard = new RiskGuard(config, universe, breakers, killSwitch, db);

  const quoter = new Quoter(clients.publicClient, universe, prices);
  const gas = new GasStrategy(clients.publicClient);
  const engine = await buildEngine({ config, clients, db, wallet, quoter, prices, universe, gas });

  const accountant = new PortfolioAccountant(db, universe);
  const reconciler = new Reconciler(wallet, accountant, universe, db, config);
  const alerter = new Alerter(config, db);

  const orchestrator = new Orchestrator({
    config,
    db,
    universe,
    clients,
    wallet,
    prices,
    candles,
    snapshots,
    safety,
    strategies,
    reasoner,
    guard,
    breakers,
    killSwitch,
    engine,
    accountant,
    reconciler,
    alerter,
  });

  const shutdown = async () => {
    await orchestrator.stop();
    killSwitch.dispose();
    closeDb();
  };

  return { config, db, universe, clients, orchestrator, shutdown };
}

async function buildEngine(deps: {
  config: AppConfig;
  clients: ChainClients;
  db: Db;
  wallet: Wallet;
  quoter: Quoter;
  prices: PriceService;
  universe: Universe;
  gas: GasStrategy;
}): Promise<ExecutionEngine> {
  if (deps.config.mode === 'paper') {
    return new PaperEngine(deps.quoter, deps.prices, deps.universe);
  }

  if (!deps.clients.walletClient || !deps.clients.address) {
    throw new Error('Live mode requires a signing wallet client');
  }

  const nonces = new NonceManager(deps.clients.publicClient, deps.db, deps.clients.address);
  await nonces.recoverPending();

  const approvals = new ApprovalManager(
    deps.clients.publicClient,
    deps.clients.walletClient,
    deps.db,
    nonces,
    deps.gas,
    deps.clients.address,
  );

  await deps.wallet.assertGasSolvent();

  return new LiveEngine({
    publicClient: deps.clients.publicClient,
    walletClient: deps.clients.walletClient,
    quoter: deps.quoter,
    prices: deps.prices,
    universe: deps.universe,
    approvals,
    nonces,
    gas: deps.gas,
    config: deps.config,
    // BNB is not in the traded universe; a conservative fixed mark is enough
    // for converting gas into accounting terms.
    bnbPriceProvider: () => deps.prices.get('WBNB')?.price ?? 600,
  });
}

export { PANCAKE_V3_ROUTER };
