/**
 * Muscle-group set counting and radar-chart normalization — a line-for-line port of
 * `MuscleBalanceCalculator.kt` (Phase 137, STATE-02, D-04), plus the MCP-side glue that
 * reproduces `AnalyticsDao.getMuscleGroupSetsInPeriod` /
 * `OfflineFirstAnalyticsRepository.getMuscleGroupHeatmapData`'s window semantics on top
 * of a decrypted snapshot.
 *
 * `toRadarValues` mirrors the Kotlin object exactly: all six radar categories always
 * present, unknown muscle keys silently skipped, values normalized against the maximum
 * category sum, every value 0 when every category sums to 0. The shared corpus section
 * `muscleBalance` (`docs/coach-planning-vectors.json`) is what proves parity — this
 * TypeScript port and `CoachPlanningVectorsTest.kt`'s replay against the real Kotlin
 * `MuscleBalanceCalculator` run the same vectors and must agree, within a named float
 * tolerance (Kotlin `Float` vs TypeScript `number`). `MuscleBalanceCalculator.kt` remains
 * the source of truth; this file is the port, never the other way around.
 *
 * Phase 138 (MUSC-06, tracer part 2 of 2): `WEIGHT_PRIMARY`/`WEIGHT_SECONDARY`/
 * `WEIGHT_STABILIZER` and `weightFor`/`weightedCounts` are a verbatim port of
 * `TrainCounter/.../domain/MuscleInvolvementWeighting.kt` — that file is the source, this
 * is the port, the shared corpus's `levelCounts`/`expectedWeighted` is the proof. These
 * three numbers are CONSTANTS in this shared calculator, deliberately **not** a Coach
 * Parameter (D-02): the app never reads the Coach Parameter table, so modeling the weights
 * there would let the app's own radar and this MCP's answer silently diverge — exactly the
 * failure this file's whole existence prevents. `muscleSetCountsInPeriod`'s counting loop
 * below calls `weightFor` on every row (was: a fixed `+ 1`) — the corpus therefore proves
 * the function that actually runs in production, not a neighboring copy.
 *
 * `muscleSetCountsInPeriod` reproduces `AnalyticsDao.getMuscleGroupSetsInPeriod`'s SQL
 * exactly, including two details that are easy to get wrong (RESEARCH.md Pitfall 3):
 *   - the window criterion is `setLog.createdAt` — a ROLLING MILLISECOND SPAN, never
 *     `session.startTime` and never a calendar-day boundary. A session that runs past
 *     midnight, or whose set logs drift slightly from the session's own start time, must
 *     not produce a different result than the app's own query.
 *   - the app's Strength query (`getMuscleGroupSetsByLevelInPeriod`) carries NO capability
 *     filter at all — it counts across every exercise, regardless of axis. The neighboring
 *     Stretch/Mobility query in `AnalyticsDao.kt` (`getMuscleGroupSetsByLevelInPeriodForAxes`,
 *     Phase 138.1 CAP-01/D-08) DOES restrict its rows to a subquery over
 *     `exercise_capabilities`/`capability_axes` for the caller-supplied axis keys (mobility/
 *     flexibility) — the two queries are not symmetric. This port follows the Strength
 *     query's own lack of a filter, not any comment describing it.
 *
 * `computeMuscleBalance` returns all three app windows (7 days, 30 days, all time) in one
 * call, because the app's own window selection (`AnalyticsViewModel.heatmapPeriodDays`,
 * default 7) is pure UI state with no persistence (D-04) — there is no single "current"
 * window synced from the app for the coach to match.
 *
 * Exports:
 *   MUSCLE_TO_RADAR_CATEGORY  — the 18-key-to-6-category mapping, verbatim from Kotlin
 *   RADAR_CATEGORIES          — the six radar categories, in the app's own draw order
 *   toRadarValues             — the port of MuscleBalanceCalculator.toRadarValues
 *   WEIGHT_PRIMARY/SECONDARY/STABILIZER — the port of MuscleInvolvementWeighting's constants
 *   weightFor                 — the port of MuscleInvolvementWeighting.weightFor
 *   weightedCounts             — the port of MuscleInvolvementWeighting.weightedCounts
 *   muscleSetCountsInPeriod   — the window-and-count query, mirrored from AnalyticsDao
 *   computeMuscleBalance      — assembles all three app windows in one call
 *
 * Security (threat model):
 *   T-137-24: a coach-reported balance number that disagrees with the app's own radar is
 *             mitigated by the shared corpus replay plus the actively-constructed window
 *             test case (Pitfall 3) — never by trusting this port's own internal logic.
 *   T-120-17/T-120-18: this module performs no I/O and throws nothing; the surrounding
 *             tool's try/catch and no-console discipline is unaffected by this file.
 *   T-138-09: the weight constants below are CONSTANTS, never a Coach Parameter — the app
 *             has no reader for the Coach Parameter table, so modeling them there would
 *             let the app's radar and this MCP's answer silently diverge (D-02).
 *   T-138-16: weightFor(null) must equal weightFor('PRIMARY') exactly — an uncurated link
 *             folds identically to before this phase (D-03); see the invariant test in
 *             tests/training-state/muscle-balance.test.ts and the Kotlin twin.
 *
 * Patterns: TrainCounter/.../domain/MuscleBalanceCalculator.kt (port target),
 *           src/training-state/consistency.ts (the Phase 137-01 port precedent this
 *           file's doc-header and export shape follow)
 */

