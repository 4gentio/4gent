import { logger, type Position, type Symbol_ } from '@4gent/core';

const log = logger('risk:stops');

export interface StopTrigger {
  symbol: Symbol_;
  reason: 'hard_stop' | 'invalidation_price' | 'stale_scalp';
  markPrice: number;
  stopPrice: number | null;
  detail: string;
}

export interface StopContext {
  marks: ReadonlyMap<Symbol_, number>;
  at?: number;
}

/**
 * Between reasoning cycles the risk layer is the only thing watching. A five
 * minute gap is an eternity for a memecoin, so stops are evaluated on the price
 * loop and force-close without waiting for the model's opinion.
 */
export function evaluateStops(positions: readonly Position[], ctx: StopContext): StopTrigger[] {
  const at = ctx.at ?? Date.now();
  const triggers: StopTrigger[] = [];

  for (const position of positions) {
    if (position.status !== 'open') continue;
    const mark = ctx.marks.get(position.symbol);
    if (mark === undefined || !(mark > 0)) continue;

    if (position.hardStopPrice > 0 && mark <= position.hardStopPrice) {
      triggers.push({
        symbol: position.symbol,
        reason: 'hard_stop',
        markPrice: mark,
        stopPrice: position.hardStopPrice,
        detail: `mark ${mark} at or below hard stop ${position.hardStopPrice}`,
      });
      continue;
    }

    const invalidationLevel = extractPriceLevel(position.invalidation);
    if (invalidationLevel !== null && mark <= invalidationLevel) {
      triggers.push({
        symbol: position.symbol,
        reason: 'invalidation_price',
        markPrice: mark,
        stopPrice: invalidationLevel,
        detail: `mark ${mark} crossed the stated invalidation level ${invalidationLevel}`,
      });
      continue;
    }

    // A scalp that has become an accidental swing is a thesis failure by
    // definition, regardless of where the price sits.
    if (position.timeHorizon === 'scalp') {
      const ageHours = (at - position.openedAt) / 3_600_000;
      if (ageHours > 4) {
        triggers.push({
          symbol: position.symbol,
          reason: 'stale_scalp',
          markPrice: mark,
          stopPrice: null,
          detail: `scalp held ${ageHours.toFixed(1)}h, beyond the 4h horizon`,
        });
      }
    }
  }

  if (triggers.length > 0) {
    log.warn({ triggers: triggers.map((t) => `${t.symbol}:${t.reason}`) }, 'stop triggers fired');
  }
  return triggers;
}

/**
 * Best-effort extraction of a numeric price level from the model's free-text
 * invalidation.
 *
 * This is intentionally conservative. It only fires on an explicit "below X"
 * or "under X" phrasing; anything vaguer is left to the hard stop, because a
 * false positive here closes a good position for no reason.
 */
export function extractPriceLevel(invalidation: string): number | null {
  const match = invalidation.match(/\b(?:below|under|breaks?(?:\s+below)?|closes?\s+under)\s+\$?([\d,]+(?:\.\d+)?)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Trailing stop that only ever ratchets upward. */
export function trailStop(currentStop: number, markPrice: number, trailPct: number): number {
  const candidate = markPrice * (1 - trailPct / 100);
  return candidate > currentStop ? candidate : currentStop;
}
