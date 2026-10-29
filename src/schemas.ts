/**
 * Shared Zod input schemas for the 6 CalisthenicsCompanion-MCP tools.
 *
 * Security boundary: All LLM-supplied tool arguments are untrusted. Every schema is strict
 * Zod — rejects malformed UUIDs, bad ISO dates, out-of-range limits, unknown muscle keys,
 * and inverted date ranges before any data access occurs (T-120-10, T-120-11).
 *
 * Muscle enum source: MuscleGroupSeed.kt lines 29–48 (18 canonical keys, verbatim).
 * Schema patterns: RESEARCH.md §Tool Input Schemas + §Zod Muscle Enum.
 */

import { z } from 'zod';
import { CoachParametersSchema } from './coach-parameters.js';
import { SESSION_KINDS } from './session-kind.js';
import { isBlankOverrideText } from './row-decode.js';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** ISO 8601 calendar date string — YYYY-MM-DD format only. */
export const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

/** RFC 4122 UUID string. */
export const UUID_STRING = z.string().uuid();

/**
 * Shared BCP-47-ish language tag bound (Phase 150, D-14) — the same 2-5 character bound
 * `GetExerciseCatalogSchema` already used before this constant existed. Reused by every
 * schema that accepts an optional `lang` for exercise-name localization
 * (`GetTemplateSchema`, `GetHistorySchema`, the `exercise` branch of `GetProgressSchema`,
 * `GetTrainingStateSchema`) so the bound cannot drift between them.
 */
export const LANG = z.string().min(2).max(5);

// ---------------------------------------------------------------------------
// Muscle group enum (18 canonical keys — sourced from MuscleGroupSeed.kt lines 29–48)
// [VERIFIED: TrainCounter/.../data/local/seed/MuscleGroupSeed.kt]
// DO NOT add or remove values without updating MuscleGroupSeed.kt in lockstep.
// ---------------------------------------------------------------------------

export const MUSCLE_KEY = z.enum([
  'chest',
  'back',
  'lats',
  'shoulders',
  'traps',
  'biceps',
  'triceps',
  'forearms',
  'abs',
  'obliques',
  'lower_back',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'hip_flexors',
  'adductors',
  'neck',
] as const);

export type MuscleKey = z.infer<typeof MUSCLE_KEY>;

// ---------------------------------------------------------------------------
// Per-tool input schemas
// ---------------------------------------------------------------------------

/** get_profile — no input, returns profile data. */
export const GetProfileSchema = z.object({});

/** list_templates — no input, returns all non-deleted templates. */
export const ListTemplatesSchema = z.object({});

/**
 * get_template — one template by ID with its blocks and templateExercises.
 *
 * `lang` (Phase 150, D-14) optionally localizes every template exercise's `exerciseName` —
 * same fallback rule as `GetExerciseCatalogSchema`: no translation for the requested
 * language falls back to English, never an error.
 */
export const GetTemplateSchema = z.object({
  templateId: UUID_STRING,
  lang: LANG.optional(),
});

/**
 * OUTPUT_FILE_FLAG (D-15, protocol v1.15 §1.5) — the reusable local-file-channel
 * switch for any detail/raw-data tool. This is a SWITCH, never a path: the
 * export location is always built process-side (`src/file-channel.ts`), so a
 * caller can never influence where a file is written (T-137-06). A string,
 * enum, or any other shape here would reopen the path-traversal question this
 * boolean-only design closes.
 */
export const OUTPUT_FILE_FLAG = z.boolean().optional();

/**
 * get_history — D-03: date range + optional exercise filter + limit.
 *
 * Constraints:
 *   - `from` and `to` are YYYY-MM-DD (ISO calendar dates)
 *   - `to` must be >= `from` (T-120-10 input validation)
 *   - `limit` bounds response size (T-120-11 DoS mitigation): 1..500, default 200
 *   - `exercise` is an optional UUID to filter by a specific exercise
 *   - `templateId` (Phase 150, D-04) optionally restricts to sessions belonging to one
 *     template — matched directly against `session.templateId`; an unknown `templateId`
 *     is never rejected, it simply matches nothing.
 *   - `sessionKind` (Phase 150, D-01/D-04/D-37) optionally restricts to one of the three
 *     session kinds (`'template' | 'templateless' | 'quick_challenge'`, see
 *     `session-kind.ts`). Named `sessionKind`, never `kind` — `get_progress` already uses
 *     `kind` as its own top-level discriminator (D-37).
 *   - `templateId`, `sessionKind` and `exercise` all AND-combine, applied before `limit`.
 *   - `outputFile` (D-15) writes the full result to a local file instead of
 *     returning it inline; see `OUTPUT_FILE_FLAG`. D-17 leaves every bound
 *     above untouched — `get_history` is not throttled, only re-framed as a
 *     targeted detail lookup (see the tool's registered description).
 *   - `lang` (Phase 150, D-14) optionally localizes each set-log's `exerciseName`.
 */
export const GetHistorySchema = z
  .object({
    from: ISO_DATE,
    to: ISO_DATE,
    exercise: UUID_STRING.optional(),
    templateId: UUID_STRING.optional(),
    sessionKind: z.enum(SESSION_KINDS).optional(),
    limit: z.number().int().min(1).max(500).optional().default(200),
    outputFile: OUTPUT_FILE_FLAG,
    lang: LANG.optional(),
  })
  .refine((d) => d.from <= d.to, { message: '`to` must be >= `from`' });

/**
 * get_planned_workouts — D-01/D-02: `from`/`to` are BOTH mandatory (no default window,
 * no notion of "today" — the MCP cannot know the athlete's calendar day until
 * `timeZoneId` arrives in Phase 137), and the requested span is capped at 366 days
 * (T-135-01 DoS mitigation, same stance as GetHistorySchema's `limit`/T-120-11). No
 * `limit`, no `exercise` filter — this tool returns the whole calendar for the window.
 */
export const GetPlannedWorkoutsSchema = z
  .object({
    from: ISO_DATE,
    to: ISO_DATE,
  })
  .refine((d) => d.from <= d.to, { message: '`to` must be >= `from`' })
  .refine(
    (d) => (new Date(d.to).getTime() - new Date(d.from).getTime()) / 86_400_000 <= 366,
    { message: '`to` - `from` must be at most 366 days' },
  );

/**
 * get_adherence (Phase 137, STATE-03, D-05/D-06/D-13/D-19/D-21) — plan adherence over
 * a caller-chosen window with a caller-chosen tolerance. Every field is optional:
 *
 *   - `from`/`to`: when BOTH are given, they win outright. When either is absent, the
 *     adherence calculator computes its own window ending on the athlete's current
 *     calendar day — D-27 a explicitly declined to add a horizon field to
 *     `get_planned_workouts` for this; that tool keeps expanding whatever window it is
 *     given, and the window-sizing question lives here instead, one call away.
 *   - `toleranceDays` overrides the coach's persisted tolerance parameter for this one
 *     call ONLY, without saving it (0..7, same range as the persisted parameter).
 *   - `windowWeeks` overrides the coach's persisted adherence-window parameter for
 *     this one call ONLY, without saving it (1..52, same range as the persisted
 *     parameter) — the window-sizing twin of `toleranceDays`.
 *   - `outputFile` (D-15) writes the full matches/missed lists to a local file instead
 *     of returning them inline; see `OUTPUT_FILE_FLAG`.
 *
 * `windowWeeks` together with a COMPLETE `from`/`to` pair is rejected at this Zod
 * boundary (a third `refine`), rather than one silently overriding the other — two
 * contradictory window specs in a single call is exactly the ambiguity class D-05
 * rules out for an adherence number.
 */
