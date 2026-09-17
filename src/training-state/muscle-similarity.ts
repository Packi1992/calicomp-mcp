/**
 * Muscle-similarity measurement between two sets of training content — Ruzicka
 * similarity over the 18 canonical muscle keys (Phase 137, D-21). This is completely
 * new arithmetic with no Kotlin analogue to port; the closest formal precedent in this
 * codebase is `src/e1rm.ts` (a pure, exported, testable function over snapshot-derived
 * data), matched in shape only, not in content.
 *
 * Why Ruzicka, and not a direction-based measure (cosine): for sparse, non-negative
 * count vectors — exactly what "how many sets hit which muscle group" is — the field
 * standard is Ruzicka/Bray-Curtis, not cosine. A direction-based measure normalizes
 * away MAGNITUDE, so a single warm-up set can look identical to a full session with the
 * same muscle *distribution* but far more volume. Worked example from the research
 * (D-21, Web-Gegenprüfung Frage 1, Befund 2): `{chest:1, triceps:1, shoulders:1}`
 * (one Push-Up set) against `{chest:6, triceps:6, shoulders:6}` (a full Push-Day
 * template with the identical distribution, nine times the volume) scores `1.0` under
 * cosine similarity — a false "perfect match" — but `3/18 ≈ 0.167` under Ruzicka,
 * correctly far below even the `uncertain` threshold. `137-RESEARCH.md`'s Pattern 3
 * code block still shows the now-superseded cosine formula; D-21 overrides it, not the
 * other way around.
 *
 * Phase 138 (MUSC-06, D-10 point 2): `buildMuscleVector` now weights every muscle-group
 * hit by its graded involvement level — `hit.setCount * weightFor(muscleGroup.involvementLevel)`
 * instead of the flat `+ hit.setCount` this file used through Phase 137 (D-26 explicitly
 * deferred the distinction to this later phase; that deferral is now closed). The weight
 * factor comes from `weightFor` in `./muscle-balance.js` — the ONE stage→factor mapping in
 * this repo (D-02), ported from `MuscleInvolvementWeighting.kt` and proven equal to the
 * Kotlin side by the shared corpus. This file does not define, import a second copy of, or
 * repeat the three weight numbers (1.0/0.5/0.25) anywhere else. An uncurated link (`null`/
 * `undefined` involvementLevel) resolves to the PRIMARY weight (1.0) inside `weightFor`
 * itself, so a fully-PRIMARY catalog produces byte-identical vectors to the pre-138
 * unweighted version (D-03).
 *
 * `ruzickaSimilarity` and `classifySimilarity` below are UNCHANGED by this phase — the
 * weighting is applied once, at vector-construction time, and flows through the same
 * formula afterward exactly as this file's Phase-137 header predicted. In particular the
 * two classification thresholds remain caller-supplied PARAMETERS, never module constants
 * (D-23, unchanged) — plan 138-14 re-derives their default values without touching this
 * file.
 *
 * Exports:
 *   MuscleHit          — one exercise's set count, the input shape buildMuscleVector reads
 *   buildMuscleVector  — hits + catalog → per-muscle-key WEIGHTED count vector (Phase 138)
 *   buildCombinedVector — hits + catalog → buildMuscleVector's dimensions PLUS a prefixed
 *                        dimension per capability axis (Phase 138.1, D-17, plan 138.1-22) —
 *                        a second vector CONSTRUCTION, never a second similarity measure
 *   ruzickaSimilarity  — Σmin(Pᵢ,Qᵢ) / Σmax(Pᵢ,Qᵢ) over the union of keys
 *   SimilarityVerdict  — the three-value classification result
 *   classifySimilarity — similarity + two threshold PARAMETERS (never module constants,
 *                        D-23) → SimilarityVerdict
 *
 * Security (threat model):
 *   T-137-08: an inferred similarity match must never be read as a certain one —
 *             classifySimilarity returns a distinct 'uncertain' tier rather than
 *             collapsing to a boolean, so the caller can surface the borderline value
 *             instead of silently trusting it.
 *   T-137-23: a wrong similarity measure would systematically bias adherence numbers
 *             upward — mitigated by using Ruzicka (never a direction-based measure) and
 *             by a lint-time grep gate excluding any vector-norm call from this module.
 *   T-138-01/T-138-18: the graded involvement level is a literal union type resolved
 *             exclusively through the imported `weightFor`, never a second local mapping
 *             — a Tampering/divergence risk closed by importing rather than re-deriving.
 *   T-120-17/T-120-18: this module performs no I/O and throws nothing; the surrounding
 *             tool's try/catch and no-console discipline is unaffected by this file.
 *
 * Patterns: src/e1rm.ts (nearest structural precedent — pure, exported, testable
 *           function over snapshot-derived data), 137-CONTEXT.md D-21/D-26,
 *           137-RESEARCH.md Web-Gegenprüfung Frage 1, 138-CONTEXT.md D-02/D-03/D-10
 */

