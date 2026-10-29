/**
 * Fixture of the characterization test of Phase 166 (plan 166-04, D-04 in the version E-15),
 * without tests of its own. It lives in a module of its own for the reason
 * `characterization-150-fixture.ts` does (Phase 160, G-MCP-03): a test file that imports
 * fixture constants from another test file registers that file's describe blocks a second
 * time. `characterization-166.test.ts` pins the outputs of this fixture; other test files
 * (for example `tests/tools/get_training_state.test.ts`) read the same fixture from here.
 *
 * The fixture is invented. It makes every counting rule of Phase 166 visible, so that every
 * plan that changes a pinned value shows at least one declared delta:
 *   - Rule S (D-01): a stretch-only exercise (only `mobility`/`flexibility` rated) beside a
 *     mixed exercise (`mobility` plus `power`) and two exercises without a stretch axis.
 *   - Rule M (D-02): a repetition set on a time station (workout exercise `TIME` on a
 *     `REPS` catalog exercise), `MAX` on a `TIME` catalog exercise, and a `REPS` workout
 *     exercise on a `TIME` catalog exercise.
 *   - Rule P (D-03): a session that was never finished, a deleted set, a deleted session and
 *     a set that carries only `workoutExerciseId`; a zero set.
 *   - D-10: two sessions of the same template on the day of its occurrence, the one with the
 *     smaller id has fewer sets.
 *   - IN-02: a weekly series whose only occurrence in the adherence window is cancelled,
 *     with a finished session of the same template on that day.
 */

import type { DecryptedSnapshot, CatalogExercise, DecryptedSetLog, DecryptedSession } from '../src/types.js';
import type { GetHistoryArgs } from '../src/tools/get_history.js';
import type { GetTrainingStateArgs } from '../src/tools/get_training_state.js';
import type { GetAdherenceArgs } from '../src/tools/get_adherence.js';
import { COACH_PARAMETER_DEFAULTS } from '../src/coach-parameters.js';
import { getTrainingState } from '../src/tools/get_training_state.js';
import { getStats } from '../src/tools/get_stats.js';
import { getHistory } from '../src/tools/get_history.js';
import { getAdherence } from '../src/tools/get_adherence.js';

const D = (iso: string): number => Date.parse(iso);

export const CHAR166_NOW_MS = D('2026-03-10T12:00:00Z');

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const CHAR166_EX_PUSH = 'char166-cat-push';
export const CHAR166_EX_STRETCH = 'char166-cat-stretch';
export const CHAR166_EX_MIXED = 'char166-cat-mixed';
export const CHAR166_EX_HOLD = 'char166-cat-hold';

function muscle(key: string, level: 'PRIMARY' | 'SECONDARY' | 'STABILIZER') {
  return { id: `char166-mg-${key}`, key, translations: [], involvementLevel: level };
}

function axis(key: string, level: 'HAUPTREIZ' | 'MITTRAINIERT' | 'GERING') {
  return { id: `char166-ax-${key}`, key, translations: [], capabilityLevel: level };
}

function catalogExercise(
  id: string,
  key: string,
  nameEn: string,
  mode: string,
  muscleGroups: CatalogExercise['muscleGroups'],
  capabilities: CatalogExercise['capabilities'],
): CatalogExercise {
  return {
    id,
    key,
    nameEn,
    mode,
    usesWeight: false,
    lastModifiedAt: D('2026-01-01T00:00:00Z'),
    translations: [],
    muscleGroups,
    equipment: [],
    capabilities,
    origin: 'CATALOG',
  };
}

