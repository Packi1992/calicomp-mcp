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
 * Phase 166 (plan 166-04; D-01, D-03, D-04 in the version E-15; protocol §1.11): the
 * strength counts read the shared population of Rule P (`set-population.ts`) and apply Rule S
 * (`strength-selection.ts`): an exercise whose rated capability axes are only `mobility` or
 * `flexibility` counts nowhere. That is the clause the app's strength heatmap queries
 * (`AnalyticsDao.getMuscleGroupSetsByLevelInPeriod`, its observed twin and the per-session
 * query) carry since 166, so `muscleBalance` mirrors the app's strength heatmap again
 * (Pitfall 3 of Phase 166). Before 166 neither side had that clause and both counted pure
 * stretching; the stretch heatmap (`getMuscleGroupSetsByLevelInPeriodForAxes`) still selects
 * by the same axis list on purpose. Two details stay easy to get wrong (Phase 137, Pitfall 3):
 *   - the window criterion is `setLog.createdAt` — a ROLLING MILLISECOND SPAN, never
 *     `session.startTime` and never a calendar-day boundary.
 *   - the counted unit is a set per muscle-group link, grouped by key and involvement level
 *     (`strengthLevelSetCounts`, the rows the corpus section `strengthHeatmapSelection`
 *     pins); the weighting folds those rows (`weightedCounts`, corpus section `muscleBalance`).
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
 *   strengthLevelSetCounts    — Rule S level rows in a window (the corpus replay target)
 *   strengthLevelSetCountsForSession — Rule S level rows of one session (the app's session card)
 *   muscleSetCountsInPeriod   — the weighted strength counts of one window
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
import { resolveSetPopulation, type PopulationSet } from './set-population.js';
import { isStretchOnly } from './strength-selection.js';

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
// Rule S over the population of Rule P (Phase 166, protocol §1.11)
// ---------------------------------------------------------------------------

/**
 * Folds population entries into the level rows of Rule S: every entry with
 * `setLog.createdAt >= sinceMs` whose exercise is not stretch-only (`isStretchOnly`) counts
 * once for EACH muscle-group link of its exercise, grouped by the link's key and involvement
 * level; a key and level without a set produce no row. Rows appear in the order of their first
 * set. The population must already be Rule P with finished sessions.
 */
function foldStrengthLevelRows(population: PopulationSet[], sinceMs: number): MuscleLevelSetCount[] {
  const rows = new Map<string, MuscleLevelSetCount>();
  for (const entry of population) {
    if (entry.setLog.createdAt < sinceMs) continue;
    if (isStretchOnly(entry.exercise)) continue;
    for (const muscleGroup of entry.exercise.muscleGroups) {
      const rowKey = `${muscleGroup.key}\u0000${muscleGroup.involvementLevel}`;
      const row = rows.get(rowKey);
      if (row === undefined) {
        rows.set(rowKey, { muscleGroupKey: muscleGroup.key, involvementLevel: muscleGroup.involvementLevel, setCount: 1 });
      } else {
        row.setCount += 1;
      }
    }
  }
  return [...rows.values()];
}

function catalogMapOf(catalog: CatalogExercise[]): Map<string, CatalogExercise> {
  return new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
}

/**
 * The level rows `{ muscleGroupKey, involvementLevel, setCount }` of the strength heatmap in the
 * window `[sinceMs, +inf)` — Rule S over the population of Rule P with finished sessions, the
 * rows `AnalyticsDao.getMuscleGroupSetsByLevelInPeriod` returns in the app. The corpus section
 * `strengthHeatmapSelection` replays against this function.
 */
export function strengthLevelSetCounts(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  sinceMs: number,
): MuscleLevelSetCount[] {
  const population = resolveSetPopulation(snapshot, catalogMapOf(catalog), { requireFinishedSession: true, sinceMs });
  return foldStrengthLevelRows(population, sinceMs);
}

/**
 * The level rows of Rule S for ONE session instead of a window, as the app's session card
 * (`AnalyticsDao.getMuscleGroupSetsByLevelForSession`): the session must still be live and
 * finished, otherwise there are no rows.
 */
export function strengthLevelSetCountsForSession(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  sessionId: string,
): MuscleLevelSetCount[] {
  const population = resolveSetPopulation(snapshot, catalogMapOf(catalog), { requireFinishedSession: true });
  return foldStrengthLevelRows(population.filter((entry) => entry.session.id === sessionId), 0);
}

/**
 * The weighted strength counts per muscle-group key in the window `[sinceMs, +inf)`:
 * `weightedCounts(strengthLevelSetCounts(...))`. Each set contributes
 * `weightFor(involvementLevel)` to each of its muscle keys (PRIMARY 1.0, SECONDARY 0.5,
 * STABILIZER 0.25, Phase 138 MUSC-06).
 *
 * Own exercises count like catalog exercises: since Phase 164 (D-25) their muscle-group links
 * arrive encrypted and `cache.ts` projects them into the catalog; an own exercise without
 * links contributes nothing, exactly as the app's join over `exercise_muscle_groups` produces no
 * row for it.
 */
export function muscleSetCountsInPeriod(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  sinceMs: number,
): Record<string, number> {
  return weightedCounts(strengthLevelSetCounts(snapshot, catalog, sinceMs));
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
 * the coach to match, so it always returns all three (D-04 of Phase 137). All-time uses the
 * lower bound 0, exactly mirroring `OfflineFirstAnalyticsRepository.getMuscleGroupHeatmapData`'s
 * `Int.MAX_VALUE` branch.
 *
 * Since Phase 166 (protocol §1.11, D-01; D-04 in the version E-15) this is Rule S over the
 * population of Rule P with finished sessions: an exercise whose rated capability axes are only
 * `mobility` or `flexibility` counts in no window, so `muscleBalance` is the same number as the
 * app's strength heatmap again. Before 166 it counted those sets too. Field name, place and
 * form are unchanged; only the sets it counts changed (in place, no parallel field).
 */
export function computeMuscleBalance(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  nowMs: number,
): { last7Days: MuscleBalanceWindow; last30Days: MuscleBalanceWindow; allTime: MuscleBalanceWindow } {
  const population = resolveSetPopulation(snapshot, catalogMapOf(catalog), { requireFinishedSession: true });
  const windowFor = (sinceMs: number): MuscleBalanceWindow => {
    const setCounts = weightedCounts(foldStrengthLevelRows(population, sinceMs));
    return { setCounts, radar: toRadarValues(setCounts) };
  };

  return {
    last7Days: windowFor(nowMs - 7 * MS_PER_DAY),
    last30Days: windowFor(nowMs - 30 * MS_PER_DAY),
    allTime: windowFor(0),
  };
}