import type { CatalogExercise } from '../types.js';
import { weightFor } from './muscle-balance.js';
import { weightFor as weightForCapability } from './capability-balance.js';

// ---------------------------------------------------------------------------
// Vector construction
// ---------------------------------------------------------------------------

/** One exercise's contribution to a muscle-content vector: how many sets of it. */
export interface MuscleHit {
  exerciseId: string;
  setCount: number;
}

/**
 * Builds a per-muscle-key WEIGHTED count vector from a list of exercise hits, resolved
 * through the catalog. An exercise not present in the catalog contributes nothing and
 * raises no error (mirrors `AnalyticsDao.getMuscleGroupSetsInPeriod`'s INNER JOIN
 * semantics: no catalog match means no rows for that hit).
 *
 * Phase 138 (MUSC-06): each muscle-group hit contributes `hit.setCount *
 * weightFor(muscleGroup.involvementLevel)` rather than the flat `hit.setCount` used
 * through Phase 137 — a PRIMARY hit counts in full, SECONDARY at half, STABILIZER at a
 * quarter (D-01/D-02). An uncurated link (missing involvementLevel) resolves to the
 * PRIMARY weight via `weightFor`, so a fully-PRIMARY catalog reproduces the pre-138
 * unweighted vectors exactly (D-03).
 */
export function buildMuscleVector(
  hits: MuscleHit[],
  catalogById: Map<string, CatalogExercise>,
): Map<string, number> {
  const vector = new Map<string, number>();
  for (const hit of hits) {
    const exercise = catalogById.get(hit.exerciseId);
    if (exercise === undefined) continue;
    for (const muscleGroup of exercise.muscleGroups) {
      vector.set(
        muscleGroup.key,
        (vector.get(muscleGroup.key) ?? 0) + hit.setCount * weightFor(muscleGroup.involvementLevel),
      );
    }
  }
  return vector;
}

/**
 * A fixed key prefix for every capability-axis dimension added by `buildCombinedVector`.
 * Guarantees no collision with a muscle-group key regardless of catalog content — the 18
 * canonical muscle keys and the seven capability-axis keys happen not to overlap today, but
 * this prefix makes that a structural guarantee, not an accident of the current vocabulary.
 */
const CAPABILITY_VECTOR_KEY_PREFIX = 'capability:';