export const CHAR166_CATALOG: CatalogExercise[] = [
  // No stretch axis: stays in the strength heatmap (Rule S).
  catalogExercise(CHAR166_EX_PUSH, 'char166_push', 'P166 Push', 'REPS',
    [muscle('chest', 'PRIMARY'), muscle('triceps', 'SECONDARY')],
    [axis('power', 'MITTRAINIERT')]),
  // Only stretch axes rated: excluded from the strength heatmap since 166 (Rule S).
  catalogExercise(CHAR166_EX_STRETCH, 'char166_stretch', 'P166 Stretch', 'REPS',
    [muscle('hamstrings', 'PRIMARY'), muscle('lower_back', 'SECONDARY')],
    [axis('mobility', 'HAUPTREIZ'), axis('flexibility', 'MITTRAINIERT')]),
  // A stretch axis plus another axis: mixed, stays (Rule S).
  catalogExercise(CHAR166_EX_MIXED, 'char166_mixed', 'P166 Mixed', 'REPS',
    [muscle('quads', 'PRIMARY'), muscle('glutes', 'SECONDARY')],
    [axis('mobility', 'HAUPTREIZ'), axis('power', 'GERING')]),
  // A TIME catalog exercise without any axis (Rule M fallback, Rule S stays).
  catalogExercise(CHAR166_EX_HOLD, 'char166_hold', 'P166 Hold', 'TIME',
    [muscle('abs', 'PRIMARY')],
    []),
];

// ---------------------------------------------------------------------------
// Templates and template exercises (the app's workout_exercises)
// ---------------------------------------------------------------------------

export const CHAR166_TPL_D10 = 'char166-tpl-d10';
export const CHAR166_TPL_IN02 = 'char166-tpl-in02';
export const CHAR166_TPL_MAIN = 'char166-tpl-main';

const TE_D10_PUSH = 'char166-te-d10-push';
const TE_IN02_MIXED = 'char166-te-in02-mixed';
const TE_PUSH_REPS = 'char166-te-push-reps';
const TE_PUSH_TIME = 'char166-te-push-time';
const TE_HOLD_MAX = 'char166-te-hold-max';
const TE_HOLD_REPS = 'char166-te-hold-reps';

function template(id: string, name: string) {
  return {
    id,
    name,
    createdAt: D('2026-01-01T00:00:00Z'),
    updatedAt: D('2026-01-01T00:00:00Z'),
    isFavoriteForWatch: false,
  };
}

