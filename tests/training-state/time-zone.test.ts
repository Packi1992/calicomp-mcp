/**
 * time-zone.ts unit tests (Phase 137, D-01/D-02 TRACER SLICE).
 *
 * Covers resolveTimeZoneId (settings-key resolution + the loud-failure contract),
 * toCalendarDay (Intl-based zone mapping — never the host zone), and isoWeekKey
 * (ISO-8601 week encoding, including the year-end transition).
 */

import { describe, it, expect } from 'vitest';
import {
  TRAINING_TIMEZONE_SETTING_KEY,
  TimeZoneUnavailableError,
  resolveTimeZoneId,
  toCalendarDay,
  isoWeekKey,
} from '../../src/training-state/time-zone.js';
import { areConsecutiveWeeks } from '../../src/training-state/consistency.js';
import { mockSnapshot } from '../fixture.js';
import type { DecryptedSnapshot } from '../../src/types.js';

function snapshotWithTimeZone(value: string | undefined): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    settings: value === undefined ? [] : [{ key: TRAINING_TIMEZONE_SETTING_KEY, type: 's', value }],
  };
}

describe('resolveTimeZoneId', () => {
  it('resolves "Europe/Berlin" from a snapshot carrying the training_timezone_id settings row', () => {
    const snapshot = snapshotWithTimeZone('Europe/Berlin');
    expect(resolveTimeZoneId(snapshot)).toBe('Europe/Berlin');
  });

  it('throws TimeZoneUnavailableError naming the key and reason when the row is entirely absent', () => {
    const snapshot = snapshotWithTimeZone(undefined);
    let error: unknown;
    try {
      resolveTimeZoneId(snapshot);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TimeZoneUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain(TRAINING_TIMEZONE_SETTING_KEY);
    expect(message).toMatch(/synced|sync/i);
    // Never leaks secret material.
    expect(message).not.toMatch(/CALICOMP_(PAT|KEY)/);
  });

  it('throws TimeZoneUnavailableError for a value Intl.supportedValuesOf("timeZone") does not recognize', () => {
    const snapshot = snapshotWithTimeZone('Not/AZone');
    expect(() => resolveTimeZoneId(snapshot)).toThrow(TimeZoneUnavailableError);
  });
});

describe('toCalendarDay', () => {
  it('maps a UTC instant to the calendar day the zone puts it on, not the host zone', () => {
    const instant = Date.UTC(2026, 0, 1, 23, 30); // 2026-01-01T23:30:00Z
    expect(toCalendarDay(instant, 'Europe/Berlin')).toBe('2026-01-02');
    expect(toCalendarDay(instant, 'America/New_York')).toBe('2026-01-01');
  });
});

describe('isoWeekKey', () => {
  it('encodes a Monday as WEEK_BASED_YEAR * 100 + WEEK', () => {
    // 2026-03-02 is a Monday, ISO week 10 of 2026.
    expect(isoWeekKey('2026-03-02')).toBe(202610);
  });

  it('assigns 2027-01-01 (a Friday) to the last ISO week of 2026', () => {
    const key = isoWeekKey('2027-01-01');
    expect(Math.floor(key / 100)).toBe(2026);
  });

  it('treats a year-start week and the immediately preceding week 52/53 as consecutive', () => {
    const lastWeekOf2026 = isoWeekKey('2027-01-01'); // 202653
    const firstWeekOf2027 = isoWeekKey('2027-01-04'); // 202701
    expect(lastWeekOf2026).toBe(202653);
    expect(firstWeekOf2027).toBe(202701);
    expect(areConsecutiveWeeks(lastWeekOf2026, firstWeekOf2027)).toBe(true);
  });
});
