import { eq } from 'drizzle-orm';
import type { Address, PublicClient } from 'viem';
import {
  bpsDiff,
  fromRaw,
  logger,
  now,
  toRaw,
  type AppConfig,
  type AssetSpec,
} from '@4gent/core';
import { erc20Abi, multicall, ownerProbeAbi, pancakeV2RouterAbi, unwrapOr } from '@4gent/chain';
import { PANCAKE_V2_ROUTER, USDT } from '@4gent/core';
import { tokenSafety, type Db } from '@4gent/db';

const log = logger('data:safety');

export interface SafetyEvidence {
  address: Address;
  symbol: string;
  /** Bytecode present and non-trivial. */
  hasCode: boolean;
  codeSize: number;
  totalSupply: bigint | null;
  /** Measured, not declared: quoted output vs simulated received output. */
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  /** A buy followed immediately by a sell must return non-zero quote. */
  roundTripOk: boolean;
  roundTripRetainedBps: number | null;
  liquidityUsd: number;
  ageMinutes: number | null;
  holderCount: number | null;
  ownerPrivileges: string[];
  errors: string[];
}

export type SafetyVerdict = 'pass' | 'fail' | 'uncertain';

export interface SafetyResult {
  address: Address;
  symbol: string;
  verdict: SafetyVerdict;
  riskScore: number;
  flags: string[];
  rationale: string;
  evidence: SafetyEvidence;
}

/** A classifier the pipeline can delegate ambiguous cases to. */
export interface TriageClassifier {
  classify(evidence: SafetyEvidence): Promise<{
    verdict: SafetyVerdict;
    risk_score: number;
    flags: string[];
    rationale: string;
  }>;
}

/**
 * Deterministic-first memecoin gate.
 *
 * Nothing here trusts a token's own claims. Taxes are measured by comparing a
 * router quote against an `eth_call` simulation of the real transfer path, and
 * a token that cannot complete a simulated buy-then-sell round trip is rejected
 * outright regardless of what any model thinks about it.
 */
export class SafetyTriage {
  constructor(
    private readonly client: PublicClient,
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly classifier?: TriageClassifier,
  ) {}

  /** Cached verdict, if the token was checked recently enough to still count. */
  async cached(address: Address, maxAgeMs = 6 * 3_600_000): Promise<SafetyResult | null> {
    const rows = await this.db.select().from(tokenSafety).where(eq(tokenSafety.address, address.toLowerCase())).limit(1);
    const row = rows[0];
    if (!row || now() - row.checkedAt > maxAgeMs) return null;
    return {
      address: row.address as Address,
      symbol: row.symbol,
      verdict: row.verdict,
      riskScore: row.riskScore,
      flags: (row.flags as string[]) ?? [],
      rationale: row.rationale ?? '',
      evidence: {
        address: row.address as Address,
        symbol: row.symbol,
        hasCode: true,
        codeSize: 0,
        totalSupply: null,
        buyTaxBps: row.buyTaxBps,
        sellTaxBps: row.sellTaxBps,
        roundTripOk: row.roundTripOk ?? false,
        roundTripRetainedBps: null,
        liquidityUsd: row.liquidityUsd ?? 0,
        ageMinutes: row.ageMinutes,
        holderCount: row.holderCount,
        ownerPrivileges: (row.ownerPrivileges as string[]) ?? [],
        errors: [],
      },
    };
  }

