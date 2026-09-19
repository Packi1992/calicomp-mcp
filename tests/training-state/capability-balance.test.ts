/**
 * capability-balance.ts unit tests (Phase 138.1, CAP-01/CAP-05, `138.1-17`).
 *
 * Covers the port's own unit behavior: the three weight constants, `weightFor`'s throw on
 * a missing level (D-04 — the deliberate divergence from the muscle axis's null-means-
 * PRIMARY default), `weightedCounts`' summation/separation across axes, and
 * `capabilitySetCountsInPeriod`'s window-and-resolution logic reused verbatim from
 * `muscleSetCountsInPeriod` (RESEARCH.md Pitfall 3). Cross-language parity against the
 * real Kotlin `CapabilityInvolvementWeighting` is proven separately by the shared
 * `capabilityBalance` corpus section (docs/coach-planning-vectors.json,
 * tests/shared-vectors.test.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  WEIGHT_HAUPTREIZ,
  WEIGHT_MITTRAINIERT,
  WEIGHT_GERING,
  weightFor,
  weightedCounts,
  capabilitySetCountsInPeriod,
  type CapabilityLevelSetCount,
} from '../../src/training-state/capability-balance.js';
import { normalizeCatalog } from '../../src/cache.js';
import type {
  DecryptedSnapshot,
  DecryptedSession,
  DecryptedSetLog,
  NormalizedTemplateExercise,
  CatalogExercise,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Minimal fixture builders (mirrors tests/training-state/muscle-balance.test.ts's
// blueprint, adapted to the `capabilities` axis instead of `muscleGroups`).
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

function buildExercise(
  id: string,
  axes: Array<{ key: string; level: 'HAUPTREIZ' | 'MITTRAINIERT' | 'GERING' }>,
): CatalogExercise {
  return {
    id,
    key: id,
    nameEn: id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [],
    muscleGroups: [],
    equipment: [],
    capabilities: axes.map((a, i) => ({
      id: `${id}-cap-${i}`,
      key: a.key,
      translations: [],
      capabilityLevel: a.level,
    })),
    origin: 'CATALOG',
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

const EX_BALANCE = buildExercise('ex-balance', [{ key: 'balance', level: 'HAUPTREIZ' }]);
const EX_TWO_AXES = buildExercise('ex-two-axes', [
  { key: 'mobility', level: 'MITTRAINIERT' },
  { key: 'flexibility', level: 'GERING' },
]);
const EX_NO_AXIS = buildExercise('ex-no-axis', []);

// ---------------------------------------------------------------------------
// weightFor
// ---------------------------------------------------------------------------

describe('weightFor', () => {
  it('returns the exact Kotlin weight constants for each stage', () => {
    expect(weightFor('HAUPTREIZ')).toBe(WEIGHT_HAUPTREIZ);
    expect(weightFor('MITTRAINIERT')).toBe(WEIGHT_MITTRAINIERT);
    expect(weightFor('GERING')).toBe(WEIGHT_GERING);
    expect(WEIGHT_HAUPTREIZ).toBe(1.0);
    expect(WEIGHT_MITTRAINIERT).toBe(0.5);
    expect(WEIGHT_GERING).toBe(0.25);
  });

  it('throws on a null level — D-04, unlike the muscle axis where null resolves to PRIMARY', () => {
    expect(() => weightFor(null)).toThrow();
  });

  it('throws on an undefined level', () => {
    expect(() => weightFor(undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// weightedCounts
// ---------------------------------------------------------------------------

describe('weightedCounts', () => {
  it('returns an empty object for an empty input list', () => {
    expect(weightedCounts([])).toEqual({});
  });

  it('sums multiple rows of the same axis and keeps two axes separate', () => {
    const rows: CapabilityLevelSetCount[] = [
      { capabilityAxisKey: 'balance', capabilityLevel: 'HAUPTREIZ', setCount: 2 },
      { capabilityAxisKey: 'balance', capabilityLevel: 'MITTRAINIERT', setCount: 4 },
      { capabilityAxisKey: 'coordination', capabilityLevel: 'GERING', setCount: 8 },
    ];
    // balance: 2*1.0 + 4*0.5 = 4.0; coordination: 8*0.25 = 2.0
    expect(weightedCounts(rows)).toEqual({ balance: 4.0, coordination: 2.0 });
  });

  it('propagates weightFor throwing on a row with a null level', () => {
    const rows: CapabilityLevelSetCount[] = [{ capabilityAxisKey: 'power', capabilityLevel: null, setCount: 3 }];
    expect(() => weightedCounts(rows)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// capabilitySetCountsInPeriod
// ---------------------------------------------------------------------------

describe('capabilitySetCountsInPeriod', () => {
  it('counts one set against two axes as one row for EACH axis, at that axis own level', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-two-axes', createdAt: 1_000_000 })],
    });
    const rows = capabilitySetCountsInPeriod(snapshot, [EX_TWO_AXES], 0);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ capabilityAxisKey: 'mobility', capabilityLevel: 'MITTRAINIERT', setCount: 1 });
    expect(rows).toContainEqual({ capabilityAxisKey: 'flexibility', capabilityLevel: 'GERING', setCount: 1 });
  });

  it('an exercise with an empty capabilities array contributes no rows and causes no error', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-no-axis', createdAt: 1_000_000 })],
    });
    expect(capabilitySetCountsInPeriod(snapshot, [EX_NO_AXIS], 0)).toEqual([]);
  });

  it('does not count a soft-deleted set log', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [
        buildSetLog({
          id: 'sl1',
          sessionId: 's1',
          exerciseId: 'ex-balance',
          createdAt: 1_000_000,
          deletedAt: 1_000_001,
        }),
      ],
    });
    expect(capabilitySetCountsInPeriod(snapshot, [EX_BALANCE], 0)).toEqual([]);
  });

  it('does not count a set log whose session is soft-deleted', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000, deletedAt: 1_000_001 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-balance', createdAt: 1_000_000 })],
    });
    expect(capabilitySetCountsInPeriod(snapshot, [EX_BALANCE], 0)).toEqual([]);
  });

  it('does not count a set log whose session has no endTime (still running)', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000, endTime: undefined })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-balance', createdAt: 1_000_000 })],
    });
    expect(capabilitySetCountsInPeriod(snapshot, [EX_BALANCE], 0)).toEqual([]);
  });

  it('resolves the exercise via workoutExerciseId → templateExercises when exerciseId is absent', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      templateExercises: [buildTemplateExercise({ id: 'te1', templateId: 't1', exerciseId: 'ex-balance' })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', workoutExerciseId: 'te1', createdAt: 1_000_000 })],
    });
    expect(capabilitySetCountsInPeriod(snapshot, [EX_BALANCE], 0)).toEqual([
      { capabilityAxisKey: 'balance', capabilityLevel: 'HAUPTREIZ', setCount: 1 },
    ]);
  });

  it('skips a set log whose exercise resolves to nothing (no exerciseId, no matching workoutExerciseId)', () => {
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: 1_000_000 })],
    });
    expect(capabilitySetCountsInPeriod(snapshot, [EX_BALANCE], 0)).toEqual([]);
  });

  it(
    'Pitfall 3, actively constructed: filters over setLog.createdAt, never session.startTime — a set ' +
      'inside the window counts even though its session starts before it, and a set outside the window ' +
      'is excluded even though its session starts inside it',
    () => {
      const sinceMs = 1_000_000;
      const snapshot = buildSnapshot({
        sessions: [
          buildSession({ id: 's-late-set', startTime: sinceMs - 500_000 }),
          buildSession({ id: 's-early-set', startTime: sinceMs + 500_000 }),
        ],
        setLogs: [
          buildSetLog({
            id: 'sl-in-window',
            sessionId: 's-late-set',
            exerciseId: 'ex-balance',
            createdAt: sinceMs + 1,
          }),
          buildSetLog({
            id: 'sl-out-of-window',
            sessionId: 's-early-set',
            exerciseId: 'ex-balance',
            createdAt: sinceMs - 1,
          }),
        ],
      });
      const rows = capabilitySetCountsInPeriod(snapshot, [EX_BALANCE], sinceMs);
      expect(rows).toEqual([{ capabilityAxisKey: 'balance', capabilityLevel: 'HAUPTREIZ', setCount: 1 }]);
    },
  );

  // CAP-05 gap-closure (2026-09-06): `capabilitySetCountsInPeriod` iterates
  // `exercise.capabilities` unguarded (see this function's own source) — currently unused by
  // any production caller (138.1-REVIEW.md IN-01), but flagged there as a latent sibling that
  // would reproduce the exact `get_stats.ts`/`adherence.ts` crash the moment a future caller
  // wires it up against a catalog sourced straight from the wire. Proves the fetch-boundary fix
  // (cache.ts's normalizeCatalog(), not a change to this file) already covers it: normalize a
  // genuinely field-omitting wire entry through the real seam, then feed the result in here.
  it('does not throw when the catalog was normalized from wire data that omitted `capabilities` entirely (138.1-REVIEW.md IN-01, latent sibling)', () => {
    const wireExercise = {
      id: 'ex-wire-omitted',
      key: 'ex-wire-omitted',
      nameEn: 'ex-wire-omitted',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      // capabilities/equipment/isSkill deliberately absent — the real wire shape.
    };
    const [normalized] = normalizeCatalog([wireExercise]);
    const snapshot = buildSnapshot({
      sessions: [buildSession({ id: 's1', startTime: 1_000_000 })],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', exerciseId: 'ex-wire-omitted', createdAt: 1_000_000 })],
    });

    expect(() => capabilitySetCountsInPeriod(snapshot, [normalized], 0)).not.toThrow();
    expect(capabilitySetCountsInPeriod(snapshot, [normalized], 0)).toEqual([]);
  });
});
