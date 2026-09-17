/**
 * Tests for src/tools/get_stats.ts
 *
 * Coverage:
 *   - Schema: unknown muscle key rejected; malformed exerciseId UUID rejected
 *   - by:'exercise': bestE1rm (Epley, app-consistent), total/avg volume, set/session counts
 *   - by:'muscle': aggregates exercises sharing muscleGroups[].key from catalog
 *   - weightedSetCount (Phase 138, MUSC-06, D-18): the additive weighted field on the
 *     muscle branch only; setCount/totalVolume stay the unweighted raw values
 *
 * All tests operate on the pre-decrypted mockSnapshot + mockCatalog from fixture.ts.
 *
 * Fixture key values:
 *   SESSION_A (2024-03-01): push-ups (bodyweight) + pull-ups (w=10kg)
 *   SESSION_B (2024-03-08): squats (w=80/85/90 kg)
 *
 *   CATALOG:
 *     PUSHUP — muscleGroups: ['chest', 'back']
 *     PULLUP — muscleGroups: ['back', 'lats']
 *     SQUAT  — muscleGroups: ['quads', 'glutes']
 *
 *   SetLogs:
 *     SL_A1: PUSHUP, w=null (bodyweight), r=15  → e1RM = null
 *     SL_A2: PULLUP, w=10, r=8                  → e1RM = 10*(1+8/30) = 12.666...
 *     SL_A3: PULLUP, w=10, r=6                  → e1RM = 10*(1+6/30) = 12.0
 *     SL_B1: SQUAT,  w=80, r=5                  → e1RM = 80*(1+5/30) = 93.333...
 *     SL_B2: SQUAT,  w=85, r=5                  → e1RM = 85*(1+5/30) = 99.166...  ← best
 *     SL_B3: SQUAT,  w=90, r=3                  → e1RM = 90*(1+3/30) = 99.0
 */

import { describe, it, expect } from 'vitest';
import { GetStatsSchema } from '../../src/schemas.js';
import { getStats } from '../../src/tools/get_stats.js';
import type { GetStatsResult } from '../../src/tools/get_stats.js';
import type { DecryptedSnapshot, CatalogExercise, CatalogExerciseWire } from '../../src/types.js';
import { normalizeCatalog } from '../../src/cache.js';
import {
  mockSnapshot,
  mockCatalog,
  CATALOG_EXERCISE_ID_PUSHUP,
  CATALOG_EXERCISE_ID_PULLUP,
  CATALOG_EXERCISE_ID_SQUAT,
} from '../fixture.js';

