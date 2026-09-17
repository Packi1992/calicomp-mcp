/**
 * MCP-local unit tests for src/recurrence.ts's parser quirks and the two D-15 loud
 * failures — behaviours the shared corpus cannot express (a rule that throws has no
 * `expectedDates` to pin; a raw stored `deletedOccurrences` column is not part of the
 * `expansion` vector shape yet — plan 135-02 extends the corpus for the cross-language
 * half of that). The corpus-driven cross-language replay itself lives in
 * tests/shared-vectors.test.ts.
 *
 * Source analogue: TrainCounter/.../ui/screens/calendar/RecurrenceExpander.kt:51-57
 * (the two degenerate branches) and :118-131 (parseDeletedOccurrences' parse tolerance).
 */

import { describe, it, expect } from 'vitest';
import {
  expandDates,
  parseRRuleConfig,
  parseDeletedOccurrences,
  parseIsoDate,
  plusMonths,
  mondayOf,
  RecurrenceRuleError,
} from '../src/recurrence.js';

describe('plusMonths — java.time-faithful clamping, never overflow', () => {
  it('2026-01-31 + 1 month lands on 2026-02-28 (clamped, not rolled over into March)', () => {
    expect(plusMonths(parseIsoDate('2026-01-31'), 1)).toEqual({ y: 2026, m: 2, d: 28 });
  });

  it('2026-01-31 + 2 months lands on 2026-03-31 (the emitted day is re-derived from the clamped cursor)', () => {
    expect(plusMonths(parseIsoDate('2026-01-31'), 2)).toEqual({ y: 2026, m: 3, d: 31 });
  });

  it('2026-02-28 + 1 month lands on 2026-03-28 (no memory of the original 31st)', () => {
    expect(plusMonths(parseIsoDate('2026-02-28'), 1)).toEqual({ y: 2026, m: 3, d: 28 });
  });
});

describe('mondayOf — moves backward or is a no-op, never forward', () => {
  it('a date that already is a Monday is a no-op', () => {
    const monday = parseIsoDate('2026-06-08'); // a Monday
    expect(mondayOf(monday)).toEqual(monday);
  });

  it('a Sunday moves back six days to the Monday of the same ISO week', () => {
    const sunday = parseIsoDate('2026-06-14'); // a Sunday
    expect(mondayOf(sunday)).toEqual(parseIsoDate('2026-06-08'));
  });
});

describe('expandDates — the FREQ-missing-but-not-blank asymmetry (RecurrenceExpander.kt:51-57)', () => {
  const rangeStart = parseIsoDate('2026-06-01');
  const rangeEnd = parseIsoDate('2026-06-30');
  const dtstart = parseIsoDate('2026-06-10');

  it('a non-blank rule with no FREQ key (line 56-57) returns DTSTART when in range EVEN WHEN DTSTART is in deletedDates', () => {
    const dates = expandDates(dtstart, 'INTERVAL=2', rangeStart, rangeEnd, new Set(['2026-06-10']));
    expect(dates).toEqual([dtstart]);
  });

  it('a null rule with the SAME deletedDates (line 51-54) returns the empty list', () => {
    const dates = expandDates(dtstart, null, rangeStart, rangeEnd, new Set(['2026-06-10']));
    expect(dates).toEqual([]);
  });
});

describe('parseRRuleConfig — parse tolerance (RecurrenceExpander.kt:150-161)', () => {
  it('an unrecognised BYDAY token is dropped while its valid neighbours survive', () => {
    const config = parseRRuleConfig('FREQ=WEEKLY;BYDAY=MO,XX,WE');
    expect(config.byDay).toEqual(['MO', 'WE']);
  });

  it('a non-numeric INTERVAL yields 1', () => {
    expect(parseRRuleConfig('FREQ=WEEKLY;INTERVAL=notanumber').interval).toBe(1);
  });

  it('an UNTIL value with a time suffix keeps only its first eight characters', () => {
    expect(parseRRuleConfig('FREQ=WEEKLY;UNTIL=20261231T235959Z').until).toBe('2026-12-31');
  });

  it('an unparseable UNTIL yields null (open-ended rule)', () => {
    expect(parseRRuleConfig('FREQ=WEEKLY;UNTIL=notadate').until).toBeNull();
  });

  it('a null rule yields the WEEKLY/1/empty/null defaults', () => {
    expect(parseRRuleConfig(null)).toEqual({ freq: 'WEEKLY', interval: 1, byDay: [], until: null });
  });

  it('byDay is emitted Monday-first regardless of stored token order (BYDAY=FR,MO -> [MO,FR])', () => {
    expect(parseRRuleConfig('FREQ=WEEKLY;BYDAY=FR,MO').byDay).toEqual(['MO', 'FR']);
  });
});

