/**
 * consistency.ts unit tests (Phase 137, D-01/D-04 TRACER SLICE + Phase 137-11, STATE-02).
 *
 * Covers the ported TrainingStreakCalculator.kt semantics (areConsecutiveWeeks,
 * calculateLongestStreak, calculateCurrentStreak) plus the MCP-side glue
 * (trainingWeekKeys, computeStreaks) that maps sessions through the athlete's own
 * time zone. Parity against the real Kotlin calculator is proven separately by the
 * shared `streak` corpus section (docs/coach-planning-vectors.json,
 * tests/shared-vectors.test.ts) — this file covers the port's own unit behavior.
 *
 * Phase 137-11 adds computeFrequency (four session-count windows) and
 * computePersonalRecords (all-time reps/hold-time maxima) — both paritaetsfrei
 * reproductions of AnalyticsViewModel.loadFrequencyData() and
 * AnalyticsDao.getMaxRepsPerExercise/getMaxTimePerExercise, plus computeConsistency,
 * which merges the streak and frequency fields into one object.
 */

import { describe, it, expect } from 'vitest';
import {
  areConsecutiveWeeks,
  calculateLongestStreak,
  calculateCurrentStreak,
  trainingWeekKeys,
  computeStreaks,
  computeFrequency,
  computePersonalRecords,
  computeConsistency,
} from '../../src/training-state/consistency.js';
import type { DecryptedSession, DecryptedSetLog, DecryptedSnapshot, CatalogExercise } from '../../src/types.js';

function session(overrides: Partial<DecryptedSession> & { id: string; startTime: number }): DecryptedSession {
  return {
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: overrides.startTime,
    updatedAt: overrides.startTime,
    ...overrides,
  };
}

/** A completed session — has an `endTime`, no `deletedAt` — for computeFrequency tests. */
function completedSession(overrides: Partial<DecryptedSession> & { id: string; startTime: number }): DecryptedSession {
  return session({ endTime: overrides.startTime + 3_600_000, ...overrides });
}

