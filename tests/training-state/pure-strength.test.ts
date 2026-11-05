/**
 * The section "Reine Kraft" of protocol §1.11 "Pure strength" (Phase 168.1, D-06): exercises
 * without a capability axis, with their amount and their progress.
 *
 * `pureStrengthProgress` is proven against the corpus section `pureStrength`
 * (docs/coach-planning-vectors.json), the same vectors the Kotlin side replays.
 * `computePureStrength` is proven over the snapshot and the catalog form the tools receive:
 * a personal list comes from the real overlay, an own exercise from the real projection.
 */

import { describe, it, expect } from 'vitest';
import { computePureStrength, pureStrengthProgress } from '../../src/training-state/pure-strength.js';
import { loadCoachPlanningVectors } from '../shared-vectors.js';
import { applyLinkOverrides, buildCatalogLinkIndex, projectUserExerciseToCatalog } from '../../src/cache.js';
import type { CatalogExercise, DecryptedSession, DecryptedSetLog, DecryptedSnapshot } from '../../src/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-05-20T12:00:00Z');

const EXERCISE_ID = '16811000-0004-4000-a000-000000000001';
const OTHER_EXERCISE_ID = '16811000-0004-4000-a000-000000000002';
const OWN_EXERCISE_ID = '16811000-0004-4000-a000-000000000003';
const AXIS_ID = '16811000-0004-4000-a000-000000000004';

