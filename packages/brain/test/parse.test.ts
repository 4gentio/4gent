import { describe, expect, it } from 'vitest';
import type { BrainResponse } from '@4gent/core';
import { actionable, parseBrainResponse, sanitizeDecisions } from '../src/parse.js';

const VALID = {
  decisions: [
    {
      action: 'open_long',
      symbol: 'bNVDA',
      conviction: 4,
      size_pct_of_available: 20,
      time_horizon: 'swing',
      thesis: 'Pool trades 90bps under NAV with the underlying session open.',
      invalidation: 'Deviation closes inside 15bps or the US session ends.',
    },
  ],
  portfolio_note: 'One new swing, otherwise flat.',
};

describe('parseBrainResponse', () => {
  it('accepts a bare JSON object', () => {
    const result = parseBrainResponse(JSON.stringify(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.decisions).toHaveLength(1);
  });

  it('recovers JSON from a markdown fence', () => {
    const result = parseBrainResponse('```json\n' + JSON.stringify(VALID) + '\n```');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repaired).toBe(true);
  });

  it('recovers JSON that follows a stray preamble', () => {
    const result = parseBrainResponse(`Here is my analysis.\n${JSON.stringify(VALID)}`);
    expect(result.ok).toBe(true);
  });

  it('is not confused by braces inside string values', () => {
    const tricky = { ...VALID, portfolio_note: 'watching the {bNVDA} pool' };
    const result = parseBrainResponse(`noise ${JSON.stringify(tricky)} trailing`);
    expect(result.ok).toBe(true);
  });

  it('rejects an out-of-range conviction with a usable repair hint', () => {
    const bad = { ...VALID, decisions: [{ ...VALID.decisions[0], conviction: 9 }] };
    const result = parseBrainResponse(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('conviction');
  });

  it('rejects unknown top-level fields rather than silently dropping them', () => {
    const result = parseBrainResponse(JSON.stringify({ ...VALID, execute_now: true }));
    expect(result.ok).toBe(false);
  });

  it('reports a clear failure when there is no JSON at all', () => {
    const result = parseBrainResponse('I would rather not trade right now.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no JSON/);
  });
});

describe('sanitizeDecisions', () => {
  const base = (overrides: Partial<BrainResponse['decisions'][number]>) => ({
    ...VALID.decisions[0]!,
    ...overrides,
  });

  const ctx = {
    knownSymbols: new Set(['bNVDA', 'bTSLA']),
    openSymbols: new Set(['bTSLA']),
    closeOnly: false,
  };

  it('discards symbols outside the universe', () => {
    const out = sanitizeDecisions(
      { decisions: [base({ symbol: 'DOGE2' })], portfolio_note: '' } as BrainResponse,
      ctx,
    );
    expect(out.accepted).toHaveLength(0);
    expect(out.discarded[0]!.reason).toMatch(/unknown symbol/);
  });

  it('rejects opens on names already held', () => {
    const out = sanitizeDecisions(
      { decisions: [base({ symbol: 'bTSLA', action: 'open_long' })], portfolio_note: '' } as BrainResponse,
      ctx,
    );
    expect(out.discarded[0]!.reason).toMatch(/already open/);
  });

  it('rejects closes on names not held', () => {
    const out = sanitizeDecisions(
      { decisions: [base({ symbol: 'bNVDA', action: 'close' })], portfolio_note: '' } as BrainResponse,
      ctx,
    );
    expect(out.discarded[0]!.reason).toMatch(/no open position/);
  });

  it('blocks new risk entirely in close-only mode', () => {
    const out = sanitizeDecisions(
      { decisions: [base({ symbol: 'bNVDA', action: 'open_long' })], portfolio_note: '' } as BrainResponse,
      { ...ctx, closeOnly: true },
    );
    expect(out.accepted).toHaveLength(0);
    expect(out.discarded[0]!.reason).toMatch(/close-only/);
  });

  it('keeps only the first decision per symbol', () => {
    const out = sanitizeDecisions(
      {
        decisions: [base({ symbol: 'bNVDA' }), base({ symbol: 'bNVDA', conviction: 1 })],
        portfolio_note: '',
      } as BrainResponse,
      ctx,
    );
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.conviction).toBe(4);
  });
});

describe('actionable', () => {
  it('filters holds out of the execution path', () => {
    const decisions = [
      { ...VALID.decisions[0]!, action: 'hold' as const },
      { ...VALID.decisions[0]!, action: 'open_long' as const },
    ];
    expect(actionable(decisions)).toHaveLength(1);
  });
});