function templateExercise(
  id: string,
  templateId: string,
  exerciseId: string,
  mode: string,
  orderIndex: number,
  targets: { targetReps?: number; targetTimeSeconds?: number },
) {
  return {
    id,
    templateId,
    exerciseId,
    exerciseSource: 'CATALOG',
    mode,
    ...targets,
    restTimeSeconds: 60,
    sets: 3,
    orderIndex,
    createdAt: D('2026-01-01T00:00:00Z'),
    updatedAt: D('2026-01-01T00:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const CHAR166_SESSION_MAIN = 'char166-s-main';
export const CHAR166_SESSION_UNFINISHED = 'char166-s-unfinished';
export const CHAR166_SESSION_DELETED = 'char166-s-deleted';
export const CHAR166_SESSION_OLD = 'char166-s-old';
/** D-10: the smaller id, one set. Through protocol 1.48 it wins pass 1 of the adherence. */
export const CHAR166_SESSION_D10_FEW = 'char166-s-d10-a';
/** D-10: the larger id, three sets. From protocol 1.49 on it wins pass 1. */
export const CHAR166_SESSION_D10_MANY = 'char166-s-d10-b';
export const CHAR166_SESSION_IN02 = 'char166-s-in02';

function session(
  id: string,
  startIso: string,
  extra: Partial<DecryptedSession> & { finished: boolean },
): DecryptedSession {
  const { finished, ...rest } = extra;
  const startTime = D(startIso);
  return {
    id,
    startTime,
    ...(finished ? { endTime: startTime + 60 * 60 * 1000 } : {}),
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: startTime,
    updatedAt: startTime,
    ...rest,
  };
}

function setLog(
  id: string,
  sessionId: string,
  createdIso: string,
  values: Partial<DecryptedSetLog>,
): DecryptedSetLog {
  const createdAt = D(createdIso);
  return {
    id,
    sessionId,
    exerciseSource: 'CATALOG',
    completedReps: null,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: createdAt,
    measuredTimeSeconds: null,
    createdAt,
    updatedAt: createdAt,
    ...values,
  };
}

const SETS: DecryptedSetLog[] = [
  // Main session 2026-03-06, finished, template MAIN.
  setLog('char166-sl-push-1', CHAR166_SESSION_MAIN, '2026-03-06T08:05:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_PUSH_REPS, completedReps: 15 }),
  // Rule P: only workoutExerciseId, no exerciseId.
  setLog('char166-sl-push-wid-only', CHAR166_SESSION_MAIN, '2026-03-06T08:06:00Z',
    { workoutExerciseId: TE_PUSH_REPS, completedReps: 9 }),
  // Rule M: repetitions on a time station (workout exercise TIME, catalog REPS).
  setLog('char166-sl-push-time-station', CHAR166_SESSION_MAIN, '2026-03-06T08:07:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_PUSH_TIME, completedReps: 40, completedTimeSeconds: 30 }),
  // A zero set.
  setLog('char166-sl-push-zero', CHAR166_SESSION_MAIN, '2026-03-06T08:08:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_PUSH_REPS, completedReps: 0 }),
  // Rule P: a deleted set.
  setLog('char166-sl-push-deleted', CHAR166_SESSION_MAIN, '2026-03-06T08:09:00Z',
    { exerciseId: CHAR166_EX_PUSH, completedReps: 25, deletedAt: D('2026-03-06T10:00:00Z') }),
  // Rule S: two sets of the stretch-only exercise, one of the mixed exercise.
  setLog('char166-sl-stretch-1', CHAR166_SESSION_MAIN, '2026-03-06T08:10:00Z',
    { exerciseId: CHAR166_EX_STRETCH, completedReps: 8 }),
  setLog('char166-sl-stretch-2', CHAR166_SESSION_MAIN, '2026-03-06T08:11:00Z',
    { exerciseId: CHAR166_EX_STRETCH, completedReps: 8 }),
  setLog('char166-sl-mixed-1', CHAR166_SESSION_MAIN, '2026-03-06T08:12:00Z',
    { exerciseId: CHAR166_EX_MIXED, completedReps: 10 }),
  // Rule M: MAX on a TIME catalog exercise records a time (its stray repetitions do not count).
  setLog('char166-sl-hold-max', CHAR166_SESSION_MAIN, '2026-03-06T08:13:00Z',
    { exerciseId: CHAR166_EX_HOLD, workoutExerciseId: TE_HOLD_MAX, completedReps: 15, completedTimeSeconds: 50 }),
  // Rule M: a REPS workout exercise on a TIME catalog exercise records repetitions (its time does not count).
  setLog('char166-sl-hold-reps', CHAR166_SESSION_MAIN, '2026-03-06T08:14:00Z',
    { exerciseId: CHAR166_EX_HOLD, workoutExerciseId: TE_HOLD_REPS, completedReps: 12, completedTimeSeconds: 60 }),
  // Rule M fallback: no workout exercise, catalog TIME.
  setLog('char166-sl-hold-time', CHAR166_SESSION_MAIN, '2026-03-06T08:15:00Z',
    { exerciseId: CHAR166_EX_HOLD, completedTimeSeconds: 45 }),

  // Rule P: a session that was never finished (2026-03-08).
  setLog('char166-sl-push-unfinished', CHAR166_SESSION_UNFINISHED, '2026-03-08T08:05:00Z',
    { exerciseId: CHAR166_EX_PUSH, completedReps: 20 }),

  // Rule P: a deleted session (2026-03-07).
  setLog('char166-sl-push-in-deleted-session', CHAR166_SESSION_DELETED, '2026-03-07T08:05:00Z',
    { exerciseId: CHAR166_EX_PUSH, completedReps: 30 }),

  // An older finished session (2026-02-20): inside 30 days, outside 7 days.
  setLog('char166-sl-stretch-old', CHAR166_SESSION_OLD, '2026-02-20T08:05:00Z',
    { exerciseId: CHAR166_EX_STRETCH, completedReps: 6 }),
  setLog('char166-sl-push-old', CHAR166_SESSION_OLD, '2026-02-20T08:06:00Z',
    { exerciseId: CHAR166_EX_PUSH, completedReps: 11 }),

  // D-10: two sessions of the same template on 2026-03-05.
  setLog('char166-sl-d10-few-1', CHAR166_SESSION_D10_FEW, '2026-03-05T08:05:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_D10_PUSH, completedReps: 5 }),
  setLog('char166-sl-d10-many-1', CHAR166_SESSION_D10_MANY, '2026-03-05T10:05:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_D10_PUSH, completedReps: 10 }),
  setLog('char166-sl-d10-many-2', CHAR166_SESSION_D10_MANY, '2026-03-05T10:06:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_D10_PUSH, completedReps: 10 }),
  setLog('char166-sl-d10-many-3', CHAR166_SESSION_D10_MANY, '2026-03-05T10:07:00Z',
    { exerciseId: CHAR166_EX_PUSH, workoutExerciseId: TE_D10_PUSH, completedReps: 10 }),

  // IN-02: the finished session on the cancelled series date 2026-03-04.
  setLog('char166-sl-in02-1', CHAR166_SESSION_IN02, '2026-03-04T08:05:00Z',
    { exerciseId: CHAR166_EX_MIXED, workoutExerciseId: TE_IN02_MIXED, completedReps: 10 }),
];

export const CHAR166_SNAPSHOT: DecryptedSnapshot = {
  syncedAt: CHAR166_NOW_MS,
  exercises: [],
  exerciseTranslations: [],
  templates: [
    template(CHAR166_TPL_D10, 'P166 Template D-10'),
    template(CHAR166_TPL_IN02, 'P166 Template IN-02'),
    template(CHAR166_TPL_MAIN, 'P166 Template main'),
  ],
  blocks: [],
  templateExercises: [
    templateExercise(TE_D10_PUSH, CHAR166_TPL_D10, CHAR166_EX_PUSH, 'REPS', 0, { targetReps: 10 }),
    templateExercise(TE_IN02_MIXED, CHAR166_TPL_IN02, CHAR166_EX_MIXED, 'REPS', 0, { targetReps: 10 }),
    templateExercise(TE_PUSH_REPS, CHAR166_TPL_MAIN, CHAR166_EX_PUSH, 'REPS', 0, { targetReps: 15 }),
    templateExercise(TE_PUSH_TIME, CHAR166_TPL_MAIN, CHAR166_EX_PUSH, 'TIME', 1, { targetTimeSeconds: 30 }),
    templateExercise(TE_HOLD_MAX, CHAR166_TPL_MAIN, CHAR166_EX_HOLD, 'MAX', 2, {}),
    templateExercise(TE_HOLD_REPS, CHAR166_TPL_MAIN, CHAR166_EX_HOLD, 'REPS', 3, { targetReps: 12 }),
  ],
  sessions: [
    session(CHAR166_SESSION_MAIN, '2026-03-06T08:00:00Z', { finished: true, templateId: CHAR166_TPL_MAIN }),
    session(CHAR166_SESSION_UNFINISHED, '2026-03-08T08:00:00Z', { finished: false }),
    session(CHAR166_SESSION_DELETED, '2026-03-07T08:00:00Z', {
      finished: true,
      updatedAt: D('2026-03-07T12:00:00Z'),
      deletedAt: D('2026-03-07T12:00:00Z'),
    }),
    session(CHAR166_SESSION_OLD, '2026-02-20T08:00:00Z', { finished: true }),
    session(CHAR166_SESSION_D10_FEW, '2026-03-05T08:00:00Z', { finished: true, templateId: CHAR166_TPL_D10 }),
    session(CHAR166_SESSION_D10_MANY, '2026-03-05T10:00:00Z', { finished: true, templateId: CHAR166_TPL_D10 }),
    session(CHAR166_SESSION_IN02, '2026-03-04T08:00:00Z', { finished: true, templateId: CHAR166_TPL_IN02 }),
  ],
  setLogs: SETS,
  hrSamples: [],
  plannedWorkouts: [
    // D-10: a single occurrence on 2026-03-05.
    {
      id: 'char166-pw-d10',
      templateId: CHAR166_TPL_D10,
      scheduledDate: D('2026-03-05T00:00:00Z'),
      scheduledTime: null,
      note: null,
      recurrenceRule: null,
      recurrenceGroupId: null,
      deletedOccurrencesRaw: null,
      completedSessionId: null,
    },
    // IN-02: weekly from 2026-03-04; its only date in the adherence window is cancelled.
    {
      id: 'char166-pw-in02',
      templateId: CHAR166_TPL_IN02,
      scheduledDate: D('2026-03-04T00:00:00Z'),
      scheduledTime: '08:00',
      note: null,
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1',
      recurrenceGroupId: 'char166-pw-in02-group',
      deletedOccurrencesRaw: '["2026-03-04"]',
      completedSessionId: null,
    },
  ],
  settings: [{ key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' }],
};

// ---------------------------------------------------------------------------
// Arguments of the pinned calls
// ---------------------------------------------------------------------------

export const CHAR166_TRAINING_STATE_ARGS: GetTrainingStateArgs = {};
export const CHAR166_TRAINING_STATE_DATA = {
  snapshot: CHAR166_SNAPSHOT,
  catalog: CHAR166_CATALOG,
  coachParameters: COACH_PARAMETER_DEFAULTS,
  parametersSource: 'defaults' as const,
};

export const CHAR166_STATS_DATA = { snapshot: CHAR166_SNAPSHOT, catalog: CHAR166_CATALOG };
/** `get_stats by:"exercise"` on the exercise of every Rule P case. */
export const CHAR166_STATS_EXERCISE_ARGS = { by: 'exercise' as const, exerciseId: CHAR166_EX_PUSH };
/** `get_stats by:"muscle"` on the primary muscle of that exercise. */
export const CHAR166_STATS_MUSCLE_ARGS = { by: 'muscle' as const, muscle: 'chest' };
export const CHAR166_STATS_CAPABILITIES_ARGS = { by: 'capabilities' as const };

export const CHAR166_HISTORY_ARGS: GetHistoryArgs = { from: '2026-02-01', to: '2026-03-31', limit: 200 };

/** Monday to Sunday: the D-10 occurrence (03-05) and the only, cancelled IN-02 date (03-04). */
export const CHAR166_ADHERENCE_ARGS: GetAdherenceArgs = { from: '2026-03-02', to: '2026-03-08' };
export const CHAR166_ADHERENCE_DATA = {
  snapshot: CHAR166_SNAPSHOT,
  catalog: CHAR166_CATALOG,
  coachParameters: COACH_PARAMETER_DEFAULTS,
};

// ---------------------------------------------------------------------------
// The pinned calls
// ---------------------------------------------------------------------------

/**
 * The outputs of the six pinned calls for this fixture, round-tripped through JSON (the pins
 * are what the tools put on the wire). `tests/vectors/characterization-166.json` was written
 * from exactly this object by a temporary, uncommitted generator test against the code before
 * Phase 166 changed it; `characterization-166.test.ts` compares against it.
 */
export function collectPinnedOutputs166(): Record<string, unknown> {
  const outputs = {
    getTrainingState: getTrainingState(CHAR166_TRAINING_STATE_ARGS, CHAR166_TRAINING_STATE_DATA, CHAR166_NOW_MS),
    getStatsExercise: getStats(CHAR166_STATS_EXERCISE_ARGS, CHAR166_STATS_DATA),
    getStatsMuscle: getStats(CHAR166_STATS_MUSCLE_ARGS, CHAR166_STATS_DATA),
    getStatsCapabilities: getStats(CHAR166_STATS_CAPABILITIES_ARGS, CHAR166_STATS_DATA),
    getHistory: getHistory(CHAR166_HISTORY_ARGS, CHAR166_SNAPSHOT),
    getAdherence: getAdherence(CHAR166_ADHERENCE_ARGS, CHAR166_ADHERENCE_DATA, CHAR166_NOW_MS),
  };
  return JSON.parse(JSON.stringify(outputs)) as Record<string, unknown>;
}

export const CHAR166_PIN_KEYS = [
  'getTrainingState',
  'getStatsExercise',
  'getStatsMuscle',
  'getStatsCapabilities',
  'getHistory',
  'getAdherence',
] as const;
