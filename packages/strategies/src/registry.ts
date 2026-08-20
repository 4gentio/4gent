import { logger, type AssetSpec, type Symbol_ } from '@4gent/core';
import type { MarketSnapshot } from '@4gent/data';
import { MemecoinMomentumStrategy } from './memecoinMomentum.js';
import { MomentumStrategy } from './momentum.js';
import { NavReversionStrategy } from './navReversion.js';
import { PairsStrategy } from './pairs.js';
import type { Signal, Strategy, StrategyContext } from './types.js';

const log = logger('strategies:registry');

export interface AnnotationResult {
  contexts: StrategyContext[];
  /** Notes keyed by strategy name, folded straight into the snapshot. */
  notes: Record<string, string[]>;
  /** Every signal, strongest conviction first. */
  signals: Signal[];
  /** Net score per symbol, weighted by each signal's confidence. */
  consensus: Map<Symbol_, { score: number; contributors: string[] }>;
}

/**
 * Runs every enabled strategy over one snapshot and folds the results into a
 * form the brain can read. Consensus is advisory: it tells the model where its
 * strategies agree, but it never becomes an order on its own.
 */
export class StrategyRegistry {
  private readonly strategies: Strategy[];

  constructor(strategies?: Strategy[]) {
    this.strategies = strategies ?? [
      new NavReversionStrategy(),
      new MomentumStrategy(),
      new MemecoinMomentumStrategy(),
      new PairsStrategy(),
    ];
  }

  get names(): string[] {
    return this.strategies.map((s) => s.name);
  }

  universe(assets: readonly AssetSpec[]): Set<Symbol_> {
    const symbols = new Set<Symbol_>();
    for (const strategy of this.strategies) {
      for (const symbol of strategy.universe(assets)) symbols.add(symbol);
    }
    return symbols;
  }

  annotate(snapshot: MarketSnapshot): AnnotationResult {
    const contexts: StrategyContext[] = [];
    const notes: Record<string, string[]> = {};
    const signals: Signal[] = [];

    for (const strategy of this.strategies) {
      try {
        const context = strategy.annotate(snapshot);
        contexts.push(context);
        signals.push(...context.signals);
        notes[strategy.name] = [
          ...context.signals.map((s) => s.note),
          ...context.notes,
        ];
      } catch (error) {
        log.error({ strategy: strategy.name, err: String(error) }, 'strategy annotation failed');
        notes[strategy.name] = [`Strategy failed to run: ${String(error)}`];
      }
    }

    const consensus = new Map<Symbol_, { score: number; contributors: string[] }>();
    for (const signal of signals) {
      const entry = consensus.get(signal.symbol) ?? { score: 0, contributors: [] };
      entry.score += signal.score * signal.confidence;
      entry.contributors.push(signal.strategy);
      consensus.set(signal.symbol, entry);
    }

    signals.sort((a, b) => Math.abs(b.score * b.confidence) - Math.abs(a.score * a.confidence));
    return { contexts, notes, signals, consensus };
  }

  guardrailsFor(strategyName: string) {
    return this.strategies.find((s) => s.name === strategyName)?.guardrails;
  }
}
