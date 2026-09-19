/**
 * Tests for src/training-state/exercise-progress.ts (Phase 137, STATE-05, D-11, D-12, D-25).
 *
 * Coverage:
 *   Block 1 (computeExerciseProgress): the STATE-05 core case (all sessions, including
 *     ones without `templateId`), chronological ordering, the three metric branches
 *     (e1rm / reps / timeSeconds) with both bestSet and sessionTotal, the MAX-mode-to-reps
 *     mapping, the "no usable value in a session" both-null case, deletedAt/no-endTime
 *     exclusion, maxPoints capping (most recent kept, ascending order), the no-`exerciseId`
 *     recent-exercises view, and D-27 c's structurally-empty-series-not-an-error case.
 *   Block 2 (directionOf / DIRECTION_RULE): insufficient-data below the four-usable-value
 *     floor, up/down/flat classification, null-ignoring half-means, and the rule text
 *     itself.
 */

import { describe, it, expect } from 'vitest';
import {
  computeExerciseProgress,
  directionOf,
  DIRECTION_RULE,
} from '../../src/training-state/exercise-progress.js';
import type { DecryptedSnapshot, DecryptedSession, DecryptedSetLog, CatalogExercise } from '../../src/types.js';

const TZ = 'UTC';

// ---------------------------------------------------------------------------
// Minimal fixture builders (local — this suite needs fine-grained per-session control
// that does not fit tests/fixture.ts's shared narrative fixture).
// ---------------------------------------------------------------------------

function buildSession(overrides: Partial<DecryptedSession> & { id: string; startTime: number }): DecryptedSession {
  return {
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: overrides.startTime,
    updatedAt: overrides.startTime,
    endTime: overrides.startTime + 3_600_000,
    ...overrides,
  };
}

