# 4gent

An autonomous trading agent for BNB Chain that trades tokenized equities
(bStocks) and BNB Chain memecoins, using Claude as the reasoning engine and
deterministic TypeScript for execution, risk and accounting.

The central design commitment is a hard separation between judgement and
authority. The language model decides what it wants to do; it never decides how
much, never computes an amount, and never signs anything. Every proposal passes
through a deterministic risk layer that can clamp it, reject it, or ignore it
entirely, and every action is recorded with the exact prompt, snapshot and model
response that produced it.

---

## Table of contents

- [Design principles](#design-principles)
- [Architecture](#architecture)
- [Data flow](#data-flow)
- [Strategies](#strategies)
- [Risk model](#risk-model)
- [Execution](#execution)
- [Getting started](#getting-started)
- [Configuration reference](#configuration-reference)
- [Universe configuration](#universe-configuration)
- [Operations](#operations)
- [Paper to live checklist](#paper-to-live-checklist)
- [Kill switch procedure](#kill-switch-procedure)
- [Dashboard](#dashboard)
- [Testing](#testing)
- [Repository layout](#repository-layout)
- [Known limitations](#known-limitations)
- [Disclaimer](#disclaimer)

---

## Design principles

**The model decides, code executes.** Claude emits structured JSON: an action, a
symbol, a conviction, a proposed size as a percentage, a time horizon, a thesis
and an invalidation condition. It receives no wallet handle, no router address
and no ability to name a token amount. Deterministic code turns intent into an
order, and that code is the only thing that can move funds.

**Paper mode is not a simulation of a different system.** The paper engine fills
against live on-chain quotes and writes to the same tables through the same
accounting path as live execution. A paper soak exercises every line of the risk
layer, the reconciler and the portfolio ledger. The only untested difference when
going live is the signature itself.

**Risk limits are code, not prompt text.** Position caps, asset-class exposure
caps, drawdown breakers and slippage ceilings live in a frozen config object the
reasoning layer cannot reach. Limits do appear in the snapshot so the model can
plan within them, but a decision that violates one is clamped or rejected
regardless of what the model believes.

**Every decision is auditable.** Each reasoning cycle persists the full system
prompt, the serialised market snapshot, the raw model response, the parsed
decisions, which of them were discarded and why, token usage and latency. The
database is a complete record of why the agent did what it did.

**Fail closed.** Stale prices, an unreachable RPC, a chain head that has stopped
advancing, a model response that fails schema validation twice, ledger drift
against on-chain balances: every one of these halts trading rather than
degrading it. Doing nothing is always available and is frequently correct.

---

## Architecture

A pnpm workspace monorepo. The dependency graph is strictly acyclic and flows in
one direction, so no package that can move money depends on a package that can
form an opinion.

```
core ──> db ──> chain ──> data ──┬──> strategies ─┐
                                 ├──> brain ──────┼──> keeper ──> agent
                                 ├──> execution ──┤
                                 ├──> portfolio ──┤
                                 └──> risk ───────┘
                                                  └──> dashboard
```

| Package | Responsibility |
| --- | --- |
| `core` | Domain types, zod contracts, config loader and risk limits, fixed-point and PnL maths, the universe resolver, structured logging. The root of the graph; imports nothing from the workspace. |
| `db` | Drizzle schema, SQLite client, migrations, durable key/value store. |
| `chain` | viem clients with RPC fallback, ABI fragments, Multicall3 batching, wallet reads, gas strategy, crash-safe nonce manager. |
| `data` | Pool state readers for PancakeSwap v3 and v2, the price service, the local candle builder and indicators, reference equity prices, the US session calendar, memecoin safety triage, and the market snapshot builder. |
| `brain` | The system prompt, prompt assembly, the Anthropic client with prompt caching, response parsing and semantic sanitisation, the reasoning cycle, and the audit log. |
| `risk` | Conviction-scaled position sizing, exposure caps, drawdown circuit breakers, stop enforcement, the kill switch, and the guard that converts decisions into orders. |
| `strategies` | Signal modules. They enrich the snapshot; they never trade. |
| `execution` | Quoting, the paper engine, the live router with a mandatory simulation gate, exact-amount approvals, and fill decoding from receipt logs. |
| `portfolio` | Position and cost-basis bookkeeping, realised and unrealised PnL, NAV history, performance metrics, and reconciliation against chain state. |
| `keeper` | Three supervised loops, the watchdog, Telegram alerting, and the orchestrator that wires them together. |
| `dashboard` | A read-only Hono server and a dependency-free single-page UI. |
| `agent` | The composition root and process entrypoint. |

---

## Data flow

One reasoning cycle, end to end:

1. **Price loop** (default 15s) reads every configured pool in a single
   Multicall batch pinned to one block, folds the observations into local 1m, 5m
   and 1h candles, marks the portfolio to market, evaluates the drawdown
   breakers, and enforces stops.
2. **Snapshot builder** assembles the single object the model sees: account
   state against the hard caps, open positions with the thesis and invalidation
   the model wrote when it opened them, per-asset price, depth, trend indicators
   and NAV deviation, recent trades, and a rolling memory of the model's own
   recent decisions with their outcomes. The whole thing is held to roughly six
   thousand tokens; when the universe grows, the least decision-relevant fields
   are dropped first.
3. **Strategies** annotate the snapshot with signals and notes. They produce a
   consensus score per symbol, which is advisory only.
4. **Reasoning loop** (default 5 minutes) sends the static system prompt, marked
   as a cache breakpoint, plus the snapshot. The response is parsed, schema
   validated, and semantically filtered against the actual universe and the
   actual open positions. A validation failure triggers exactly one repair
   attempt with the error fed back; a second failure holds everything.
5. **Risk guard** sizes each accepted decision against conviction, the
   per-position cap, the asset-class cap, the total invested cap, available cash,
   and pool depth, then rejects anything that lands below the dust floor. It
   emits orders with a minimum output and a stop level already fixed.
6. **Execution** quotes, re-checks the quote against the slippage and price
   impact ceilings, simulates against live chain state, signs, submits, waits for
   confirmation, and decodes the actual received amount from the transfer logs.
7. **Accounting** records the fill, updates cost basis, realises PnL against the
   running average, and resolves the outcome of the originating decision so it
   appears in the next cycle's memory.
8. **Reconciliation loop** (default 10 minutes) compares the ledger against
   on-chain balances. Material drift pauses trading rather than silently
   rewriting cost basis.

---

## Strategies

Strategies implement a narrow interface: a universe, an `annotate` method that
returns signals and notes, and a set of guardrails. They do not place orders.
The model synthesises across them, and the risk layer has the final word.

**bStock NAV mean-reversion.** While the underlying US equity is trading, a
tokenized claim on it should track it. A material deviation has a mechanical
convergence path. Two guards matter more than the signal: deviation outside the
regular session is discarded rather than traded, because the pool is legitimately
pricing overnight risk, and an implausibly large deviation is treated as a data
fault rather than free money.

**bStock momentum.** Requires agreement between the fast/slow EMA structure and
the four-hour change. RSI is used only to veto: an extended reading downgrades an
otherwise valid signal rather than creating a contrarian one. Chasing an
exhausted move is the dominant failure mode of a naive momentum rule, so it is
priced in here rather than left to the model.

**Memecoin momentum.** Shaped entirely by the fat left tail that the price series
does not show in advance. The edge is in constraints, not prediction: scalp
horizon only, small size, mandatory prior clearance through safety triage, and an
explicit upper bound on how far into a move it will still enter.

**Sector relative value.** Ranks names within a sector cohort and expresses a
preference for the leader over the laggard, giving the model a way to rotate
exposure without changing gross risk.

### Memecoin safety triage

No memecoin is tradable until it has passed a deterministic gate. Nothing in the
gate trusts a token's own claims:

- Bytecode presence and size.
- Buy and sell taxes **measured**, by comparing a router quote against an
  `eth_call` simulation of the real transfer path.
- A simulated buy-then-sell round trip. A token that cannot return funds inside
  `eth_call` is rejected outright.
- Pool liquidity, token age and holder count against configured floors.
- Owner privilege probes: unrenounced ownership, pause flags, trading toggles,
  and max transaction or wallet limits set below meaningful thresholds.

Hard failures are absolute. Only genuinely ambiguous evidence is escalated to
Claude Haiku as a tiebreaker, and its verdict can never override a failed round
trip or an out-of-policy sell tax. An `uncertain` verdict means untradable.

---

## Risk model

Sizing runs in a fixed order, and every step can only reduce the notional:

1. The model's proposed percentage of deployable cash, scaled by a conviction
   curve that is deliberately sub-linear at the top. A conviction of 5 is worth
   roughly twice a conviction of 1, not five times, because models rank ideas
   well and calibrate the gap between them poorly.
2. The per-position cap against NAV, inclusive of existing exposure to the same
   symbol.
3. The asset-class exposure cap.
4. The total invested cap.
5. Available cash.
6. A fraction of measured pool depth.
7. A dust floor, below which gas and slippage dominate any expected edge.

Every binding clamp is logged and surfaced back to the model in the next cycle's
memory, so it can learn that a particular kind of proposal keeps getting reduced.

**Circuit breakers.** Daily and weekly NAV drawdown breakers track peaks per UTC
day and per ISO week, persisted, so a restart mid-drawdown does not reset the
reference high and quietly re-arm the agent. A tripped breaker forces close-only
mode for a cooldown period. It does not liquidate: forced selling into the move
that caused the drawdown is usually the worst available action.

**Stops.** Evaluated on the price loop, not the reasoning loop, because a
memecoin can complete an entire round trip inside one five-minute reasoning
interval. Three triggers: the hard stop set at entry, an explicit price level
parsed conservatively from the model's stated invalidation, and a scalp that has
outlived its horizon. The invalidation parser only fires on unambiguous phrasing,
because a false positive closes a good position for no reason.

**Reconciliation.** The database is a model of reality, not reality. Anything
that moves tokens outside the agent shows up as drift, and material drift pauses
trading. Repair is an explicit operator action, never automatic, because silently
rewriting cost basis to match an unexplained balance destroys the audit trail.

---

## Execution

The live pipeline is fixed, and every stage can abort the trade:

```
quote -> minOut -> approve -> simulate -> sign -> submit -> confirm -> decode
```

The simulate step is not optional. An `eth_call` against the real router at the
real block catches fee-on-transfer surprises, insufficient allowance and router
reverts before a signature is ever produced.

Approvals are exact-amount. Infinite approval is the convenient default and a
standing invitation; the cost of doing it properly on BNB Chain is a few cents of
gas per trade.

Gas policy optimises for inclusion, not cost. A swap sitting unmined while the
pool moves against it is far more expensive than a few gwei of premium, so the
agent bids above the network price and escalates on replacement. A stalled
transaction is replaced at the same nonce, never re-sent as a second trade.

Every allocated nonce is written to `pending_txs` before broadcast. On restart
those rows are reconciled against the chain, which is what makes a mid-swap crash
recoverable instead of a double-send.

---

## Getting started

Requirements: Node 22 or newer, pnpm 9, and a BNB Chain RPC endpoint.

```bash
git clone https://github.com/4gentio/4gent
cd 4gent
pnpm install
cp .env.example .env
```

Set at minimum `ANTHROPIC_API_KEY` and `WALLET_ADDRESS` for paper mode. Leave
`EXECUTION_MODE=paper`.

```bash
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm agent
```

To validate the wiring without spending tokens on the reasoning model:

```bash
pnpm agent:dev -- --offline
```

The dashboard is at `http://127.0.0.1:8787`.

---

## Configuration reference

Every value is set through the environment and validated by zod at startup.
Structural invariants are checked too: a per-position cap larger than the total
invested cap, or a weekly breaker tighter than the daily one, will refuse to
boot.

### Execution

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXECUTION_MODE` | `paper` | `paper` simulates fills against live quotes; `live` signs and broadcasts. |
| `LIVE_CONFIRMATION_FILE` | `.LIVE_CONFIRMED` | File that must exist and match the phrase before live mode arms. |
| `LIVE_CONFIRMATION_PHRASE` | see `.env.example` | Exact contents required in the confirmation file. |
| `KILL_SWITCH_FILE` | `.KILL_SWITCH` | Presence of this file halts all trading. |

### Chain

| Variable | Default | Meaning |
| --- | --- | --- |
| `BNB_RPC_PRIMARY` | public dataseed | Primary RPC endpoint. |
| `BNB_RPC_FALLBACK` | public dataseed | Secondary endpoint; viem ranks and rotates automatically. |
| `CHAIN_ID` | `56` | Verified against the RPC on every health check. |
| `WALLET_PRIVATE_KEY` | unset | Required for live mode. Environment only; never persisted or logged. |
| `WALLET_ADDRESS` | unset | Read-only address for paper mode when no key is supplied. |

### Reasoning

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Required unless running with `--offline`. |
| `MODEL_REASONING` | `claude-sonnet-4-6` | Trading decisions. |
| `MODEL_CLASSIFY` | `claude-haiku-4-5` | Safety triage tiebreaks and sentiment. |
| `BRAIN_MAX_TOKENS` | `4096` | Response ceiling. |
| `BRAIN_TEMPERATURE` | `0.2` | Low by design; this is a structured output task. |

### Loops

| Variable | Default | Meaning |
| --- | --- | --- |
| `PRICE_LOOP_MS` | `15000` | Pool polling, candles, marks, stops. |
| `REASONING_LOOP_MS` | `300000` | Full reasoning cycle. |
| `REASONING_LOOP_ACTIVE_MS` | `60000` | Faster cadence while memecoin positions are open. |
| `RECONCILE_LOOP_MS` | `600000` | Ledger versus chain. |
| `LOOP_JITTER_PCT` | `15` | Symmetric jitter so loops do not synchronise into RPC bursts. |
| `WATCHDOG_STALL_MULTIPLIER` | `4` | Intervals without success before a loop is declared stalled. |

### Risk

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_POSITION_PCT` | `5` | Per-position ceiling as a percentage of NAV. |
| `MAX_BSTOCK_EXPOSURE_PCT` | `60` | bStock asset-class cap. |
| `MAX_MEMECOIN_EXPOSURE_PCT` | `15` | Memecoin asset-class cap. |
| `MAX_TOTAL_INVESTED_PCT` | `80` | Total deployed capital cap. |
| `MAX_OPEN_POSITIONS` | `12` | Concurrent position limit. |
| `DAILY_DRAWDOWN_BREAKER_PCT` | `6` | Daily drawdown that forces close-only mode. |
| `WEEKLY_DRAWDOWN_BREAKER_PCT` | `12` | Weekly equivalent; must be looser than the daily breaker. |
| `BREAKER_COOLDOWN_HOURS` | `24` | Close-only duration after a trip. |
| `HARD_STOP_BSTOCK_PCT` | `8` | Stop distance for bStocks. |
| `HARD_STOP_MEMECOIN_PCT` | `20` | Wider stop for memecoins, compensated by much smaller size. |
| `MIN_TRADE_USD` | `25` | Dust floor. |

### Execution guards

| Variable | Default | Meaning |
| --- | --- | --- |
| `SLIPPAGE_CAP_BSTOCK_BPS` | `60` | Slippage ceiling for bStocks. |
| `SLIPPAGE_CAP_MEMECOIN_BPS` | `300` | Slippage ceiling for memecoins. |
| `MAX_PRICE_IMPACT_BPS` | `500` | Global price impact ceiling. |
| `QUOTE_STALENESS_MS` | `20000` | Quotes older than this are refused at pre-flight. |

### Safety triage

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_BUY_TAX_BPS` | `500` | Measured buy tax ceiling. |
| `MAX_SELL_TAX_BPS` | `500` | Measured sell tax ceiling. Exceeding this is a hard fail. |
| `MIN_LIQUIDITY_USD` | `25000` | Pool depth floor. |
| `MIN_TOKEN_AGE_MINUTES` | `30` | Minimum age before a token is considered. |
| `MIN_HOLDER_COUNT` | `250` | Holder distribution floor. |

### Reference prices, alerts, dashboard, logging

| Variable | Default | Meaning |
| --- | --- | --- |
| `EQUITY_PRICE_PROVIDER` | `stooq` | `stooq` or `yahoo`. |
| `EQUITY_PRICE_STALE_MS` | `120000` | Reference quotes older than this are not actionable. |
| `NAV_DEVIATION_TRIGGER_BPS` | `75` | Deviation at which a NAV signal becomes actionable. |
| `TELEGRAM_BOT_TOKEN` | unset | Alert delivery. |
| `TELEGRAM_CHAT_ID` | unset | Alert destination. |
| `ALERTS_ENABLED` | `false` | Falls back to log-only when credentials are incomplete. |
| `DASHBOARD_ENABLED` | `true` | Read-only operator view. |
| `DASHBOARD_PORT` | `8787` | Listening port. |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address. Do not expose directly. |
| `LOG_LEVEL` | `info` | pino level. |
| `LOG_PRETTY` | `false` | Human-readable output for local development. |

---

## Universe configuration

The tradable universe lives in `config/universe.json`. Anything not listed there
is untradable by construction: the model can name a symbol, but the resolver
rejects it before an order is ever built.

```json
{
  "symbol": "bNVDA",
  "assetClass": "bstock",
  "address": "0x...",
  "decimals": 18,
  "underlying": "NVDA",
  "navRatio": 1,
  "sector": "semis",
  "enabled": true,
  "pool": {
    "address": "0x...",
    "version": "v3",
    "feeTier": 500,
    "token0": "0x...",
    "token1": "0x...",
    "token0Decimals": 18,
    "token1Decimals": 18,
    "assetIsToken0": true
  }
}
```

`navRatio` handles tokens that do not represent exactly one share. `sector`
groups names into cohorts for the relative value strategy. Setting `enabled` to
false removes an asset from the universe without losing its configuration.

The pool addresses shipped in the repository are placeholders. Replace them with
the live PancakeSwap pools for your deployment before running anything beyond a
dry run.

---

## Operations

```bash
# Funding and gas pre-flight
pnpm tsx scripts/fund-check.ts

# Inspect the ledger
pnpm tsx scripts/db-inspect.ts positions
pnpm tsx scripts/db-inspect.ts trades 20
pnpm tsx scripts/db-inspect.ts reasoning 5
pnpm tsx scripts/db-inspect.ts performance

# Arm live mode (interactive, requires the exact confirmation phrase)
pnpm tsx scripts/arm-live.ts

# Emergency liquidation
pnpm tsx scripts/exit-all.ts
```

Deployment on a bare-metal Linux box, including the systemd unit, hardening
settings and backup guidance, is documented in [`deploy/README.md`](deploy/README.md).

---

## Paper to live checklist

Do not skip steps. Each one exists because the failure it prevents is expensive.

1. **Soak in paper mode for at least 72 hours** against live BNB mainnet data,
   spanning at least two full US market sessions and one weekend so the session
   calendar and the NAV strategy's closed-market behaviour are both exercised.
2. **Reconciliation clean throughout.** Any drift during the soak is a bug in the
   accounting path, not a rounding artefact. Investigate before proceeding.
3. **Review the reasoning log.** Read at least twenty cycles end to end. Look for
   theses that do not follow from the snapshot, invalidations that are not
   checkable, and repeated rejections that indicate the model is misreading a
   limit.
4. **Verify the universe.** Every pool address, fee tier, token ordering and
   decimal count confirmed against the chain. A wrong `assetIsToken0` inverts
   every price for that asset.
5. **Confirm risk caps.** Read them out loud as absolute numbers, not
   percentages. Five percent of NAV means a specific amount of money.
6. **Fund the wallet with an amount you can afford to lose entirely**, and no
   more. Run `scripts/fund-check.ts` and confirm the gas balance.
7. **Test the alert path.** Trip a breaker in paper mode and confirm the Telegram
   message arrives.
8. **Rehearse the kill switch.** Create the flag file and confirm the agent stops
   opening new risk within one poll interval.
9. **Arm live mode** with `scripts/arm-live.ts`. Setting `EXECUTION_MODE=live`
   alone does nothing without the confirmation file.
10. **Watch the first live cycle in full**, from snapshot to fill to ledger
    entry, before leaving the agent unattended.

---

## Kill switch procedure

The kill switch is deliberately dumb: a file on disk and a process signal. An
operator with SSH and nothing else must be able to stop the agent, and that path
must not depend on the database, the RPC, or any code the agent itself controls.

**To halt trading immediately:**

```bash
touch /opt/4gent/.KILL_SWITCH
```

The agent polls for this file every two seconds. Once engaged it refuses to plan
any order, cancels its loops, drains in-flight transactions and alerts. Existing
positions are left open; the switch stops new activity, it does not liquidate.

**To halt and liquidate:**

```bash
pnpm tsx scripts/exit-all.ts
```

This writes the kill switch flag first, then market-sells every open position
through the normal execution path so the exits are accounted for like any other
trade.

**To stop the process entirely:**

```bash
sudo systemctl stop 4gent
```

`SIGTERM` triggers a graceful shutdown: loops stop, in-flight transactions drain,
open candle buckets flush, and the database closes cleanly. Allow up to 180
seconds.

**To re-arm:** remove the flag file. This is manual and never automatic.

```bash
rm /opt/4gent/.KILL_SWITCH
```

---

## Dashboard

A read-only operator view at `http://127.0.0.1:8787`, showing NAV and performance
statistics, open positions with the thesis and invalidation attached to each,
recent fills with realised PnL, reasoning cycles with decisions and token usage,
and the alert history.

There are no mutating endpoints, by design. Everything that can change the
agent's behaviour goes through the config, the ops scripts, or the kill switch
file, never through an HTTP request that could be reached by anything that finds
the port. The UI is a single dependency-free HTML string with no build step,
because a broken asset pipeline is not an acceptable reason to be unable to see
your positions at three in the morning.

Reach it over an SSH tunnel rather than exposing the port:

```bash
ssh -L 8787:127.0.0.1:8787 user@host
```

---

## Testing

```bash
pnpm test          # full suite
pnpm test:watch    # watch mode
pnpm typecheck     # project-wide type check
```

Tests use recorded fixtures and deterministic fakes. No live keys, no network
calls, no RPC access. The reasoning client has a static implementation that
replays fixed responses, so the full cycle including parsing, sanitisation and
risk planning can be exercised offline.

Coverage is concentrated where a bug costs money: fixed-point and PnL maths, the
config invariants, the decision parser and its semantic filters, position sizing
under every combination of binding cap, stop evaluation, and each strategy's
signal logic including the cases where it must stay silent.

---

## Repository layout

```
4gent/
  apps/
    agent/            Composition root and process entrypoint
  packages/
    core/             Types, schemas, config, maths, universe, logging
    db/               Drizzle schema, SQLite client, migrations
    chain/            viem clients, multicall, wallet, gas, nonces
    data/             Pools, prices, candles, equities, sessions, safety, snapshot
    brain/            Prompts, Anthropic client, parsing, reasoning cycle
    risk/             Sizing, breakers, stops, kill switch, guard
    strategies/       Signal modules and registry
    execution/        Quoter, paper engine, live router, approvals
    portfolio/        Accounting, metrics, reconciliation
    keeper/           Loops, watchdog, alerts, orchestrator
    dashboard/        Read-only server and UI
  config/
    universe.json     Tradable universe definition
  drizzle/            Generated migrations
  deploy/             systemd unit and deployment notes
  scripts/            Operational tooling
```

---

## Known limitations

- **Single instance only.** The SQLite database, the nonce manager and the kill
  switch all assume exactly one process against one wallet. Two instances will
  double-send.
- **v3 depth is approximated.** Depth for concentrated-liquidity pools is derived
  from active liquidity rather than a full tick walk. It is used for position
  sizing sanity, never for pricing a fill; fills always come from the on-chain
  quoter.
- **Reference prices are free-tier.** Stooq and Yahoo are unreliable enough that
  the NAV strategy treats a stale quote as no signal rather than trading on it.
  A paid feed would materially improve that strategy.
- **Holder counts and token age are not populated on chain.** The safety triage
  schema carries these fields and enforces them when present, but deriving them
  requires an indexer the agent does not currently include.
- **The invalidation parser is conservative by design.** It only extracts price
  levels from unambiguous phrasing. Vaguer invalidations fall through to the hard
  stop.
- **No shorting.** The decision schema supports long exposure only. Tokenized
  equities on an AMM have no borrow mechanism.

---

## Disclaimer

This software trades real assets with real money and can lose all of it. It is
provided as-is, with no warranty of any kind and no representation that it is
profitable, correct, or suitable for any purpose.

Tokenized equities and memecoins carry risks that conventional markets do not,
including smart contract failure, depeg from the underlying, liquidity
disappearing without warning, and outright fraud. Automated trading amplifies
every one of them.

Nothing here is financial advice. You are responsible for the legal and
regulatory status of running this in your jurisdiction, for the funds you expose
to it, and for every trade it makes on your behalf. Run it in paper mode. Read
the reasoning log. Understand the risk limits before you change them.
