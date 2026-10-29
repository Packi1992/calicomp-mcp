/**
 * Rule P of protocol §1.11 (Phase 166, plan 166-04; D-03): one population for every count.
 *
 * Every count of §1.11 — the strength balance (`muscleBalance`, Rule S), the personal records
 * (Rule M) and, from plan 166-06 on, `get_stats`, the capability balance and the suspect marks —
 * reads the sets of this one function, never an own resolution. A set is resolved exactly once:
 *
 *   - **Exercise:** `setLog.exerciseId` if set, otherwise the `exerciseId` of the workout
 *     exercise (`snapshot.templateExercises`, the app's `workout_exercises`) that
 *     `workoutExerciseId` points to, also a soft-deleted one (the app joins it without looking
 *     at `deletedAt`). The resolved exercise must exist and be live: here that means it is in
 *     the catalog the tool receives (`cache.ts` merges the curated catalog with the athlete's
 *     LIVE own exercises; a soft-deleted own exercise is not in it). Otherwise the set belongs
 *     to no count.
 *   - **Session:** `setLog.sessionId`; the session row must exist.
 *   - **Deletion marks exclude:** a set with `deletedAt` and a set of a session with
 *     `deletedAt`. `null` and an absent key are the same (no mark): `consistency.ts` tested
 *     `!= null`, `muscle-balance.ts` `!== undefined`; `isMarkedDeleted` covers both.
 *   - **Finished session:** `endTime` must be set when `requireFinishedSession` is true (every
 *     balance, `get_stats`); personal records and suspect marks pass `false`.
 *   - **Window:** with `sinceMs`, a set counts exactly when `setLog.createdAt >= sinceMs`; the
 *     window is cut on the set, never on the session.
 *   - **No kind filter:** manual sessions, quick challenges and group sessions count like any
 *     other session.
 *
 * Each entry also carries the mode the set was trained in (Rule M, `trainingModeOf`) and
 * whether it records a time (`recordsTime`).
 *
 * Exports:
 *   PopulationSet, SetPopulationOptions — the entry and option shapes
 *   isMarkedDeleted     — a deletion mark, `null` and absent alike
 *   resolveSetPopulation — the population of Rule P
 *   trainingModeOf      — the effective mode of a set (Rule M, step 1)
 *   recordsTime         — whether a set records a time (Rule M, step 2; the app's `recordsTime`)
 */

import type {
  CatalogExercise,
  DecryptedSession,
  DecryptedSetLog,
  DecryptedSnapshot,
  NormalizedTemplateExercise,
} from '../types.js';

/** One set of the population, resolved once. */
export interface PopulationSet {
  setLog: DecryptedSetLog;
  session: DecryptedSession;
  /** The resolved exercise id: `setLog.exerciseId`, else the workout exercise's. */
  exerciseId: string;
  /** The live catalog exercise of `exerciseId`. */
  exercise: CatalogExercise;
  /** The workout exercise `workoutExerciseId` points to, also a soft-deleted one; `undefined` when absent. */
  workoutExercise: NormalizedTemplateExercise | undefined;
  /** The mode the set was trained in (Rule M, step 1). */
  trainingMode: string | undefined;
  /** Whether the set records a time (Rule M, step 2). */
  recordsTime: boolean;
}

export interface SetPopulationOptions {
  /** `endTime` required: true for every balance and `get_stats`, false for records and suspect marks. */
  requireFinishedSession: boolean;
  /** When given, only sets with `createdAt >= sinceMs`. */
  sinceMs?: number;
}

/** A deletion mark: set when `deletedAt` is neither absent nor `null`. */
export function isMarkedDeleted(row: { deletedAt?: number | null }): boolean {
  return row.deletedAt !== undefined && row.deletedAt !== null;
}

/**
 * The effective mode of a set (Rule M, step 1): the `mode` of the workout exercise that
 * `workoutExerciseId` points to, also a soft-deleted one; otherwise (no `workoutExerciseId`,
 * or a row that does not exist) the catalog mode. The catalog mode is a fallback only.
 */
export function trainingModeOf(
  setLog: DecryptedSetLog,
  templateExerciseById: ReadonlyMap<string, NormalizedTemplateExercise>,
  catalogMode: string | undefined,
): string | undefined {
  const workoutExercise =
    setLog.workoutExerciseId != null ? templateExerciseById.get(setLog.workoutExerciseId) : undefined;
  return workoutExercise?.mode ?? catalogMode;
}

/**
 * Whether a set records a time (Rule M, step 2; the app's `recordsTime`,
 * `WorkoutExerciseEntity.kt`, plan 165-02): its effective mode is `TIME`, or `MAX` on an
 * exercise whose catalog mode is `TIME`. Only `MAX` asks the catalog.
 */
export function recordsTime(mode: string | undefined, catalogMode: string | undefined): boolean {
  return mode === 'TIME' || (mode === 'MAX' && catalogMode === 'TIME');
}

/**
 * The population of Rule P: every live set of the snapshot once, in snapshot order, with its
 * session, its resolved live exercise and the mode it was trained in.
 */
export function resolveSetPopulation(
  snapshot: DecryptedSnapshot,
  catalogById: ReadonlyMap<string, CatalogExercise>,
  options: SetPopulationOptions,
): PopulationSet[] {
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]));
  const { requireFinishedSession, sinceMs } = options;

  const population: PopulationSet[] = [];
  for (const setLog of snapshot.setLogs) {
    if (isMarkedDeleted(setLog)) continue;

    const session = sessionById.get(setLog.sessionId);
    if (session === undefined) continue;
    if (isMarkedDeleted(session)) continue;
    if (requireFinishedSession && session.endTime == null) continue;

    if (sinceMs !== undefined && setLog.createdAt < sinceMs) continue;

    const workoutExercise =
      setLog.workoutExerciseId != null ? templateExerciseById.get(setLog.workoutExerciseId) : undefined;
    const exerciseId = setLog.exerciseId ?? workoutExercise?.exerciseId;
    if (exerciseId == null) continue;

    const exercise = catalogById.get(exerciseId);
    if (exercise === undefined) continue;

    const trainingMode = trainingModeOf(setLog, templateExerciseById, exercise.mode);
    population.push({
      setLog,
      session,
      exerciseId,
      exercise,
      workoutExercise,
      trainingMode,
      recordsTime: recordsTime(trainingMode, exercise.mode),
    });
  }
  return population;
}