export const GetAdherenceSchema = z
  .object({
    from: ISO_DATE.optional(),
    to: ISO_DATE.optional(),
    toleranceDays: z.number().int().min(0).max(7).optional(),
    windowWeeks: z.number().int().min(1).max(52).optional(),
    outputFile: OUTPUT_FILE_FLAG,
  })
  .refine((d) => d.from === undefined || d.to === undefined || d.from <= d.to, {
    message: '`to` must be >= `from`',
  })
  .refine(
    (d) =>
      d.from === undefined ||
      d.to === undefined ||
      (new Date(d.to).getTime() - new Date(d.from).getTime()) / 86_400_000 <= 366,
    { message: '`to` - `from` must be at most 366 days' },
  )
  .refine((d) => !(d.windowWeeks !== undefined && d.from !== undefined && d.to !== undefined), {
    message: '`windowWeeks` cannot be combined with a complete `from`/`to` pair',
  });

/**
 * get_stats — D-04: discriminated union by exercise, muscle group, or capability axis.
 *
 * `{ by: 'exercise', exerciseId: UUID }` — aggregates for a single exercise.
 * `{ by: 'muscle', muscle: MuscleKey }` — aggregates across all exercises in that muscle group.
 * `{ by: 'capabilities' }` (Phase 138.1, CAP-05, D-14) — breaks down over ALL capability
 * axes at once, with no further argument. This is a deliberate asymmetry with the
 * `muscle` branch, not an oversight: `muscle` requires a concrete argument and is
 * therefore not really a "breakdown" — the caller must already know which muscle group
 * to ask about. D-14 requires the capability axes to be surfaced without that prior
 * knowledge, so the coach can see whether balance/mobility/etc. occurred at all across
 * the training history, not just how much of one axis it already knew to ask for. The
 * branch is `.strict()` — it carries no further fields other than the shared optional
 * `lang` (Phase 150, D-14/D-35) added below; an unknown extra field (e.g. a caller
 * mistakenly passing a single `axis` filter) is rejected here rather than silently
 * ignored. `lang` localizes every name the tool layer additively attaches — see
 * `get_stats.ts`'s `withExerciseNames` — identically across all three branches.
 */
export const GetStatsSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('exercise'), exerciseId: UUID_STRING, lang: LANG.optional() }),
  z.object({ by: z.literal('muscle'), muscle: MUSCLE_KEY, lang: LANG.optional() }),
  z.object({ by: z.literal('capabilities'), lang: LANG.optional() }).strict(),
]);

/**
 * get_progress (Phase 137, STATE-05, D-11/D-12/D-13/D-22/D-25/D-27 c) — discriminated
 * union by `kind`, following the exact precedent `GetStatsSchema` sets above (`by:
 * 'exercise' | 'muscle'`). D-22 merges what would have been two separate tools
 * (`get_exercise_progress`/`get_format_progress`) into this ONE tool with a discriminator,
 * so an agent picking the wrong argument for a branch (an `exerciseId` under `kind:
 * 'format'`) is rejected at this Zod boundary rather than silently ignored.
 *
 * `points` (D-13: depth is an argument, never a second tool) overrides the coach's
 * `exerciseTrendPoints` parameter for this one call only, bounded 3..30 like the
 * parameter's own range. `outputFile` (D-15) writes the full point series to a local file
 * instead of returning it inline; see `OUTPUT_FILE_FLAG`. Neither branch requires its own
 * id — omitting `exerciseId`/`templateId` selects the "all" view (D-27 c: a call with no
 * matching data returns a structurally empty result, never an error).
 *
 * Phase 150, D-06: under `kind: 'exercise'`, `templateId` and `sessionKind` no longer mean
 * "select a series" (that is what `kind: 'format'`'s own `templateId` does) — they FILTER
 * which sessions' points feed the returned exercise series, restricting it to one template
 * and/or one session kind (`session-kind.ts`). This is a deliberate behavior change from
 * this schema's earlier stance of rejecting a `templateId` under `kind: 'exercise'`
 * outright; it fixes a real mixed series (a `pull_up` progress series polluted by
 * QuickChallenge points a template filter could not previously exclude). The branch stays
 * `.strict()` — the same field never means two different things in the same request.
 *
 * `lang` (Phase 150, D-14) optionally localizes each series' `exerciseName` under
 * `kind: 'exercise'` only — `kind: 'format'` names no exercise.
 */
export const GetProgressSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('exercise'),
      exerciseId: UUID_STRING.optional(),
      templateId: UUID_STRING.optional(),
      sessionKind: z.enum(SESSION_KINDS).optional(),
      points: z.number().int().min(3).max(30).optional(),
      outputFile: OUTPUT_FILE_FLAG,
      lang: LANG.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('format'),
      templateId: UUID_STRING.optional(),
      points: z.number().int().min(3).max(30).optional(),
      outputFile: OUTPUT_FILE_FLAG,
    })
    .strict(),
]);

/** get_exercise_catalog — optional language preference (BCP-47 language tag, 2–5 chars). */
export const GetExerciseCatalogSchema = z.object({
  lang: z.string().min(2).max(5).optional(),
});

/**
 * get_training_state — Phase 137 (D-14 TRACER SLICE): the coach's standard overview
 * entry point. Later Phase 137 plans extend this shape additively as further
 * training-state metrics ship (volume, per-exercise progress, adherence) — never
 * replace it with a new discriminant.
 *
 * `lang` (Phase 150, D-14) optionally localizes every `recentExercises`/`personalRecords`
 * `exerciseName` — the narrative sentence itself is never affected by `lang` (D-03).
 */
export const GetTrainingStateSchema = z.object({
  lang: LANG.optional(),
});

// ---------------------------------------------------------------------------
// WRITE-tool input schemas (D-05) — propose_plan_update / propose_new_plan /
// propose_new_exercise. Strict Zod boundary: every LLM-supplied op-list/exercise
// definition is validated here BEFORE any hashing or network I/O.
//
// Array/string bounds (T-121-03 DoS mitigation): ops max 50, newExercises/blocks
// max 20, exercises-per-block max 50, roundTargets max 50, reorder order max 200,
// name max 200, rationale/description max 2000, tempId max 64. Numeric targets are
// non-negative (targetReps/targetTimeSeconds int >= 0, targetWeight >= 0,
// round 1..100) — WR-02.
//
// Discriminated unions (T-121-06 tampering mitigation): ExerciseRefSchema on
// 'source', PlanOpSchema on 'op' — unknown discriminant literals are rejected
// at the validation boundary.
//
// Shapes pinned verbatim in RESEARCH.md Pattern 5 (op vocabulary + inline
// new-exercise) and Pattern 7 (propose_new_plan).
// ---------------------------------------------------------------------------

/** Reference to an exercise: either an existing catalog UUID or a proposal-local temp id. */
export const ExerciseRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('catalog'), exerciseId: UUID_STRING }),
  z.object({ source: z.literal('new'), tempId: z.string().min(1).max(64) }),
]);

/** Per-round target overrides (D-03 Ladder/Pyramid-style round targets). */
export const RoundTargetInputSchema = z.object({
  round: z.number().int().min(1).max(100),
  targetReps: z.number().int().min(0).optional(),
  targetTimeSeconds: z.number().int().min(0).optional(),
  targetWeight: z.number().min(0).optional(),
});

