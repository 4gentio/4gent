import { describe, expect, it } from 'vitest';
import type { Position } from '@4gent/core';
import { evaluateStops, extractPriceLevel, trailStop } from '../src/stops.js';

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    symbol: 'bTSLA',
    assetClass: 'bstock',
    quantityRaw: 10n ** 18n,
    quantity: 10,
    avgEntryPrice: 100,
    costBasis: 1_000,
    openedAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    strategy: 'brain_open',
    thesis: 't',
    invalidation: 'thesis fails',
    timeHorizon: 'swing',
    conviction: 3,
    hardStopPrice: 92,
    status: 'open',
    ...overrides,
  };
}

describe('extractPriceLevel', () => {
  it('reads explicit downside levels', () => {
    expect(extractPriceLevel('Close if it trades below 245.50')).toBeCloseTo(245.5);
    expect(extractPriceLevel('invalid under $1,320')).toBeCloseTo(1320);
    expect(extractPriceLevel('breaks below 88')).toBeCloseTo(88);
  });

  it('stays silent on vague phrasing rather than guessing', () => {
    expect(extractPriceLevel('the thesis stops working')).toBeNull();
    expect(extractPriceLevel('NAV deviation converges to 10bps')).toBeNull();
    expect(extractPriceLevel('above 300')).toBeNull();
  });
});

describe('evaluateStops', () => {
  it('fires when the mark breaches the hard stop', () => {
    const triggers = evaluateStops([position()], { marks: new Map([['bTSLA', 91]]) });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.reason).toBe('hard_stop');
  });

  it('does not fire above the stop', () => {
    expect(evaluateStops([position()], { marks: new Map([['bTSLA', 99]]) })).toHaveLength(0);
  });

  it('fires on a stated invalidation level before the hard stop', () => {
    const triggers = evaluateStops([position({ invalidation: 'exit below 97' })], {
      marks: new Map([['bTSLA', 96]]),
    });
    expect(triggers[0]!.reason).toBe('invalidation_price');
  });

  it('closes a scalp that has overstayed its horizon', () => {
    const stale = position({ timeHorizon: 'scalp', openedAt: Date.now() - 6 * 3_600_000 });
    const triggers = evaluateStops([stale], { marks: new Map([['bTSLA', 105]]) });
    expect(triggers[0]!.reason).toBe('stale_scalp');
  });

  it('skips positions with no fresh mark rather than assuming a price', () => {
    expect(evaluateStops([position()], { marks: new Map() })).toHaveLength(0);
  });

  it('ignores closed positions', () => {
    const closed = position({ status: 'closed' });
    expect(evaluateStops([closed], { marks: new Map([['bTSLA', 1]]) })).toHaveLength(0);
  });
});

describe('trailStop', () => {
  it('only ever ratchets upward', () => {
    expect(trailStop(90, 120, 10)).toBeCloseTo(108);
    expect(trailStop(108, 100, 10)).toBeCloseTo(108);
  });
});
