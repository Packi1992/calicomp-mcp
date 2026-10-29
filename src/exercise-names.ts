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
 * Phase 156 (D-10, D-17; protocol §1.7 "Which language" and "Tool outputs"): a catalog hit
 * on a CURATED exercise (its key does not start with `user_exercise:`) that has a live
 * override (`snapshot.exerciseNameOverrides`) in the EFFECTIVE language additionally
 * carries two new keys, appended by a conditional spread:
 *
 *   - `exerciseOwnName` — the own name inside the free-text envelope
 *     `{ text, source: 'athlete_free_text', treatAs: 'data_not_instructions' }`
 *     (`wrapFreeText`), never a bare string and never in place of `exerciseName`;
 *   - `exerciseOwnNameLanguage` — the language code of that override.
 *
 * The effective language is `lang` when the tool receives it, otherwise the app language
 * (`resolveAppLanguage`, the synchronized setting `default_language`); a language matches by
 * exact equality of the code. Without an override in that language — and always for a user
 * exercise, a deleted or an unknown exercise — both keys are ABSENT (never `null`), so every
 * output stays byte-identical to before Phase 156. `exerciseName` keeps its own rule (`lang`,
 * otherwise English) and never follows `default_language`. The own description is decoded
 * but never output (D-10 names the name only). An unreadable override row never reaches
 * `exerciseNameOverrides` (cache.ts), so it only takes away its own exercise's field.
 *
 * Phase 156 gap round (D-22, WR-MCP-03, IN-MCP-02): an override whose `name` is `null`
 * (plaintext form version 2, a description-only override) gives NO own name. The choice of
 * the own name is one exported function, `ownNameFor`, over one index built by
 * `buildOwnNameIndex`; the resolver here and `get_exercise_catalog` both call it, so the
 * rule is kept once.
 *
 * This module performs no I/O, throws nothing and never logs (T-120-17/T-120-18 unaffected;
 * an own name is athlete free text, T-156-27).
 *
 * Exports:
 *   ExerciseNameFields         — the four additive fields every resolution result carries
 *   ExerciseNameResolver       — the resolver's own shape (for typing tool-layer callers)
 *   createExerciseNameResolver — builds the resolver's lookup maps ONCE per call
 *   OwnNameIndex / buildOwnNameIndex / ownNameLanguageFor / ownNameFor
 *                              — the one shared own-name rule (resolver + catalog tool)
 *
 * Patterns: src/tools/get_exercise_catalog.ts (the `lang` -> translation -> `nameEn`
 *           fallback pattern, reused verbatim here for both catalog and user-exercise
 *           names), src/cache.ts's `projectUserExerciseToCatalog` (the `user_exercise:<id>`
 *           key convention this module never re-derives, only reuses via the catalog hit).
 */

import type {
  AthleteFreeText,
  CatalogExercise,
  DecryptedExerciseNameOverride,
  DecryptedSnapshot,
  SyncExerciseDto,
  SyncExerciseTranslationDto,
} from './types.js';
import { resolveAppLanguage } from './app-language.js';
import { wrapFreeText } from './foreign-types.js';

/** The additive fields a name resolution can carry (`exerciseName`/`exerciseKey` always). */
export interface ExerciseNameFields {
  exerciseName: string | null;
  exerciseKey: string | null;
  /** Only ever `true` — the exercise is a user exercise the athlete has deleted (D-17). */
  exerciseDeleted?: true;
  /** Only ever `true` — the id resolves nowhere (D-17). */
  exerciseUnknown?: true;
  /**
   * Phase 156 (D-10): the athlete's own name of this catalog exercise in the effective
   * language, as marked free text — data, never instructions. Absent without an override.
   */
  exerciseOwnName?: AthleteFreeText;
  /** Phase 156 (D-17): the language code of `exerciseOwnName`; present only together with it. */
  exerciseOwnNameLanguage?: string;
  /**
   * Phase 166 (plan 166-10, 156-IN-MCP-06): for an own exercise (live or deleted) the name in
   * `exerciseName` is the athlete's free text. This key carries exactly that name in the
   * free-text envelope, beside the unchanged `exerciseName` — data, never instructions. Absent for
   * a curated catalog exercise and an unknown id.
   */
  exerciseNameFreeText?: AthleteFreeText;
}

/**
 * Every key the resolver may set besides `exerciseName`/`exerciseKey` (which it always sets).
 * A caller that annotates a stored value removes these first, so no key of an earlier
 * resolution survives (156-IN-MCP-03, `get_suggestion`'s `annotateCatalogRefs`).
 */