import type { DecryptedSnapshot, CatalogExercise, MuscleInvolvementLevel } from '../types.js';

// ---------------------------------------------------------------------------
// Port of MuscleBalanceCalculator.kt
// ---------------------------------------------------------------------------

/**
 * Maps canonical muscle group keys to the 6 radar chart categories. Verbatim from
 * `MuscleBalanceCalculator.kt`'s private `MUSCLE_TO_RADAR_CATEGORY` — do not add, remove,
 * or re-map an entry without updating the Kotlin original in lockstep.
 */
export const MUSCLE_TO_RADAR_CATEGORY: Record<string, string> = {
  chest: 'chest',
  back: 'back',
  lats: 'back',
  traps: 'back',
  lower_back: 'back',
  neck: 'back',
  quads: 'legs',
  hamstrings: 'legs',
  glutes: 'legs',
  calves: 'legs',
  adductors: 'legs',
  hip_flexors: 'legs',
  shoulders: 'shoulders',
  biceps: 'arms',
  triceps: 'arms',
  forearms: 'arms',
  abs: 'core',
  obliques: 'core',
};

/**
 * The ordered list of radar chart categories — order is part of the contract, because
 * the radar chart draws in this order (`MuscleBalanceCalculator.kt`'s `RADAR_CATEGORIES`).
 */
export const RADAR_CATEGORIES = ['chest', 'shoulders', 'back', 'legs', 'core', 'arms'] as const;

/**
 * Converts a map of muscle group set counts to normalized radar values (0-1).
 *
 * Unknown muscle keys are silently ignored. All 6 radar categories are always present in
 * the result. If all categories sum to zero, every value is 0.
 *
 * Mirrors `MuscleBalanceCalculator.toRadarValues` exactly.
 */
export function toRadarValues(muscleSetCounts: Record<string, number>): Record<string, number> {
  const categorySums: Record<string, number> = {};
  for (const category of RADAR_CATEGORIES) categorySums[category] = 0;

  for (const [muscleKey, sets] of Object.entries(muscleSetCounts)) {
    const category = MUSCLE_TO_RADAR_CATEGORY[muscleKey];
    if (category === undefined) continue;
    categorySums[category] = (categorySums[category] ?? 0) + sets;
  }

  const maxVal = Math.max(...RADAR_CATEGORIES.map((category) => categorySums[category]));
  if (maxVal === 0) {
    const zeroed: Record<string, number> = {};
    for (const category of RADAR_CATEGORIES) zeroed[category] = 0;
    return zeroed;
  }

  const result: Record<string, number> = {};
  for (const category of RADAR_CATEGORIES) result[category] = categorySums[category] / maxVal;
  return result;
}

// ---------------------------------------------------------------------------
// Port of MuscleInvolvementWeighting.kt (Phase 138, MUSC-06)
// ---------------------------------------------------------------------------

/** Full credit — the muscle group is the primary mover for this exercise. */
export const WEIGHT_PRIMARY = 1.0;

/** Half credit — the muscle group assists but is not the primary mover. */
export const WEIGHT_SECONDARY = 0.5;

/** Quarter credit — the muscle group stabilizes without driving the movement. */
export const WEIGHT_STABILIZER = 0.25;

/** One graded muscle-group set-count row — the port of Kotlin's `MuscleLevelSetCount`. */
export interface MuscleLevelSetCount {
  muscleGroupKey: string;
  involvementLevel: MuscleInvolvementLevel | null;
  setCount: number;
}

/**
 * Resolves the weight factor for a graded involvement level.
 *
 * `null`/`undefined` resolve to [WEIGHT_PRIMARY] — the same value as an explicit
 * `'PRIMARY'` — because an uncurated link is defined to behave exactly as it did before
 * this phase (D-03). This equivalence is an invariant, proven by a dedicated test on both
 * language sides: it must never silently change, because every uncurated exercise in the
 * catalog depends on it.
 *
 * Mirrors `MuscleInvolvementWeighting.weightFor` exactly.
 */
export function weightFor(level: MuscleInvolvementLevel | null | undefined): number {
  switch (level) {
    case 'SECONDARY':
      return WEIGHT_SECONDARY;
    case 'STABILIZER':
      return WEIGHT_STABILIZER;
    case 'PRIMARY':
    case null:
    case undefined:
      return WEIGHT_PRIMARY;
  }
}

/**
 * Folds graded per-muscle-group set-count rows into a weighted count per muscle-group key.
 *
 * Multiple rows for the same `muscleGroupKey` accumulate — each row's
 * `setCount * weightFor(involvementLevel)` is summed into that key's total. An empty input
 * array returns an empty object.
 *
 * Mirrors `MuscleInvolvementWeighting.weightedCounts` exactly.
 */
