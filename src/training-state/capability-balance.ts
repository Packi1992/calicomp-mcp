/**
 * Capability-axis stage-to-factor folding — a verbatim port of
 * `CapabilityInvolvementWeighting.kt` (Phase 138.1, CAP-01/CAP-05, `138.1-16`), plus the
 * MCP-side window-and-count glue that reproduces `AnalyticsDao.getCapabilitySetsByLevelInPeriod`'s
 * semantics on top of a decrypted snapshot — the capability-axis counterpart to
 * `muscle-balance.ts`.
 *
 * Kotlin is the source, this file is the port, the shared corpus
 * (`docs/coach-planning-vectors.json`, `capabilityBalance` section) is the proof — the same
 * three-way contract `muscle-balance.ts`'s header documents, held for four prior phases
 * (D-13). This direction is never reversed: a disagreement between this file and the
 * corpus means THIS file is wrong, never the corpus.
 *
 * **Deliberate divergence from `muscle-balance.ts`'s `weightFor`:** there, a missing level
 * resolves to `WEIGHT_PRIMARY` (D-03 of Phase 138 — an uncurated muscle link is defined to
 * behave exactly as it did before that phase). Here, `weightFor` **throws** on
 * `null`/`undefined` (D-04 of Phase 138.1) — a present `exercise_capabilities` row always
 * carries an explicit level, so there is no "uncurated but linked" state and therefore no
 * meaningful default to fall back to. A missing level reaching this function can only mean
 * a bug (a query that lost the level column, or a caller that forgot D-04's contract), and
 * a silent fallback would let a forgotten curation float to the top of the evaluation
 * instead of failing loudly — mirrors `CapabilityInvolvementWeighting.weightFor` exactly,
 * including the throw.
 *
 * `capabilitySetCountsInPeriod` reuses `muscleSetCountsInPeriod`'s window logic verbatim
 * (RESEARCH.md Pitfall 3): the window criterion is `setLog.createdAt` — a ROLLING
 * MILLISECOND SPAN, never `session.startTime` and never a calendar-day boundary — and only
 * sets from completed (`session.endTime` set), non-soft-deleted sessions count. A second,
 * slightly different window logic here would be a silent difference between two
 * evaluations of the same period — exactly the failure this reuse prevents.
 *
 * Exports:
 *   WEIGHT_HAUPTREIZ/MITTRAINIERT/GERING — the port of CapabilityInvolvementWeighting's constants
 *   weightFor                            — the port of CapabilityInvolvementWeighting.weightFor (throws on null/undefined)
 *   weightedCounts                       — the port of CapabilityInvolvementWeighting.weightedCounts
 *   CapabilityLevelSetCount               — the port of Kotlin's CapabilityLevelSetCount
 *   capabilitySetCountsInPeriod           — the window-and-count query, mirrored from muscleSetCountsInPeriod
 *
 * Security (threat model):
 *   T-138.1-40: a coach-reported capability weight that disagrees with the app's own
 *               calculator is mitigated by the shared corpus replay — never by trusting
 *               this port's own internal logic. A dedicated plan-level verify gate also
 *               compares this file's WEIGHT_* constants against
 *               CapabilityInvolvementWeighting.kt's directly.
 *   T-138.1-38: weightFor(null)/weightFor(undefined) MUST throw, exactly like the Kotlin
 *               source — the corpus's `missing-level-rejected` vector (`expectRejection:
 *               true`) proves both languages reject the same input, not merely that this
 *               port agrees with itself.
 *   T-138.1-41: no weighting constant lives anywhere outside this file — enforced by a
 *               plan-level verify gate grepping `src/tools/get_stats.ts` for a stray
 *               weight literal.
 *
 * Patterns: TrainCounter/.../domain/CapabilityInvolvementWeighting.kt (port target),
 *           src/training-state/muscle-balance.ts (the Phase 138 port precedent this
 *           file's doc-header, export shape, and window-logic reuse follow)
 */

import type { DecryptedSnapshot, CatalogExercise, CapabilityInvolvementLevel } from '../types.js';

// ---------------------------------------------------------------------------
// Port of CapabilityInvolvementWeighting.kt
// ---------------------------------------------------------------------------

/** Full credit — the capability axis is the main training stimulus for this exercise. */
export const WEIGHT_HAUPTREIZ = 1.0;

/** Half credit — the capability axis is co-trained alongside the main stimulus. */
export const WEIGHT_MITTRAINIERT = 0.5;

/** Quarter credit — the capability axis is only minimally involved. */
export const WEIGHT_GERING = 0.25;