/** Protocol §2.6 "Block ops": `rounds` of `updateBlock` and `addBlock` (assumption A3, 166-RESEARCH.md). */
export const BLOCK_ROUNDS_MIN = 1;
export const BLOCK_ROUNDS_MAX = 100;

/**
 * The shape of one exercise entry inside a `new_plan` proposal — used both for a block's
 * own `exercises[]` (block-local `orderIndex`) and for a top-level `standalone[]` entry
 * (shared top-level `orderIndex` space with `blocks[]`, docs/COACH-PLANNING-PROTOCOL.md §2.6,
 * D-24). Extracted as its own named schema (Phase 150, D-22) so both call sites reference
 * the identical field set instead of two copies drifting apart.
 */
export const NewPlanExerciseInputSchema = z.object({
  exercise: ExerciseRefSchema,
  mode: z.enum(['REPS', 'TIME', 'MAX']),
  targetReps: z.number().int().min(0).optional(),
  targetTimeSeconds: z.number().int().min(0).optional(),
  restTimeSeconds: z.number().int().min(0).describe(
    'Rest after this exercise\'s set(s). A unilateral pair is two consecutive entries: the ' +
      'first carries only the side-switch rest (about 5-10s: 5s for a pure side switch such as ' +
      'side plank or typewriter, up to 10s when regripping or changing equipment such as clean ' +
      'and press), the second the exercise\'s normal rest.',
  ),
  sets: z.number().int().min(1).describe(
    'Number of times this exercise repeats back to back (expandSets). A standalone entry with ' +
      'several sets runs them back to back, so a side pair with 3 sets each runs L, L, L, R, R, R ' +
      '— alternating sides across sets needs a block instead, with rounds equal to the set count.',
  ),
  targetWeight: z.number().min(0).optional(),
  orderIndex: z.number().int().min(0).describe(
    'Position within its own order space: block-local when this entry is inside a block\'s ' +
      'exercises[], or the shared top-level space (together with blocks[]) when this entry sits ' +
      'in standalone[].',
  ),
  roundTargets: z.array(RoundTargetInputSchema).max(50).optional(),
});

/**
 * A single structural change to an existing template, referencing exercises by
 * UUID/tempId only (D-03 op vocabulary).
 */
export const PlanOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addExercise'),
    blockId: UUID_STRING.nullable(),        // null = standalone (top-level) exercise
    exercise: ExerciseRefSchema,
    mode: z.enum(['REPS', 'TIME', 'MAX']),
    // Phase 134 (G-134-12): widened to accept an explicit JSON `null` (not just an
    // omitted key) — the shared formatProposal corpus's `format-params-required-ops-
    // against-circuit` vector encodes "not set" as literal `null` for these four
    // fields, mirroring the Kotlin side's `Int?`/`Double?`/`List<...>? = null`
    // nullable defaults (`PlanOp.AddExercise`, ProposalPayload.kt). `blockId` above
    // already accepted `null`; these four did not until now.
    targetReps: z.number().int().min(0).nullable().optional(),
    targetTimeSeconds: z.number().int().min(0).nullable().optional(),
    restTimeSeconds: z.number().int().min(0).describe(
      'Rest after this exercise\'s set(s). A unilateral pair is two consecutive entries: the ' +
        'first carries only the side-switch rest (about 5-10s), the second the exercise\'s normal ' +
        'rest.',
    ),
    sets: z.number().int().min(1).describe(
      'Number of times this exercise repeats back to back (expandSets). A side pair with several ' +
        'sets each runs L, L, L, R, R, R — alternating sides across sets needs several ops instead.',
    ),
    targetWeight: z.number().min(0).nullable().optional(),
    orderIndex: z.number().int().min(0).describe(
      'Insert position within the level: block-local when blockId is set, or the shared ' +
        'top-level space (blocks plus standalone exercises) when blockId is null. Existing ' +
        'siblings at or after this index move down by one (app 4.4.0 and later); several ' +
        'addExercise ops in one proposal apply one after another.',
    ),
    roundTargets: z.array(RoundTargetInputSchema).max(50).nullable().optional(),
  }),
  z.object({ op: z.literal('removeExercise'), workoutExerciseId: UUID_STRING }),
  z.object({
    op: z.literal('updateSetsReps'),
    workoutExerciseId: UUID_STRING,
    sets: z.number().int().min(1).optional(),
    targetReps: z.number().int().min(0).optional(),
    targetTimeSeconds: z.number().int().min(0).optional(),
    targetWeight: z.number().min(0).optional(),
    restTimeSeconds: z.number().int().min(0).optional(),
    roundTargets: z.array(RoundTargetInputSchema).max(50).optional(),
  }),
  z.object({
    op: z.literal('reorder'),
    blockId: UUID_STRING.nullable(),
    order: z.array(UUID_STRING).min(1).max(200),  // full ordered list of workoutExerciseIds in this block/standalone group
  }),
  // Phase 166 (plan 166-08, MCP-05, D-12): protocol §2.6 "Block ops: updateBlock and addBlock"
  // (app 4.5 and later). The bound 1..100 on `rounds` is the chosen value of assumption A3; the
  // app refuses a payload outside it as malformed, so both enforcement points agree.
  z.object({
    op: z.literal('updateBlock'),
    blockId: UUID_STRING.describe(
      'Id of a live block of this proposal\'s template (the blockId get_template shows). A block ' +
        'of another template is never changed: the app writes nothing and reports the id.',
    ),
    rounds: z.number().int().min(BLOCK_ROUNDS_MIN).max(BLOCK_ROUNDS_MAX).describe(
      'New number of rounds of the block, a whole number from 1 to 100.',
    ),
  }),
  z.object({
    op: z.literal('addBlock'),
    rounds: z.number().int().min(BLOCK_ROUNDS_MIN).max(BLOCK_ROUNDS_MAX).describe(
      'Number of rounds of the new block, a whole number from 1 to 100. The new block has no name.',
    ),
    orderIndex: z.number().int().min(0).describe(
      'Position of the new block in the shared top-level space of blocks and standalone ' +
        'exercises. Existing top-level siblings at or after this index move down by one; an ' +
        'index past the end appends.',
    ),
    exercises: z.array(NewPlanExerciseInputSchema).min(1).max(50).describe(
      'The exercises of the new block, 1 to 50 entries in the form of a new_plan block entry. ' +
        'Each orderIndex here is block-local. A source:"new" ref must name a tempId declared in ' +
        'newExercises[] of the same proposal.',
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Phase 166 (plan 166-08, MCP-06, D-11, D-15): protocol §2.7 "Exercise Proposals". Four
// optional fields of new_exercise and newExercises[] (translations, muscleGroups, capabilities,
// equipment) and three of exercise_update (translations, muscleGroups, capabilities). Every list
// is optional, never empty when present, and refused (never cut, trimmed or repaired) outside its
// form; the app treats the same payload as malformed (only Reject stays available). Muscle keys
// are checked here (MUSCLE_KEY); capability and equipment keys against the loaded catalog in the
// tools (`findUnknownLinkKey`, propose_new_exercise.ts), because the catalog is their vocabulary.
// ---------------------------------------------------------------------------

/** §1.9 `NAME_MAX` / `DESCRIPTION_MAX` in UTF-16 code units (`String.length`), the widths the app stores. */
export const EXERCISE_TEXT_NAME_MAX = 255;
export const EXERCISE_TEXT_DESCRIPTION_MAX = 1000;
/** §2.7 list bounds. */
export const TRANSLATIONS_MAX = 10;
export const MUSCLE_LINKS_MAX = 18;
export const CAPABILITY_LINKS_MAX = 7;
export const EQUIPMENT_LINKS_MAX = 20;

/** A translation name: 1 to 255 code units, never blank by the set W of §1.7 (never trimmed). */
const TRANSLATION_NAME = z
  .string()
  .min(1)
  .max(EXERCISE_TEXT_NAME_MAX)
  .refine((v) => !isBlankOverrideText(v), { message: 'A translation name must not be blank (protocol §1.7 set W)' });

const TranslationEntrySchema = z.object({
  languageCode: LANG.describe('Language code of this translation, for example de.'),
  name: TRANSLATION_NAME.describe('The exercise name in this language, 1 to 255 characters, never blank.'),
  description: z.string().max(EXERCISE_TEXT_DESCRIPTION_MAX).nullable().optional().describe(
    'The description in this language, at most 1000 characters; null or absent for none.',
  ),
});

/** Refuses a list whose `key(entry)` repeats; names the field and the repeated key. */
function uniqueBy<T>(field: string, key: (entry: T) => string) {
  return (list: T[], ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    for (const entry of list) {
      const k = key(entry);
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `${field} must not repeat a key (${k})` });
      seen.add(k);
    }
  };
}

/**
 * `translations` of new_exercise and newExercises[]: `en` is the base language (`name` and
 * `description`), so an `en` entry is refused here (§2.7, assumption A2).
 */
export const NewExerciseTranslationsSchema = z
  .array(TranslationEntrySchema)
  .min(1)
  .max(TRANSLATIONS_MAX)
  .superRefine(uniqueBy('translations[].languageCode', (t) => t.languageCode))
  .superRefine((list, ctx) => {
    if (list.some((t) => t.languageCode === 'en')) {
      ctx.addIssue({ code: 'custom', message: 'translations must not name en: the base name is name, the base description description' });
    }
  });

/** `translations` of exercise_update: may name `en` (for an own exercise it changes the base name). */
export const ExerciseUpdateTranslationsSchema = z
  .array(TranslationEntrySchema)
  .min(1)
  .max(TRANSLATIONS_MAX)
  .superRefine(uniqueBy('translations[].languageCode', (t) => t.languageCode));

export const MuscleLinksSchema = z
  .array(
    z.object({
      key: MUSCLE_KEY,
      level: z.enum(['PRIMARY', 'SECONDARY', 'STABILIZER']).optional().describe(
        'PRIMARY, SECONDARY or STABILIZER; absent for an unrated link.',
      ),
    }),
  )
  .min(1)
  .max(MUSCLE_LINKS_MAX)
  .superRefine(uniqueBy('muscleGroups[].key', (m) => m.key));

export const CapabilityLinksSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(64).describe('A capability key of the catalog (get_exercise_catalog), for example mobility.'),
      level: z.enum(['HAUPTREIZ', 'MITTRAINIERT', 'GERING']).describe(
        'Required: HAUPTREIZ, MITTRAINIERT or GERING. An unrated capability link weighs nothing and is never proposed.',
      ),
    }),
  )
  .min(1)
  .max(CAPABILITY_LINKS_MAX)
  .superRefine(uniqueBy('capabilities[].key', (c) => c.key));