export function weightedCounts(rows: MuscleLevelSetCount[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const row of rows) {
    const contribution = row.setCount * weightFor(row.involvementLevel);
    sums[row.muscleGroupKey] = (sums[row.muscleGroupKey] ?? 0) + contribution;
  }
  return sums;
}

// ---------------------------------------------------------------------------
// AnalyticsDao.getMuscleGroupSetsInPeriod / OfflineFirstAnalyticsRepository window mirror
// ---------------------------------------------------------------------------

/**
 * Counts sets per muscle-group key in the window `[sinceMs, +inf)`, mirroring
 * `AnalyticsDao.getMuscleGroupSetsInPeriod`'s SQL exactly:
 *   - `sl.deletedAt IS NULL`               — setLog not soft-deleted
 *   - the set's session exists, is not soft-deleted, and has `endTime IS NOT NULL`
 *     (a running/ongoing session contributes nothing)
 *   - `sl.createdAt >= sinceTimestamp`     — the ROLLING MILLISECOND window, over the
 *     set log's own `createdAt`, never over `session.startTime` and never over a
 *     calendar-day boundary (RESEARCH.md Pitfall 3). A session spanning midnight, or a
 *     set log whose `createdAt` drifts from its session's `startTime`, is judged solely
 *     by its own timestamp — exactly as the app's SQL does.
 *   - the app's Strength query carries NO capability-axis filter (its neighboring
 *     Stretch/Mobility query, `getMuscleGroupSetsByLevelInPeriodForAxes`, restricts to a
 *     mobility/flexibility capability-axis subquery instead) — the two queries are not
 *     symmetric. This port follows the Strength query's own lack of a filter.
 *
 * Exercise resolution mirrors `COALESCE(sl.exerciseId, we.exerciseId)`: if the set log
 * carries its own `exerciseId`, that wins; otherwise the linked `workoutExerciseId` is
 * looked up in `snapshot.templateExercises`. If neither resolves, or the resolved
 * exercise is not present in the CATALOG (custom/user exercises carry no muscle-group
 * data on the wire — `SyncExerciseDto` has no `muscleGroups` field), the set contributes
 * nothing — exactly as the SQL's `INNER JOIN exercises` / `INNER JOIN
 * exercise_muscle_groups` would produce zero rows for it.
 *
 * A set touching multiple muscles counts once for EACH of its muscle keys (`GROUP BY
 * mg.canonicalKey` after the join fans out one row per muscle-group link).
 *
 * Phase 138 (MUSC-06): each contribution is now `weightFor(muscleGroup.involvementLevel)`
 * rather than a fixed `1` — the graded involvement level from the catalog (PRIMARY = 1.0,
 * SECONDARY = 0.5, STABILIZER = 0.25, missing = PRIMARY per D-03) scales how much a set
 * counts toward that muscle group.
 */
export function muscleSetCountsInPeriod(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  sinceMs: number,
): Record<string, number> {
  const catalogById = new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]));

  const counts: Record<string, number> = {};

  for (const setLog of snapshot.setLogs) {
    if (setLog.deletedAt !== undefined) continue;

    const session = sessionById.get(setLog.sessionId);
    if (session === undefined) continue;
    if (session.deletedAt !== undefined) continue;
    if (session.endTime === undefined) continue;

    if (setLog.createdAt < sinceMs) continue;

    const exerciseId =
      setLog.exerciseId ??
      (setLog.workoutExerciseId !== undefined
        ? templateExerciseById.get(setLog.workoutExerciseId)?.exerciseId
        : undefined);
    if (exerciseId === undefined) continue;

    const exercise = catalogById.get(exerciseId);
    if (exercise === undefined) continue;

    for (const muscleGroup of exercise.muscleGroups) {
      counts[muscleGroup.key] = (counts[muscleGroup.key] ?? 0) + weightFor(muscleGroup.involvementLevel);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// The three app windows in one call
// ---------------------------------------------------------------------------

export interface MuscleBalanceWindow {
  setCounts: Record<string, number>;
  radar: Record<string, number>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Computes the muscle balance for all three app windows in one call — 7 days, 30 days,
 * and all time — because the app's own window selection
 * (`AnalyticsViewModel.heatmapPeriodDays`, default 7) is pure UI state with no
 * persistence (`AnalyticsViewModel.kt:75`); there is no synced "current" window value for
 * the coach to match, so it always returns all three (D-04). All-time uses the lower
 * bound 0, exactly mirroring `OfflineFirstAnalyticsRepository.getMuscleGroupHeatmapData`'s
 * `Int.MAX_VALUE` branch.
 */
export function computeMuscleBalance(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  nowMs: number,
): { last7Days: MuscleBalanceWindow; last30Days: MuscleBalanceWindow; allTime: MuscleBalanceWindow } {
  const windowFor = (sinceMs: number): MuscleBalanceWindow => {
    const setCounts = muscleSetCountsInPeriod(snapshot, catalog, sinceMs);
    return { setCounts, radar: toRadarValues(setCounts) };
  };

  return {
    last7Days: windowFor(nowMs - 7 * MS_PER_DAY),
    last30Days: windowFor(nowMs - 30 * MS_PER_DAY),
    allTime: windowFor(0),
  };
}