const data = { snapshot: mockSnapshot, catalog: mockCatalog };

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('get_stats — schema validation', () => {
  it('rejects an unknown muscle key (not in the 18 canonical keys)', () => {
    const result = GetStatsSchema.safeParse({ by: 'muscle', muscle: 'unknown_muscle' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed (non-UUID) exerciseId', () => {
    const result = GetStatsSchema.safeParse({ by: 'exercise', exerciseId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid by-exercise input', () => {
    const result = GetStatsSchema.safeParse({
      by: 'exercise',
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid by-muscle input', () => {
    const result = GetStatsSchema.safeParse({ by: 'muscle', muscle: 'back' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// by:'exercise' path
// ---------------------------------------------------------------------------

describe('get_stats — by exercise', () => {
  it('computes app-consistent bestE1rm using Epley formula for pull-up', () => {
    const result = getStats({ by: 'exercise', exerciseId: CATALOG_EXERCISE_ID_PULLUP }, data);
    // SL_A2: w=10, r=8  → e1RM = 10*(1+8/30) = 12.666...
    // SL_A3: w=10, r=6  → e1RM = 10*(1+6/30) = 12.0
    // bestE1rm = max(12.666..., 12.0) = 12.666...
    const expectedBest = 10 * (1.0 + 8 / 30.0);
    expect(result.bestE1rm).toBeCloseTo(expectedBest, 10);
  });

  it('computes correct total volume (Σ reps × weight for weighted sets)', () => {
    const result = getStats({ by: 'exercise', exerciseId: CATALOG_EXERCISE_ID_PULLUP }, data);
    // (8 × 10) + (6 × 10) = 80 + 60 = 140
    expect(result.totalVolume).toBe(140);
  });

  it('reports correct set and session counts for pull-up', () => {
    const result = getStats({ by: 'exercise', exerciseId: CATALOG_EXERCISE_ID_PULLUP }, data);
    expect(result.setCount).toBe(2);        // SL_A2 + SL_A3
    expect(result.sessionCount).toBe(1);    // only SESSION_A
  });

  it('reports first and last session dates for squat (ISO YYYY-MM-DD)', () => {
    const result = getStats({ by: 'exercise', exerciseId: CATALOG_EXERCISE_ID_SQUAT }, data);
    // SL_B1/B2/B3 all belong to SESSION_B (2024-03-08)
    expect(result.firstSessionDate).toBe('2024-03-08');
    expect(result.lastSessionDate).toBe('2024-03-08');
  });

  it('computes bestE1rm for squat (SL_B2 with w=85 kg is the best set)', () => {
    const result = getStats({ by: 'exercise', exerciseId: CATALOG_EXERCISE_ID_SQUAT }, data);
    // SL_B1: 80*(1+5/30) = 93.333...
    // SL_B2: 85*(1+5/30) = 99.166... ← best
    // SL_B3: 90*(1+3/30) = 99.0
    const expectedBest = 85 * (1.0 + 5 / 30.0);
    expect(result.bestE1rm).toBeCloseTo(expectedBest, 10);
  });

  it('returns null bestE1rm for a bodyweight-only exercise (push-up)', () => {
    const result = getStats({ by: 'exercise', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }, data);
    // SL_A1: w=null (bodyweight) → setE1rm = null → bestE1rm = null
    expect(result.bestE1rm).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// by:'muscle' path
// ---------------------------------------------------------------------------

describe('get_stats — by muscle', () => {
  it('aggregates set count across all exercises sharing muscle key "back"', () => {
    const result = getStats({ by: 'muscle', muscle: 'back' }, data);
    // 'back' matches: PUSHUP (chest+back) + PULLUP (back+lats)
    // setLogs: SL_A1 (PUSHUP) + SL_A2 (PULLUP) + SL_A3 (PULLUP) = 3
    expect(result.setCount).toBe(3);
  });

  it('computes correct bestE1rm across all back-muscle exercises', () => {
    const result = getStats({ by: 'muscle', muscle: 'back' }, data);
    // Weighted: SL_A2 (w=10, r=8 → 12.666...) and SL_A3 (w=10, r=6 → 12.0)
    // SL_A1 is bodyweight (null e1RM)
    // bestE1rm = 10*(1+8/30)
    const expectedBest = 10 * (1.0 + 8 / 30.0);
    expect(result.bestE1rm).toBeCloseTo(expectedBest, 10);
  });

  it('includes correct matchingExerciseIds for muscle "back" (PUSHUP + PULLUP, not SQUAT)', () => {
    const result = getStats({ by: 'muscle', muscle: 'back' }, data);
    // Narrow the discriminated union so TypeScript knows matchingExerciseIds exists
    if (result.by !== 'muscle') throw new Error('expected by-muscle result');
    expect(result.matchingExerciseIds).toContain(CATALOG_EXERCISE_ID_PUSHUP);
    expect(result.matchingExerciseIds).toContain(CATALOG_EXERCISE_ID_PULLUP);
    // SQUAT only has quads+glutes
    expect(result.matchingExerciseIds).not.toContain(CATALOG_EXERCISE_ID_SQUAT);
  });

  it('returns zero sets and null e1RM for a muscle with no logged sets (neck)', () => {
    const result = getStats({ by: 'muscle', muscle: 'neck' }, data);
    expect(result.setCount).toBe(0);
    expect(result.bestE1rm).toBeNull();
    expect(result.sessionCount).toBe(0);
  });

  it('computes correct volume for "back" muscle (only weighted pull-up sets contribute)', () => {
    const result = getStats({ by: 'muscle', muscle: 'back' }, data);
    // SL_A1 (PUSHUP bodyweight) contributes 0; SL_A2 + SL_A3 (PULLUP) contribute
    // (8 × 10) + (6 × 10) = 140
    expect(result.totalVolume).toBe(140);
  });

  it('a PRIMARY-only muscle group (fixture "back"): weightedSetCount === setCount (D-03 backward-compat case)', () => {
    const result = getStats({ by: 'muscle', muscle: 'back' }, data);
    if (result.by !== 'muscle') throw new Error('expected by-muscle result');
    expect(result.weightedSetCount).toBe(result.setCount);
  });
});

// ---------------------------------------------------------------------------
// weightedSetCount (Phase 138, MUSC-06, D-18) — the additive weighted field on the
// muscle branch. A dedicated local snapshot isolates SECONDARY and STABILIZER
// involvement levels the shared fixture.ts catalog (all-PRIMARY) does not carry.
// ---------------------------------------------------------------------------

describe('get_stats — weightedSetCount', () => {
  const EX_SECONDARY_ID = 'aaaaaaaa-0010-4000-a000-000000000001';
  const EX_PRIMARY_ID = 'aaaaaaaa-0010-4000-a000-000000000002';
  const EX_STABILIZER_ID = 'aaaaaaaa-0010-4000-a000-000000000003';

  const weightedCatalog: CatalogExercise[] = [
    {
      id: EX_SECONDARY_ID,
      key: 'secondary_exercise',
      nameEn: 'Secondary Exercise',
      mode: 'REPS',
      usesWeight: true,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [
        { id: 'mg-secondary', key: 'triceps', translations: [], involvementLevel: 'SECONDARY' },
      ],
      equipment: [],
      capabilities: [],
    },
    {
      id: EX_PRIMARY_ID,
      key: 'primary_exercise',
      nameEn: 'Primary Exercise',
      mode: 'REPS',
      usesWeight: true,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [
        { id: 'mg-primary', key: 'shoulders', translations: [], involvementLevel: 'PRIMARY' },
      ],
      equipment: [],
      capabilities: [],
    },
    {
      id: EX_STABILIZER_ID,
      key: 'stabilizer_exercise',
      nameEn: 'Stabilizer Exercise',
      mode: 'REPS',
      usesWeight: true,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [
        { id: 'mg-stabilizer', key: 'shoulders', translations: [], involvementLevel: 'STABILIZER' },
      ],
      equipment: [],
      capabilities: [],
    },
  ];

  const S_SECONDARY = 'bbbbbbbb-0010-4000-b000-000000000001';
  const S_MIXED = 'bbbbbbbb-0010-4000-b000-000000000002';
  const S_SECONDARY_START = Date.UTC(2024, 6, 1, 8, 0);
  const S_MIXED_START = Date.UTC(2024, 6, 8, 8, 0);

  function buildSetLogs(
    sessionId: string,
    exerciseId: string,
    count: number,
    weightUsed: number,
    reps: number,
    startBase: number,
    idPrefix: string,
  ) {
    return Array.from({ length: count }, (_, i) => ({
      id: `${idPrefix}-${i}`,
      sessionId,
      exerciseId,
      completedReps: reps,
      completedTimeSeconds: null,
      weightUsed,
      startedAt: null,
      measuredTimeSeconds: null,
      createdAt: startBase + i * 1000,
      updatedAt: startBase + i * 1000,
    }));
  }

  const weightedSnapshot: DecryptedSnapshot = {
    syncedAt: 1_700_000_000_000,
    exercises: [],
    exerciseTranslations: [],
    templates: [],
    blocks: [],
    templateExercises: [],
    sessions: [
      {
        id: S_SECONDARY,
        startTime: S_SECONDARY_START,
        endTime: S_SECONDARY_START + 3_600_000,
        isManual: false,
        isCorrected: false,
        isQuickChallenge: false,
        createdAt: S_SECONDARY_START,
        updatedAt: S_SECONDARY_START,
      },
      {
        id: S_MIXED,
        startTime: S_MIXED_START,
        endTime: S_MIXED_START + 3_600_000,
        isManual: false,
        isCorrected: false,
        isQuickChallenge: false,
        createdAt: S_MIXED_START,
        updatedAt: S_MIXED_START,
      },
    ],
    setLogs: [
      // 4 sets of a SECONDARY-triceps exercise: weight=10, reps=5 each → volume 50/set
      ...buildSetLogs(S_SECONDARY, EX_SECONDARY_ID, 4, 10, 5, S_SECONDARY_START, 'sl-secondary'),
      // 4 sets of a PRIMARY-shoulders exercise: weight=20, reps=5 each → volume 100/set
      ...buildSetLogs(S_MIXED, EX_PRIMARY_ID, 4, 20, 5, S_MIXED_START, 'sl-primary'),
      // 4 sets of a STABILIZER-shoulders exercise: weight=5, reps=5 each → volume 25/set
      ...buildSetLogs(S_MIXED, EX_STABILIZER_ID, 4, 5, 5, S_MIXED_START + 100_000, 'sl-stabilizer'),
    ],
    hrSamples: [],
    plannedWorkouts: [],
    settings: [],
  };

  const weightedData = { snapshot: weightedSnapshot, catalog: weightedCatalog };

  it('4 sets of a SECONDARY exercise: setCount === 4, weightedSetCount === 2', () => {
    const result = getStats({ by: 'muscle', muscle: 'triceps' }, weightedData);
    if (result.by !== 'muscle') throw new Error('expected by-muscle result');
    expect(result.setCount).toBe(4);
    expect(result.weightedSetCount).toBe(2);
  });

  it('mixing a PRIMARY and a STABILIZER exercise (4 sets each): setCount === 8, weightedSetCount === 5', () => {
    const result = getStats({ by: 'muscle', muscle: 'shoulders' }, weightedData);
    if (result.by !== 'muscle') throw new Error('expected by-muscle result');
    expect(result.setCount).toBe(8);
    expect(result.weightedSetCount).toBe(5);
  });

  it('totalVolume is the exact unweighted Σ reps × weight in all three cases — never scaled by an involvement factor (D-18)', () => {
    const secondaryResult = getStats({ by: 'muscle', muscle: 'triceps' }, weightedData);
    // 4 sets × (5 reps × 10 kg) = 200
    expect(secondaryResult.totalVolume).toBe(200);

    const mixedResult = getStats({ by: 'muscle', muscle: 'shoulders' }, weightedData);
    // 4 × (5×20) + 4 × (5×5) = 400 + 100 = 500
    expect(mixedResult.totalVolume).toBe(500);
  });

  it('get_stats by:"exercise" does not carry a weightedSetCount key', () => {
    const result = getStats({ by: 'exercise', exerciseId: EX_PRIMARY_ID }, weightedData);
    expect(result).not.toHaveProperty('weightedSetCount');
  });

  it('matchingExerciseIds includes an exercise where the requested muscle is only STABILIZER', () => {
    const result = getStats({ by: 'muscle', muscle: 'shoulders' }, weightedData);
    if (result.by !== 'muscle') throw new Error('expected by-muscle result');
    expect(result.matchingExerciseIds).toContain(EX_STABILIZER_ID);
    expect(result.matchingExerciseIds).toContain(EX_PRIMARY_ID);
  });
});

// ---------------------------------------------------------------------------
// trend.points (Phase 137, STATE-01, D-16) — additive point series next to the
// unchanged two-point delta. tests/fixture.ts's shared narrative fixture only ever
// touches ONE session per query (pull-up/squat/back all resolve to a single session),
// so a local, fine-grained snapshot is built here — the same pattern
// tests/training-state/exercise-progress.test.ts already established for multi-session
// scenarios that do not fit the shared fixture.
// ---------------------------------------------------------------------------

describe('get_stats — trend.points', () => {
  const POINTS_EXERCISE_ID = 'aaaaaaaa-0009-4000-a000-000000000001';

  const pointsCatalog: CatalogExercise[] = [
    {
      id: POINTS_EXERCISE_ID,
      key: 'points_exercise',
      nameEn: 'Points Exercise',
      mode: 'REPS',
      usesWeight: true,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [{ id: 'mg-points', key: 'chest', translations: [], involvementLevel: 'PRIMARY' }],
      equipment: [],
      capabilities: [],
    },
  ];

  const S1 = 'bbbbbbbb-0009-4000-b000-000000000001';
  const S2 = 'bbbbbbbb-0009-4000-b000-000000000002';
  const S3 = 'bbbbbbbb-0009-4000-b000-000000000003';

  // 2024-06-01, 2024-06-08, 2024-06-15 — three chronologically ascending sessions.
  const S1_START = Date.UTC(2024, 5, 1, 8, 0);
  const S2_START = Date.UTC(2024, 5, 8, 8, 0);
  const S3_START = Date.UTC(2024, 5, 15, 8, 0);

  function buildPointsSnapshot(): DecryptedSnapshot {
    return {
      syncedAt: 1_700_000_000_000,
      exercises: [],
      exerciseTranslations: [],
      templates: [],
      blocks: [],
      templateExercises: [],
      // Deliberately inserted out of chronological order — computeAggregates must sort
      // touchedSessions by startTime itself, not rely on array order.
      sessions: [
        { id: S3, startTime: S3_START, endTime: S3_START + 3_600_000, isManual: false, isCorrected: false, isQuickChallenge: false, createdAt: S3_START, updatedAt: S3_START },
        { id: S1, startTime: S1_START, endTime: S1_START + 3_600_000, isManual: false, isCorrected: false, isQuickChallenge: false, createdAt: S1_START, updatedAt: S1_START },
        { id: S2, startTime: S2_START, endTime: S2_START + 3_600_000, isManual: false, isCorrected: false, isQuickChallenge: false, createdAt: S2_START, updatedAt: S2_START },
      ],
      setLogs: [
        // S1: weighted set → e1RM = 50*(1+5/30) = 58.333...
        { id: 'sl-points-1', sessionId: S1, exerciseId: POINTS_EXERCISE_ID, completedReps: 5, completedTimeSeconds: null, weightUsed: 50, startedAt: null, measuredTimeSeconds: null, createdAt: S1_START, updatedAt: S1_START },
        // S2: bodyweight-only set → e1RM null; the point must NOT be dropped
        { id: 'sl-points-2', sessionId: S2, exerciseId: POINTS_EXERCISE_ID, completedReps: 20, completedTimeSeconds: null, weightUsed: null, startedAt: null, measuredTimeSeconds: null, createdAt: S2_START, updatedAt: S2_START },
        // S3: heavier weighted set → e1RM = 60*(1+5/30) = 70.0
        { id: 'sl-points-3', sessionId: S3, exerciseId: POINTS_EXERCISE_ID, completedReps: 5, completedTimeSeconds: null, weightUsed: 60, startedAt: null, measuredTimeSeconds: null, createdAt: S3_START, updatedAt: S3_START },
      ],
      hrSamples: [],
      plannedWorkouts: [],
      settings: [],
    };
  }

  const pointsData = { snapshot: buildPointsSnapshot(), catalog: pointsCatalog };

  it('carries one point per touched session, chronologically ordered', () => {
    const result = getStats({ by: 'exercise', exerciseId: POINTS_EXERCISE_ID }, pointsData);
    expect(result.trend?.points.map((p) => p.sessionId)).toEqual([S1, S2, S3]);
  });

  it('keeps a null-e1rm point for a session whose sets are all bodyweight', () => {
    const result = getStats({ by: 'exercise', exerciseId: POINTS_EXERCISE_ID }, pointsData);
    expect(result.trend?.points[1]).toMatchObject({ sessionId: S2, e1rm: null });
  });

  it('first and last points carry the same e1rm as trend.firstE1rm / trend.lastE1rm', () => {
    const result = getStats({ by: 'exercise', exerciseId: POINTS_EXERCISE_ID }, pointsData);
    expect(result.trend?.points[0].e1rm).toBe(result.trend?.firstE1rm);
    expect(result.trend?.points[2].e1rm).toBe(result.trend?.lastE1rm);
    expect(result.trend?.points[0].e1rm).toBeCloseTo(50 * (1 + 5 / 30), 10);
    expect(result.trend?.points[2].e1rm).toBeCloseTo(60 * (1 + 5 / 30), 10);
  });

  it('each point carries an ISO calendar date matching its session', () => {
    const result = getStats({ by: 'exercise', exerciseId: POINTS_EXERCISE_ID }, pointsData);
    expect(result.trend?.points[0].date).toBe('2024-06-01');
    expect(result.trend?.points[1].date).toBe('2024-06-08');
    expect(result.trend?.points[2].date).toBe('2024-06-15');
  });

  it('by:"muscle" carries the same point series as by:"exercise" for the same underlying sessions', () => {
    const result = getStats({ by: 'muscle', muscle: 'chest' }, pointsData);
    expect(result.trend?.points.map((p) => p.sessionId)).toEqual([S1, S2, S3]);
  });

  it('a single touched session yields exactly one point, with delta 0 per existing single-session behavior', () => {
    const singleSessionData = {
      snapshot: {
        ...pointsData.snapshot,
        sessions: pointsData.snapshot.sessions.filter((s) => s.id === S1),
        setLogs: pointsData.snapshot.setLogs.filter((sl) => sl.sessionId === S1),
      },
      catalog: pointsCatalog,
    };
    const result = getStats({ by: 'exercise', exerciseId: POINTS_EXERCISE_ID }, singleSessionData);
    expect(result.trend?.points).toHaveLength(1);
    expect(result.trend?.delta).toBe(0);
  });

  it('trend stays null (no empty points array) when no session is touched', () => {
    const result = getStats({ by: 'exercise', exerciseId: 'no-such-id' }, pointsData);
    expect(result.trend).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// by:'capabilities' (Phase 138.1, CAP-01/CAP-05, D-14) — the third get_stats branch,
// breaking down over ALL capability axes at once with no further argument. A dedicated
// local fixture is built here (the shared fixture.ts catalog carries `capabilities: []`
// on every exercise) so an axis with sets, an axis with zero sets, and an exercise with
// an empty capabilities array can all be exercised in one place.
// ---------------------------------------------------------------------------

describe('get_stats — schema validation for by:"capabilities"', () => {
  it('accepts { by: "capabilities" } with no further argument', () => {
    const result = GetStatsSchema.safeParse({ by: 'capabilities' });
    expect(result.success).toBe(true);
  });

  it('rejects an additional unknown field on the capabilities branch', () => {
    const result = GetStatsSchema.safeParse({ by: 'capabilities', axis: 'balance' });
    expect(result.success).toBe(false);
  });
});

describe('get_stats — by capabilities', () => {
  const EX_BALANCE_ID = 'aaaaaaaa-0011-4000-a000-000000000001';
  const EX_MOBILITY_FLEX_ID = 'aaaaaaaa-0011-4000-a000-000000000002';
  const EX_NO_AXIS_ID = 'aaaaaaaa-0011-4000-a000-000000000003';
  const EX_BREATH_UNUSED_ID = 'aaaaaaaa-0011-4000-a000-000000000004';

  const capabilitiesCatalog: CatalogExercise[] = [
    {
      id: EX_BALANCE_ID,
      key: 'balance_exercise',
      nameEn: 'Balance Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      equipment: [],
      capabilities: [
        {
          id: 'cap-balance',
          key: 'balance',
          translations: [
            { languageCode: 'en', name: 'Balance' },
            { languageCode: 'de', name: 'Balance' },
          ],
          capabilityLevel: 'HAUPTREIZ',
        },
      ],
    },
    {
      id: EX_MOBILITY_FLEX_ID,
      key: 'mobility_flex_exercise',
      nameEn: 'Mobility Flex Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      equipment: [],
      capabilities: [
        {
          id: 'cap-mobility',
          key: 'mobility',
          translations: [
            { languageCode: 'en', name: 'Mobility' },
            { languageCode: 'de', name: 'Mobilitaet' },
          ],
          capabilityLevel: 'MITTRAINIERT',
        },
        {
          id: 'cap-flexibility',
          key: 'flexibility',
          translations: [
            { languageCode: 'en', name: 'Flexibility' },
            { languageCode: 'de', name: 'Dehnfaehigkeit' },
          ],
          capabilityLevel: 'GERING',
        },
      ],
    },
    {
      id: EX_NO_AXIS_ID,
      key: 'no_axis_exercise',
      nameEn: 'No Axis Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      equipment: [],
      capabilities: [],
    },
    {
      id: EX_BREATH_UNUSED_ID,
      key: 'breath_unused_exercise',
      nameEn: 'Breath Unused Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      equipment: [],
      // Present in the catalog, but never logged below — proves an axis with zero sets
      // in the data still appears in the result, with null/zero fields, not omitted.
      capabilities: [
        { id: 'cap-breath', key: 'breath', translations: [{ languageCode: 'en', name: 'Breath' }], capabilityLevel: 'HAUPTREIZ' },
      ],
    },
  ];

  const S_BALANCE = 'bbbbbbbb-0011-4000-b000-000000000001';
  const S_MOBILITY = 'bbbbbbbb-0011-4000-b000-000000000002';
  const S_NO_AXIS = 'bbbbbbbb-0011-4000-b000-000000000003';
  const S_BALANCE_START = Date.UTC(2024, 8, 1, 8, 0);
  const S_MOBILITY_START = Date.UTC(2024, 8, 8, 8, 0);
  const S_NO_AXIS_START = Date.UTC(2024, 8, 15, 8, 0);

  function buildCapSetLogs(sessionId: string, exerciseId: string, count: number, startBase: number, idPrefix: string) {
    return Array.from({ length: count }, (_, i) => ({
      id: `${idPrefix}-${i}`,
      sessionId,
      exerciseId,
      completedReps: 10,
      completedTimeSeconds: null,
      weightUsed: null,
      startedAt: null,
      measuredTimeSeconds: null,
      createdAt: startBase + i * 1000,
      updatedAt: startBase + i * 1000,
    }));
  }

  const capabilitiesSnapshot: DecryptedSnapshot = {
    syncedAt: 1_700_000_000_000,
    exercises: [],
    exerciseTranslations: [],
    templates: [],
    blocks: [],
    templateExercises: [],
    sessions: [
      {
        id: S_BALANCE,
        startTime: S_BALANCE_START,
        endTime: S_BALANCE_START + 3_600_000,
        isManual: false,
        isCorrected: false,
        isQuickChallenge: false,
        createdAt: S_BALANCE_START,
        updatedAt: S_BALANCE_START,
      },
      {
        id: S_MOBILITY,
        startTime: S_MOBILITY_START,
        endTime: S_MOBILITY_START + 3_600_000,
        isManual: false,
        isCorrected: false,
        isQuickChallenge: false,
        createdAt: S_MOBILITY_START,
        updatedAt: S_MOBILITY_START,
      },
      {
        id: S_NO_AXIS,
        startTime: S_NO_AXIS_START,
        endTime: S_NO_AXIS_START + 3_600_000,
        isManual: false,
        isCorrected: false,
        isQuickChallenge: false,
        createdAt: S_NO_AXIS_START,
        updatedAt: S_NO_AXIS_START,
      },
    ],
    setLogs: [
      // 3 sets of the balance (HAUPTREIZ) exercise -> raw 3, weighted 3*1.0=3
      ...buildCapSetLogs(S_BALANCE, EX_BALANCE_ID, 3, S_BALANCE_START, 'sl-balance'),
      // 2 sets of the mobility+flexibility exercise -> each axis raw 2;
      // mobility weighted 2*0.5=1.0, flexibility weighted 2*0.25=0.5
      ...buildCapSetLogs(S_MOBILITY, EX_MOBILITY_FLEX_ID, 2, S_MOBILITY_START, 'sl-mobility'),
      // 1 set of the no-axis exercise -> contributes to no axis at all
      ...buildCapSetLogs(S_NO_AXIS, EX_NO_AXIS_ID, 1, S_NO_AXIS_START, 'sl-no-axis'),
    ],
    hrSamples: [],
    plannedWorkouts: [],
    settings: [],
  };

  const capabilitiesData = { snapshot: capabilitiesSnapshot, catalog: capabilitiesCatalog };

  function axisFor(result: GetStatsResult, key: string) {
    if (result.by !== 'capabilities') throw new Error('expected by-capabilities result');
    const axis = result.axes.find((a) => a.key === key);
    if (axis === undefined) throw new Error(`axis "${key}" not found in result`);
    return axis;
  }

  it('breaks down over all axes without any further argument', () => {
    const result = getStats({ by: 'capabilities' }, capabilitiesData);
    expect(result.by).toBe('capabilities');
  });

  it('carries canonical key, EN/DE names, raw and weighted set count, session count, contributing exercise ids, and last session date for the balance axis', () => {
    const result = getStats({ by: 'capabilities' }, capabilitiesData);
    const axis = axisFor(result, 'balance');
    expect(axis.nameEn).toBe('Balance');
    expect(axis.nameDe).toBe('Balance');
    expect(axis.setCount).toBe(3);
    expect(axis.weightedSetCount).toBe(3);
    expect(axis.sessionCount).toBe(1);
    expect(axis.contributingExerciseIds).toEqual([EX_BALANCE_ID]);
    expect(axis.lastSessionDate).toBe('2024-09-01');
  });

  it('an exercise carrying two axes contributes one raw set per axis, each at its own graded weight', () => {
    const result = getStats({ by: 'capabilities' }, capabilitiesData);
    const mobility = axisFor(result, 'mobility');
    const flexibility = axisFor(result, 'flexibility');
    expect(mobility.setCount).toBe(2);
    expect(mobility.weightedSetCount).toBe(1.0);
    expect(flexibility.setCount).toBe(2);
    expect(flexibility.weightedSetCount).toBe(0.5);
    // Raw counts are unchanged/unscaled — the weighted value is additive, never a
    // replacement (mirrors the muscle branch's weightedSetCount contract, D-18).
    expect(flexibility.setCount).not.toBe(flexibility.weightedSetCount);
  });

  it('an axis with zero sets in the data appears with null/zero fields instead of being omitted', () => {
    const result = getStats({ by: 'capabilities' }, capabilitiesData);
    const breath = axisFor(result, 'breath');
    expect(breath.setCount).toBe(0);
    expect(breath.weightedSetCount).toBe(0);
    expect(breath.sessionCount).toBe(0);
    expect(breath.contributingExerciseIds).toEqual([]);
    expect(breath.lastSessionDate).toBeNull();
  });

  it('an exercise with an empty capabilities array contributes to no axis', () => {
    const result = getStats({ by: 'capabilities' }, capabilitiesData);
    if (result.by !== 'capabilities') throw new Error('expected by-capabilities result');
    for (const axis of result.axes) {
      expect(axis.contributingExerciseIds).not.toContain(EX_NO_AXIS_ID);
    }
  });

  it('falls back to the canonical key when a translation is missing (breath has no DE translation)', () => {
    const result = getStats({ by: 'capabilities' }, capabilitiesData);
    const breath = axisFor(result, 'breath');
    expect(breath.nameEn).toBe('Breath');
    expect(breath.nameDe).toBe('breath');
  });

  it('a snapshot with no training at all returns a well-formed all-zero response, not an error', () => {
    const emptySnapshot: DecryptedSnapshot = {
      ...capabilitiesSnapshot,
      sessions: [],
      setLogs: [],
    };
    const result = getStats({ by: 'capabilities' }, { snapshot: emptySnapshot, catalog: capabilitiesCatalog });
    if (result.by !== 'capabilities') throw new Error('expected by-capabilities result');
    expect(result.axes.length).toBeGreaterThan(0);
    for (const axis of result.axes) {
      expect(axis.setCount).toBe(0);
      expect(axis.weightedSetCount).toBe(0);
      expect(axis.sessionCount).toBe(0);
      expect(axis.contributingExerciseIds).toEqual([]);
      expect(axis.lastSessionDate).toBeNull();
    }
  });

  it('existing by:"muscle" and by:"exercise" branches stay unaffected by the new branch', () => {
    const result = getStats({ by: 'muscle', muscle: 'back' }, data);
    expect(result.setCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CAP-05 gap-closure (2026-09-06, VERIFICATION.md gap 1): the real server OMITS
// `capabilities`/`equipment`/`isSkill` ENTIRELY for any exercise at its Kotlin-side default
// (`Dtos.kt`'s `= emptyList()`/`= false` + kotlinx.serialization `encodeDefaults = false`) —
// it does not send `capabilities: []`. Every fixture above (and every fixture that predates
// this gap-closure) sets `capabilities: []` explicitly, which never exercises the real wire
// shape — that blind spot is exactly why `922/922` green shipped a `TypeError` against
// production (75/189 live catalog exercises omit the key; reproduced directly by the phase
// verifier against `GET /api/exercises`). This block builds a genuine `CatalogExerciseWire[]`
// with the fields OMITTED (not set to `[]`/`false`), runs it through the real
// `normalizeCatalog()` seam from cache.ts (never hand-rolled here), and only then feeds the
// result into `getStats` — proving the fix at the actual production data-flow boundary.
// ---------------------------------------------------------------------------

describe('get_stats — by capabilities, wire catalog with genuinely omitted fields (CAP-05 gap-closure)', () => {
  const EX_OMITTED_ID = 'aaaaaaaa-0012-4000-a000-000000000001';

  // Deliberately typed as CatalogExerciseWire and built as an object literal with NO
  // `capabilities`/`equipment`/`isSkill` keys at all — matching res.json() on a real
  // GET /api/exercises response for a default-valued exercise, not a cast-away `undefined`.
  const wireCatalog: CatalogExerciseWire[] = [
    {
      id: EX_OMITTED_ID,
      key: 'omitted_fields_exercise',
      nameEn: 'Omitted Fields Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
    },
  ];

  const emptySnapshot: DecryptedSnapshot = {
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
  };

  it('normalizeCatalog resolves an omitted `capabilities`/`equipment` key to `[]` and an omitted `isSkill` to `false`, not `undefined`', () => {
    const [normalized] = normalizeCatalog(wireCatalog);

    expect(normalized.capabilities).toEqual([]);
    expect(normalized.equipment).toEqual([]);
    expect(normalized.isSkill).toBe(false);
  });

  it('getStats({ by: "capabilities" }) does not throw against a catalog normalized from wire data omitting the field (the exact production crash this closes)', () => {
    const normalizedCatalog = normalizeCatalog(wireCatalog);

    expect(() =>
      getStats({ by: 'capabilities' }, { snapshot: emptySnapshot, catalog: normalizedCatalog }),
    ).not.toThrow();

    const result = getStats({ by: 'capabilities' }, { snapshot: emptySnapshot, catalog: normalizedCatalog });
    expect(result.by).toBe('capabilities');
  });
});