/**
 * D-17 (Phase 138.1, plan `138.1-22`) — a SECOND vector construction alongside
 * `buildMuscleVector`, never a second similarity implementation (`ruzickaSimilarity` and
 * `classifySimilarity` below are unchanged and apply to either vector identically). Builds
 * the same muscle part `buildMuscleVector` does, then additionally folds in each hit
 * exercise's capability axes as extra dimensions, keyed with `CAPABILITY_VECTOR_KEY_PREFIX`
 * so they can never collide with a muscle-group key.
 *
 * The capability weighting comes from `weightFor` in `./capability-balance.js` — the SAME
 * stage→factor mapping `get_stats({ by: 'capabilities' })` uses — imported, never
 * re-derived. A session whose exercises carry no capability assignment at all produces a
 * vector byte-identical to `buildMuscleVector`'s (additive extension, no behavior change
 * for the pre-existing case).
 *
 * `docs/research/CAPABILITY-INVOLVEMENT.md`'s D-04 rule means a capability axis with no curated
 * entry for an exercise contributes NOTHING for that axis (unlike a muscle-group link,
 * which resolves an absent level to PRIMARY) — there is no silent default to fall back to,
 * mirrored here by simply not iterating an axis the exercise's `capabilities` array does
 * not list.
 *
 * This is also how the pure-Breathhold finding from `138.1-15` resolves: an exercise with
 * NO muscle groups but a capability axis produces an EMPTY vector under `buildMuscleVector`
 * (two such sessions score `ruzickaSimilarity` `0`, "none", even though they are literally
 * identical), but a NON-empty vector here — the capability dimension carries the content
 * the muscle vector cannot see, so two identical such sessions score `1`, correctly.
 *
 * D-17's own empirical question — whether these capability dimensions actually belong in
 * the PRODUCTION similarity vector, decided from real data rather than assumed — is answered
 * in `.planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md`: the
 * capability axes measurably widen the gap between matching and non-matching sessions, so
 * `adherence.ts` calls this function (not `buildMuscleVector`) in production, and
 * `ruzicka-threshold.ts`'s injectable `vectorBuilder` defaults to this function too. If a
 * future re-run of that derivation ever finds the opposite, this function stays in the code
 * regardless (per the plan's own rule) — only the production call sites and the derivation
 * tool's default would move back.
 */
export function buildCombinedVector(
  hits: MuscleHit[],
  catalogById: Map<string, CatalogExercise>,
): Map<string, number> {
  const vector = buildMuscleVector(hits, catalogById);
  for (const hit of hits) {
    const exercise = catalogById.get(hit.exerciseId);
    if (exercise === undefined) continue;
    for (const axis of exercise.capabilities) {
      const key = `${CAPABILITY_VECTOR_KEY_PREFIX}${axis.key}`;
      vector.set(key, (vector.get(key) ?? 0) + hit.setCount * weightForCapability(axis.capabilityLevel));
    }
  }
  return vector;
}

// ---------------------------------------------------------------------------
// Ruzicka similarity (D-21) — Σmin(Pᵢ,Qᵢ) / Σmax(Pᵢ,Qᵢ)
// ---------------------------------------------------------------------------

/**
 * Ruzicka similarity between two non-negative count vectors, over the UNION of their
 * keys. Returns 0 (never NaN) when both vectors are empty — Σmax is 0 in that case,
 * which would otherwise be a division by zero.
 *
 * Deliberately no vector norm, no dot product, no square root anywhere in this
 * function — that would be the direction-based (cosine) measure D-21 explicitly
 * rejects for this magnitude-sensitive comparison.
 */
export function ruzickaSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  let sumMin = 0;
  let sumMax = 0;
  for (const key of keys) {
    const av = a.get(key) ?? 0;
    const bv = b.get(key) ?? 0;
    sumMin += Math.min(av, bv);
    sumMax += Math.max(av, bv);
  }
  if (sumMax === 0) return 0;
  return sumMin / sumMax;
}

// ---------------------------------------------------------------------------
// Classification — thresholds are PARAMETERS, never module constants (D-23)
// ---------------------------------------------------------------------------

/** Three-value verdict: a certain match, a borderline candidate, or no candidate. */
export type SimilarityVerdict = 'matched' | 'uncertain' | 'none';

/**
 * Classifies a Ruzicka similarity value against two caller-supplied thresholds — the
 * coach's own tunable `matchThreshold`/`uncertainThreshold` parameters (D-23), never
 * module-level constants, so calibrating them at runtime never requires a code change.
 * Both boundaries are inclusive: `similarity === matchThreshold` is `'matched'`, and
 * `similarity === uncertainThreshold` is `'uncertain'`.
 */
export function classifySimilarity(
  similarity: number,
  matchThreshold: number,
  uncertainThreshold: number,
): SimilarityVerdict {
  if (similarity >= matchThreshold) return 'matched';
  if (similarity >= uncertainThreshold) return 'uncertain';
  return 'none';
}
