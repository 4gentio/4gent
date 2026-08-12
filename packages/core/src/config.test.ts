import { describe, expect, it } from 'vitest';
import { loadConfig, publicConfig, resetConfigCache } from './config.js';

const BASE = { EXECUTION_MODE: 'paper' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies documented defaults when the env is empty', () => {
    resetConfigCache();
    const c = loadConfig({}, true);
    expect(c.mode).toBe('paper');
    expect(c.chain.id).toBe(56);
    expect(c.risk.maxPositionPct).toBe(5);
    expect(c.risk.maxMemecoinExposurePct).toBe(15);
  });

  it('rejects a per-position cap larger than the total invested cap', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({ ...BASE, MAX_POSITION_PCT: '90', MAX_TOTAL_INVESTED_PCT: '80' }, true),
    ).toThrow(/MAX_POSITION_PCT/);
  });

  it('rejects a weekly breaker tighter than the daily breaker', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({ ...BASE, DAILY_DRAWDOWN_BREAKER_PCT: '12', WEEKLY_DRAWDOWN_BREAKER_PCT: '6' }, true),
    ).toThrow(/breaker/);
  });

  it('refuses live mode without a wallet key', () => {
    resetConfigCache();
    expect(() => loadConfig({ EXECUTION_MODE: 'live' }, true)).toThrow(/WALLET_PRIVATE_KEY/);
  });

  it('never exposes secrets through publicConfig', () => {
    resetConfigCache();
    const c = loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'sk-ant-secret', TELEGRAM_BOT_TOKEN: 'tg-secret' }, true);
    const serialised = JSON.stringify(publicConfig(c));
    expect(serialised).not.toContain('sk-ant-secret');
    expect(serialised).not.toContain('tg-secret');
  });
});