export const EquipmentLinksSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(64).describe('An equipment key of the catalog (get_exercise_catalog), for example kettlebell.'),
      optional: z.boolean().optional().describe('Whether the equipment is optional; absent means false.'),
    }),
  )
  .min(1)
  .max(EQUIPMENT_LINKS_MAX)
  .superRefine(uniqueBy('equipment[].key', (e) => e.key));

/** The four optional fields of new_exercise and newExercises[] (§2.7), shared by both schemas. */
const NEW_EXERCISE_LINK_FIELDS = {
  translations: NewExerciseTranslationsSchema.optional().describe(
    'Optional. Names and descriptions in languages other than en (name and description are the ' +
      'base language en), up to 10 entries, one per language.',
  ),
  muscleGroups: MuscleLinksSchema.optional().describe(
    'Optional. Muscle links by muscle key, up to 18, each with an optional level.',
  ),
  capabilities: CapabilityLinksSchema.optional().describe(
    'Optional. Capability links by catalog key, up to 7, each with a required level.',
  ),
  equipment: EquipmentLinksSchema.optional().describe(
    'Optional. Equipment links by catalog key, up to 20, each with an optional flag.',
  ),
};

/** A brand-new exercise defined inline within a proposal (never a direct catalog write). */
export const NewExerciseDefSchema = z.object({
  tempId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  mode: z.enum(['REPS', 'TIME', 'MAX']),
  usesWeight: z.boolean(),
  // Phase 134 (G-134-12): widened to accept an explicit JSON `null` — mirrors the
  // Kotlin side's `description: String? = null` (NewExerciseDef, ProposalPayload.kt);
  // the shared formatProposal corpus's tempId vector encodes an absent description
  // as literal `null`, not an omitted key.
  description: z.string().max(2000).nullable().optional(),
  ...NEW_EXERCISE_LINK_FIELDS,
});

// ---------------------------------------------------------------------------
// Format-template plan_update (Phase 134, G-134-12, Protocol v1.7 §2.5).
//
// A plan_update against a format template (CIRCUIT/EMOM/AMRAP/TABATA/LADDER/
// FOR_TIME/CHIPPER/DEATH_BY) carries `formatParams` — the complete new authoring
// parameters — instead of `ops[]`. `.strict()` on every member and entry shape
// below is deliberate parity, not incidental: the Kotlin-side ProposalPayloadParser
// decodes with `ignoreUnknownKeys = false`, so a Zod schema that silently strips an
// unknown key would accept a payload the app later rejects — a divergence between
// the two enforcement points this section exists to prevent (T-134-21-03).
//
// Two of the six named refusal reasons (FormatRefusalReason, format_proposal.ts)
// originate here rather than in validateFormatProposal: UNKNOWN_FORMAT_TYPE is the
// discriminatedUnion itself rejecting an unrecognized workoutType, and
// FORMAT_PARAMS_INVALID is each member's own .superRefine() below, mirroring
// FormatProposalApplier.validateParams (Kotlin) rule for rule.
// ---------------------------------------------------------------------------

/**
 * `formatExerciseEntry` (Protocol §2.5) — mode, target and weight. Used by
 * CIRCUIT/AMRAP/FOR_TIME/CHIPPER's `exercises` and EMOM's `stations`.
 *
 * `mode` is deliberately `'REPS' | 'TIME'` only — WITHOUT `'MAX'`, unlike
 * `PlanOpSchema`'s CLASSIC-path `mode` — because none of the format wrapper editors
 * offer a MAX-mode exercise; `PlanOpSchema` keeps `MAX` for the CLASSIC path only.
 *
 * `targetReps`/`targetTimeSeconds`/`targetWeight` accept an explicit JSON `null`
 * (the corpus's own encoding of "not applicable for this entry's mode", mirroring
 * kotlinx.serialization's nullable `Int?`/`Double?`) as well as being omitted.
 */
export const FormatExerciseEntrySchema = z
  .object({
    exercise: ExerciseRefSchema,
    mode: z.enum(['REPS', 'TIME']),
    targetReps: z.number().int().min(0).nullable().optional(),
    targetTimeSeconds: z.number().int().min(0).nullable().optional(),
    orderIndex: z.number().int().min(0),
    targetWeight: z.number().min(0).nullable().optional(),
  })
  .strict();