function buildSetLog(
  overrides: Partial<DecryptedSetLog> & { id: string; sessionId: string; createdAt: number },
): DecryptedSetLog {
  return {
    exerciseId: EX_REPS,
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

// ---------------------------------------------------------------------------
// Catalog exercises — one per metric branch
// ---------------------------------------------------------------------------

const EX_REPS = 'ex-bodyweight-reps'; // usesWeight: false, mode: REPS -> metric 'reps'
const EX_WEIGHTED = 'ex-weighted-pullup'; // usesWeight: true, mode: REPS -> metric 'e1rm'
const EX_TIME = 'ex-bodyweight-time'; // usesWeight: false, mode: TIME -> metric 'timeSeconds'
const EX_MAX = 'ex-max-station'; // usesWeight: false, mode: MAX -> metric 'reps'

const CATALOG: CatalogExercise[] = [
  buildExercise({ id: EX_REPS, mode: 'REPS', usesWeight: false }),
  buildExercise({ id: EX_WEIGHTED, mode: 'REPS', usesWeight: true }),
  buildExercise({ id: EX_TIME, mode: 'TIME', usesWeight: false }),
  buildExercise({ id: EX_MAX, mode: 'MAX', usesWeight: false }),
];

const DAY = 24 * 60 * 60 * 1000;
const BASE = 1_700_000_000_000; // 2023-11-14T22:13:20Z

function dayStart(offsetDays: number): number {
  // Snap to a stable mid-day instant so UTC calendar-day boundaries never surprise us.
  return Math.floor(BASE / DAY) * DAY + offsetDays * DAY + 12 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// computeExerciseProgress
// ---------------------------------------------------------------------------

describe('computeExerciseProgress', () => {
  it('STATE-05: an exercise trained in three sessions, two of them WITHOUT templateId, yields three points', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0), templateId: 'template-a' });
    const s2 = buildSession({ id: 's2', startTime: dayStart(1) }); // no templateId — free training
    const s3 = buildSession({ id: 's3', startTime: dayStart(2) }); // no templateId — free training

    const snapshot = buildSnapshot({
      sessions: [s1, s2, s3],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, completedReps: 10 }),
        buildSetLog({ id: 'sl2', sessionId: 's2', createdAt: s2.startTime, completedReps: 12 }),
        buildSetLog({ id: 'sl3', sessionId: 's3', createdAt: s3.startTime, completedReps: 14 }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.points).toHaveLength(3);
    expect(series.points.map((p) => p.sessionId)).toEqual(['s1', 's2', 's3']);
  });

  it('points are chronologically ascending by the session calendar day', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(2) });
    const s2 = buildSession({ id: 's2', startTime: dayStart(0) });
    const s3 = buildSession({ id: 's3', startTime: dayStart(1) });

    const snapshot = buildSnapshot({
      sessions: [s1, s2, s3],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, completedReps: 10 }),
        buildSetLog({ id: 'sl2', sessionId: 's2', createdAt: s2.startTime, completedReps: 10 }),
        buildSetLog({ id: 'sl3', sessionId: 's3', createdAt: s3.startTime, completedReps: 10 }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.points.map((p) => p.sessionId)).toEqual(['s2', 's3', 's1']);
    expect(series.points.map((p) => p.date)).toEqual([...series.points.map((p) => p.date)].sort());
  });

  it('usesWeight true -> metric e1rm; bestSet is bestE1rm, sessionTotal is the volume sum', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0) });
    const snapshot = buildSnapshot({
      sessions: [s1],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, exerciseId: EX_WEIGHTED, completedReps: 8, weightUsed: 10 }),
        buildSetLog({ id: 'sl2', sessionId: 's1', createdAt: s1.startTime, exerciseId: EX_WEIGHTED, completedReps: 6, weightUsed: 10 }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_WEIGHTED, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.metric).toBe('e1rm');
    // setE1rm(10, 8) = 10 * (1 + 8/30) = 12.6666...  <- best
    // setE1rm(10, 6) = 10 * (1 + 6/30) = 12.0
    expect(series.points[0].bestSet).toBeCloseTo(12.6666, 3);
    // volume = 8*10 + 6*10 = 140
    expect(series.points[0].sessionTotal).toBe(140);
  });

  it('usesWeight false, mode REPS -> metric reps; bestSet is the max completedReps, sessionTotal is their sum', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0) });
    const snapshot = buildSnapshot({
      sessions: [s1],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, completedReps: 10 }),
        buildSetLog({ id: 'sl2', sessionId: 's1', createdAt: s1.startTime, completedReps: 15 }),
        buildSetLog({ id: 'sl3', sessionId: 's1', createdAt: s1.startTime, completedReps: 12 }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.metric).toBe('reps');
    expect(series.points[0].bestSet).toBe(15);
    expect(series.points[0].sessionTotal).toBe(37);
  });

  it('usesWeight false, mode TIME -> metric timeSeconds; bestSet is the max completedTimeSeconds, sessionTotal is their sum', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0) });
    const snapshot = buildSnapshot({
      sessions: [s1],
      setLogs: [
        buildSetLog({
          id: 'sl1', sessionId: 's1', createdAt: s1.startTime,
          exerciseId: EX_TIME, completedTimeSeconds: 30,
        }),
        buildSetLog({
          id: 'sl2', sessionId: 's1', createdAt: s1.startTime,
          exerciseId: EX_TIME, completedTimeSeconds: 45,
        }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_TIME, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.metric).toBe('timeSeconds');
    expect(series.points[0].bestSet).toBe(45);
    expect(series.points[0].sessionTotal).toBe(75);
  });

  it('mode MAX and usesWeight false falls to reps — a MAX station is logged in reps', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0) });
    const snapshot = buildSnapshot({
      sessions: [s1],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, exerciseId: EX_MAX, completedReps: 20 }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_MAX, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.metric).toBe('reps');
    expect(series.points[0].bestSet).toBe(20);
  });

  it('a set with no usable value contributes to neither figure; an all-unusable session keeps its point with both fields null', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0) });
    const snapshot = buildSnapshot({
      sessions: [s1],
      setLogs: [
        // metric is 'reps' for EX_REPS; completedReps is null on both rows here.
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, completedReps: null }),
        buildSetLog({ id: 'sl2', sessionId: 's1', createdAt: s1.startTime, completedReps: null }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.points).toHaveLength(1);
    expect(series.points[0].bestSet).toBeNull();
    expect(series.points[0].sessionTotal).toBeNull();
    expect(series.points[0].setCount).toBe(2);
  });

  it('a deleted set-log, a deleted session, and an ongoing session (no endTime) all produce no point', () => {
    const sDeleted = buildSession({ id: 's-deleted', startTime: dayStart(0), deletedAt: dayStart(0) });
    const sOngoing = buildSession({ id: 's-ongoing', startTime: dayStart(1), endTime: undefined });
    const sReal = buildSession({ id: 's-real', startTime: dayStart(2) });

    const snapshot = buildSnapshot({
      sessions: [sDeleted, sOngoing, sReal],
      setLogs: [
        buildSetLog({ id: 'sl-deleted-session', sessionId: 's-deleted', createdAt: sDeleted.startTime, completedReps: 10 }),
        buildSetLog({ id: 'sl-ongoing', sessionId: 's-ongoing', createdAt: sOngoing.startTime, completedReps: 10 }),
        buildSetLog({ id: 'sl-real', sessionId: 's-real', createdAt: sReal.startTime, completedReps: 10 }),
        buildSetLog({
          id: 'sl-deleted-log', sessionId: 's-real', createdAt: sReal.startTime,
          completedReps: 99, deletedAt: sReal.startTime,
        }),
      ],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.points).toHaveLength(1);
    expect(series.points[0].sessionId).toBe('s-real');
    expect(series.points[0].bestSet).toBe(10); // the deleted set-log never contributes
  });

  it('maxPoints keeps the most recent points and the result stays ascending', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => buildSession({ id: `s${i}`, startTime: dayStart(i) }));
    const snapshot = buildSnapshot({
      sessions,
      setLogs: sessions.map((s, i) =>
        buildSetLog({ id: `sl${i}`, sessionId: s.id, createdAt: s.startTime, completedReps: 10 + i }),
      ),
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 2, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.points).toHaveLength(2);
    expect(series.points.map((p) => p.sessionId)).toEqual(['s3', 's4']);
  });

  it('without exerciseId, returns the recentExerciseCount most-recently-trained exercises, descending by last occurrence', () => {
    const sOld = buildSession({ id: 's-old', startTime: dayStart(0) });
    const sMid = buildSession({ id: 's-mid', startTime: dayStart(1) });
    const sNew = buildSession({ id: 's-new', startTime: dayStart(2) });

    const snapshot = buildSnapshot({
      sessions: [sOld, sMid, sNew],
      setLogs: [
        buildSetLog({ id: 'sl-old', sessionId: 's-old', createdAt: sOld.startTime, exerciseId: EX_TIME, completedTimeSeconds: 30 }),
        buildSetLog({ id: 'sl-mid', sessionId: 's-mid', createdAt: sMid.startTime, exerciseId: EX_WEIGHTED, completedReps: 5, weightUsed: 20 }),
        buildSetLog({ id: 'sl-new', sessionId: 's-new', createdAt: sNew.startTime, exerciseId: EX_REPS, completedReps: 10 }),
      ],
    });

    const series = computeExerciseProgress(
      { maxPoints: 30, recentExerciseCount: 2 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.map((s) => s.exerciseId)).toEqual([EX_REPS, EX_WEIGHTED]);
  });

  it('D-27 c: an exercise with no sets at all yields a structurally empty series, not an error', () => {
    const snapshot = buildSnapshot({});

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.points).toEqual([]);
    expect(series.bestSetDirection.label).toBe('insufficient-data');
    expect(series.sessionTotalDirection.label).toBe('insufficient-data');
  });

  it('every series carries rule equal to DIRECTION_RULE', () => {
    const s1 = buildSession({ id: 's1', startTime: dayStart(0) });
    const snapshot = buildSnapshot({
      sessions: [s1],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime, completedReps: 10 })],
    });

    const [series] = computeExerciseProgress(
      { exerciseId: EX_REPS, maxPoints: 30, recentExerciseCount: 5 },
      { snapshot, catalog: CATALOG, timeZoneId: TZ },
    );

    expect(series.rule).toBe(DIRECTION_RULE);
  });
});