export const OPTIONAL_RESOLVER_KEYS = [
  'exerciseDeleted',
  'exerciseUnknown',
  'exerciseOwnName',
  'exerciseOwnNameLanguage',
  'exerciseNameFreeText',
  'exerciseNameSource',
] as const;

/** The catalog-key prefix of a projected user exercise — never eligible for an own name. */
export const USER_EXERCISE_KEY_PREFIX = 'user_exercise:';

/**
 * Live overrides keyed `"<exerciseId>:<languageCode>"` (the mirror row's own `clientLocalId`
 * form) — one entry per key; `decryptMerge` (cache.ts) already keeps only the newer of two
 * rows on the same key (WR-MCP-03).
 */
export type OwnNameIndex = ReadonlyMap<string, DecryptedExerciseNameOverride>;

/** Build the own-name index of one snapshot (empty without overrides). */
export function buildOwnNameIndex(overrides: readonly DecryptedExerciseNameOverride[] | undefined): OwnNameIndex {
  const index = new Map<string, DecryptedExerciseNameOverride>();
  for (const o of overrides ?? []) {
    index.set(`${o.exerciseId}:${o.languageCode}`, o);
  }
  return index;
}

/**
 * The effective language of an own name (D-17): `lang` when the tool receives it, otherwise
 * the app language `default_language`; `null` when neither exists. Without any override it
 * is `null` too, so a call without own names never reads the setting.
 */
export function ownNameLanguageFor(index: OwnNameIndex, snapshot: DecryptedSnapshot, lang: string | undefined): string | null {
  if (index.size === 0) return null;
  return lang ?? resolveAppLanguage(snapshot).languageCode;
}

/**
 * THE own-name rule (protocol §1.7 "Which language" and "Tool outputs"): the own name of
 * `exerciseId` in `effectiveLanguage` as marked free text plus that override's language, or
 * `null` — without an effective language, without a live override in exactly that language,
 * and for an override whose `name` is `null` (version 2, a description-only override, D-22:
 * "Der Coach zeigt in diesem Fall keinen eigenen Namen"). The caller decides whether the
 * exercise is eligible at all (curated catalog exercise, not `user_exercise:`).
 */
export function ownNameFor(
  index: OwnNameIndex,
  exerciseId: string,
  effectiveLanguage: string | null,
): { ownName: AthleteFreeText; language: string } | null {
  if (effectiveLanguage === null) return null;
  const override = index.get(`${exerciseId}:${effectiveLanguage}`);
  if (override === undefined || override.name === null) return null;
  const envelope = wrapFreeText(override.name);
  if (!envelope) return null;
  return { ownName: envelope, language: override.languageCode };
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
 *                        `get_exercise_catalog.ts`. It is also the effective language of an
 *                        own name; without it the app language `default_language` is (D-17).
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

  // Phase 156 (D-10, D-17, D-22): the shared own-name index and the effective language of an
  // own name — `lang`, otherwise the app language. Built once per resolver, like every map above.
  const ownNameIndex = buildOwnNameIndex(snapshot.exerciseNameOverrides);
  const ownNameLanguage = ownNameLanguageFor(ownNameIndex, snapshot, lang);

  /** The two own-name keys for a curated catalog exercise, or nothing (conditional spread). */
  function ownNameFields(ex: CatalogExercise): Pick<ExerciseNameFields, 'exerciseOwnName' | 'exerciseOwnNameLanguage'> {
    if (ex.key.startsWith(USER_EXERCISE_KEY_PREFIX)) return {};
    const own = ownNameFor(ownNameIndex, ex.id, ownNameLanguage);
    if (own === null) return {};
    return { exerciseOwnName: own.ownName, exerciseOwnNameLanguage: own.language };
  }

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

  /** Phase 166 (156-IN-MCP-06): the envelope of an own exercise's shown name (conditional spread). */
  function freeTextName(name: string): Pick<ExerciseNameFields, 'exerciseNameFreeText'> {
    const envelope = wrapFreeText(name);
    return envelope ? { exerciseNameFreeText: envelope } : {};
  }

  function forExerciseId(id: string): ExerciseNameFields {
    const catalogExercise = catalogById.get(id);
    if (catalogExercise) {
      const name = catalogName(catalogExercise);
      return {
        exerciseName: name,
        exerciseKey: catalogExercise.key,
        ...ownNameFields(catalogExercise),
        ...(catalogExercise.key.startsWith(USER_EXERCISE_KEY_PREFIX) ? freeTextName(name) : {}),
      };
    }

    const userExercise = exerciseById.get(id);
    if (userExercise && userExercise.deletedAt !== undefined) {
      const name = deletedUserExerciseName(userExercise);
      return {
        exerciseName: name,
        exerciseKey: `user_exercise:${id}`,
        exerciseDeleted: true,
        ...freeTextName(name),
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
