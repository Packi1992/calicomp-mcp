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

/**
 * An own exercise on the wire. Phase 164 (CRYPT-01, protocol 1.45 §1.9): with
 * `?exerciseCipher=1` a row of a migrated account carries `encryptedPayload` and only
 * placeholders in `name`/`mode`/`usesWeight`/`description` (`""`, `"REPS"`, `false`, absent).
 * `cache.ts`'s `decryptMerge` reads such a row only from the ciphertext and hands every tool
 * the plaintext shape without `encryptedPayload` — a snapshot row never carries it.
 */
export interface SyncExerciseDto {
  id: string;
  name: string;
  mode: string;                // "REPS" | "TIME" | "MAX"
  usesWeight: boolean;
  description?: string;
  /** Phase 164: the opaque ciphertext of the row (§1.9); absent on a plaintext row. */
  encryptedPayload?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * A translation of an own exercise on the wire. `id`, `createdAt` and `updatedAt` have always
 * been sent by the server (`SyncDtos.kt`) and are optional here only because older fixtures
 * omit them. Phase 164 (§1.9): a row with `encryptedPayload` carries placeholders in `name` and
 * `description`; `exerciseId` and `languageCode` stay plaintext.
 */
export interface SyncExerciseTranslationDto {
  id?: string;
  exerciseId: string;
  languageCode: string;
  name: string;
  description?: string;
  /** Phase 164: the opaque ciphertext of the row (§1.9); absent on a plaintext row. */
  encryptedPayload?: string;
  createdAt?: number;
  updatedAt?: number;
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
  // Phase 155 (FA-08, E-9): ciphertext-only foreign sport rows — kinds
  // `foreign_activity_type`, `foreign_activity` and `planned_foreign_activity`
  // (protocol §1.3 "Why foreign sport is here", §1.6 "Decoded rows"). UNLIKE every other
  // list above, the server (Plan 155-03) sends these three ALWAYS (`@EncodeDefault(ALWAYS)`),
  // an empty list included. Optional here anyway: a key that is missing means the server
  // predates Phase 155, and `decryptMerge` then leaves the matching snapshot field out
  // instead of inventing an empty list (`read-guard.ts`'s `foreignSportAvailability`
  // reports `server_without_foreign_sport`).
  foreignActivityTypes?: MiscSyncRow[];
  foreignActivities?: MiscSyncRow[];
  plannedForeignActivities?: MiscSyncRow[];
  // Phase 156 (REN-01, D-11): ciphertext-only own names of catalog exercises — kind
  // `exercise_name_override`, live rows only (protocol §1.3, §1.7 "Decoded rows"). The
  // server (Plan 156-04) sends this field ALWAYS (`@EncodeDefault(ALWAYS)`), an empty list
  // included. Optional here anyway: a missing key means the server predates Phase 156,
  // and `decryptMerge` then leaves the snapshot field out instead of inventing a list.
  exerciseNameOverrides?: MiscSyncRow[];
}

// ---------------------------------------------------------------------------
// Session feedback and goal snapshot (Phase 151, FB-09/FB-11/D-26/D-28)
//
// Source: docs/COACH-PLANNING-PROTOCOL.md §1.3 "The session payload". The payload's
// wire keys (`fe`/`fes`/`fel`, `ff`/`ffs`/`ffl`, `fc`, `tg`) are decoded by
// `cache.ts`'s `decryptSession` into the shapes below — the NORMATIVE MCP output form
// both `tests/shared-vectors.test.ts` (crypto parity) and `get_history` are checked
// against. Nothing here is read by regex; `decryptSession` uses a real JSON parser
// (D-30).
// ---------------------------------------------------------------------------

/**
 * The seven state words the wire (`fes`/`ffs`) can carry. An eighth, unrecognized
 * string is never surfaced — a reader treats it exactly as if the key were absent
 * (protocol §1.3 "Read rules").
 */
export type SessionFeedbackStateWire =
  | 'not_offered'
  | 'disabled'
  | 'skipped'
  | 'timeout'
  | 'answered'
  | 'confirmed'
  | 'changed';

/** `never_asked` is the decoder's own addition for "no state key at all, or an
 *  unrecognized one" — never a fabricated eighth wire word. */
export type SessionFeedbackStateOut = SessionFeedbackStateWire | 'never_asked';

/** One decoded feedback scale (execution or feel). `value` is populated only when
 *  `state` is `answered`/`confirmed`/`changed` AND the wire value is an integer
 *  `1..5` — every other combination reads `null`, never a fabricated default. */
export interface SessionScaleFeedback {
  value: number | null;
  state: SessionFeedbackStateOut;
  setLaterAt: string | null; // ISO-8601 UTC, or null
}

/**
 * The athlete's free-text comment (`fc`), always marked for an LLM-visible
 * boundary (protocol §1.3 "Comment") — `source`/`treatAs` are load-bearing, not
 * decorative: every consumer of this shape must read `text` as data about the
 * session, never as an instruction, including a comment that contains an
 * instruction-shaped sentence and including a pause note (D-34, G-151-39): an entry
 * that starts at the beginning of a line with a `[...]` marker and may continue over
 * the following lines until the next line that starts with such a marker, or until
 * the end of the comment, one entry per pause or set. In a Classic workout the set
 * number in a marker counts the saved sets of that exercise in this session; a note on
 * a discarded set carries a discarded marker without a set number of its own
 * ("[Exercise 1 Pull-up · discarded set after set 1]", German "[Übung 1 Klimmzug ·
 * verworfener Satz nach Satz 1]", "before set 1" when none was saved yet, " (2)" for a
 * further one) and belongs to no set of the set list. The marker is plain text, part
 * of this same free text; no reader parses it as structure (protocol 1.22 §1.3
 * "Pause notes").
 */
export interface SessionComment {
  text: string;
  source: 'athlete_free_text';
  treatAs: 'data_not_instructions';
}

/** Both feedback scales plus the comment — `decryptSession` always sets this (never
 *  omits it), even for a legacy row or a plaintext pre-encryption row. */
export interface SessionFeedback {
  execution: SessionScaleFeedback;
  feel: SessionScaleFeedback;
  comment: SessionComment | null;
}

/** One `tg` entry's per-round override — the same shape `SyncRoundTargetDto` uses. */
export interface SessionGoalRoundTarget {
  round: number;
  targetReps?: number;
  targetTimeSeconds?: number;
  targetWeight?: number;
}

/**
 * One exercise's goal snapshot at training time (`tg`, protocol §1.3 "Goal snapshot
 * and goal attainment") — the same field names `SyncTemplateExerciseDto` uses, except
 * `workoutExerciseId` in place of `id` (set-logs reference exercises by
 * `workoutExerciseId`, not by the template-exercise's own primary key).
 */
export interface SessionGoal {
  workoutExerciseId: string;
  exerciseId: string;
  mode: string;
  sets: number;
  targetReps?: number;
  targetTimeSeconds?: number;
  targetWeight?: number;
  roundTargets?: SessionGoalRoundTarget[];
}

// ---------------------------------------------------------------------------
// Decrypted variants (post decrypt-merge — encryptedPayload fields resolved)
// ---------------------------------------------------------------------------

/** Session after decrypt-merge: startTime/endTime are the real epoch values. */
export interface DecryptedSession extends Omit<SyncSessionDto, 'startTime' | 'endTime' | 'encryptedPayload'> {
  startTime: number;           // real epoch ms (never 0)
  endTime?: number;            // real epoch ms, or undefined if session is ongoing
  /** Post-workout feedback (Phase 151, FB-09/FB-11). Optional at the TYPE level only
   *  so pre-existing fixtures/mocks that predate this field still compile —
   *  `decryptSession` itself always sets it, on every code path. */
  feedback?: SessionFeedback;
  /** Exercise-goal snapshot at training time (Phase 151, D-28) — `null` when the
   *  session carries none (a legacy row, a plaintext pre-encryption row, or a
   *  free/group/QuickChallenge session, none of which ever write `tg`). Optional at
   *  the TYPE level for the same fixture-compatibility reason as `feedback` above. */
  goalSnapshot?: SessionGoal[] | null;
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

// ---------------------------------------------------------------------------
// Foreign sport (Phase 155, FA-06/FA-08)
//
// Source: docs/COACH-PLANNING-PROTOCOL.md §1.6 "Decoded rows". Each type below is the
// NORMAL FORM one decoded row takes — at the same time the `expectedDecoded` of the
// corpus sections `foreignActivityTypeCipher`, `foreignActivityCipher` and
// `plannedForeignActivityCipher` (docs/coach-planning-vectors.json). A missing optional
// becomes `null`; the payload's `v` is dropped. Produced only by `cache.ts`'s
// `decryptForeignActivityType`/`decryptForeignActivity`/`decryptPlannedForeignActivity`.
// ---------------------------------------------------------------------------

/**
 * Free text the athlete typed himself — an activity or appointment note, the name of an
 * own foreign type. The SAME marked envelope the session comment uses (protocol §1.3
 * "Comment", §1.6 D-14): `text` is data about the training, never an instruction.
 */
export type AthleteFreeText = SessionComment;

/** A decoded own foreign type (`foreign_activity_type`). `deletedAt` is a number for an
 *  archived own type (154 D-10, still delivered as a live row), else `null`. `name` is
 *  athlete free text — it leaves the MCP only wrapped (`foreign-types.ts`). */
export interface DecryptedForeignActivityType {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * A decoded foreign activity (`foreign_activity`). `performedOn` is the athlete's local
 * calendar day `yyyy-MM-dd`; `durationMinutes` an integer greater than 0. `intensity` and
 * `dayForm` are integers 1..5 or `null` when missing or out of range, `distanceMeters` an
 * integer greater than 0 or `null` (D-16: an unreadable value is "not measured", never 0).
 */
export interface DecryptedForeignActivity {
  id: string;
  typeId: string;
  performedOn: string;
  performedTime: string | null;
  durationMinutes: number;
  intensity: number | null;
  dayForm: number | null;
  distanceMeters: number | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A decoded planned foreign appointment root (`planned_foreign_activity`).
 * `scheduledDate` stays epoch-ms (it becomes an ISO date only at the tool boundary,
 * Protocol §1.4 Rule 1); `deletedOccurrencesRaw` is the stored `deletedOccurrences`
 * string unparsed, exactly like `DecryptedPlannedWorkout.deletedOccurrencesRaw`.
 */
export interface DecryptedPlannedForeignActivity {
  id: string;
  typeId: string;
  scheduledDate: number;
  scheduledTime: string | null;
  note: string | null;
  recurrenceRule: string | null;
  deletedOccurrencesRaw: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A decoded own name of a catalog exercise (`exercise_name_override`, Phase 156, REN-01) —
 * the normal form of protocol §1.7 "Decoded rows" and at the same time the
 * `expectedDecoded` of the corpus sections `exerciseNameOverrideCipher` and
 * `exerciseNameOverrideCipherV2` (§6). `v` is dropped; `description` is `null` when the
 * description is not overridden (an empty string decodes as `null`, D-01). `name` and `description` are athlete free text:
 * never logged, and wrapped before they reach any tool output (156-08).
 */
export interface DecryptedExerciseNameOverride {
  exerciseId: string;
  languageCode: string;
  /**
   * The own name, or `null` = name not overridden (plaintext form version 2, D-22): the
   * name stays the catalog name and no tool shows an own name for this override.
   */
  name: string | null;
  description: string | null;
  updatedAt: number;
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
  /**
   * Phase 155 (FA-08, E-9): the three foreign sport lists. OPTIONAL on purpose, for two
   * reasons: (1) a key is left out when the server did not send the matching wire field
   * (a server older than Phase 155) — absence means "unknown", never "no foreign sport";
   * (2) every existing snapshot fixture of the test suite stays valid unchanged (Pitfall 2).
   * Read availability through `read-guard.ts`'s `foreignSportAvailability`, never by
   * defaulting a missing list to `[]`.
   */
  foreignActivityTypes?: DecryptedForeignActivityType[];
  foreignActivities?: DecryptedForeignActivity[];
  plannedForeignActivities?: DecryptedPlannedForeignActivity[];
  /**
   * Phase 156 (REN-01, D-11): the readable own names of catalog exercises. OPTIONAL for
   * the same two reasons as the foreign lists above: the key is left out when the server
   * did not send `exerciseNameOverrides` (a server older than Phase 156), and every
   * existing snapshot fixture stays valid unchanged. An unreadable override row is not in
   * this list; it is counted in the `DecodeReport` and degrades only its own exercise (D-10).
   */
  exerciseNameOverrides?: DecryptedExerciseNameOverride[];
  /**
   * Phase 164 (CRYPT-01, D-25; protocol 1.45 §1.9 "Links ride in the payload"): the decoded
   * muscle-group, equipment and capability links of every own exercise that arrived as
   * ciphertext, keyed by the exercise id, beside `exercises` (the plaintext row shape has no
   * place for them). OPTIONAL: left out when no own exercise arrived as ciphertext (a plaintext
   * account, a server before 1.45), so every existing snapshot fixture stays valid. The catalog
   * projection (`projectUserExerciseToCatalog`) maps them onto catalog keys.
   */
  ownExerciseLinks?: Record<string, import('./own-exercise-cipher.js').OwnExerciseLinks>;
}

// ---------------------------------------------------------------------------
// Per-row decode fault tolerance (Phase 150, D-08/D-09/D-10/D-11/D-12).
//
// `decryptMerge` (cache.ts) used to throw on the first bad row of ANY entity, failing
// every tool that calls `getSnapshot()`. It now decodes each row, collects failures into
// a `DecodeReport` carried BESIDE the snapshot (never inside `DecryptedSnapshot` — every
// pure metric function above stays byte-identical and every existing snapshot fixture
// stays valid), and leaves the strictness decision to the tool boundary
// (`read-guard.ts`'s `assertEntitiesReadable`/`assertCalendarReadable`).
//
// `sessionKind` (D-10's "kind") is set on `session`-entity `UnreadableRow`s by the shared
// classifier introduced in Plan 150-04 (`session-kind.ts`'s `classifySession`), computed
// WITHOUT a template index (no `templateStatus`) — the plaintext routing fields already on
// the row (`templateId`, `isQuickChallenge`) are all `classifySession` needs.
// ---------------------------------------------------------------------------

/** The eleven row kinds `decryptMerge` can fail to decode (three since Phase 155, one since
 *  Phase 156, the last two since Phase 164). `exerciseNameOverride` belongs to no readability
 *  check of any tool: an unreadable override only takes away its own exercise's own name (D-10).
 *  `exercise` and `exerciseTranslation` (own exercises with ciphertext, protocol 1.45 §1.9) belong
 *  to none either: an unreadable own exercise is left out of the snapshot and degrades only
 *  itself — a tool then names it `exerciseUnknown`, never with a placeholder name. */
export type UnreadableEntity =
  | 'session'
  | 'setLog'
  | 'hrSample'
  | 'plannedWorkout'
  | 'setting'
  | 'foreignActivityType'
  | 'foreignActivity'
  | 'plannedForeignActivity'
  | 'exerciseNameOverride'
  | 'exercise'
  | 'exerciseTranslation';

/**
 * Why a row could not be decoded. `unknown_version` only ever applies to
 * `plannedWorkout`/`setting`, the three foreign sport kinds
 * (`foreignActivityType`/`foreignActivity`/`plannedForeignActivity`, Phase 155) and
 * `exerciseNameOverride` (Phase 156) —
 * session/setLog/hrSample payloads carry no `v` field (§Befund 3a of the phase research).
 */
export type UnreadableReason = 'decrypt_failed' | 'malformed_payload' | 'unknown_version';

/**
 * One row that could not be decoded, carrying only the plaintext routing fields the
 * wire DTO already exposes — never plaintext training content, ciphertext, or key
 * material (T-120-17). Fields beyond `entity`/`id`/`reason` are optional because they
 * vary by entity (an HR sample has no `createdAt`/`updatedAt`; only `session` carries
 * `templateId`/`isQuickChallenge`; only `setLog`/`hrSample` carry `sessionId`; only
 * `setting` carries `key`).
 */
export interface UnreadableRow {
  entity: UnreadableEntity;
  id: string;
  reason: UnreadableReason;
  createdAt?: number;
  updatedAt?: number;
  templateId?: string;
  isQuickChallenge?: boolean;
  /** Only on `session` rows (Plan 150-04) — computed by `classifySession` without a
   *  template index, so never carries `templateStatus`. */
  sessionKind?: import('./session-kind.js').SessionKind;
  sessionId?: string;
  key?: string;
  /** Set-logs of an unreadable session are removed from the snapshot and counted here
   *  instead of appearing individually in `unreadable` (D-10). Only on `session` rows. */
  affectedSetLogCount?: number;
  /** Same as `affectedSetLogCount`, for HR samples. Only on `session` rows. */
  affectedHrSampleCount?: number;
}

/**
 * The decode report `decryptMerge` returns beside the decrypted snapshot. `encryptedCount`
 * counts the rows of each kind that carry ciphertext (a decrypt was attempted) — never
 * plaintext-only rows, so an all-plaintext, pre-encryption account never trips the
 * "wrong key" guard. It is the denominator of `read-guard.ts`'s `assertEntitiesReadable`
 * (D-11); the numerator there is the number of `decrypt_failed` rows in `unreadable`, NOT
 * `failedCount` (Phase 150 review WR-01). `failedCount` counts every row of a kind that
 * could not be decoded for any reason, including rows without ciphertext (empty-payload
 * tombstones) — `assertCalendarReadable` (D-09) and the D-32 degrade path read it.
 */
export interface DecodeReport {
  unreadable: UnreadableRow[];
  encryptedCount: Record<UnreadableEntity, number>;
  failedCount: Record<UnreadableEntity, number>;
  /**
   * Phase 164 (D-25, protocol 1.45 §1.9 "Links ride in the payload"): the links of own
   * exercises the catalog projection left out — a link id the catalog the MCP holds does not
   * know (never invented), and a capability link without level (no grade to weigh, D-04).
   * Counts only, never an id or a name. Present only when an own exercise arrived as ciphertext.
   */
  ownExerciseLinksLeftOut?: OwnExerciseLinksLeftOut;
}

/** Phase 164: counts of own-exercise links the catalog projection left out (see `DecodeReport`). */
export interface OwnExerciseLinksLeftOut {
  unknownMuscleGroup: number;
  unknownEquipment: number;
  unknownCapability: number;
  capabilityWithoutLevel: number;
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
   * made `capabilities` required after the CAP-05 gap. A `'CUSTOM'` entry carries the muscle,
   * equipment and capability links the athlete set, once its row arrived as ciphertext (Phase
   * 164, D-25); a plaintext row carries none and stays unrated. The coach uses `origin` to tell
   * an own exercise apart from a curated one.
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
  | { op: 'reorder'; blockId: string | null; order: string[] }
  // Phase 166 (plan 166-08, MCP-05, D-12): protocol §2.6 "Block ops: updateBlock and addBlock".
  | { op: 'updateBlock'; blockId: string; rounds: number }
  | { op: 'addBlock'; rounds: number; orderIndex: number; exercises: BlockExerciseInput[] };

/**
 * One exercise of a block a proposal creates: `addBlock.exercises[]` (plan_update) and
 * `blocks[].exercises[]` / `standalone[]` (new_plan) share this form (`NewPlanExerciseInputSchema`,
 * protocol §2.6 "Field Reference"); `orderIndex` is block-local inside a block.
 */
export interface BlockExerciseInput {
  exercise: ExerciseRef;
  mode: 'REPS' | 'TIME' | 'MAX';
  targetReps?: number;
  targetTimeSeconds?: number;
  restTimeSeconds: number;
  sets: number;
  targetWeight?: number;
  orderIndex: number;
  roundTargets?: RoundTargetInput[];
}

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