describe('parseDeletedOccurrences — parse tolerance (RecurrenceExpander.kt:118-131)', () => {
  it('a bracketed, quoted, unsorted column with a duplicate yields the sorted deduplicated list', () => {
    expect(parseDeletedOccurrences('["2026-06-16","2026-06-02","2026-06-02"]')).toEqual([
      '2026-06-02',
      '2026-06-16',
    ]);
  });

  it('an unbracketed bare list parses too', () => {
    expect(parseDeletedOccurrences('2026-06-02,2026-06-16')).toEqual(['2026-06-02', '2026-06-16']);
  });

  it('an empty token is skipped', () => {
    expect(parseDeletedOccurrences('2026-06-02,,2026-06-16')).toEqual(['2026-06-02', '2026-06-16']);
  });

  it('a column containing one unparseable token yields the empty list rather than the parseable subset', () => {
    expect(parseDeletedOccurrences('["2026-06-02","not-a-date"]')).toEqual([]);
  });

  it('null input yields the empty list', () => {
    expect(parseDeletedOccurrences(null)).toEqual([]);
  });

  it('blank input yields the empty list', () => {
    expect(parseDeletedOccurrences('   ')).toEqual([]);
  });
});

/** Calls `fn`, which MUST throw, and returns the caught error — never lets a
 * silently-returning `fn` pass unnoticed the way a bare `try { fn() } catch {}`
 * would (a test that merely awaited a value would hang forever on the interval
 * case per the plan's own warning — `toThrow` below is the primary assertion; this
 * helper exists only to inspect the thrown error's `.code`/message afterwards). */
function captureThrow(fn: () => unknown): unknown {
  expect(fn).toThrow();
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('unreachable: fn was already asserted to throw');
}

describe('expandDates — D-15 loud failures', () => {
  const rangeStart = parseIsoDate('2026-06-01');
  const rangeEnd = parseIsoDate('2026-06-30');
  const dtstart = parseIsoDate('2026-06-01');

  it('an interval below 1 throws RecurrenceRuleError with code INTERVAL_MUST_BE_POSITIVE', () => {
    expect(() =>
      expandDates(dtstart, 'FREQ=DAILY;INTERVAL=0', rangeStart, rangeEnd, new Set()),
    ).toThrow(RecurrenceRuleError);
    const err = captureThrow(() => expandDates(dtstart, 'FREQ=DAILY;INTERVAL=0', rangeStart, rangeEnd, new Set()));
    expect(err).toBeInstanceOf(RecurrenceRuleError);
    expect((err as RecurrenceRuleError).code).toBe('INTERVAL_MUST_BE_POSITIVE');
    expect((err as Error).message).toContain('FREQ=DAILY;INTERVAL=0');
  });

  it('the message names the root id when one is passed', () => {
    const err = captureThrow(() =>
      expandDates(dtstart, 'FREQ=DAILY;INTERVAL=0', rangeStart, rangeEnd, new Set(), 'root-abc'),
    );
    expect((err as Error).message).toContain('root-abc');
  });

  it('a MONTHLY rule with BYMONTHDAY=0 throws RecurrenceRuleError with code BYMONTHDAY_OUT_OF_RANGE', () => {
    expect(() =>
      expandDates(dtstart, 'FREQ=MONTHLY;BYMONTHDAY=0', rangeStart, rangeEnd, new Set()),
    ).toThrow(RecurrenceRuleError);
    const err = captureThrow(() => expandDates(dtstart, 'FREQ=MONTHLY;BYMONTHDAY=0', rangeStart, rangeEnd, new Set()));
    expect(err).toBeInstanceOf(RecurrenceRuleError);
    expect((err as RecurrenceRuleError).code).toBe('BYMONTHDAY_OUT_OF_RANGE');
    expect((err as Error).message).toContain('FREQ=MONTHLY;BYMONTHDAY=0');
  });

  it('a MONTHLY rule with BYMONTHDAY=45 clamps to month-end, matching Kotlin — it does not throw (135-05, correcting CR-01)', () => {
    // Same inputs and expected dates as the corpus vector
    // "monthly-bymonthday-above-31-clamps-to-month-end" (docs/coach-planning-vectors.json)
    // — read from the corpus, not invented here.
    const dates = expandDates(
      parseIsoDate('2026-01-15'),
      'FREQ=MONTHLY;BYMONTHDAY=45',
      parseIsoDate('2026-01-01'),
      parseIsoDate('2026-04-30'),
      new Set(),
    );
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'].map(parseIsoDate));
  });

  it('a MONTHLY rule with a negative BYMONTHDAY still throws RecurrenceRuleError with code BYMONTHDAY_OUT_OF_RANGE', () => {
    expect(() =>
      expandDates(dtstart, 'FREQ=MONTHLY;BYMONTHDAY=-5', rangeStart, rangeEnd, new Set()),
    ).toThrow(RecurrenceRuleError);
    const err = captureThrow(() => expandDates(dtstart, 'FREQ=MONTHLY;BYMONTHDAY=-5', rangeStart, rangeEnd, new Set()));
    expect(err).toBeInstanceOf(RecurrenceRuleError);
    expect((err as RecurrenceRuleError).code).toBe('BYMONTHDAY_OUT_OF_RANGE');
  });

  it('the same BYMONTHDAY values under FREQ=WEEKLY do NOT throw and return the ordinary weekly expansion', () => {
    const datesZero = expandDates(dtstart, 'FREQ=WEEKLY;BYMONTHDAY=0', rangeStart, rangeEnd, new Set());
    const datesLarge = expandDates(dtstart, 'FREQ=WEEKLY;BYMONTHDAY=45', rangeStart, rangeEnd, new Set());
    // FREQ=WEEKLY without BYDAY advances by whole weeks from DTSTART — BYMONTHDAY is
    // simply never consulted on this branch (Kotlin only reaches withDayOfMonth inside
    // the MONTHLY branch).
    expect(datesZero).toEqual(['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29'].map(parseIsoDate));
    expect(datesLarge).toEqual(datesZero);
  });
});