/** `formatSlotEntry` (Protocol §2.5) — exercise and order only. Used by TABATA's
 * `exercises`: TABATA carries no per-entry mode or target on either side of the wire. */
export const FormatSlotEntrySchema = z
  .object({
    exercise: ExerciseRefSchema,
    orderIndex: z.number().int().min(0),
  })
  .strict();

/** `formatWeightEntry` (Protocol §2.5) — exercise, order and weight, no mode/target.
 * Used by LADDER and DEATH_BY's `exercises`. */
export const FormatWeightEntrySchema = z
  .object({
    exercise: ExerciseRefSchema,
    orderIndex: z.number().int().min(0),
    targetWeight: z.number().min(0).nullable().optional(),
  })
  .strict();

/**
 * Adds a `FORMAT_PARAMS_INVALID` issue for any entry whose target field doesn't
 * match its own `mode` — the same `hasValidTarget()` rule
 * `FormatProposalApplier.validateParams` (Kotlin) checks for every format built on
 * `formatExerciseEntry` (CIRCUIT/EMOM/AMRAP/FOR_TIME/CHIPPER). Not used by TABATA
 * (`formatSlotEntry` has no `mode`) or LADDER/DEATH_BY (`formatWeightEntry`, same).
 */
function addTargetInvalidIssues(
  entries: readonly { mode: 'REPS' | 'TIME'; targetReps?: number | null; targetTimeSeconds?: number | null }[],
  ctx: z.RefinementCtx,
): void {
  for (const entry of entries) {
    if (entry.mode === 'REPS' && entry.targetReps == null) {
      ctx.addIssue('FORMAT_PARAMS_INVALID: a REPS entry requires targetReps');
    }
    if (entry.mode === 'TIME' && entry.targetTimeSeconds == null) {
      ctx.addIssue('FORMAT_PARAMS_INVALID: a TIME entry requires targetTimeSeconds');
    }
  }
}

/**
 * EMOM window bounds (seconds) — the range the App's own editor stepper enforces
 * (D-01). Both numbers MUST match `SaveNormalization.EMOM_WINDOW_MIN_SECONDS` /
 * `EMOM_WINDOW_MAX_SECONDS` in `FormatProposalApplier.kt` (Kotlin, Plan 134-45) — a
 * mismatch would let the MCP and the App's save-boundary normalization decide the
 * same proposal differently (T-134-21-03). The corpus is the shared source for
 * DECISIONS, not for these hand-maintained constants; `emom-window-below-range-
 * normalized-not-rejected` and `emom-window-above-range-time-station-still-refused`
 * (`docs/coach-planning-vectors.json`, Plan 134-44) are the machine check that the
 * two sides still agree.
 */
export const EMOM_WINDOW_MIN_SECONDS = 30;
export const EMOM_WINDOW_MAX_SECONDS = 300;

/**
 * Normalizes a proposed EMOM window into [`EMOM_WINDOW_MIN_SECONDS`,
 * `EMOM_WINDOW_MAX_SECONDS`] — read ONLY by the TIME-station refusal rule below.
 * The MCP no longer clamps `windowSeconds` itself (T-134-21-01): this function never
 * touches the stored/parsed value, only the comparison the refusal rule makes.
 */
function clampEmomWindowSeconds(proposed: number): number {
  return Math.min(Math.max(proposed, EMOM_WINDOW_MIN_SECONDS), EMOM_WINDOW_MAX_SECONDS);
}

/**
 * `formatParams` — Protocol §2.5's discriminated union over the eight non-CLASSIC
 * `WorkoutType` values, keyed on its own `workoutType` field (mirrors
 * `ExerciseRefSchema`'s `source` discriminant idiom, T-121-06). This plan (134-21
 * Task 1) adds the CIRCUIT member alone; Task 2 adds the remaining seven.
 *
 * An unrecognized `workoutType` is refused by the `discriminatedUnion` itself —
 * that IS `UNKNOWN_FORMAT_TYPE` (see the section banner above); it is never produced
 * by `validateFormatProposal`.
 */