function buildExercise(overrides: Partial<CatalogExercise> & { id: string }): CatalogExercise {
  return {
    key: overrides.id,
    nameEn: 'Pull Up',
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

const NO_AXIS = buildExercise({ id: EXERCISE_ID });
const RATED = buildExercise({
  id: OTHER_EXERCISE_ID,
  key: 'rated',
  nameEn: 'Rated',
  capabilities: [{ id: AXIS_ID, key: 'balance', translations: [], capabilityLevel: 'HAUPTREIZ' }],
});

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

function buildSession(id: string, startTime: number, overrides: Partial<DecryptedSession> = {}): DecryptedSession {
  return {
    id,
    startTime,
    endTime: startTime + 3_600_000,
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: startTime,
    updatedAt: startTime,
    ...overrides,
  };
}

function buildSet(id: string, session: DecryptedSession, exerciseId: string, overrides: Partial<DecryptedSetLog> = {}): DecryptedSetLog {
  return {
    id,
    sessionId: session.id,
    exerciseId,
    completedReps: 10,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    createdAt: session.startTime,
    updatedAt: session.startTime,
    ...overrides,
  };
}

/** One finished session per entry of `reps`, a day apart, one set each, ending yesterday. */
function trainingOf(exerciseId: string, reps: number[]): { sessions: DecryptedSession[]; setLogs: DecryptedSetLog[] } {
  const sessions = reps.map((_, i) => buildSession(`s-${exerciseId}-${i}`, NOW - (reps.length - i) * DAY));
  const setLogs = reps.map((r, i) => buildSet(`l-${exerciseId}-${i}`, sessions[i], exerciseId, { completedReps: r }));
  return { sessions, setLogs };
}

describe('pureStrengthProgress', () => {
  for (const vector of loadCoachPlanningVectors().pureStrength) {
    it(`computes the corpus vector ${vector.name}`, () => {
      const progress = pureStrengthProgress(vector.sessions, vector.mode);
      expect(progress.metric).toBe(vector.expect.metric);
      expect(progress.values).toEqual(vector.expect.values);
      expect(progress.direction).toBe(vector.expect.label);
    });
  }
});

describe('computePureStrength', () => {
  it('a pull up that carries usesWeight and was trained without weight shows a direction', () => {
    const pullUp = buildExercise({ id: EXERCISE_ID, usesWeight: true });
    const snapshot = buildSnapshot(trainingOf(EXERCISE_ID, [5, 6, 8, 9]));
    expect(computePureStrength(snapshot, [pullUp], 0)).toEqual([
      { exerciseId: EXERCISE_ID, name: 'Pull Up', setCount: 4, metric: 'reps', direction: 'up' },
    ]);
  });

  it('an exercise with a rated axis is not in the section', () => {
    const snapshot = buildSnapshot(trainingOf(OTHER_EXERCISE_ID, [5, 6, 8, 9]));
    expect(computePureStrength(snapshot, [RATED], 0)).toEqual([]);
  });

  it('a capability added by a personal list moves the exercise out of the section', () => {
    const curated = [NO_AXIS, RATED];
    const snapshot = buildSnapshot(trainingOf(EXERCISE_ID, [5, 6, 8, 9]));
    expect(computePureStrength(snapshot, curated, 0).map((r) => r.exerciseId)).toEqual([EXERCISE_ID]);

    const effective = applyLinkOverrides(
      curated,
      [{ exerciseId: EXERCISE_ID, muscleGroups: null, capabilities: [{ id: AXIS_ID, level: 'GERING' }], updatedAt: 1 }],
      buildCatalogLinkIndex(curated),
      { unknownExercise: 0, unknownMuscleGroup: 0, unknownCapability: 0 },
    );
    expect(computePureStrength(snapshot, effective, 0)).toEqual([]);
  });

  it('own exercises without an axis are in the section', () => {
    const own = projectUserExerciseToCatalog(
      { id: OWN_EXERCISE_ID, name: 'Own bar work', mode: 'REPS', usesWeight: false, createdAt: 1, updatedAt: 1 },
      [],
    );
    const snapshot = buildSnapshot(trainingOf(OWN_EXERCISE_ID, [5, 6, 8, 9]));
    const [row] = computePureStrength(snapshot, [own], 0);
    expect(row).toMatchObject({ exerciseId: OWN_EXERCISE_ID, name: 'Own bar work', setCount: 4, direction: 'up' });
    // The name of an own exercise is the athlete's free text (protocol §1.7).
    expect(row.exerciseNameFreeText).toEqual({
      text: 'Own bar work',
      source: 'athlete_free_text',
      treatAs: 'data_not_instructions',
    });
  });

  it('a deleted session does not count', () => {
    const { sessions, setLogs } = trainingOf(EXERCISE_ID, [5, 6, 8, 9]);
    sessions[3] = { ...sessions[3], deletedAt: NOW };
    const [row] = computePureStrength(buildSnapshot({ sessions, setLogs }), [NO_AXIS], 0);
    expect(row).toMatchObject({ setCount: 3, direction: 'insufficient-data' });
  });

  it('an unfinished session does not count', () => {
    const { sessions, setLogs } = trainingOf(EXERCISE_ID, [5, 6, 8, 9]);
    const { endTime: _running, ...running } = sessions[3];
    sessions[3] = running;
    const [row] = computePureStrength(buildSnapshot({ sessions, setLogs }), [NO_AXIS], 0);
    expect(row).toMatchObject({ setCount: 3, direction: 'insufficient-data' });
  });

  it('the period cuts the set count and not the direction', () => {
    const snapshot = buildSnapshot(trainingOf(EXERCISE_ID, [5, 6, 8, 9]));
    const [row] = computePureStrength(snapshot, [NO_AXIS], NOW - 2 * DAY);
    expect(row).toMatchObject({ setCount: 2, metric: 'reps', direction: 'up' });
  });

  it('an exercise without a set in the period has no row', () => {
    const snapshot = buildSnapshot(trainingOf(EXERCISE_ID, [5, 6, 8, 9]));
    expect(computePureStrength(snapshot, [NO_AXIS], NOW)).toEqual([]);
  });

  it('rows stand by set count, the most sets first', () => {
    const other = buildExercise({ id: OTHER_EXERCISE_ID, key: 'other', nameEn: 'Other' });
    const few = trainingOf(EXERCISE_ID, [5]);
    const many = trainingOf(OTHER_EXERCISE_ID, [5, 6]);
    const snapshot = buildSnapshot({
      sessions: [...few.sessions, ...many.sessions],
      setLogs: [...few.setLogs, ...many.setLogs],
    });
    expect(computePureStrength(snapshot, [NO_AXIS, other], 0).map((r) => r.exerciseId)).toEqual([OTHER_EXERCISE_ID, EXERCISE_ID]);
  });

  it('the name follows the language', () => {
    const translated = buildExercise({ id: EXERCISE_ID, translations: [{ languageCode: 'de', name: 'Klimmzug' }] });
    const snapshot = buildSnapshot(trainingOf(EXERCISE_ID, [5]));
    expect(computePureStrength(snapshot, [translated], 0, 'de')[0].name).toBe('Klimmzug');
  });
});