function setLog(
  overrides: Partial<DecryptedSetLog> & { id: string; sessionId: string; createdAt: number },
): DecryptedSetLog {
  return {
    completedReps: null,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function buildExercise(overrides: Partial<CatalogExercise> & { id: string }): CatalogExercise {
  return {
    key: overrides.id,
    nameEn: overrides.id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [],
    muscleGroups: [],
    equipment: [],
    capabilities: [],
    origin: 'CATALOG',
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<DecryptedSnapshot>): DecryptedSnapshot {
  return {
    syncedAt: 1_700_000_000_000,
    exercises: [],
    exerciseTranslations: [],
    templates: [],
    blocks: [],
    templateExercises: [],
    sessions: [],
    setLogs: [],
    hrSamples: [],
    plannedWorkouts: [],
    settings: [],
    ...overrides,
  };
}

describe('areConsecutiveWeeks', () => {
  it('is true for adjacent weeks in the same year', () => {
    expect(areConsecutiveWeeks(202609, 202610)).toBe(true);
  });

  it('is false for weeks two apart in the same year', () => {
    expect(areConsecutiveWeeks(202609, 202611)).toBe(false);
  });

  it('is true across the year-end transition (week 52 → week 1 of next year)', () => {
    expect(areConsecutiveWeeks(202652, 202701)).toBe(true);
  });

  it('is false when week 51 is followed by week 1 of the next year', () => {
    expect(areConsecutiveWeeks(202651, 202701)).toBe(false);
  });
});

describe('calculateLongestStreak', () => {
  it('returns 0 for an empty list', () => {
    expect(calculateLongestStreak([])).toBe(0);
  });

  it('returns 1 for a single week', () => {
    expect(calculateLongestStreak([202601])).toBe(1);
  });

  it('returns the full length for consecutive weeks', () => {
    expect(calculateLongestStreak([202607, 202608, 202609])).toBe(3);
  });

  it('resets the count across a gap', () => {
    expect(calculateLongestStreak([202607, 202608, 202610, 202611])).toBe(2);
  });
});

describe('calculateCurrentStreak', () => {
  it('is 0 when the last training week is neither the current week nor the immediately preceding one', () => {
    const weeks = [202601, 202603];
    expect(calculateCurrentStreak(weeks, 202609)).toBe(0);
  });

  it('counts backward from the last training week when it IS the current week', () => {
    const weeks = [202607, 202608, 202609];
    expect(calculateCurrentStreak(weeks, 202609)).toBe(3);
  });
});

describe('trainingWeekKeys', () => {
  const TZ = 'Europe/Berlin';

  it('deduplicates two sessions in the same week to one key', () => {
    const sessions = [
      session({ id: 's1', startTime: Date.UTC(2026, 2, 2, 8, 0) }), // Mon 2026-03-02, week 202610
      session({ id: 's2', startTime: Date.UTC(2026, 2, 4, 8, 0) }), // Wed same week
    ];
    expect(trainingWeekKeys(sessions, TZ)).toEqual([202610]);
  });

  it('sorts ascending', () => {
    const sessions = [
      session({ id: 's-later', startTime: Date.UTC(2026, 2, 16, 8, 0) }), // week 202612
      session({ id: 's-earlier', startTime: Date.UTC(2026, 2, 2, 8, 0) }), // week 202610
    ];
    expect(trainingWeekKeys(sessions, TZ)).toEqual([202610, 202612]);
  });

  it('skips sessions with deletedAt set', () => {
    const sessions = [
      session({ id: 's1', startTime: Date.UTC(2026, 2, 2, 8, 0) }),
      session({ id: 's2', startTime: Date.UTC(2026, 2, 16, 8, 0), deletedAt: Date.UTC(2026, 2, 17) }),
    ];
    expect(trainingWeekKeys(sessions, TZ)).toEqual([202610]);
  });
});

describe('computeStreaks', () => {
  it('maps nowMs via toCalendarDay + isoWeekKey in the same zone to derive currentWeekKey', () => {
    // 2026-03-16T08:00Z is a Monday in Europe/Berlin (week 202612).
    const sessions = [session({ id: 's1', startTime: Date.UTC(2026, 2, 16, 8, 0) })];
    const nowMs = Date.UTC(2026, 2, 16, 12, 0); // same day
    const result = computeStreaks(sessions, 'Europe/Berlin', nowMs);
    expect(result.currentStreakWeeks).toBe(1);
    expect(result.longestStreakWeeks).toBe(1);
    expect(result.trainingWeekCount).toBe(1);
  });

  it('a session at 23:30 UTC on Dec 31 falls into the next day\'s week in Europe/Berlin', () => {
    // 2025-12-31T23:30:00Z in Europe/Berlin is 2026-01-01T00:30 local — ISO week 202601.
    const sessions = [session({ id: 's1', startTime: Date.UTC(2025, 11, 31, 23, 30) })];
    const nowMs = Date.UTC(2026, 0, 1, 12, 0);
    const result = computeStreaks(sessions, 'Europe/Berlin', nowMs);
    expect(result.trainingWeekCount).toBe(1);
    expect(result.currentStreakWeeks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeFrequency (Phase 137-11, STATE-02)
// ---------------------------------------------------------------------------

describe('computeFrequency', () => {
  const TZ = 'Europe/Berlin';
  // Monday 2026-03-16, ISO week 202612. Noon UTC stays 2026-03-16 in Europe/Berlin.
  const NOW = Date.UTC(2026, 2, 16, 12, 0);
  // fourWeeksAgo  = 2026-02-16 (28 days before NOW's calendar day)
  // eightWeeksAgo = 2026-01-19 (56 days before NOW's calendar day)

  it('counts sessions whose calendar day falls in the same ISO week as now', () => {
    const sessions = [
      completedSession({ id: 's-this-week', startTime: Date.UTC(2026, 2, 17, 8, 0) }), // Tue, same week
      completedSession({ id: 's-last-week', startTime: Date.UTC(2026, 2, 9, 8, 0) }), // prior week
    ];
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsThisIsoWeek).toBe(1);
  });

  it('a session exactly on the day 28 days before today counts in sessionsLast4Weeks, not sessionsPrior4Weeks', () => {
    const sessions = [completedSession({ id: 's-boundary', startTime: Date.UTC(2026, 1, 16, 8, 0) })]; // 2026-02-16
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsLast4Weeks).toBe(1);
    expect(result.sessionsPrior4Weeks).toBe(0);
  });

  it('a session exactly on the day 56 days before today counts in sessionsPrior4Weeks', () => {
    const sessions = [completedSession({ id: 's-boundary', startTime: Date.UTC(2026, 0, 19, 8, 0) })]; // 2026-01-19
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsPrior4Weeks).toBe(1);
    expect(result.sessionsLast4Weeks).toBe(0);
  });

  it('a session one day before the 56-day boundary counts in neither 4-week window', () => {
    const sessions = [completedSession({ id: 's-too-old', startTime: Date.UTC(2026, 0, 18, 8, 0) })]; // 2026-01-18
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsLast4Weeks).toBe(0);
    expect(result.sessionsPrior4Weeks).toBe(0);
    expect(result.totalCompletedSessions).toBe(1);
  });

  it('totalCompletedSessions counts every completed session regardless of window', () => {
    const sessions = [
      completedSession({ id: 's1', startTime: Date.UTC(2026, 2, 16, 8, 0) }),
      completedSession({ id: 's2', startTime: Date.UTC(2020, 0, 1, 8, 0) }), // far in the past
    ];
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.totalCompletedSessions).toBe(2);
  });

  it('excludes a session with deletedAt set from all four figures', () => {
    const sessions = [
      completedSession({ id: 's-deleted', startTime: Date.UTC(2026, 2, 16, 8, 0), deletedAt: Date.UTC(2026, 2, 17) }),
    ];
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsThisIsoWeek).toBe(0);
    expect(result.sessionsLast4Weeks).toBe(0);
    expect(result.sessionsPrior4Weeks).toBe(0);
    expect(result.totalCompletedSessions).toBe(0);
  });

  it('excludes an ongoing session (no endTime) from all four figures', () => {
    const sessions = [session({ id: 's-ongoing', startTime: Date.UTC(2026, 2, 16, 8, 0) })]; // no endTime
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsThisIsoWeek).toBe(0);
    expect(result.sessionsLast4Weeks).toBe(0);
    expect(result.totalCompletedSessions).toBe(0);
  });

  it('a session at 23:30 UTC on Sunday falls into Monday in Europe/Berlin, and into the next ISO week', () => {
    // 2026-03-15 (Sunday) 23:30 UTC → 2026-03-16 00:30 in Europe/Berlin (CET, UTC+1 in
    // March before DST) → falls into week 202612, the SAME week as NOW (Monday
    // 2026-03-16). Judged by the raw UTC calendar day instead, it would land on Sunday
    // 2026-03-15, week 202611 — the previous week. The zone decides.
    const sessions = [completedSession({ id: 's-sunday-late', startTime: Date.UTC(2026, 2, 15, 23, 30) })];
    const result = computeFrequency(sessions, TZ, NOW);
    expect(result.sessionsThisIsoWeek).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computePersonalRecords (Phase 137-11, STATE-02)
// ---------------------------------------------------------------------------

describe('computePersonalRecords', () => {
  const TZ = 'Europe/Berlin';
  const EX_REPS_ID = 'ex-reps';
  const EX_TIME_ID = 'ex-time';
  const EX_MAX_ID = 'ex-max';

  const catalog: CatalogExercise[] = [
    buildExercise({ id: EX_REPS_ID, mode: 'REPS' }),
    buildExercise({ id: EX_TIME_ID, mode: 'TIME' }),
    buildExercise({ id: EX_MAX_ID, mode: 'MAX' }),
  ];

  it('reports the all-time maximum reps for an exercise, with achievedOn as its calendar day in the athlete zone', () => {
    const sessionId = 's1';
    // 2026-03-10T23:30:00Z is 2026-03-11T00:30 local in Europe/Berlin (CET, UTC+1).
    const createdAt = Date.UTC(2026, 2, 10, 23, 30);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt })],
      setLogs: [setLog({ id: 'sl1', sessionId, exerciseId: EX_REPS_ID, completedReps: 12, createdAt })],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxReps).toEqual([
      { exerciseId: EX_REPS_ID, exerciseName: EX_REPS_ID, value: 12, achievedOn: '2026-03-11' },
    ]);
  });

  it('reports the all-time maximum hold-time only for a TIME-mode exercise', () => {
    const sessionId = 's1';
    const createdAt = Date.UTC(2026, 2, 10, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt })],
      setLogs: [
        setLog({ id: 'sl1', sessionId, exerciseId: EX_TIME_ID, completedTimeSeconds: 45, createdAt }),
        setLog({ id: 'sl2', sessionId, exerciseId: EX_TIME_ID, completedTimeSeconds: 60, createdAt: createdAt + 1000 }),
      ],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxHoldSeconds).toEqual([
      { exerciseId: EX_TIME_ID, exerciseName: EX_TIME_ID, value: 60, achievedOn: '2026-03-10' },
    ]);
  });

  it('never counts a MAX- or REPS-mode exercise toward maxHoldSeconds, even with a completedTimeSeconds value', () => {
    const sessionId = 's1';
    const createdAt = Date.UTC(2026, 2, 10, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt })],
      setLogs: [
        setLog({ id: 'sl1', sessionId, exerciseId: EX_MAX_ID, completedTimeSeconds: 999, createdAt }),
        setLog({ id: 'sl2', sessionId, exerciseId: EX_REPS_ID, completedTimeSeconds: 999, createdAt }),
      ],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxHoldSeconds).toEqual([]);
  });

  it('a MAX-mode exercise still counts toward maxReps (the app query carries no mode restriction there)', () => {
    const sessionId = 's1';
    const createdAt = Date.UTC(2026, 2, 10, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt })],
      setLogs: [setLog({ id: 'sl1', sessionId, exerciseId: EX_MAX_ID, completedReps: 30, createdAt })],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxReps).toEqual([
      { exerciseId: EX_MAX_ID, exerciseName: EX_MAX_ID, value: 30, achievedOn: '2026-03-10' },
    ]);
  });

  it('on a tie, deterministically picks the earliest achievedOn — and a second run agrees', () => {
    const sessionId = 's1';
    const earlier = Date.UTC(2026, 0, 1, 8, 0);
    const later = Date.UTC(2026, 2, 1, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: earlier })],
      setLogs: [
        // Later set logged first in array order — the earliest achievedAt must still win.
        setLog({ id: 'sl-later', sessionId, exerciseId: EX_REPS_ID, completedReps: 10, createdAt: later }),
        setLog({ id: 'sl-earlier', sessionId, exerciseId: EX_REPS_ID, completedReps: 10, createdAt: earlier }),
      ],
    });
    const first = computePersonalRecords(snapshot, catalog, TZ);
    const second = computePersonalRecords(snapshot, catalog, TZ);
    expect(first.maxReps[0].achievedOn).toBe('2026-01-01');
    expect(second.maxReps).toEqual(first.maxReps);
  });

  it('excludes a set with deletedAt set', () => {
    const sessionId = 's1';
    const createdAt = Date.UTC(2026, 2, 10, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt })],
      setLogs: [setLog({ id: 'sl1', sessionId, exerciseId: EX_REPS_ID, completedReps: 12, createdAt, deletedAt: createdAt + 1 })],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxReps).toEqual([]);
  });

  it('excludes a set whose session is soft-deleted', () => {
    const sessionId = 's1';
    const createdAt = Date.UTC(2026, 2, 10, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt, deletedAt: createdAt + 1 })],
      setLogs: [setLog({ id: 'sl1', sessionId, exerciseId: EX_REPS_ID, completedReps: 12, createdAt })],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxReps).toEqual([]);
  });

  it('an exercise with no usable value never appears in a list — never with value null', () => {
    const sessionId = 's1';
    const createdAt = Date.UTC(2026, 2, 10, 8, 0);
    const snapshot = buildSnapshot({
      sessions: [session({ id: sessionId, startTime: createdAt })],
      // EX_TIME_ID has no completedTimeSeconds anywhere → must not appear in maxHoldSeconds at all.
      setLogs: [setLog({ id: 'sl1', sessionId, exerciseId: EX_TIME_ID, completedReps: 5, createdAt })],
    });
    const result = computePersonalRecords(snapshot, catalog, TZ);
    expect(result.maxHoldSeconds).toEqual([]);
    expect(result.maxHoldSeconds.some((r) => r.exerciseId === EX_TIME_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeConsistency (Phase 137-11, STATE-02) — the one call Plan 137-12's overview makes
// ---------------------------------------------------------------------------

describe('computeConsistency', () => {
  const TZ = 'Europe/Berlin';
  const catalog: CatalogExercise[] = [];

  it('merges the streak fields and the frequency fields into one object', () => {
    const sessionId = 's1';
    const startTime = Date.UTC(2026, 2, 16, 8, 0); // Monday, week 202612
    const snapshot = buildSnapshot({
      sessions: [completedSession({ id: sessionId, startTime })],
    });
    const nowMs = Date.UTC(2026, 2, 16, 12, 0);

    const result = computeConsistency(snapshot, catalog, TZ, nowMs);

    expect(result).toEqual({
      currentStreakWeeks: 1,
      longestStreakWeeks: 1,
      trainingWeekCount: 1,
      sessionsThisIsoWeek: 1,
      sessionsLast4Weeks: 1,
      sessionsPrior4Weeks: 0,
      totalCompletedSessions: 1,
    });
  });

  it('no field name of the result contains the word "month" in any spelling', () => {
    const snapshot = buildSnapshot({});
    const result = computeConsistency(snapshot, catalog, TZ, Date.UTC(2026, 2, 16, 12, 0));
    for (const key of Object.keys(result)) {
      expect(key.toLowerCase()).not.toContain('month');
    }
  });
});