export const FormatParamsSchema = z.discriminatedUnion('workoutType', [
  z
    .object({
      workoutType: z.literal('CIRCUIT'),
      rounds: z.number().int().min(1).optional().default(3),
      restSeconds: z.number().int().min(0).optional().default(60),
      exercises: z.array(FormatExerciseEntrySchema).min(1).max(50),
    })
    .strict()
    .superRefine((val, ctx) => addTargetInvalidIssues(val.exercises, ctx)),

  /**
   * `rounds` is the TOTAL number of intervals across the whole workout, not
   * per-station (Protocol §2.5, "Where the EMOM minute slot lives") — a station's
   * minute slot is derived entirely from its `orderIndex` within `stations`.
   *
   * `windowSeconds` is passed through UNCHANGED — the MCP proposes what the coach
   * means and does not alter the value (`134-21-PLAN.md:277`'s original mandate,
   * restored by `T-134-21-01` after `134-21` clamped it here by mistake instead). The
   * App normalizes it to the editor's stepper range at its own save boundary and
   * REPORTS the normalization in `applied_payload` (`SaveNormalization`, Plan 134-45;
   * Protocol v1.8 §2.5, `accepted_modified` per §5) — the window bends, visibly. A
   * TIME station whose target is not strictly below the window still does NOT bend:
   * it remains a `FORMAT_PARAMS_INVALID` refusal (D-03/T-123-03-01), exactly
   * mirroring `FormatProposalApplier.validateParams`'s EMOM branch (Kotlin). That
   * refusal rule compares against the NORMALIZED window (the helper declared above,
   * not the raw field) — not an inconsistency, but the condition under which the MCP
   * and the App's `SaveNormalization` decide every boundary case identically
   * (T-134-21-03). Do not reintroduce a clamp on the field itself.
   */
  z
    .object({
      workoutType: z.literal('EMOM'),
      windowSeconds: z.number().int().min(1).optional().default(60),
      rounds: z.number().int().min(1).optional().default(12),
      stations: z.array(FormatExerciseEntrySchema).min(1).max(50),
    })
    .strict()
    .superRefine((val, ctx) => {
      addTargetInvalidIssues(val.stations, ctx);
      const normalizedWindowSeconds = clampEmomWindowSeconds(val.windowSeconds);
      for (const station of val.stations) {
        if (station.mode === 'TIME' && station.targetTimeSeconds != null && station.targetTimeSeconds >= normalizedWindowSeconds) {
          ctx.addIssue('FORMAT_PARAMS_INVALID: a TIME station target must be strictly less than the (normalized) EMOM window');
        }
      }
    }),

  /** An AMRAP round is the `exercises` list itself, repeated until `timeCapMinutes` elapses. */
  z
    .object({
      workoutType: z.literal('AMRAP'),
      timeCapMinutes: z.number().int().min(1).optional().default(10),
      exercises: z.array(FormatExerciseEntrySchema).min(1).max(50),
    })
    .strict()
    .superRefine((val, ctx) => addTargetInvalidIssues(val.exercises, ctx)),

  /** TABATA carries no per-entry mode or target — the work interval comes from
   * `workSeconds` alone and the compiler sets `mode = TIME` on the authoring side.
   * `exercises` therefore uses `formatSlotEntry`, which has no field for either —
   * a payload entry carrying `mode` or `targetReps` is rejected by `.strict()`. */
  z
    .object({
      workoutType: z.literal('TABATA'),
      workSeconds: z.number().int().min(1).optional().default(20),
      restSeconds: z.number().int().min(0).optional().default(10),
      rounds: z.number().int().min(1).optional().default(8),
      exercises: z.array(FormatSlotEntrySchema).min(1).max(50),
    })
    .strict(),

  /**
   * `repsPerRound` is AUTHORITATIVE — its length is the round count. `pattern`/
   * `startReps`/`step` are generator inputs kept only so the wrapper's re-display
   * can offer a starting point for further editing; they never regenerate the ramp
   * (Protocol §2.5, "Where the ladder ramp lives") — a proposal that changes the
   * progression changes `repsPerRound` directly.
   */
  z
    .object({
      workoutType: z.literal('LADDER'),
      pattern: z.enum(['ASCENDING', 'DESCENDING', 'PYRAMID', 'PYRAMID_REVERSE']).optional().default('ASCENDING'),
      startReps: z.number().int().min(1).optional().default(1),
      step: z.number().int().min(1).optional().default(1),
      restSeconds: z.number().int().min(0).optional().default(60),
      repsPerRound: z.array(z.number().int().min(1)).min(1).max(100),
      exercises: z.array(FormatWeightEntrySchema).min(1).max(50),
    })
    .strict(),

  z
    .object({
      workoutType: z.literal('FOR_TIME'),
      rounds: z.number().int().min(1).optional().default(1),
      raceTimer: z.boolean().optional().default(true),
      exercises: z.array(FormatExerciseEntrySchema).min(1).max(50),
    })
    .strict()
    .superRefine((val, ctx) => addTargetInvalidIssues(val.exercises, ctx)),

  /**
   * Shares FOR_TIME's schema exactly (Protocol §2.5) — INCLUDING `rounds`, even
   * though the app always overwrites it to `1` at apply time
   * (`FormatProposalApplier.toChipperParams`, Kotlin). `rounds` stays on the wire
   * deliberately: the frozen shared corpus's `chipper-rounds-normalized-not-rejected`
   * vector carries `rounds: 3`, and `ProposalPayloadParser`'s `ignoreUnknownKeys =
   * false` means omitting the field here would make that ACCEPTED corpus vector
   * fail to parse on the Kotlin side's decoder — the two enforcement points must
   * decode the identical wire shape. `rounds` is deliberately NOT validated as a
   * `FORMAT_PARAMS_INVALID` condition (Protocol §2.5, "Normalizing rather than
   * rejecting CHIPPER's rounds") — any value is accepted; the app normalizes it.
   *
   * WR-03 (134-REVIEW.md): unlike every sibling member's `rounds` field, this one
   * deliberately has NO `.min(1)` — `FormatProposalApplier.validateParams`'s CHIPPER
   * branch (Kotlin) never checks `rounds` at all, so `rounds: 0` or a negative value
   * must reach the app to be normalized to `1`, not be refused here before the coach
   * can even propose it. A `.min(1)` here would make the MCP strictly MORE restrictive
   * than the documented, Kotlin-enforced contract this schema is supposed to mirror.
   */
  z
    .object({
      workoutType: z.literal('CHIPPER'),
      rounds: z.number().int().optional().default(1),
      raceTimer: z.boolean().optional().default(true),
      exercises: z.array(FormatExerciseEntrySchema).min(1).max(50),
    })
    .strict()
    .superRefine((val, ctx) => addTargetInvalidIssues(val.exercises, ctx)),

  /** Same shape as LADDER minus `pattern`: an ascending ladder run per-minute until
   * failure. `roundCap` is a forward-compatibility bound with no wrapper UI element. */
  z
    .object({
      workoutType: z.literal('DEATH_BY'),
      startReps: z.number().int().min(1).optional().default(1),
      step: z.number().int().min(1).optional().default(1),
      roundCap: z.number().int().min(1).optional().default(30),
      exercises: z.array(FormatWeightEntrySchema).min(1).max(50),
    })
    .strict(),
]);

/**
 * Returns every `{ exercise: ExerciseRef }` entry from a parsed `formatParams`'s own
 * entry list, regardless of which field name this format uses (EMOM: `stations`; the
 * other seven: `exercises`). Exhaustive `switch` over `workoutType` with NO `default`
 * branch — the same guardrail `rewriteFormatParamsRefs` (`src/tools/propose_plan_update.ts`)
 * already gives the dedupe rewrite: a ninth member added to `FormatParamsSchema`
 * without a matching `case` here fails the build (TS2366, "function lacks ending
 * return statement") instead of silently skipping that format's entries for the
 * tempId-declaration check below.
 */
function formatParamsEntries(
  formatParams: z.infer<typeof FormatParamsSchema>,
): { exercise: z.infer<typeof ExerciseRefSchema> }[] {
  switch (formatParams.workoutType) {
    case 'CIRCUIT':
      return formatParams.exercises;
    case 'EMOM':
      return formatParams.stations;
    case 'AMRAP':
      return formatParams.exercises;
    case 'TABATA':
      return formatParams.exercises;
    case 'LADDER':
      return formatParams.exercises;
    case 'FOR_TIME':
      return formatParams.exercises;
    case 'CHIPPER':
      return formatParams.exercises;
    case 'DEATH_BY':
      return formatParams.exercises;
  }
}

/**
 * propose_plan_update — either an op-list diff against a CLASSIC template (`ops`),
 * or a whole-parameter replacement against a format template (`formatParams`) —
 * Protocol v1.7 §2.5. Never both, never neither.
 *
 * `.refine`: every `addExercise` op with `source:'new'` must reference a tempId
 * defined in `newExercises[]` (D-05 actionable error — cross-field consistency
 * enforced at the Zod boundary before hashing/network I/O); `newExercises[].tempId`
 * values must be unique (WR-07 — duplicates make the dedupe rewrite ambiguous,
 * last-match-wins silently); and EXACTLY ONE of a non-empty `ops` or `formatParams`
 * must be present — `OPS_AND_FORMAT_PARAMS_EXCLUSIVE` when both are set,
 * `FORMAT_PARAMS_REQUIRED` when neither is (Protocol §2.5's rejection table). This
 * third refine is STRICTER than the pre-134-21 state (`ops` was mandatory,
 * non-empty), not looser: today "neither" was already impossible, and it remains
 * impossible — only "formatParams alone" becomes newly expressible.
 *
 * Three checks enforce ONE condition — a `{source:'new', tempId}` ref must resolve
 * against a declaration in `newExercises[]` — at the three places a proposal can
 * carry such a ref: the `.refine` above for `addExercise` ops, the mirrored `.refine`
 * on `ProposeNewPlanSchema` below for `blocks[].exercises[]`, and the final
 * `.superRefine` here for `formatParams`. Plan `134-21` built the first two and
 * missed the third (`T-134-21-01`, closed by Plan `134-47`); this file now has all
 * three. The two enforcement styles diverge deliberately downstream of this schema:
 * on the App side, an `ops[]` entry whose ref cannot be resolved is reported as a
 * skipped op (D-12, `CoachApplyDao`'s best-effort `ops[]` semantics since Phase 122)
 * — it is never refused here, because `ops[]` was never required to resolve every
 * entry to begin with. `formatParams`, by contrast, IS refused below for exactly
 * this condition, because a format proposal is a whole-parameter replacement
 * (Protocol v1.8 §2.5): a template built from a proposal missing a declared
 * exercise is not a best-effort application, it is a different plan than the one
 * proposed.
 */