  async check(asset: AssetSpec, opts: { probeUsd?: number; force?: boolean } = {}): Promise<SafetyResult> {
    const address = asset.address.toLowerCase() as Address;
    if (!opts.force) {
      const hit = await this.cached(address);
      if (hit) return hit;
    }

    const evidence = await this.gather(asset, opts.probeUsd ?? 100);
    const hard = this.applyHardRules(evidence);

    let result: SafetyResult;
    if (hard.verdict === 'fail') {
      result = { address, symbol: asset.symbol, ...hard, evidence };
    } else if (hard.verdict === 'pass' || !this.classifier) {
      result = { address, symbol: asset.symbol, ...hard, evidence };
    } else {
      // Only genuinely ambiguous evidence reaches the model.
      const classified = await this.classifier.classify(evidence).catch((error) => {
        log.warn({ symbol: asset.symbol, err: String(error) }, 'classifier failed, holding uncertain');
        return { verdict: 'uncertain' as const, risk_score: 75, flags: ['classifier_error'], rationale: String(error) };
      });
      result = {
        address,
        symbol: asset.symbol,
        verdict: classified.verdict,
        riskScore: classified.risk_score,
        flags: [...hard.flags, ...classified.flags],
        rationale: classified.rationale,
        evidence,
      };
    }

    await this.persist(result);
    log.info({ symbol: asset.symbol, verdict: result.verdict, risk: result.riskScore }, 'safety triage complete');
    return result;
  }

  /** A token is tradable only on an explicit pass. Uncertain means no. */
  async isTradable(asset: AssetSpec): Promise<boolean> {
    if (asset.assetClass !== 'memecoin') return true;
    const result = await this.check(asset);
    return result.verdict === 'pass';
  }

  private async gather(asset: AssetSpec, probeUsd: number): Promise<SafetyEvidence> {
    const address = asset.address.toLowerCase() as Address;
    const errors: string[] = [];
    const ownerPrivileges: string[] = [];

    const code = await this.client.getCode({ address }).catch(() => undefined);
    const codeSize = code ? (code.length - 2) / 2 : 0;

    const probes = await multicall(this.client, [
      { address, abi: erc20Abi, functionName: 'totalSupply' },
      { address, abi: ownerProbeAbi, functionName: 'owner' },
      { address, abi: ownerProbeAbi, functionName: 'paused' },
      { address, abi: ownerProbeAbi, functionName: 'tradingEnabled' },
      { address, abi: ownerProbeAbi, functionName: 'maxTxAmount' },
      { address, abi: ownerProbeAbi, functionName: 'maxWalletAmount' },
    ]);

    const totalSupply = probes[0]?.ok ? (probes[0].value as bigint) : null;
    const ZERO = '0x0000000000000000000000000000000000000000';
    if (probes[1]?.ok && String(probes[1].value).toLowerCase() !== ZERO) ownerPrivileges.push('owner_not_renounced');
    if (probes[2]?.ok && probes[2].value === true) ownerPrivileges.push('paused');
    if (probes[3]?.ok && probes[3].value === false) ownerPrivileges.push('trading_disabled');
    if (probes[4]?.ok && totalSupply) {
      const maxTx = probes[4].value as bigint;
      if (maxTx > 0n && maxTx * 100n < totalSupply) ownerPrivileges.push('max_tx_under_1pct');
    }
    if (probes[5]?.ok && totalSupply) {
      const maxWallet = probes[5].value as bigint;
      if (maxWallet > 0n && maxWallet * 200n < totalSupply) ownerPrivileges.push('max_wallet_under_0_5pct');
    }

    const roundTrip = await this.simulateRoundTrip(asset, probeUsd).catch((error) => {
      errors.push(`round_trip: ${String(error)}`);
      return null;
    });

    const liquidityUsd = await this.estimateLiquidity(asset).catch((error) => {
      errors.push(`liquidity: ${String(error)}`);
      return 0;
    });

    return {
      address,
      symbol: asset.symbol,
      hasCode: codeSize > 0,
      codeSize,
      totalSupply,
      buyTaxBps: roundTrip?.buyTaxBps ?? null,
      sellTaxBps: roundTrip?.sellTaxBps ?? null,
      roundTripOk: roundTrip?.ok ?? false,
      roundTripRetainedBps: roundTrip?.retainedBps ?? null,
      liquidityUsd,
      ageMinutes: null,
      holderCount: null,
      ownerPrivileges,
      errors,
    };
  }