// ---------------------------------------------------------------------------
// directionOf / DIRECTION_RULE
// ---------------------------------------------------------------------------

describe('directionOf', () => {
  it('fewer than four values yields insufficient-data', () => {
    expect(directionOf([1, 2, 3]).label).toBe('insufficient-data');
  });

  it('a clearly increasing series yields up', () => {
    const result = directionOf([1, 2, 10, 11]);
    expect(result.label).toBe('up');
    expect(result.firstHalfMean).toBe(1.5);
    expect(result.secondHalfMean).toBe(10.5);
  });

  it('a clearly decreasing series yields down', () => {
    const result = directionOf([11, 10, 2, 1]);
    expect(result.label).toBe('down');
  });

  it('a series whose two halves differ by less than the dead band yields flat', () => {
    // firstHalfMean = 100, secondHalfMean = 101 -> relativeChange = 1% < 3%
    const result = directionOf([100, 100, 101, 101]);
    expect(result.label).toBe('flat');
  });

  it('ignores null values when averaging each half', () => {
    const result = directionOf([1, null, 2, 10, null, 11]);
    expect(result.firstHalfMean).toBe(1.5);
    expect(result.secondHalfMean).toBe(10.5);
    expect(result.label).toBe('up');
  });

  it('yields insufficient-data when both halves consist only of null', () => {
    const result = directionOf([null, null, null, null, 5, 6]);
    // odd-length handling aside, at least one half here is entirely null.
    expect(result.label).toBe('insufficient-data');
  });
});

describe('DIRECTION_RULE', () => {
  it('is a non-empty plain-text sentence naming the halving and the dead band', () => {
    expect(DIRECTION_RULE.length).toBeGreaterThan(0);
    expect(DIRECTION_RULE).toMatch(/half/i);
    expect(DIRECTION_RULE).toMatch(/3%/);
  });
});