export const ProposePlanUpdateSchema = z
  .object({
    templateId: UUID_STRING,
    rationale: z.string().min(1).max(2000),
    newExercises: z.array(NewExerciseDefSchema).max(20).optional(),
    ops: z.array(PlanOpSchema).max(50).optional(),
    formatParams: FormatParamsSchema.optional(),
  })
  .refine(
    (d) => {
      // Phase 166 (plan 166-08, Pitfall 11, T-166-24): the refs of `addBlock.exercises[]` are
      // collected too, so a dangling tempId inside a new block is refused here, never sent.
      const definedTempIds = new Set((d.newExercises ?? []).map((e) => e.tempId));
      const referencedTempIds: string[] = [];
      for (const op of d.ops ?? []) {
        if (op.op === 'addExercise' && op.exercise.source === 'new') {
          referencedTempIds.push(op.exercise.tempId);
        } else if (op.op === 'addBlock') {
          for (const entry of op.exercises) {
            if (entry.exercise.source === 'new') referencedTempIds.push(entry.exercise.tempId);
          }
        }
      }
      return referencedTempIds.every((id) => definedTempIds.has(id));
    },
    { message: 'Every addExercise op with source:"new" must reference a tempId defined in newExercises[]' },
  )
  .refine(
    (d) => {
      const ids = (d.newExercises ?? []).map((e) => e.tempId);
      return new Set(ids).size === ids.length;
    },
    { message: 'newExercises[].tempId values must be unique' },
  )
  .superRefine((d, ctx) => {
    const hasOps = (d.ops ?? []).length > 0;
    const hasFormatParams = d.formatParams !== undefined;
    if (hasOps && hasFormatParams) {
      ctx.addIssue('OPS_AND_FORMAT_PARAMS_EXCLUSIVE: a proposal may carry ops[] or formatParams, never both');
    } else if (!hasOps && !hasFormatParams) {
      ctx.addIssue('FORMAT_PARAMS_REQUIRED: a proposal must carry a non-empty ops[] or formatParams');
    }
  })
  .superRefine((d, ctx) => {
    // T-134-21-01 (third finding, Plan 134-47): a formatParams entry whose
    // {source:'new', tempId} ref is not declared in newExercises[] is refused here
    // — the SAME condition the two `.refine`s above already enforce for ops[] and
    // blocks[].exercises[], applied a third time because a proposal has a third way
    // to carry a New ref. Reason code FORMAT_PARAMS_INVALID (not a new code — this
    // is a sub-case of the existing code, per docs/COACH-PLANNING-PROTOCOL.md v1.8
    // §2.5's Rejection Table). The ops[] path is deliberately NOT touched here: it
    // stays best-effort at the App boundary (D-12), reporting an unresolvable ref
    // as a skipped op rather than refusing the whole proposal.
    if (d.formatParams === undefined) {
      return;
    }
    const definedTempIds = new Set((d.newExercises ?? []).map((e) => e.tempId));
    for (const entry of formatParamsEntries(d.formatParams)) {
      if (entry.exercise.source === 'new' && !definedTempIds.has(entry.exercise.tempId)) {
        ctx.addIssue(
          `FORMAT_PARAMS_INVALID: a formatParams entry references a tempId not declared in newExercises[] (${entry.exercise.tempId})`,
        );
      }
    }
  });

/**
 * propose_new_plan — a full new-plan structure (not an op-list seeded from empty;
 * there is no existing templateId to diff against). RESEARCH.md Pattern 7.
 *
 * Phase 150 (D-22/D-24, Protocol §2.6): `blocks` is now optional and `standalone[]` — an
 * optional array of blockless exercise entries sharing the top-level `orderIndex` space with
 * `blocks[]` — lets a coach propose an exercise whose own sets run back to back without
 * wrapping it in a meaningless `rounds: 1` block. Neither field enforces a block-form rule
 * (D-20): a `rounds: 1` block is accepted, never rejected — meaning is not enforcement.
 *
 * `.refine`s, in order: (a) at least one block or standalone entry must exist; (b) every
 * `blocks[].orderIndex` and `standalone[].orderIndex` value is unique across BOTH lists
 * together (D-24 — one shared top-level order space, never two independently-numbered
 * spaces); (c) every `{source:'new', tempId}` exercise ref in `blocks[].exercises[]` OR
 * `standalone[]` must reference a tempId defined in `newExercises[]` (WR-01 — mirrors the
 * ProposePlanUpdateSchema refine; dangling refs are unresolvable at apply-time, now checked
 * over both lists); (d) `newExercises[].tempId` values must each be unique (WR-07); (e)
 * `blocks[].tempBlockId` values must each be unique (WR-07 — duplicates make the dedupe
 * rewrite ambiguous, last-match-wins silently).
 */
export const ProposeNewPlanSchema = z.object({
  name: z.string().min(1).max(200),
  rationale: z.string().min(1).max(2000),
  newExercises: z.array(NewExerciseDefSchema).max(20).optional(),
  blocks: z
    .array(
      z.object({
        tempBlockId: z.string().min(1).max(64),   // LLM-facing placeholder, mirrors tempId pattern
        rounds: z.number().int().min(1).describe(
          'A block is an exercise list that is run through rounds times; in a circuit each ' +
            'exercise typically has sets: 1, because the repetition comes from the round, not the ' +
            'set. A block with rounds: 1 makes no sense — use a standalone entry instead. Which ' +
            'form to choose is up to you.',
        ),
        orderIndex: z.number().int().min(0).describe(
          'Position in the shared top-level order space with standalone[]; must be unique across ' +
            'blocks[].orderIndex and standalone[].orderIndex together.',
        ),
        exercises: z.array(NewPlanExerciseInputSchema).min(1).max(50),
      }),
    )
    .max(20)
    .optional(),
  standalone: z.array(NewPlanExerciseInputSchema).max(50).optional().describe(
    'A standalone entry is one exercise whose own sets run back to back with no other exercise ' +
      'between them — the alternative to a block with rounds: 1. Shares one top-level orderIndex ' +
      'space with blocks[] and may sit before, between, or after any of them. Optional and ' +
      'present ONLY when at least one standalone entry exists — never an empty array.',
  ),
})
  .refine(
    (d) => (d.blocks ?? []).length + (d.standalone ?? []).length >= 1,
    { message: 'A new plan needs at least one block or standalone entry' },
  )
  .refine(
    (d) => {
      const indices = [
        ...(d.blocks ?? []).map((b) => b.orderIndex),
        ...(d.standalone ?? []).map((s) => s.orderIndex),
      ];
      return new Set(indices).size === indices.length;
    },
    {
      message:
        'blocks[].orderIndex and standalone[].orderIndex share one top-level order space and must be unique',
    },
  )
  .refine(
    (d) => {
      const definedTempIds = new Set((d.newExercises ?? []).map((e) => e.tempId));
      const blocksOk = (d.blocks ?? []).every((b) =>
        b.exercises.every(
          (ex) => ex.exercise.source !== 'new' || definedTempIds.has(ex.exercise.tempId),
        ),
      );
      const standaloneOk = (d.standalone ?? []).every(
        (ex) => ex.exercise.source !== 'new' || definedTempIds.has(ex.exercise.tempId),
      );
      return blocksOk && standaloneOk;
    },
    { message: 'Every exercise ref with source:"new" must reference a tempId defined in newExercises[]' },
  )
  .refine(
    (d) => {
      const ids = (d.newExercises ?? []).map((e) => e.tempId);
      return new Set(ids).size === ids.length;
    },
    { message: 'newExercises[].tempId values must be unique' },
  )
  .refine(
    (d) => {
      const ids = (d.blocks ?? []).map((b) => b.tempBlockId);
      return new Set(ids).size === ids.length;
    },
    { message: 'blocks[].tempBlockId values must be unique' },
  );