/** One graded capability-axis set-count row — the port of Kotlin's `CapabilityLevelSetCount`. */
export interface CapabilityLevelSetCount {
  capabilityAxisKey: string;
  capabilityLevel: CapabilityInvolvementLevel | null | undefined;
  setCount: number;
}

/**
 * Resolves the weight factor for a graded capability-involvement level.
 *
 * `null`/`undefined` **throw** — unlike the muscle axis's `weightFor` in
 * `muscle-balance.ts`, there is no default level to fall back to (D-04 of Phase 138.1): a
 * present `exercise_capabilities` row always carries an explicit level, so a missing value
 * here is always a bug, never a valid "uncurated" state.
 *
 * Mirrors `CapabilityInvolvementWeighting.weightFor` exactly, including the throw.
 */
export function weightFor(level: CapabilityInvolvementLevel | null | undefined): number {
  switch (level) {
    case 'HAUPTREIZ':
      return WEIGHT_HAUPTREIZ;
    case 'MITTRAINIERT':
      return WEIGHT_MITTRAINIERT;
    case 'GERING':
      return WEIGHT_GERING;
    case null:
    case undefined:
      throw new Error(
        'capability-balance.weightFor: level must not be null/undefined — a present ' +
          'exercise_capabilities row always carries an explicit level (D-04 of Phase ' +
          '138.1). A missing level here is a bug, not a valid default.',
      );
  }
}

/**
 * Folds graded per-capability-axis set-count rows into a weighted count per axis key.
 *
 * Multiple rows for the same `capabilityAxisKey` accumulate — each row's
 * `setCount * weightFor(capabilityLevel)` is summed into that key's total. An empty input
 * array returns an empty object. `weightFor` throwing on any row (a missing level)
 * propagates out of this function — it is not caught here.
 *
 * Mirrors `CapabilityInvolvementWeighting.weightedCounts` exactly.
 */
export function weightedCounts(rows: CapabilityLevelSetCount[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const row of rows) {
    const contribution = row.setCount * weightFor(row.capabilityLevel);
    sums[row.capabilityAxisKey] = (sums[row.capabilityAxisKey] ?? 0) + contribution;
  }
  return sums;
}

// ---------------------------------------------------------------------------
// AnalyticsDao.getCapabilitySetsByLevelInPeriod window mirror
// ---------------------------------------------------------------------------

/**
 * Counts sets per capability-axis key in the window `[sinceMs, +inf)`, reusing
 * `muscleSetCountsInPeriod`'s window logic verbatim (RESEARCH.md Pitfall 3):
 *   - `sl.deletedAt` not set              — setLog not soft-deleted
 *   - the set's session exists, is not soft-deleted, and has `endTime` set (a
 *     running/ongoing session contributes nothing)
 *   - `sl.createdAt >= sinceMs`           — the ROLLING MILLISECOND window, over the set
 *     log's own `createdAt`, never over `session.startTime` and never over a calendar-day
 *     boundary. A session spanning midnight, or a set log whose `createdAt` drifts from
 *     its session's `startTime`, is judged solely by its own timestamp.
 *
 * Exercise resolution mirrors `COALESCE(sl.exerciseId, we.exerciseId)`, exactly like
 * `muscleSetCountsInPeriod`: if the set log carries its own `exerciseId`, that wins;
 * otherwise the linked `workoutExerciseId` is looked up in `snapshot.templateExercises`.
 * If neither resolves, or the resolved exercise is not present in the catalog, the set
 * contributes nothing.
 *
 * A set whose exercise carries multiple capability axes counts once for EACH axis, at
 * that axis's own graded level — mirroring `exercise_capabilities`' one-row-per-axis-link
 * shape (a join fanning out one row per axis link, same as the muscle-group join). An
 * exercise with an EMPTY `capabilities` array contributes to no axis and causes no error.
 *
 * Returns the raw per-set rows for `weightedCounts` to fold — this function does not fold
 * them itself, so a caller needing only the raw (unweighted) per-axis set count can derive
 * it directly from the returned rows without going through the weighting step.
 */
export function capabilitySetCountsInPeriod(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  sinceMs: number,
): CapabilityLevelSetCount[] {
  const catalogById = new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]));

  const rows: CapabilityLevelSetCount[] = [];

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

    for (const axis of exercise.capabilities) {
      rows.push({
        capabilityAxisKey: axis.key,
        capabilityLevel: axis.capabilityLevel,
        setCount: 1,
      });
    }
  }

  return rows;
}
