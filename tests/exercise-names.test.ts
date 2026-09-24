/**
 * Tests for src/exercise-names.ts (Phase 150, D-14/D-15/D-16/D-17).
 *
 * Coverage:
 *   - forExerciseId: catalog hit (curated + live user exercise), deleted-user-exercise
 *     fallback with exerciseDeleted, unresolvable id with exerciseUnknown — never invented.
 *   - lang: falls back to nameEn/name when no translation matches, for both a catalog
 *     exercise and a deleted user exercise's own translations.
 *   - forSetLog: resolves a set-log with no exerciseId through workoutExerciseId ->
 *     templateExercises, tagged exerciseNameSource: 'workoutExerciseId'.
 */

import { describe, it, expect } from 'vitest';
import { createExerciseNameResolver } from '../src/exercise-names.js';
import type { CatalogExercise, DecryptedSnapshot } from '../src/types.js';

const CATALOG_ID = 'aaaaaaaa-1111-4000-a000-000000000001';
const LIVE_USER_ID = 'bbbbbbbb-2222-4000-b000-000000000001';
const DELETED_USER_ID = 'cccccccc-3333-4000-c000-000000000001';

const curatedExercise: CatalogExercise = {
  id: CATALOG_ID,
  key: 'push_up',
  nameEn: 'Push-Up',
  mode: 'REPS',
  usesWeight: false,
  lastModifiedAt: 1_700_000_000_000,
  translations: [{ languageCode: 'de', name: 'Liegestütz' }],
  muscleGroups: [],
  equipment: [],
  capabilities: [],
  origin: 'CATALOG',
};

const liveUserCatalogEntry: CatalogExercise = {
  id: LIVE_USER_ID,
  key: `user_exercise:${LIVE_USER_ID}`,
  nameEn: 'Meine Übung',
  mode: 'REPS',
  usesWeight: false,
  lastModifiedAt: 1_700_000_000_000,
  translations: [],
  muscleGroups: [],
  equipment: [],
  capabilities: [],
  origin: 'CUSTOM',
};

function emptySnapshot(): DecryptedSnapshot {
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
  };
}

describe('createExerciseNameResolver — forExerciseId', () => {
  it('P150 D-15 a curated exercise resolves to its catalog name and key', () => {
    const resolver = createExerciseNameResolver({ catalog: [curatedExercise], snapshot: emptySnapshot() });
    expect(resolver.forExerciseId(CATALOG_ID)).toEqual({ exerciseName: 'Push-Up', exerciseKey: 'push_up' });
  });

  it('P150 D-15 a live user exercise resolves with key user_exercise:<id>', () => {
    const resolver = createExerciseNameResolver({ catalog: [liveUserCatalogEntry], snapshot: emptySnapshot() });
    expect(resolver.forExerciseId(LIVE_USER_ID)).toEqual({
      exerciseName: 'Meine Übung',
      exerciseKey: `user_exercise:${LIVE_USER_ID}`,
    });
  });

  it('P150 D-17 a deleted user exercise keeps its name and is flagged exerciseDeleted', () => {
    const snapshot: DecryptedSnapshot = {
      ...emptySnapshot(),
      exercises: [
        {
          id: DELETED_USER_ID,
          name: 'Alte Übung',
          mode: 'REPS',
          usesWeight: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          deletedAt: 1_700_000_100_000,
        },
      ],
    };
    // Not in the catalog — a deleted user exercise drops out of doFetch's projection.
    const resolver = createExerciseNameResolver({ catalog: [], snapshot });
    expect(resolver.forExerciseId(DELETED_USER_ID)).toEqual({
      exerciseName: 'Alte Übung',
      exerciseKey: `user_exercise:${DELETED_USER_ID}`,
      exerciseDeleted: true,
    });
  });

  it('P150 D-17 an unresolvable id yields nulls and exerciseUnknown', () => {
    const resolver = createExerciseNameResolver({ catalog: [], snapshot: emptySnapshot() });
    expect(resolver.forExerciseId('does-not-exist')).toEqual({
      exerciseName: null,
      exerciseKey: null,
      exerciseUnknown: true,
    });
  });
});

describe('createExerciseNameResolver — lang (D-14)', () => {
  it('P150 D-14 lang falls back to nameEn when no translation exists', () => {
    const resolver = createExerciseNameResolver({
      catalog: [curatedExercise],
      snapshot: emptySnapshot(),
      lang: 'fr',
    });
    expect(resolver.forExerciseId(CATALOG_ID).exerciseName).toBe('Push-Up');
  });

  it('P150 D-14 a user exercise translation is used for lang', () => {
    const snapshot: DecryptedSnapshot = {
      ...emptySnapshot(),
      exercises: [
        {
          id: DELETED_USER_ID,
          name: 'Alte Übung',
          mode: 'REPS',
          usesWeight: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          deletedAt: 1_700_000_100_000,
        },
      ],
      exerciseTranslations: [{ exerciseId: DELETED_USER_ID, languageCode: 'de', name: 'Alte Übung DE' }],
    };
    const resolver = createExerciseNameResolver({ catalog: [], snapshot, lang: 'de' });
    expect(resolver.forExerciseId(DELETED_USER_ID).exerciseName).toBe('Alte Übung DE');
  });
});

describe('createExerciseNameResolver — forSetLog (D-16)', () => {
  it('P150 a set-log without exerciseId is named through its workoutExerciseId', () => {
    const snapshot: DecryptedSnapshot = {
      ...emptySnapshot(),
      templateExercises: [
        {
          id: 'te-1',
          templateId: 'tpl-1',
          exerciseId: CATALOG_ID,
          exerciseSource: 'CATALOG',
          mode: 'REPS',
          restTimeSeconds: 60,
          sets: 1,
          orderIndex: 0,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ],
    };
    const resolver = createExerciseNameResolver({ catalog: [curatedExercise], snapshot });
    expect(resolver.forSetLog({ workoutExerciseId: 'te-1' })).toEqual({
      exerciseName: 'Push-Up',
      exerciseKey: 'push_up',
      exerciseNameSource: 'workoutExerciseId',
    });
  });

  it('a set-log with neither exerciseId nor a resolvable workoutExerciseId yields exerciseUnknown', () => {
    const resolver = createExerciseNameResolver({ catalog: [], snapshot: emptySnapshot() });
    expect(resolver.forSetLog({ workoutExerciseId: 'no-such-te' })).toEqual({
      exerciseName: null,
      exerciseKey: null,
      exerciseUnknown: true,
    });
    expect(resolver.forSetLog({})).toEqual({ exerciseName: null, exerciseKey: null, exerciseUnknown: true });
  });
});
