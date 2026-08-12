import { readFileSync } from 'node:fs';
import { universeSchema, type UniverseConfig } from './schemas.js';
import type { AssetSpec, Symbol_ } from './types.js';

/**
 * The tradable universe. bStock pool addresses are deployment-specific, so the
 * shipped defaults live in `config/universe.json` and are overridable per host.
 * Anything not listed here is untradable by construction — the brain can name a
 * symbol, but the resolver will reject it before an order is ever built.
 */

export const USDT: `0x${string}` = '0x55d398326f99059ff775485246999027b3197955';
export const WBNB: `0x${string}` = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

export const PANCAKE_V3_QUOTER: `0x${string}` = '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997';
export const PANCAKE_V3_ROUTER: `0x${string}` = '0x13f4ea83d0bd40e75c8222255bc855a974568dd4';
export const PANCAKE_V2_ROUTER: `0x${string}` = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
export const PANCAKE_V2_FACTORY: `0x${string}` = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
export const MULTICALL3: `0x${string}` = '0xca11bde05977b3631167028862be2a173976ca11';

export class Universe {
  private readonly bySymbol = new Map<Symbol_, AssetSpec>();
  readonly quoteAsset: { symbol: Symbol_; address: `0x${string}`; decimals: number };

  constructor(config: UniverseConfig) {
    this.quoteAsset = {
      symbol: config.quote.symbol,
      address: config.quote.address,
      decimals: config.quote.decimals,
    };
    for (const raw of config.assets) {
      const asset: AssetSpec = { ...raw } as AssetSpec;
      this.bySymbol.set(asset.symbol.toUpperCase(), asset);
    }
  }

  static fromFile(path: string): Universe {
    const parsed = universeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return new Universe(parsed);
  }

  /** Case-insensitive lookup. Returns undefined for anything off-universe. */
  get(symbol: Symbol_): AssetSpec | undefined {
    return this.bySymbol.get(symbol.toUpperCase());
  }

  /** Throws rather than returning undefined — used on the execution path. */
  require(symbol: Symbol_): AssetSpec {
    const asset = this.get(symbol);
    if (!asset) throw new Error(`Unknown symbol "${symbol}" — not in the configured universe`);
    if (!asset.enabled) throw new Error(`Symbol "${symbol}" is disabled in the universe config`);
    return asset;
  }

  all(): AssetSpec[] {
    return [...this.bySymbol.values()];
  }

  enabled(): AssetSpec[] {
    return this.all().filter((a) => a.enabled);
  }

  byClass(assetClass: AssetSpec['assetClass']): AssetSpec[] {
    return this.enabled().filter((a) => a.assetClass === assetClass);
  }

  bstocks(): AssetSpec[] {
    return this.byClass('bstock');
  }

  memecoins(): AssetSpec[] {
    return this.byClass('memecoin');
  }

  /** Assets sharing a sector tag, used by the relative-value strategy. */
  cohort(sector: string): AssetSpec[] {
    return this.enabled().filter((a) => a.sector === sector);
  }

  sectors(): string[] {
    return [...new Set(this.enabled().map((a) => a.sector).filter(Boolean) as string[])];
  }

  /** Register a memecoin discovered at runtime once it has cleared triage. */
  admit(asset: AssetSpec): void {
    this.bySymbol.set(asset.symbol.toUpperCase(), asset);
  }

  revoke(symbol: Symbol_): void {
    const asset = this.get(symbol);
    if (asset) this.bySymbol.set(symbol.toUpperCase(), { ...asset, enabled: false });
  }
}