/** propose_new_exercise — a single brand-new exercise definition (never a direct catalog write). */
export const ProposeNewExerciseSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(['REPS', 'TIME', 'MAX']),
  usesWeight: z.boolean(),
  rationale: z.string().min(1).max(2000),
  description: z.string().max(2000).optional(),
  ...NEW_EXERCISE_LINK_FIELDS,
});

// ---------------------------------------------------------------------------
// propose_planned_update (Phase 136, D-01, Protocol v1.11 §2). The coach names an
// INTENT — `z.discriminatedUnion('intent', [...])` — and the MCP code (never the
// LLM) computes the full after-state `planned_update` envelope from it. Phase 136-01
// (TRACER SLICE) landed the `move_occurrence` member only; 136-02 adds
// `cancel_occurrence`, `schedule_workout` and `change_series_rule` to this same
// union. Follows the strict-union idiom already used by `ExerciseRefSchema`/
// `PlanOpSchema` above (T-121-06: unknown discriminant literals rejected at the
// validation boundary, before any hashing or network I/O).
//
// `schedule_workout` carries EXACTLY ONE of `templateId` (an existing template) or
// `chainSuggestionId` (Phase 136-08, D-04, protocol §2's "Proposal Chain Reference")
// — the id of the coach's own still-open `new_plan` proposal to schedule against once
// it resolves to a real template. Both fields are optional at the shape level; the
// exclusivity itself is a `.superRefine`, mirroring `change_series_rule.cutoffDate`'s
// idiom immediately below. Resolving a supplied `chainSuggestionId` against the
// caller's own proposals (ownership/type/pending) is `propose_planned_update.ts`'s
// job, not this schema's — this file only enforces the shape.
//
// `change_series_rule.cutoffDate` is required exactly when `scope` is
// `this_and_following` (protocol §2 "Splitting a series at a date") — enforced with
// `.superRefine` rather than `.refine`, mirroring `FormatParamsSchema`'s own members
// above: `.refine` degrades a discriminated-union member to `ZodEffects`, which loses
// the `shape` the union's discriminant lookup needs, while `.superRefine` on a
// `z.object(...)` keeps that shape intact.
// ---------------------------------------------------------------------------

export const ProposePlannedUpdateSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('move_occurrence'),
    rootId: UUID_STRING,
    occurrenceDate: ISO_DATE,
    newDate: ISO_DATE,
    newTime: z.string().optional(),
    rationale: z.string().min(1).max(2000),
  }),

  z.object({
    intent: z.literal('cancel_occurrence'),
    rootId: UUID_STRING,
    occurrenceDate: ISO_DATE,
    rationale: z.string().min(1).max(2000),
  }),

  z
    .object({
      intent: z.literal('schedule_workout'),
      templateId: UUID_STRING.optional(),
      chainSuggestionId: UUID_STRING.optional(),
      date: ISO_DATE,
      time: z.string().optional(),
      recurrenceRule: z.string().optional(),
      rationale: z.string().min(1).max(2000),
    })
    .superRefine((d, ctx) => {
      const hasTemplateId = d.templateId !== undefined;
      const hasChain = d.chainSuggestionId !== undefined;
      if (hasTemplateId === hasChain) {
        ctx.addIssue(
          'CHAIN_EXCLUSIVITY: schedule_workout requires exactly one of templateId or ' +
            'chainSuggestionId, never both, never neither',
        );
      }
    }),

  z
    .object({
      intent: z.literal('change_series_rule'),
      rootId: UUID_STRING,
      scope: z.enum(['this_and_following', 'whole_series']),
      newRecurrenceRule: z.string().min(1),
      cutoffDate: ISO_DATE.optional(),
      rationale: z.string().min(1).max(2000),
    })
    .superRefine((val, ctx) => {
      if (val.scope === 'this_and_following' && val.cutoffDate === undefined) {
        ctx.addIssue('cutoffDate is required when scope is this_and_following');
      }
    }),
]);

// ---------------------------------------------------------------------------
// Coach proposal read-back / withdraw contract (Phase 136, D-08/D-09,
// PROP-10/PROP-11). get_suggestions, get_suggestion, withdraw_suggestion.
// ---------------------------------------------------------------------------

/** The seven protocol status values (protocol v1.11 §5 Status Vocabulary) —
 * verbatim, including the two Phase 136 additions (`withdrawn`, `obsolete`). */
export const SUGGESTION_STATUS = z.enum([
  'pending',
  'accepted',
  'accepted_modified',
  'rejected',
  'expired',
  'withdrawn',
  'obsolete',
] as const);

export type SuggestionStatus = z.infer<typeof SUGGESTION_STATUS>;

/**
 * get_suggestions — D-08/D-09. Optional status filter (one of the seven protocol
 * values); optional `limit`. Deliberately NOT `.min(1).max(500)` like
 * GetHistorySchema's reject-on-out-of-range `limit` — get_suggestions.ts's own
 * `clampSuggestionsLimit` clamps rather than rejects (matching the server's own
 * `coerceIn(1, 500)`, protocol v1.11 §5.5), so an out-of-range value here is
 * advisory paging, not a hard input-validation boundary the caller must get
 * exactly right.
 */
export const GetSuggestionsSchema = z.object({
  status: SUGGESTION_STATUS.optional(),
  limit: z.number().int().optional(),
});

/**
 * get_suggestion — D-08/D-09. One own proposal in full by id. `lang` (Phase 150,
 * D-14/D-35) is optional and localizes every name in `payloadResolved`/
 * `appliedPayloadResolved` — see `get_suggestion.ts`.
 */
export const GetSuggestionSchema = z.object({
  id: UUID_STRING,
  lang: LANG.optional(),
});

/** withdraw_suggestion — D-08, PROP-11. Withdraw one own still-pending proposal.
 * No status field of any kind — the route this schema feeds recognises exactly
 * one transition (`pending` -> `withdrawn`) and accepts no other, so there is
 * nothing here for a caller to select (T-136-23 — this schema itself is part of
 * what makes the tool unable to express a general status-setting mutation). */
export const WithdrawSuggestionSchema = z.object({
  id: UUID_STRING,
});

// ---------------------------------------------------------------------------
// Coach-parameters tool schemas (Phase 137, D-09/D-23, STATE-06).
// ---------------------------------------------------------------------------

/** get_coach_parameters — no input; returns defaults, ranges, and current values (D-09). */
export const GetCoachParametersSchema = z.object({});

/**
 * set_coach_parameters — a thin re-export of `CoachParametersSchema`
 * (coach-parameters.ts): the one strict object with exactly the seven optional,
 * range-checked numeric fields and no free-form key. This schema alone is what
 * makes the tool structurally unable to express anything other than setting
 * those seven keys (T-137-02) — the same non-expressibility argument
 * `withdraw_suggestion`'s schema carries for its single transition.
 */
export const SetCoachParametersSchema = CoachParametersSchema;
