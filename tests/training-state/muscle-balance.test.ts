/**
 * muscle-balance.ts unit tests (Phase 137, STATE-02, D-04).
 *
 * Covers the port's own unit behavior: the 18-to-6 category mapping, normalization,
 * unknown-key handling, the exercise-resolution fallback chain, the soft-delete/ongoing-
 * session guards, and — the actively-constructed case RESEARCH.md Pitfall 3 calls for —
 * a window boundary where `session.startTime` and `setLog.createdAt` fall on opposite
 * sides of the window, proving the port filters on `createdAt`, never `startTime`.
 * Cross-language parity against the real Kotlin `MuscleBalanceCalculator` is proven
 * separately by the shared `muscleBalance` corpus section
 * (docs/coach-planning-vectors.json, tests/shared-vectors.test.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  RADAR_CATEGORIES,
  toRadarValues,
  muscleSetCountsInPeriod,
  computeMuscleBalance,
} from '../../src/training-state/muscle-balance.js';
import type {
  DecryptedSnapshot,
  DecryptedSession,
  DecryptedSetLog,
  NormalizedTemplateExercise,
  CatalogExercise,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Minimal fixture builders (local to this file — the fine-grained timestamp control
// this suite needs does not fit tests/fixture.ts's shared narrative fixture).
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
    completedReps: null,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function buildTemplateExercise(
  overrides: Partial<NormalizedTemplateExercise> & { id: string; templateId: string; exerciseId: string },
): NormalizedTemplateExercise {
  return {
    mode: 'REPS',
    restTimeSeconds: 60,
    orderIndex: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    exerciseSource: 'CATALOG',
    sets: 3,
    ...overrides,
  };
}

function buildExercise(id: string, muscleKeys: string[]): CatalogExercise {
  return {
    id,
    key: id,
    nameEn: id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [],
    // PRIMARY for every link — this suite covers window/exercise-resolution filtering, not
    // graded weighting (see tests/shared-vectors.test.ts for the weightedCounts corpus
    // replay), so every set here must still count as a full 1, exactly as before Phase 138.
    muscleGroups: muscleKeys.map((key, i) => ({
      id: `${id}-mg-${i}`,
      key,
      translations: [],
      involvementLevel: 'PRIMARY' as const,
    })),
    equipment: [],
    capabilities: [],
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

const EX_THREE = buildExercise('ex-three', ['chest', 'shoulders', 'biceps']);
const EX_BACK = buildExercise('ex-back', ['back']);

// ---------------------------------------------------------------------------
// toRadarValues
// ---------------------------------------------------------------------------

describe('toRadarValues', () => {
  it('returns all six radar categories at 0 for empty input', () => {
    const result = toRadarValues({});
    expect(Object.keys(result).sort()).toEqual([...RADAR_CATEGORIES].sort());
    for (const category of RADAR_CATEGORIES) expect(result[category]).toBe(0);
  });

  it('returns all six radar categories at 0 when every key is unknown — unknown keys are silently ignored, not an error', () => {
    const result = toRadarValues({ made_up_muscle: 5, another_unknown: 3 });
    for (const category of RADAR_CATEGORIES) expect(result[category]).toBe(0);
  });

  it('maps chest and biceps to their categories and normalizes against the max', () => {
    const result = toRadarValues({ chest: 4, biceps: 2 });
    expect(result.chest).toBe(1);
    expect(result.arms).toBe(0.5);
    expect(result.shoulders).toBe(0);
    expect(result.back).toBe(0);
    expect(result.legs).toBe(0);
    expect(result.core).toBe(0);
  });

  it('sums all five back-mapped keys (back, lats, traps, lower_back, neck) into the back category', () => {
    const result = toRadarValues({ back: 1, lats: 1, traps: 1, lower_back: 1, neck: 1 });
    expect(result.back).toBe(1);
    for (const category of RADAR_CATEGORIES) {
      if (category !== 'back') expect(result[category]).toBe(0);
    }
  });

  it('sums all six leg-mapped keys (quads, hamstrings, glutes, calves, adductors, hip_flexors) into the legs category', () => {
    const result = toRadarValues({
      quads: 1,
      hamstrings: 1,
      glutes: 1,
      calves: 1,
      adductors: 1,
      hip_flexors: 1,
    });
    expect(result.legs).toBe(1);
    for (const category of RADAR_CATEGORIES) {
      if (category !== 'legs') expect(result[category]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// muscleSetCountsInPeriod
// ---------------------------------------------------------------------------

describe('muscleSetCountsInPeriod', () => {
  it('counts one set against three muscles as one for EACH of the three muscle keys', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-three', createdAt: 1_000_000 })],
    });
    expect(muscleSetCountsInPeriod(snapshot, [EX_THREE], 0)).toEqual({ chest: 1, shoulders: 1, biceps: 1 });
  });

  it('does not count a soft-deleted set log', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-back', createdAt: 1_000_000, deletedAt: 1_000_001 }),
      ],
    });
    expect(muscleSetCountsInPeriod(snapshot, [EX_BACK], 0)).toEqual({});
  });

  it('does not count a set log whose session is soft-deleted', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000, deletedAt: 1_000_001 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-back', createdAt: 1_000_000 })],
    });
    expect(muscleSetCountsInPeriod(snapshot, [EX_BACK], 0)).toEqual({});
  });

  it('does not count a set log whose session has no endTime (still running)', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000, endTime: undefined })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-back', createdAt: 1_000_000 })],
    });
    expect(muscleSetCountsInPeriod(snapshot, [EX_BACK], 0)).toEqual({});
  });

  it('resolves the exercise via workoutExerciseId → templateExercises when exerciseId is absent', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      templateExercises: [buildTemplateExercise({ id: 'te1', templateId: 't1', exerciseId: 'ex-back' })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', workoutExerciseId: 'te1', createdAt: 1_000_000 })],
    });
    expect(muscleSetCountsInPeriod(snapshot, [EX_BACK], 0)).toEqual({ back: 1 });
  });

  it('skips a set log whose exercise resolves to nothing (no exerciseId, no matching workoutExerciseId)', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: 1_000_000 })],
    });
    expect(muscleSetCountsInPeriod(snapshot, [EX_BACK], 0)).toEqual({});
  });

  it(
    'Pitfall 3, actively constructed: filters over setLog.createdAt, never session.startTime — a set ' +
      'inside the window counts even though its session starts before it, and a set outside the window ' +
      'is excluded even though its session starts inside it',
    () => {
      const sinceMs = 1_000_000;
      const snapshot = buildSnapshot({
        sessions: [
          // Session starts BEFORE the window boundary, but the set below has createdAt inside it.
          buildSession({ id: 's-late-set', startTime: sinceMs - 500_000 }),
          // Session starts INSIDE the window boundary, but the set below has createdAt before it.
          buildSession({ id: 's-early-set', startTime: sinceMs + 500_000 }),
        ],
        setLogs: [
          buildSetLog({ id: 'sl-in-window', sessionId: 's-late-set', exerciseId: 'ex-back', createdAt: sinceMs + 1 }),
          buildSetLog({
            id: 'sl-out-of-window',
            sessionId: 's-early-set',
            exerciseId: 'ex-back',
            createdAt: sinceMs - 1,
          }),
        ],
      });
      expect(muscleSetCountsInPeriod(snapshot, [EX_BACK], sinceMs)).toEqual({ back: 1 });
    },
  );
});

// ---------------------------------------------------------------------------
// computeMuscleBalance
// ---------------------------------------------------------------------------

describe('computeMuscleBalance', () => {
  it('returns all three app windows, and all-time (lower bound 0) contains every valid set', () => {
    const nowMs = Date.UTC(2026, 2, 16, 12, 0);
    const withinWeek = nowMs - 2 * 86_400_000;
    const monthsAgo = nowMs - 100 * 86_400_000;

    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: withinWeek }), buildSession({ id: 's2', startTime: monthsAgo })],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-back', createdAt: withinWeek }),
        buildSetLog({ id: 'sl2', sessionId: 's2', exerciseId: 'ex-back', createdAt: monthsAgo }),
      ],
    });

    const result = computeMuscleBalance(snapshot, [EX_BACK], nowMs);

    expect(result.last7Days.setCounts).toEqual({ back: 1 });
    expect(result.last30Days.setCounts).toEqual({ back: 1 });
    expect(result.allTime.setCounts).toEqual({ back: 2 });
    expect(result.last7Days.radar.back).toBe(1);
    expect(result.allTime.radar.back).toBe(1);
  });
});
