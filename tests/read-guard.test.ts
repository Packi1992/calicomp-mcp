/**
 * Tests for src/read-guard.ts — the tool-boundary guards over the per-row decode
 * report (Phase 150, D-09/D-11/D-12).
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_DECODE_REPORT,
  decodeReportOf,
  assertEntitiesReadable,
  assertCalendarReadable,
  assertTimeZoneReadable,
} from '../src/read-guard.js';
import { TimeZoneUnavailableError } from '../src/training-state/time-zone.js';
import type { DecodeReport, UnreadableEntity } from '../src/types.js';

const PAT = 'calicomp_pat_testonly';
const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function emptyCounts(): Record<UnreadableEntity, number> {
  return { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 };
}

describe('decodeReportOf', () => {
  it('returns EMPTY_DECODE_REPORT when data carries no decodeReport field', () => {
    expect(decodeReportOf({})).toBe(EMPTY_DECODE_REPORT);
  });

  it('returns the carried report unchanged when present', () => {
    const report: DecodeReport = {
      unreadable: [{ entity: 'session', id: 'a', reason: 'decrypt_failed' }],
      encryptedCount: { ...emptyCounts(), session: 1 },
      failedCount: { ...emptyCounts(), session: 1 },
    };
    expect(decodeReportOf({ decodeReport: report })).toBe(report);
  });
});

describe('assertEntitiesReadable', () => {
  it('P150 D-11 assertEntitiesReadable throws when every encrypted row of a kind failed', () => {
    const report: DecodeReport = {
      unreadable: [{ entity: 'session', id: 'sess-1', reason: 'decrypt_failed' }],
      encryptedCount: { ...emptyCounts(), session: 1 },
      failedCount: { ...emptyCounts(), session: 1 },
    };

    expect(() => assertEntitiesReadable(report, ['session'], 'History error')).toThrow(
      /History error: every encrypted session row \(1 of 1\) failed/,
    );
  });

  it('P150 D-11 assertEntitiesReadable passes when only some rows failed or none were encrypted', () => {
    const partialFailure: DecodeReport = {
      unreadable: [{ entity: 'session', id: 'sess-1', reason: 'decrypt_failed' }],
      encryptedCount: { ...emptyCounts(), session: 3 },
      failedCount: { ...emptyCounts(), session: 1 },
    };
    expect(() => assertEntitiesReadable(partialFailure, ['session'], 'History error')).not.toThrow();

    const noneEncrypted: DecodeReport = {
      unreadable: [],
      encryptedCount: emptyCounts(),
      failedCount: emptyCounts(),
    };
    expect(() => assertEntitiesReadable(noneEncrypted, ['session', 'setLog'], 'History error')).not.toThrow();
  });
});

describe('assertCalendarReadable', () => {
  it('P150 D-09 assertCalendarReadable names the row id and reason', () => {
    const report: DecodeReport = {
      unreadable: [{ entity: 'plannedWorkout', id: 'row-1', reason: 'unknown_version' }],
      encryptedCount: { ...emptyCounts(), plannedWorkout: 1 },
      failedCount: { ...emptyCounts(), plannedWorkout: 1 },
    };

    expect(() => assertCalendarReadable(report, 'Planned workouts error')).toThrow(
      /Planned workouts error: the training calendar is unreadable — 1 planned_workout row\(s\) could not be decoded \(row-1: unknown_version\)/,
    );
  });

  it('passes when no planned_workout row failed', () => {
    const report: DecodeReport = {
      unreadable: [],
      encryptedCount: { ...emptyCounts(), plannedWorkout: 2 },
      failedCount: emptyCounts(),
    };
    expect(() => assertCalendarReadable(report, 'Planned workouts error')).not.toThrow();
  });
});

describe('assertTimeZoneReadable', () => {
  it('P150 assertTimeZoneReadable throws its own message for an unreadable tz setting', () => {
    const report: DecodeReport = {
      unreadable: [{ entity: 'setting', id: 'row-tz', reason: 'malformed_payload', key: 'training_timezone_id' }],
      encryptedCount: { ...emptyCounts(), setting: 1 },
      failedCount: { ...emptyCounts(), setting: 1 },
    };

    expect(() => assertTimeZoneReadable(report, 'Adherence error')).toThrow(TimeZoneUnavailableError);
    expect(() => assertTimeZoneReadable(report, 'Adherence error')).toThrow(
      /training_timezone_id.*could not be decoded \(reason: malformed_payload\)/,
    );
  });

  it('passes when the unreadable setting is not the time-zone key', () => {
    const report: DecodeReport = {
      unreadable: [{ entity: 'setting', id: 'row-other', reason: 'malformed_payload', key: 'some_other_key' }],
      encryptedCount: { ...emptyCounts(), setting: 1 },
      failedCount: { ...emptyCounts(), setting: 1 },
    };
    expect(() => assertTimeZoneReadable(report, 'Adherence error')).not.toThrow();
  });
});

describe('secrets discipline', () => {
  it('P150 D-12 guard messages never contain key or PAT material', () => {
    const report: DecodeReport = {
      unreadable: [
        { entity: 'session', id: 'sess-1', reason: 'decrypt_failed' },
        { entity: 'plannedWorkout', id: 'row-1', reason: 'decrypt_failed' },
        { entity: 'setting', id: 'row-tz', reason: 'decrypt_failed', key: 'training_timezone_id' },
      ],
      encryptedCount: { ...emptyCounts(), session: 1, plannedWorkout: 1, setting: 1 },
      failedCount: { ...emptyCounts(), session: 1, plannedWorkout: 1, setting: 1 },
    };

    const messages: string[] = [];
    try {
      assertEntitiesReadable(report, ['session'], 'History error');
    } catch (err) {
      messages.push((err as Error).message);
    }
    try {
      assertCalendarReadable(report, 'Planned workouts error');
    } catch (err) {
      messages.push((err as Error).message);
    }
    try {
      assertTimeZoneReadable(report, 'Adherence error');
    } catch (err) {
      messages.push((err as Error).message);
    }

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).not.toContain(PAT);
      expect(message).not.toContain(KEY_B64);
    }
  });
});