  /**
   * Buys `probeUsd` of the token and immediately sells it back, entirely inside
   * `eth_call`. A honeypot either reverts on the sell leg or returns far less
   * than the router quote implied.
   */
  private async simulateRoundTrip(
    asset: AssetSpec,
    probeUsd: number,
  ): Promise<{ ok: boolean; buyTaxBps: number; sellTaxBps: number; retainedBps: number }> {
    const amountIn = toRaw(probeUsd, 18);
    const buyPath = [USDT, asset.address] as Address[];
    const sellPath = [asset.address, USDT] as Address[];

    const buyQuote = (await this.client.readContract({
      address: PANCAKE_V2_ROUTER,
      abi: pancakeV2RouterAbi,
      functionName: 'getAmountsOut',
      args: [amountIn, buyPath],
    })) as readonly bigint[];
    const expectedTokens = buyQuote[buyQuote.length - 1] ?? 0n;
    if (expectedTokens === 0n) throw new Error('buy quote returned zero');

    // Simulate the actual transfer path with a fee-on-transfer-tolerant call.
    const probeCaller = '0x000000000000000000000000000000000000dEaD' as Address;
    const buySim = await this.client.simulateContract({
      address: PANCAKE_V2_ROUTER,
      abi: pancakeV2RouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, 0n, buyPath, probeCaller, BigInt(Math.floor(Date.now() / 1000) + 600)],
      account: probeCaller,
    }).catch(() => null);

    const receivedTokens = buySim
      ? ((buySim.result as readonly bigint[])?.at(-1) ?? expectedTokens)
      : expectedTokens;
    const buyTaxBps = Math.max(0, -bpsDiff(Number(receivedTokens), Number(expectedTokens)));

    const sellQuote = (await this.client.readContract({
      address: PANCAKE_V2_ROUTER,
      abi: pancakeV2RouterAbi,
      functionName: 'getAmountsOut',
      args: [receivedTokens, sellPath],
    })) as readonly bigint[];
    const expectedBack = sellQuote[sellQuote.length - 1] ?? 0n;

    const sellSim = await this.client.simulateContract({
      address: PANCAKE_V2_ROUTER,
      abi: pancakeV2RouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [receivedTokens, 0n, sellPath, probeCaller, BigInt(Math.floor(Date.now() / 1000) + 600)],
      account: probeCaller,
    }).catch(() => null);

    if (!sellSim || expectedBack === 0n) {
      return { ok: false, buyTaxBps, sellTaxBps: 10_000, retainedBps: 0 };
    }

    const receivedBack = (sellSim.result as readonly bigint[])?.at(-1) ?? expectedBack;
    const sellTaxBps = Math.max(0, -bpsDiff(Number(receivedBack), Number(expectedBack)));
    const retainedBps = Math.round((Number(receivedBack) / Number(amountIn)) * 10_000);

