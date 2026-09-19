/**
 * Catalog-exercise name-dedupe helpers (D-04).
 *
 * `normalizeExerciseName` is an exact TypeScript port of the app's existing
 * `ExerciseNameNormalizer.kt` (TrainCounter/.../data/util/ExerciseNameNormalizer.kt),
 * used by `DuplicateDetector.kt` for the local-exercise-vs-predefined-exercise merge
 * feature (Phase 87). Porting the exact semantics keeps "what counts as a duplicate"
 * consistent app-wide instead of inventing a second, subtly-different algorithm here.
 *
 * Kotlin reference algorithm (verified, read directly):
 *   trim() -> lowercase(Locale.ROOT) -> collapse whitespace runs -> NFD normalize ->
 *   strip characters of Unicode category Mn (non-spacing marks / accents).
 *
 * `findCatalogMatch` mirrors `DuplicateDetector.kt`'s match scope: compares the
 * normalized proposed name against BOTH `nameEn` AND every translation name, so a
 * German proposal can match an English-cataloged exercise carrying a German translation.
 *
 * 141-18 (G-141-2-SCOPE): since `data.catalog` now also carries every user's own exercises
 * (origin: 'CUSTOM', projected in from `snapshot.exercises`), the match is scoped to
 * `origin: 'CATALOG'` entries only. A proposal for a new CATALOG exercise must never fail
 * because some user once created a same-named exercise for themselves — that would be a
 * block from someone else's data, and the propose path is exactly the path such an exercise
 * would take INTO the catalog (T-141-81).
 *
 * Pure functions only — no fetch, no `console.*` (T-121-04). Used by the propose-only
 * WRITE tools (Plans 03/04) to resolve a proposed exercise name to an existing catalog
 * UUID instead of creating a duplicate (T-121-02: callers reference matches by `.id` only).
 *
 * Source: RESEARCH.md Pattern 6.
 */

import type { CatalogExercise } from './types.js';

/**
 * Normalize an exercise name for duplicate comparison.
 *
 * Exact port of ExerciseNameNormalizer.kt:
 *   1. trim()
 *   2. lowercase using a fixed locale ('en-US' — analogous to Kotlin's Locale.ROOT,
 *      avoids locale-dependent edge cases like the Turkish dotless-I)
 *   3. collapse whitespace runs to a single space
 *   4. NFD (canonical decomposition) normalize
 *   5. strip Unicode category Mn (non-spacing marks) — folds accents/diacritics
 */
export function normalizeExerciseName(name: string): string {
  const trimmed = name.trim();
  const lowered = trimmed.toLocaleLowerCase('en-US');
  const collapsed = lowered.replace(/\s+/g, ' ');
  const nfd = collapsed.normalize('NFD');
  return nfd.replace(/\p{Mn}/gu, '');
}

/**
 * Find a catalog exercise whose English name or any translation name normalizes
 * equal to the proposed name.
 *
 * Returns `undefined` for an empty/whitespace-only proposed name (no meaningful key
 * to match against) and for no match found.
 *
 * @param proposedName  The LLM-proposed exercise name (any language).
 * @param catalog       The full cached exercise catalog.
 */
export function findCatalogMatch(
  proposedName: string,
  catalog: CatalogExercise[],
): CatalogExercise | undefined {
  const key = normalizeExerciseName(proposedName);
  if (!key) return undefined;
  return catalog.find(
    (ex) =>
      ex.origin === 'CATALOG' &&
      (normalizeExerciseName(ex.nameEn) === key ||
        ex.translations.some((t) => normalizeExerciseName(t.name) === key)),
  );
}
