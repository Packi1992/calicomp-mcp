/**
 * TypeScript interfaces for CalisthenicsCompanion-MCP.
 *
 * Wire DTOs mirror the server's Kotlin @Serializable data classes (SyncDtos.kt, Dtos.kt,
 * ProfileRoutes.kt). Decrypted variants replace encrypted/zeroed fields with their resolved
 * values after AES-256-GCM decrypt-merge.
 *
 * Source analogues:
 *   - SyncDtos.kt (CalisthenicsServer) — wire shapes for sync pull response
 *   - Dtos.kt (CalisthenicsServer) — ExerciseDto / CatalogExercise
 *   - ProfileRoutes.kt (CalisthenicsServer) — UserProfileResponse
 */

// ---------------------------------------------------------------------------
// Wire DTOs (as returned by /api/mcp/data/pull before decryption)
// ---------------------------------------------------------------------------

export interface SyncExerciseDto {
  id: string;
  name: string;
  mode: string;                // "REPS" | "TIME" | "MAX"
  usesWeight: boolean;
  description?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface SyncExerciseTranslationDto {
  exerciseId: string;
  languageCode: string;
  name: string;
  description?: string;
}

export interface SyncTemplateDto {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  isFavoriteForWatch: boolean;
  // Phase 134 (G-134-12), Protocol v1.7 §2.5. Plaintext on the wire (see Tables.kt's
  // UserWorkoutTemplates KDoc / T-134-18-01) — templates are never encrypted, so this is not a
  // new crypto boundary. `formatParams` is the device's raw authoring JSON, discriminated on its
  // own `workoutType` field; the MCP passes it through as text and does not parse or validate it
  // here (that lands in Plan 134-21). Absent on a CLASSIC template or a pre-Phase-134 row.
  //
  // CR-01 (134-REVIEW.md): the server's `Json` config has no `explicitNulls = false`
  // (`Application.kt`), and the column is nullable with NO backfill (`DatabaseFactory.kt`), so a
  // row whose column has never been (re-)written since the migration lands serializes as a
  // literal wire `null`, not an absent key — `| null` here is the true wire shape, not just a
  // defensive widening. `cache.ts`'s `templates: raw.templates` passes this through unchanged, so
  // every consumer of a decrypted snapshot's `template.workoutType`/`.formatParams` must treat
  // `null` and `undefined` identically (nullish checks, never strict `!== undefined`).
  workoutType?: string | null;
  formatParams?: string | null;
}

export interface SyncBlockDto {
  id: string;
  templateId: string;
  name: string;
  // G-134-37 (planhash-wire-defaults-parity.md): the Kotlin DTO gives this field the default
  // `1`, and BOTH the app's push `Json` (NetworkModule.kt) and the server's response `Json`
  // (Application.kt) run without `encodeDefaults` — so a block whose round count equals the
  // default serializes with the `rounds` KEY ABSENT, not `rounds: 1`. Optional here purely to
  // model the wire; `cache.ts`'s `normalizeWireBlock` re-inserts the default at the decode
  // boundary, and `NormalizedBlock` below carries it as pflichtig again. Rule for the next Wire
  // DTO field: a field is optional here IF AND ONLY IF the Kotlin DTO declares it a default.
  rounds?: number;
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface SyncRoundTargetDto {
  round: number;
  targetReps?: number;
  targetTimeSeconds?: number;
  targetWeight?: number;
}

export interface SyncTemplateExerciseDto {
  id: string;
  templateId: string;
  blockId?: string;
  exerciseId: string;
  // G-134-37: Kotlin default `"CATALOG"` — same encodeDefaults=false story as `rounds` above.
  // `BackupSyncService.kt` additionally hardcodes every pushed row's exerciseSource to
  // "CATALOG", so in practice this key is ALWAYS absent on the wire, never merely sometimes.
  exerciseSource?: string;     // "CATALOG" | "CUSTOM"
  mode: string;
  targetReps?: number;
  targetTimeSeconds?: number;
  restTimeSeconds: number;
  // G-134-37: Kotlin default `1` — same encodeDefaults=false story as `rounds` above.
  sets?: number;
  targetWeight?: number;
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  roundTargets?: SyncRoundTargetDto[];
}

/**
 * Session wire DTO. When encryptedPayload is non-null:
 *   startTime = 0 (zeroed), endTime = null (zeroed).
 * Real values live in encryptedPayload = {"st":<epoch>,"et":<epoch>}.
 */
export interface SyncSessionDto {
  id: string;
  templateId?: string;
  startTime: number;           // 0 when encryptedPayload != null
  endTime?: number;            // null when encryptedPayload != null
  isManual: boolean;
  isCorrected: boolean;
  isQuickChallenge: boolean;
  encryptedPayload?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * Set-log wire DTO. When encryptedPayload is non-null all metric fields are null.
 * Real values live in encryptedPayload = {"r":<reps>,"t":<timeSec>,"w":<weight>,"sa":<startedAt>,"mt":<measuredTimeSec>}.
 */
export interface SyncSetLogDto {
  id: string;
  sessionId: string;
  exerciseId?: string;
  exerciseSource?: string;
  workoutExerciseId?: string;
  completedReps?: number;      // null when encryptedPayload != null
  completedTimeSeconds?: number; // null when encryptedPayload != null
  weightUsed?: number;         // null when encryptedPayload != null
  startedAt?: number;          // null when encryptedPayload != null
  measuredTimeSeconds?: number; // null when encryptedPayload != null
  encryptedPayload?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * HR sample wire DTO. When encryptedPayload is non-null:
 *   timestampMs = 0, bpm = 0.
 * Real values live in encryptedPayload = {"ts":<timestampMs>,"bpm":<bpm>}.
 */
export interface SyncHrSampleDto {
  id: string;
  sessionId: string;
  timestampMs: number;         // 0 when encryptedPayload != null
  bpm: number;                 // 0 when encryptedPayload != null
  encryptedPayload?: string;
}

/**
 * One row in the misc-sync (M012) exchange — the generic zero-knowledge sync channel
 * for entities the server never parses (`planned_workout`, `training_state`, …). The
 * server only ever sees routing metadata; the entity content lives in
 * `encryptedPayload`, empty when this row is a tombstone (`deletedAt != null`).
 *
 * Source analogue: CalisthenicsServer SyncDtos.kt `MiscSyncRow` (:243-256).
 */
export interface MiscSyncRow {
  id: string;
  kind: string;
  clientLocalId: string;
  encryptedPayload: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** Root response from GET /api/mcp/data/pull (identical to McpDataPullResponse). */
export interface SyncPullResponse {
  syncedAt: number;
  // Phase 146: ALL eight list fields below are optional, for exactly the reason
  // `plannedWorkouts` and `settings` already state — `McpDataPullResponse` (SyncDtos.kt)
  // declares every one of them `= emptyList()`, and the server's `Json` runs with
  // `encodeDefaults = false`, so an empty list is dropped from the wire entirely. The
  // governing rule was already written down in `SyncBlockDto`'s comment — "a field is
  // optional here IF AND ONLY IF the Kotlin DTO declares it a default" — it had simply
  // only been applied to the two fields whose emptiness someone had actually hit.
  //
  // Measured 2026-09-22 against production for a user with no self-created exercises:
  // `exercises` and `exerciseTranslations` were BOTH absent from the response. Typed as
  // required, they reached `decryptMerge` as `undefined`, were assigned through unguarded,
  // and the first `.filter` on the snapshot threw `Cannot read properties of undefined
  // (reading 'filter')`. That single defect took down three of four read tools and all ten
  // `propose_new_plan` calls of Plan 146-07 — while `plannedWorkouts`, absent in the very
  // same response, passed through without a murmur because its `?? []` was there.
  exercises?: SyncExerciseDto[];
  exerciseTranslations?: SyncExerciseTranslationDto[];
  templates?: SyncTemplateDto[];
  blocks?: SyncBlockDto[];
  templateExercises?: SyncTemplateExerciseDto[];
  sessions?: SyncSessionDto[];
  setLogs?: SyncSetLogDto[];
  hrSamples?: SyncHrSampleDto[];
  // Phase 135 (SCHED-01): ciphertext-only planned-workout rows (kind 'planned_workout').
  // Optional — NOT required — because the Kotlin DTO (McpDataPullResponse) declares the
  // default `emptyList()` and the server's `Json` runs without `encodeDefaults`, so a
  // user with no planned workouts receives no `plannedWorkouts` key on the wire at all.
  // `SyncBlockDto`'s comment states the governing rule verbatim: a field is optional
  // here IF AND ONLY IF the Kotlin DTO declares it a default.
  plannedWorkouts?: MiscSyncRow[];
  // `trainingState` carries `@EncodeDefault(EncodeDefault.Mode.ALWAYS)` on the Kotlin
  // side (SyncDtos.kt), so it is ALWAYS present on the wire — explicitly `null` when
  // never written, distinguishable from "field absent" for an older client. Required
  // and nullable here for wire honesty; nothing reads it this phase (Phase 137 does).
  trainingState: MiscSyncRow | null;
  // Phase 137 (D-03): ciphertext, one row per synchronized `settings` key —
  // `clientLocalId` equals the key name, the same per-key mirror form
  // `SettingsSyncHandler.kt` already uses for the app's own settings sync
  // (Protocol §1.3). Optional — NOT required — because the server (Plan 137-03)
  // declares the same `emptyList()` default the other misc-sync rails use, so a
  // user with no synced settings receives no `settings` key on the wire at all.
  settings?: MiscSyncRow[];
}

// ---------------------------------------------------------------------------
// Decrypted variants (post decrypt-merge — encryptedPayload fields resolved)
// ---------------------------------------------------------------------------

/** Session after decrypt-merge: startTime/endTime are the real epoch values. */
export interface DecryptedSession extends Omit<SyncSessionDto, 'startTime' | 'endTime' | 'encryptedPayload'> {
  startTime: number;           // real epoch ms (never 0)
  endTime?: number;            // real epoch ms, or undefined if session is ongoing
}

/** Set-log after decrypt-merge: all metric fields are number | null (never undefined). */
export interface DecryptedSetLog extends Omit<SyncSetLogDto,
  'completedReps' | 'completedTimeSeconds' | 'weightUsed' | 'startedAt' | 'measuredTimeSeconds' | 'encryptedPayload'
> {
  completedReps: number | null;
  completedTimeSeconds: number | null;
  weightUsed: number | null;
  startedAt: number | null;
  measuredTimeSeconds: number | null;
}

/** HR sample after decrypt-merge: timestampMs and bpm are the real values. */
export interface DecryptedHrSample extends Omit<SyncHrSampleDto, 'timestampMs' | 'bpm' | 'encryptedPayload'> {
  timestampMs: number;         // real epoch ms
  bpm: number;                 // real heart-rate value
}

/**
 * Block after decrypt-merge (G-134-37): the SAME wire fields as `SyncBlockDto`, but `rounds`
 * is pflichtig again — `cache.ts`'s `normalizeWireBlock` is the one place that performs this
 * narrowing, by re-inserting the Kotlin default (`1`) wherever the wire key was absent. Two
 * types exist for the same row on purpose: before the decode boundary the wire is the truth
 * (the key can be missing), after it the normalization is the truth (the key is always
 * present) — so a future reader that forgets to normalize a newly-added default field gets a
 * compile error here, not a silent `undefined` in a hash string.
 */
export interface NormalizedBlock extends Omit<SyncBlockDto, 'rounds'> {
  rounds: number;
}

/**
 * Template-exercise after decrypt-merge (G-134-37): same story as `NormalizedBlock`, for the
 * two Kotlin-default fields `exerciseSource` ("CATALOG") and `sets` (`1`). Produced by
 * `cache.ts`'s `normalizeWireTemplateExercise`.
 */
export interface NormalizedTemplateExercise extends Omit<SyncTemplateExerciseDto, 'exerciseSource' | 'sets'> {
  exerciseSource: string;
  sets: number;
}

/**
 * Decrypted `planned_workout` root record (Phase 135, D-06). Exactly nine fields —
 * deliberately NO `calendarEventId` and NO `createdAt`: giving the type no field to
 * carry them enforces their omission from every downstream consumer (this tool's
 * output included) at compile time rather than by discipline (Protocol §2 "Omitted"
 * rows). `scheduledDate` stays epoch-ms here; it becomes an ISO string only at the LLM
 * boundary, inside the tool (Protocol §1.4 Rule 1).
 *
 * Source analogue: PlannedWorkoutSyncHandler.kt's private `PlannedWorkoutSnapshot`
 * (:60-73) — the wire-safe shape this type is decrypted from.
 */
export interface DecryptedPlannedWorkout {
  id: string;
  templateId: string;
  scheduledDate: number;
  scheduledTime: string | null;
  note: string | null;
  recurrenceRule: string | null;
  recurrenceGroupId: string | null;
  deletedOccurrencesRaw: string | null;
  completedSessionId: string | null;
}

/**
 * One decrypted `settings` row (Phase 137, D-03) — the per-key app-preference mirror
 * `SettingsSyncHandler.kt` maintains. `key` is `MiscSyncRow.clientLocalId`; `type` is the
 * type tag from the decrypted `SettingSnapshot.t` (`b`/`i`/`l`/`f`/`s`); `value` is always
 * the string-encoded form the app writes — this type never re-parses it to a native type,
 * matching the app's own "parsed back to the right type on pull" comment, which is the
 * app's own concern, not the coach's.
 */
export interface DecryptedSetting {
  key: string;
  type: string;
  value: string;
}

/** Full decrypted snapshot aggregate — what the tool handlers receive from the cache layer. */
export interface DecryptedSnapshot {
  syncedAt: number;
  exercises: SyncExerciseDto[];
  exerciseTranslations: SyncExerciseTranslationDto[];
  templates: SyncTemplateDto[];
  blocks: NormalizedBlock[];
  templateExercises: NormalizedTemplateExercise[];
  sessions: DecryptedSession[];
  setLogs: DecryptedSetLog[];
  hrSamples: DecryptedHrSample[];
  plannedWorkouts: DecryptedPlannedWorkout[];
  settings: DecryptedSetting[];
}

// ---------------------------------------------------------------------------
// Exercise catalog (from GET /api/exercises — unauthenticated public endpoint)
// Source: Dtos.kt ExerciseDto + MuscleGroupDto
// ---------------------------------------------------------------------------

export interface CatalogMuscleGroupTranslation {
  languageCode: string;
  name: string;
}

/**
 * Phase 138 (MUSC-05/MUSC-06) — the three graded involvement levels a muscle-group link can
 * carry. Verbatim mirror of the server's `MuscleInvolvement` / app's `MuscleInvolvementLevel`
 * vocabulary (Dtos.kt / MuscleInvolvementLevel.kt).
 */
export type MuscleInvolvementLevel = 'PRIMARY' | 'SECONDARY' | 'STABILIZER';

export interface CatalogMuscleGroup {
  id: string;
  key: string;                 // one of the 18 canonical muscle keys from MuscleGroupSeed.kt
  translations: CatalogMuscleGroupTranslation[];
  // The server already resolves a NULL involvement_level column to 'PRIMARY' (D-03,
  // MuscleGroupDto.involvementLevel's default) before this DTO is ever serialized — the
  // catalog type therefore never observes an absent/null value and can declare this required.
  involvementLevel: MuscleInvolvementLevel;
}

export interface CatalogTranslation {
  languageCode: string;
  name: string;
  description?: string;
}

export interface CatalogEquipment {
  equipmentId: string;
  key: string;
  nameEn: string;
  isOptional: boolean;
}

/**
 * Phase 138.1 tracer — the capability-involvement level vocabulary, mirroring the server's
 * `CapabilityInvolvement` object (db/CapabilityInvolvement.kt). Provisional pending the
 * Product-Owner checkpoint in plan `138.1-06` (see `138.1-01-PLAN.md`).
 */
export type CapabilityInvolvementLevel = 'HAUPTREIZ' | 'MITTRAINIERT' | 'GERING';

export interface CatalogCapabilityAxisTranslation {
  languageCode: string;
  name: string;
}

/**
 * Second classification axis alongside [CatalogMuscleGroup] (Phase 138.1 tracer, D-01/D-05).
 *
 * Unlike `CatalogMuscleGroup.involvementLevel`, `capabilityLevel` here is required for a
 * different reason than "the server resolves a default": there IS no default to resolve (D-04).
 * An exercise that doesn't train a given capability simply carries no entry for that axis in
 * `CatalogExercise.capabilities` — the field is required because every entry that DOES exist
 * always has an explicit level, never because a missing value gets filled in.
 */
export interface CatalogCapabilityAxis {
  id: string;
  key: string;
  translations: CatalogCapabilityAxisTranslation[];
  capabilityLevel: CapabilityInvolvementLevel;
}

/**
 * ExerciseDto from GET /api/exercises — includes muscleGroups used by get_stats { by:'muscle' }.
 *
 * **This is the NORMALIZED, internal shape — every field below is safe to read unguarded.**
 * `muscleGroups`, `id`, `key`, etc. have no Kotlin-side default (`Dtos.kt`'s `ExerciseDto`
 * declares them without `= ...`), so kotlinx.serialization's `encodeDefaults = false` can never
 * omit them from the wire regardless of content — those fields are honestly required both on
 * the wire and here.
 *
 * `equipment`, `isSkill`, and `capabilities` are DIFFERENT: `Dtos.kt` gives all three Kotlin-side
 * defaults (`= emptyList()` / `= false`), so the server OMITS THEM ENTIRELY from the JSON
 * whenever an exercise carries only the default value — not a rare edge case: measured directly
 * against the production catalog (138.1 gap-closure), 75/189 exercises omit `capabilities` and
 * 164/189 omit `isSkill`. See `CatalogExerciseWire` for the honest wire type. `cache.ts`'s
 * `normalizeCatalog()` is the ONE seam that turns a `CatalogExerciseWire[]` into this type —
 * every consumer in this codebase reads catalog data exclusively via `getSnapshot()`, which
 * calls that normalizer, so `equipment`/`isSkill`/`capabilities` are guaranteed real values here.
 * Never add a second path that reads `fetchCatalog()`'s result directly — route it through
 * `normalizeCatalog()` instead, or this contract silently breaks again (CAP-05 gap, 2026-09-06).
 */
export interface CatalogExercise {
  id: string;
  key: string;
  nameEn: string;
  mode: string;
  usesWeight: boolean;
  description?: string;
  lastModifiedAt: number;
  translations: CatalogTranslation[];
  muscleGroups: CatalogMuscleGroup[];
  equipment: CatalogEquipment[];
  easierVariantId?: string;
  harderVariantId?: string;
  /**
   * CAP-07/D-07 (138.1-21) — replaces the retired STRENGTH/STRETCH/MOBILITY/SKILL `category`
   * axis. `SKILL` does not resolve into a capability axis (D-07: "Handstand ist eine
   * Faehigkeit" is a statement about the exercise, not a trained capability) — this field
   * carries that user-facing label to the coach instead, so retiring `category` loses no
   * information. Optional here purely as a defensive parsing convention (matches
   * `CatalogMuscleGroup`-adjacent optional fields elsewhere) — by the time any tool reads it,
   * `normalizeCatalog()` has already resolved an absent wire value to `false`.
   */
  isSkill?: boolean;
  capabilities: CatalogCapabilityAxis[];
  /**
   * Phase 141-18 (G-141-2-SCOPE) — provenance of this catalog entry. `'CATALOG'` for every
   * entry `normalizeCatalog()` builds from the curated `GET /api/exercises` response;
   * `'CUSTOM'` for a user's own exercise projected into the merged catalog from
   * `snapshot.exercises` (see `projectUserExerciseToCatalog` in `cache.ts`). Required, not
   * optional, so the type checker finds every construction site — the same reasoning that
   * made `capabilities` required after the CAP-05 gap. A `'CUSTOM'` entry carries no muscle,
   * equipment or capability rating (see that field's own doc); the coach uses `origin` to
   * tell an unrated exercise apart from a rated one with zero values.
   */
  origin: 'CATALOG' | 'CUSTOM';
}

/**
 * The RAW shape `fetchCatalog()` receives from `GET /api/exercises`, before normalization.
 *
 * `capabilities`, `equipment`, and `isSkill` are optional here — and ONLY here — because they
 * are genuinely, routinely absent on the wire (see `CatalogExercise`'s doc for the measured
 * 75/189 and 164/189 figures). This type exists so the type system tells the truth about what
 * `fetchCatalog()` can actually return, instead of `CatalogExercise` silently lying about a
 * field the server can omit (the CAP-05 root cause, 2026-09-06 gap-closure). `cache.ts`'s
 * `normalizeCatalog()` is the only place allowed to construct a `CatalogExercise` from this type.
 *
 * `origin` is excluded too — like `capabilities`/`equipment`/`isSkill`, it does not come off
 * the wire at all. It is stamped on in the one seam (`normalizeCatalog()` for curated entries,
 * `projectUserExerciseToCatalog()` for a user's own), never read from `GET /api/exercises`.
 */
export type CatalogExerciseWire = Omit<CatalogExercise, 'capabilities' | 'equipment' | 'isSkill' | 'origin'> & {
  capabilities?: CatalogCapabilityAxis[];
  equipment?: CatalogEquipment[];
  isSkill?: boolean;
};

// ---------------------------------------------------------------------------
// Profile (from GET /api/mcp/profile — PAT-authed)
// Source: ProfileRoutes.kt UserProfileResponse
// ---------------------------------------------------------------------------

export interface UserProfileResponse {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  isPremium: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Propose-only WRITE contract (POST /api/mcp/suggest — PAT-authed)
// Source: CalisthenicsServer McpDtos.kt SuggestRequest / SuggestionDto (Phase 118, LOCKED)
// Server validates only that the 5 required fields are non-blank; never
// recomputes changeHash/planHash; never parses payload structure.
// ---------------------------------------------------------------------------

export interface SuggestRequestBody {
  type: 'plan_update' | 'new_plan' | 'new_exercise' | 'planned_update';
  payload: string;          // JSON.stringify(canonical payload) — UUID-referencing only
  rationale: string;
  sourceLlm: string;
  changeHash: string;       // 64-char lowercase hex SHA-256
  planHash?: string;        // 64-char lowercase hex SHA-256; plan_update only
  // Phase 133 (D-08/D-09), Phase 136 (producer) — the planned_update stale-guard,
  // client-computed and server-trusted verbatim (never recomputed server-side).
  // Required (64-char lowercase hex) for type='planned_update', absent otherwise —
  // mirrors CalisthenicsServer's SuggestRequest.seriesHash exactly.
  seriesHash?: string;
}

export interface SuggestionDtoResponse {
  id: string;
  type: string;
  payload: string;
  rationale: string;
  sourceLlm: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  planHash: string | null;
  // Phase 136 (D-08/D-09), PROP-10 — the same wire DTO the server returns from the
  // PAT read-back route (`GET /api/mcp/coach/suggestions/{id}`, src/http.ts's
  // `fetchSuggestion`) also flows through `postSuggest`'s response — both share the
  // Kotlin `SuggestionDto`. Both fields are optional here because `postSuggest`'s
  // create-time response never carries them (a fresh `pending` row has neither an
  // applied payload nor is `seriesHash` echoed back by that route today), while a
  // single-fetch read-back may.
  appliedPayload?: string | null;
  seriesHash?: string | null;
}

// ---------------------------------------------------------------------------
// Coach proposal read-back / withdraw contract types (Phase 136, D-08/D-09,
// PROP-10/PROP-11). Mirror CalisthenicsServer's McpDtos.kt `SuggestionSummaryDto`
// field-for-field — the summary projection for `GET /api/mcp/coach/suggestions`
// (src/http.ts's `fetchSuggestions`). Deliberately no `payload`/`appliedPayload`
// member (D-09, T-136-16) — a full row comes only from `SuggestionDtoResponse`
// via `fetchSuggestion`.
// ---------------------------------------------------------------------------

export interface SuggestionSummaryDtoResponse {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  targetLabel: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Op-list / plan-update contract types (D-03, RESEARCH.md Pattern 5)
// Used by propose_plan_update / propose_new_plan (Plans 03/04).
// ---------------------------------------------------------------------------

/** Reference to an exercise: either an existing catalog UUID or a proposal-local temp id. */
export type ExerciseRef =
  | { source: 'catalog'; exerciseId: string }
  | { source: 'new'; tempId: string };

export interface RoundTargetInput {
  round: number;
  targetReps?: number;
  targetTimeSeconds?: number;
  targetWeight?: number;
}

/** A single structural change to an existing template, referencing exercises by UUID/tempId only. */
export type PlanOp =
  | {
      op: 'addExercise';
      blockId: string | null;      // null = standalone (top-level) exercise
      exercise: ExerciseRef;
      mode: 'REPS' | 'TIME' | 'MAX';
      // Phase 134 (G-134-12): widened to `| null` — see schemas.ts's PlanOpSchema
      // KDoc for why (the shared formatProposal corpus encodes "not set" as literal
      // JSON `null` for these four fields, mirroring Kotlin's nullable defaults).
      targetReps?: number | null;
      targetTimeSeconds?: number | null;
      restTimeSeconds: number;
      sets: number;
      targetWeight?: number | null;
      orderIndex: number;
      roundTargets?: RoundTargetInput[] | null;
    }
  | { op: 'removeExercise'; workoutExerciseId: string }
  | {
      op: 'updateSetsReps';
      workoutExerciseId: string;
      sets?: number;
      targetReps?: number;
      targetTimeSeconds?: number;
      targetWeight?: number;
      restTimeSeconds?: number;
      roundTargets?: RoundTargetInput[];
    }
  | { op: 'reorder'; blockId: string | null; order: string[] };

/** A brand-new exercise defined inline within a proposal (never a direct catalog write). */
export interface NewExerciseDef {
  tempId: string;
  name: string;
  mode: 'REPS' | 'TIME' | 'MAX';
  usesWeight: boolean;
  // Phase 134 (G-134-12): widened to `| null` — see schemas.ts's NewExerciseDefSchema
  // KDoc for why.
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Format-template plan_update contract (Phase 134, G-134-12, Protocol v1.7 §2.5).
// Mirrors schemas.ts's FormatParamsSchema field-for-field — see that file for the
// runtime validation this type only describes statically. Hand-written (not
// z.infer), matching this file's existing style for ExerciseRef/PlanOp above.
// ---------------------------------------------------------------------------

/** `formatExerciseEntry` — mode, target and weight. Used by CIRCUIT/AMRAP/FOR_TIME/
 * CHIPPER's `exercises` and EMOM's `stations`. `mode` excludes `'MAX'` deliberately —
 * see schemas.ts's `FormatExerciseEntrySchema` KDoc. */
export interface FormatExerciseEntryProposal {
  exercise: ExerciseRef;
  mode: 'REPS' | 'TIME';
  targetReps?: number | null;
  targetTimeSeconds?: number | null;
  orderIndex: number;
  targetWeight?: number | null;
}

/** `formatSlotEntry` — exercise and order only. Used by TABATA's `exercises`. */
export interface FormatSlotEntryProposal {
  exercise: ExerciseRef;
  orderIndex: number;
}

/** `formatWeightEntry` — exercise, order and weight, no mode/target. Used by LADDER
 * and DEATH_BY's `exercises`. */
export interface FormatWeightEntryProposal {
  exercise: ExerciseRef;
  orderIndex: number;
  targetWeight?: number | null;
}

/**
 * The strict, discriminated wire form of a format template's authoring parameters,
 * as carried by `plan_update`'s `formatParams` field. Discriminated on `workoutType`,
 * exactly like `ExerciseRef` is discriminated on `source`. All eight members —
 * field-for-field mirrors of `schemas.ts`'s `FormatParamsSchema` and of the
 * Kotlin `FormatParamsProposal` sealed class (TrainCounter, Plans 134-19/134-20).
 */
export type FormatParamsProposal =
  | {
      workoutType: 'CIRCUIT';
      rounds: number;
      restSeconds: number;
      exercises: FormatExerciseEntryProposal[];
    }
  | {
      /** TOTAL intervals across the whole workout, not per-station — see
       * `FormatExerciseEntrySchema`'s `orderIndex` KDoc in schemas.ts. */
      workoutType: 'EMOM';
      windowSeconds: number;
      rounds: number;
      stations: FormatExerciseEntryProposal[];
    }
  | {
      workoutType: 'AMRAP';
      timeCapMinutes: number;
      exercises: FormatExerciseEntryProposal[];
    }
  | {
      /** No per-entry mode/target — see `FormatSlotEntryProposal`. */
      workoutType: 'TABATA';
      workSeconds: number;
      restSeconds: number;
      rounds: number;
      exercises: FormatSlotEntryProposal[];
    }
  | {
      /** `repsPerRound` is AUTHORITATIVE — its length is the round count.
       * `pattern`/`startReps`/`step` are generator inputs only, never regenerated. */
      workoutType: 'LADDER';
      pattern: 'ASCENDING' | 'DESCENDING' | 'PYRAMID' | 'PYRAMID_REVERSE';
      startReps: number;
      step: number;
      restSeconds: number;
      repsPerRound: number[];
      exercises: FormatWeightEntryProposal[];
    }
  | {
      workoutType: 'FOR_TIME';
      rounds: number;
      raceTimer: boolean;
      exercises: FormatExerciseEntryProposal[];
    }
  | {
      /** Shares FOR_TIME's shape exactly, INCLUDING `rounds` — the app always
       * normalizes it to `1` at apply time; see schemas.ts's `FormatParamsSchema`
       * CHIPPER member KDoc for why the field stays on the wire regardless. */
      workoutType: 'CHIPPER';
      rounds: number;
      raceTimer: boolean;
      exercises: FormatExerciseEntryProposal[];
    }
  | {
      /** Same shape as LADDER minus `pattern`. */
      workoutType: 'DEATH_BY';
      startReps: number;
      step: number;
      roundCap: number;
      exercises: FormatWeightEntryProposal[];
    };