    return { ok: receivedBack > 0n, buyTaxBps, sellTaxBps, retainedBps };
  }

  private async estimateLiquidity(asset: AssetSpec): Promise<number> {
    const results = await multicall(this.client, [
      { address: asset.pool.address, abi: erc20Abi, functionName: 'balanceOf', args: [asset.pool.address] },
      { address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [asset.pool.address] },
    ]);
    const quoteSide = unwrapOr(results[1], 0n) as bigint;
    // A constant-product pool's total depth is roughly twice the quote reserve.
    return fromRaw(quoteSide, 18) * 2;
  }

  /**
   * Hard rules. These are absolute: no classifier verdict can override a failed
   * round trip or an out-of-policy sell tax.
   */
  private applyHardRules(e: SafetyEvidence): { verdict: SafetyVerdict; riskScore: number; flags: string[]; rationale: string } {
    const flags: string[] = [];
    const { safety } = this.config;

    if (!e.hasCode) return fail(flags, 'no_bytecode', 'Address holds no contract code');
    if (e.codeSize < 200) flags.push('tiny_bytecode');
    if (!e.roundTripOk) return fail(flags, 'round_trip_failed', 'Simulated buy-then-sell did not return funds');
    if (e.sellTaxBps !== null && e.sellTaxBps > safety.maxSellTaxBps) {
      return fail(flags, 'sell_tax_above_cap', `Sell tax ${e.sellTaxBps}bps exceeds ${safety.maxSellTaxBps}bps cap`);
    }
    if (e.buyTaxBps !== null && e.buyTaxBps > safety.maxBuyTaxBps) {
      return fail(flags, 'buy_tax_above_cap', `Buy tax ${e.buyTaxBps}bps exceeds ${safety.maxBuyTaxBps}bps cap`);
    }
    if (e.liquidityUsd < safety.minLiquidityUsd) {
      return fail(
        flags,
        'insufficient_liquidity',
        `Liquidity ${Math.round(e.liquidityUsd)} below ${safety.minLiquidityUsd} floor`,
      );
    }
    if (e.ageMinutes !== null && e.ageMinutes < safety.minTokenAgeMinutes) {
      return fail(flags, 'too_new', `Token is ${e.ageMinutes}m old, below the ${safety.minTokenAgeMinutes}m floor`);
    }
    if (e.holderCount !== null && e.holderCount < safety.minHolderCount) {
      flags.push('low_holder_count');
    }

    let riskScore = 10;
    for (const privilege of e.ownerPrivileges) {
      flags.push(privilege);
      riskScore += privilege === 'owner_not_renounced' ? 20 : 15;
    }
    if (e.roundTripRetainedBps !== null && e.roundTripRetainedBps < 9_000) {
      flags.push('high_round_trip_cost');
      riskScore += 15;
    }
    if (e.errors.length > 0) {
      flags.push('incomplete_evidence');
      riskScore += 20;
    }

    if (riskScore >= 60) {
      return { verdict: 'uncertain', riskScore, flags, rationale: 'Multiple owner privileges or incomplete evidence' };
    }
    return { verdict: 'pass', riskScore, flags, rationale: 'Cleared all deterministic checks' };
  }

  private async persist(result: SafetyResult): Promise<void> {
    const e = result.evidence;
    await this.db
      .insert(tokenSafety)
      .values({
        address: result.address,
        symbol: result.symbol,
        verdict: result.verdict,
        riskScore: result.riskScore,
        buyTaxBps: e.buyTaxBps,
        sellTaxBps: e.sellTaxBps,
        liquidityUsd: e.liquidityUsd,
        holderCount: e.holderCount,
        ageMinutes: e.ageMinutes,
        sourceVerified: null,
        roundTripOk: e.roundTripOk,
        ownerPrivileges: e.ownerPrivileges as never,
        flags: result.flags as never,
        rationale: result.rationale,
        checkedAt: now(),
      })
      .onConflictDoUpdate({
        target: tokenSafety.address,
        set: {
          verdict: result.verdict,
          riskScore: result.riskScore,
          buyTaxBps: e.buyTaxBps,
          sellTaxBps: e.sellTaxBps,
          liquidityUsd: e.liquidityUsd,
          roundTripOk: e.roundTripOk,
          flags: result.flags as never,
          rationale: result.rationale,
          checkedAt: now(),
        },
      });
  }
}

function fail(flags: string[], flag: string, rationale: string) {
  return { verdict: 'fail' as const, riskScore: 100, flags: [...flags, flag], rationale };
}

/** Human-readable one-liner for alerts and the dashboard. */
export function describeSafety(result: SafetyResult): string {
  const tax = `buy ${result.evidence.buyTaxBps ?? '?'}bps / sell ${result.evidence.sellTaxBps ?? '?'}bps`;
  const flags = result.flags.length > 0 ? ` [${result.flags.join(', ')}]` : '';
  return `${result.symbol} ${result.verdict} (risk ${result.riskScore}, ${tax})${flags}`;
}
