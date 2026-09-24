/**
 * Exercise name resolution — Phase 150, D-14/D-15/D-16/D-17/D-35.
 *
 * A single resolver used by every tool that names an `exerciseId`: `get_template`,
 * `get_history`, `get_progress` and `get_training_state` (this plan, 150-05); `get_stats`,
 * `get_suggestion(s)` follow in 150-06. Resolution order (D-15/D-17), never invented:
 *
 *   1. The merged catalog (`data.catalog` — curated exercises AND live, uncollided user
 *      exercises, both already projected by `cache.ts`'s `projectUserExerciseToCatalog`
 *      into `key: "user_exercise:<id>"`, D-15). A hit here returns the catalog name
 *      (translated for `lang`, English fallback, same rule as `get_exercise_catalog.ts`)
 *      and `key`.
 *   2. `snapshot.exercises` with `deletedAt` set — a user exercise the athlete deleted.
 *      Its name is never lost: this branch returns it (translated the same way, from
 *      `snapshot.exerciseTranslations`), the same `user_exercise:<id>` key, and
 *      `exerciseDeleted: true`.
 *   3. Neither — `exerciseName`/`exerciseKey` are both `null` and `exerciseUnknown: true`.
 *      This also covers an id the server's tombstone GC removed entirely (150-CONTEXT.md's
 *      flagged assumption): its name is then genuinely unrecoverable.
 *
 * `forSetLog` (D-16) additionally resolves a set-log that carries no `exerciseId` at all
 * (a format-runtime row) through `workoutExerciseId` -> `snapshot.templateExercises`
 * (including tombstones — the exercise identity of a since-removed template exercise is
 * still real) -> the same three-step resolution above, tagged with
 * `exerciseNameSource: 'workoutExerciseId'` so a caller can tell "named via the row's own
 * exerciseId" apart from "named via its workoutExerciseId". A set-log with neither field,
 * or whose `workoutExerciseId` no longer resolves to any template exercise (tombstoned or
 * not), yields the same null/`exerciseUnknown` shape as an unresolvable id.
 *
 * This module performs no I/O and throws nothing (T-120-17/T-120-18 unaffected).
 *
 * Exports:
 *   ExerciseNameFields         — the four additive fields every resolution result carries
 *   ExerciseNameResolver       — the resolver's own shape (for typing tool-layer callers)
 *   createExerciseNameResolver — builds the resolver's lookup maps ONCE per call
 *
 * Patterns: src/tools/get_exercise_catalog.ts (the `lang` -> translation -> `nameEn`
 *           fallback pattern, reused verbatim here for both catalog and user-exercise
 *           names), src/cache.ts's `projectUserExerciseToCatalog` (the `user_exercise:<id>`
 *           key convention this module never re-derives, only reuses via the catalog hit).
 */

import type {
  CatalogExercise,
  DecryptedSnapshot,
  SyncExerciseDto,
  SyncExerciseTranslationDto,
} from './types.js';

/** The four additive fields a name resolution can carry, always added together. */
export interface ExerciseNameFields {
  exerciseName: string | null;
  exerciseKey: string | null;
  /** Only ever `true` — the exercise is a user exercise the athlete has deleted (D-17). */
  exerciseDeleted?: true;
  /** Only ever `true` — the id resolves nowhere (D-17). */
  exerciseUnknown?: true;
}

/** `forSetLog`'s result additionally tags HOW the exercise identity was found. */
export type SetLogExerciseNameFields = ExerciseNameFields & {
  /** Present only when the set-log carried no `exerciseId` of its own (D-16). */
  exerciseNameSource?: 'workoutExerciseId';
};

/** The resolver's public shape — one resolver built once per tool call (D-15). */
export interface ExerciseNameResolver {
  forExerciseId(id: string): ExerciseNameFields;
  forSetLog(setLog: { exerciseId?: string; workoutExerciseId?: string }): SetLogExerciseNameFields;
}

/**
 * Builds a name resolver over one merged catalog + snapshot + optional language. Every
 * lookup map is built exactly once here, not per `forExerciseId`/`forSetLog` call.
 *
 * @param input.catalog  The merged catalog (`data.catalog` — curated + live user exercises).
 * @param input.snapshot The decrypted snapshot — `exercises`/`exerciseTranslations` carry a
 *                        deleted user exercise's name even after it drops out of the catalog;
 *                        `templateExercises` (including tombstones) resolves `forSetLog`.
 * @param input.lang     Optional BCP-47-ish tag (same bound as `GetExerciseCatalogSchema`);
 *                        omitted or unmatched falls back to English, exactly like
 *                        `get_exercise_catalog.ts`.
 */
export function createExerciseNameResolver(input: {
  catalog: CatalogExercise[];
  snapshot: DecryptedSnapshot;
  lang?: string;
}): ExerciseNameResolver {
  const { catalog, snapshot, lang } = input;

  const catalogById = new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
  const exerciseById = new Map<string, SyncExerciseDto>(snapshot.exercises.map((ex) => [ex.id, ex]));
  const translationsByExerciseId = new Map<string, SyncExerciseTranslationDto[]>();
  for (const t of snapshot.exerciseTranslations) {
    const bucket = translationsByExerciseId.get(t.exerciseId);
    if (bucket) bucket.push(t);
    else translationsByExerciseId.set(t.exerciseId, [t]);
  }
  // Includes tombstoned template exercises on purpose (D-16) — a since-removed template
  // exercise's own exerciseId is still a real fact worth resolving.
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));

  /** `get_exercise_catalog.ts`'s exact `lang` -> translation -> `nameEn` fallback rule. */
  function catalogName(ex: CatalogExercise): string {
    if (!lang) return ex.nameEn;
    const translation = ex.translations.find((t) => t.languageCode === lang);
    return translation ? translation.name : ex.nameEn;
  }

  /** Same fallback rule, over a deleted user exercise's own translations (D-14/D-17). */
  function deletedUserExerciseName(ex: SyncExerciseDto): string {
    if (!lang) return ex.name;
    const translations = translationsByExerciseId.get(ex.id) ?? [];
    const translation = translations.find((t) => t.languageCode === lang);
    return translation ? translation.name : ex.name;
  }

  function forExerciseId(id: string): ExerciseNameFields {
    const catalogExercise = catalogById.get(id);
    if (catalogExercise) {
      return { exerciseName: catalogName(catalogExercise), exerciseKey: catalogExercise.key };
    }

    const userExercise = exerciseById.get(id);
    if (userExercise && userExercise.deletedAt !== undefined) {
      return {
        exerciseName: deletedUserExerciseName(userExercise),
        exerciseKey: `user_exercise:${id}`,
        exerciseDeleted: true,
      };
    }

    return { exerciseName: null, exerciseKey: null, exerciseUnknown: true };
  }

  function forSetLog(setLog: { exerciseId?: string; workoutExerciseId?: string }): SetLogExerciseNameFields {
    if (setLog.exerciseId !== undefined) {
      return forExerciseId(setLog.exerciseId);
    }

    if (setLog.workoutExerciseId !== undefined) {
      const templateExercise = templateExerciseById.get(setLog.workoutExerciseId);
      if (templateExercise) {
        return { ...forExerciseId(templateExercise.exerciseId), exerciseNameSource: 'workoutExerciseId' };
      }
    }

    return { exerciseName: null, exerciseKey: null, exerciseUnknown: true };
  }

  return { forExerciseId, forSetLog };
}
