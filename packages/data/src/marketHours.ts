import type { MarketSession } from '@4gent/core';

/**
 * US equity session state.
 *
 * This matters more than it looks: a bStock trading 3% away from its underlying
 * at 2am UTC is not an arbitrage, it is simply the market pricing overnight
 * risk. The NAV strategy is therefore only allowed to act during the regular
 * session.
 */

/** Fixed NYSE holidays for the current schedule, as UTC date keys. */
const HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

/** Half days close at 13:00 ET. */
const HALF_DAYS_2026 = new Set(['2026-11-27', '2026-12-24']);

/**
 * US Eastern offset from UTC in hours. DST runs from the second Sunday in March
 * to the first Sunday in November.
 */
export function easternOffsetHours(timestamp: number): number {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const marchSecondSunday = nthWeekdayUtc(year, 2, 0, 2);
  const novemberFirstSunday = nthWeekdayUtc(year, 10, 0, 1);
  const dstStart = marchSecondSunday + 7 * 3_600_000; // 07:00 UTC
  const dstEnd = novemberFirstSunday + 6 * 3_600_000; // 06:00 UTC
  return timestamp >= dstStart && timestamp < dstEnd ? -4 : -5;
}

function nthWeekdayUtc(year: number, month: number, weekday: number, n: number): number {
  const first = Date.UTC(year, month, 1);
  const firstWeekday = new Date(first).getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return first + (offset + (n - 1) * 7) * 86_400_000;
}

export interface SessionInfo {
  session: MarketSession;
  /** Minutes until the next session transition. */
  minutesToChange: number;
  easternTime: string;
  dateKey: string;
}

export function marketSession(timestamp = Date.now()): SessionInfo {
  const offset = easternOffsetHours(timestamp);
  const et = new Date(timestamp + offset * 3_600_000);
  const dateKey = et.toISOString().slice(0, 10);
  const day = et.getUTCDay();
  const minutes = et.getUTCHours() * 60 + et.getUTCMinutes();
  const easternTime = et.toISOString().slice(11, 16);

  const weekend = day === 0 || day === 6;
  if (weekend) {
    return { session: 'closed', minutesToChange: minutesUntilWeekdayOpen(day, minutes), easternTime, dateKey };
  }
  if (HOLIDAYS_2026.has(dateKey)) {
    return { session: 'holiday', minutesToChange: 24 * 60 - minutes, easternTime, dateKey };
  }

  const OPEN = 9 * 60 + 30;
  const CLOSE = HALF_DAYS_2026.has(dateKey) ? 13 * 60 : 16 * 60;
  const PRE_OPEN = 4 * 60;
  const POST_CLOSE = 20 * 60;

  if (minutes < PRE_OPEN) return { session: 'closed', minutesToChange: PRE_OPEN - minutes, easternTime, dateKey };
  if (minutes < OPEN) return { session: 'pre', minutesToChange: OPEN - minutes, easternTime, dateKey };
  if (minutes < CLOSE) return { session: 'open', minutesToChange: CLOSE - minutes, easternTime, dateKey };
  if (minutes < POST_CLOSE) return { session: 'post', minutesToChange: POST_CLOSE - minutes, easternTime, dateKey };
  return { session: 'closed', minutesToChange: 24 * 60 - minutes + PRE_OPEN, easternTime, dateKey };
}

export function isRegularSession(timestamp = Date.now()): boolean {
  return marketSession(timestamp).session === 'open';
}

/** True in the last 15 minutes before the close, when spreads widen. */
export function isNearClose(timestamp = Date.now(), withinMinutes = 15): boolean {
  const info = marketSession(timestamp);
  return info.session === 'open' && info.minutesToChange <= withinMinutes;
}

function minutesUntilWeekdayOpen(day: number, minutes: number): number {
  const daysToMonday = day === 6 ? 2 : 1;
  return daysToMonday * 24 * 60 - minutes + 9 * 60 + 30;
}