describe('expandDates — Int32 parse-boundary parity (135-05, WR-02)', () => {
  // Kotlin's String.toIntOrNull() is bounded to Int32 (-2147483648..2147483647); a
  // numeral one above the max is not a valid Int and returns null on both sides, so the
  // caller's existing fallback applies. Exercised through expandDates (observable
  // expansion behaviour), not against the private parser directly.

  it('an INTERVAL exactly at the Int32 max parses — only the first occurrence falls inside a short window', () => {
    const dates = expandDates(
      parseIsoDate('2026-07-01'),
      'FREQ=DAILY;INTERVAL=2147483647',
      parseIsoDate('2026-07-01'),
      parseIsoDate('2026-07-05'),
      new Set(),
    );
    expect(dates).toEqual(['2026-07-01'].map(parseIsoDate));
  });

  it('an INTERVAL one above the Int32 max is not parsed and falls back to 1, matching Kotlin (mirrors the interval-above-int32-max-not-parsed-falls-back-to-one corpus vector)', () => {
    const dates = expandDates(
      parseIsoDate('2026-07-01'),
      'FREQ=DAILY;INTERVAL=2147483648',
      parseIsoDate('2026-07-01'),
      parseIsoDate('2026-07-05'),
      new Set(),
    );
    expect(dates).toEqual(
      ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map(parseIsoDate),
    );
  });

  it('a BYMONTHDAY exactly at the Int32 max parses and clamps to month-end, same as any other value above 31', () => {
    const dates = expandDates(
      parseIsoDate('2026-01-15'),
      'FREQ=MONTHLY;BYMONTHDAY=2147483647',
      parseIsoDate('2026-01-01'),
      parseIsoDate('2026-04-30'),
      new Set(),
    );
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'].map(parseIsoDate));
  });

  it('a BYMONTHDAY one above the Int32 max is not parsed and falls back to the DTSTART day-of-month, matching Kotlin (mirrors the bymonthday-above-int32-max-not-parsed-falls-back-to-dtstart-day corpus vector)', () => {
    const dates = expandDates(
      parseIsoDate('2026-01-15'),
      'FREQ=MONTHLY;BYMONTHDAY=2147483648',
      parseIsoDate('2026-01-01'),
      parseIsoDate('2026-04-30'),
      new Set(),
    );
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'].map(parseIsoDate));
  });
});
