/**
 * Loader + shape validation for the shared coach-planning test-vector corpus
 * (docs/coach-planning-vectors.json) living in the CaliCompanion super-repo, above this
 * CalisthenicsCompanion-MCP submodule checkout.
 *
 * D-01: single canonical source, no copies, no sync step, no generator — both this
 * TypeScript loader and TrainCounter's CoachPlanningVectorsLoader.kt read the same file.
 * D-02: fails LOUDLY (never a silent skip, never a default value) if the corpus is
 * unreachable, and Zod parse failures propagate rather than being swallowed — a malformed
 * corpus edit must fail loudly at load time, not produce silently wrong test results.
 *
 * Path resolution uses this module's own file URL (dirname), not process.cwd() — resolves
 * identically regardless of which directory `npm test`/`vitest run` is invoked from.
 *
 * Shape source: docs/COACH-PLANNING-PROTOCOL.md.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ISO_DATE, ProposePlannedUpdateSchema } from '../src/schemas.js';
import type { CatalogExercise, DecryptedSnapshot } from '../src/types.js';

/** Path to the corpus, relative to this file's own directory (tests/). */
export const CORPUS_RELATIVE_PATH = '../../docs/coach-planning-vectors.json';

/** Resolve the absolute corpus path, cwd-independent. [fromDir] defaults to this file's dir. */
export function resolveCorpusPath(fromDir?: string): string {
  const baseDir = fromDir ?? dirname(fileURLToPath(import.meta.url));
  return join(baseDir, CORPUS_RELATIVE_PATH);
}

const ExpansionVectorSchema = z.object({
  name: z.string().min(1),
  startDate: ISO_DATE,
  rrule: z.string().min(1),
  rangeStart: ISO_DATE,
  rangeEnd: ISO_DATE,
  deletedOccurrences: z.array(ISO_DATE),
  expectedDates: z.array(ISO_DATE),
  /**
   * The `deletedOccurrences` STORED COLUMN, verbatim (phase 135, D-09). When present, this
   * is the raw text the app would have written to `PlannedWorkoutEntity.deletedOccurrences`
   * — a replay must feed it through its own `parseDeletedOccurrences` and use THAT result
   * as the excluded set, then additionally assert the derived list deep-equals the
   * `deletedOccurrences` array above. `deletedOccurrences` therefore states the expected
   * PARSED set (as it always has), while `deletedOccurrencesRaw` makes the parse step
   * itself part of the cross-language assertion, not just a comment. Optional and nullable
   * — most vectors carry no stored-column claim at all.
   */
  deletedOccurrencesRaw: z.string().nullable().optional(),
});

/** D-13's seven-field allowlist. `deletedOccurrencesRaw` is the STORED column text
 * (verbatim, or null) — never a parsed array — because D-14's whole point is that the
 * stored form is untrustworthy and the canonical form is derived from it. */
const SeriesHashRootSchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  scheduledDate: z.number().int(),
  scheduledTime: z.string().nullable(),
  recurrenceRule: z.string().nullable(),
  recurrenceGroupId: z.string().nullable(),
  deletedOccurrencesRaw: z.string().nullable(),
});

const SeriesHashVectorSchema = z.object({
  name: z.string().min(1),
  roots: z.array(SeriesHashRootSchema).min(1),
  expectedCanonicalString: z.string().min(1),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char lowercase hex digest'),
});

/**
 * Phase 135-03 (SCHED-02, D-07/D-08/D-10): one vector is ONE series — every root shares a
 * single `recurrenceGroupId`, or the vector holds exactly one root whose
 * `recurrenceGroupId` is null. `expectedFields` has one entry per root (any order),
 * matched by `rootId`. `freq`/`byDay` are `as const` tuples because Zod 4's `z.enum`
 * needs a literal tuple, not a TS union type.
 */
const SeriesFieldsVectorSchema = z.object({
  name: z.string().min(1),
  roots: z.array(SeriesHashRootSchema).min(1),
  expectedFields: z
    .array(
      z.object({
        rootId: z.string().min(1),
        freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY'] as const),
        interval: z.number().int().min(1),
        byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const)),
        until: ISO_DATE.nullable(),
        weekOffset: z.number().int(),
      }),
    )
    .min(1),
});

/** D-18's five silently-failing tokens plus the two crash/hang tokens from
 * RESEARCH.md Critical Finding 2 — a closed set (D-17: strict allowlist). Exported so
 * Phase 136's enforcement code can reuse the same closed set rather than re-deriving it. */
export const RRULE_ALLOWLIST_REASON_CODES = [
  'COUNT_NOT_SUPPORTED',
  'YEARLY_NOT_SUPPORTED',
  'BYSETPOS_NOT_SUPPORTED',
  'ORDINAL_BYDAY_NOT_SUPPORTED',
  'MULTI_VALUE_BYMONTHDAY_NOT_SUPPORTED',
  'INTERVAL_MUST_BE_POSITIVE',
  'BYMONTHDAY_OUT_OF_RANGE',
  'UNKNOWN_TOKEN',
] as const;

const RruleAllowlistCaseSchema = z
  .object({
    rrule: z.string().min(1),
    accepted: z.boolean(),
    reason: z.enum(RRULE_ALLOWLIST_REASON_CODES).nullable(),
    replacement: z.string().nullable(),
  })
  .refine((c) => (c.accepted ? c.reason === null : c.reason !== null), {
    message: 'accepted cases must have reason=null; rejected cases must have a non-null reason',
  });

/** D-19: the corpus is the shared regression guard for the RRULE-allowlist enforcement points
 * (PROP-08, EDIT-07) — a later contributor dropping one site's validation has to delete a corpus
 * entry a test asserts on (loud), not just a sentence in a document (silent).
 *
 * Phase 134 (G-134-12, Protocol v1.7 §2.5) added two more entries for the format-proposal
 * enforcement points (EDIT-01, one for the MCP at creation, one for the app at apply) — the same
 * "loud, not silent" guarantee, for a different requirement. `.min(2)` rather than an exact count
 * because this registry now covers two independent feature areas that grow on separate phase
 * timelines (RRULE enforcement per 136, format-proposal enforcement per 134-19/134-20/134-21) —
 * a fixed length would need bumping on every future addition to either. */
const EnforcementPointSchema = z.object({
  where: z.string().min(1),
  when: z.string().min(1),
  phase: z.string().min(1),
  requirement: z.enum(['PROP-08', 'EDIT-07', 'EDIT-01']),
  note: z.string().min(1),
});

const ProvenanceSchema = z.object({
  spec: z.string().min(1),
  sourceOfTruth: z.string().min(1),
  phase: z.string().min(1),
  decisions: z.array(z.string()),
  consumers: z.array(z.string()),
  regeneration: z.record(z.string(), z.string()),
  enforcementPoints: z.array(EnforcementPointSchema).min(2),
});

/**
 * The six named refusal reasons a format-template `plan_update` proposal is refused
 * under (Protocol v1.7 §2.5's rejection table) — the closed set the `formatProposal`
 * corpus section's `reason` field draws from. Mirrors `FormatRefusalReason`
 * (`../src/format_proposal.ts`) as a literal string array so it can also serve as a
 * Zod enum here (a `z.enum` needs a tuple of literals, not a TS union type).
 */
export const FORMAT_PROPOSAL_REASON_CODES = [
  'FORMAT_PARAMS_REQUIRED',
  'FORMAT_PARAMS_NOT_ALLOWED',
  'FORMAT_TYPE_MISMATCH',
  'OPS_AND_FORMAT_PARAMS_EXCLUSIVE',
  'UNKNOWN_FORMAT_TYPE',
  'FORMAT_PARAMS_INVALID',
] as const;

/**
 * Phase 134 (G-134-12, Protocol v1.7 §2.5) — one `plan_update` proposal against a
 * named target template, decided true/false by BOTH enforcement points (the MCP at
 * proposal-creation time, the app at apply time). `payload` deliberately stays a
 * loosely-typed record here (not `ProposePlanUpdateSchema`'s own shape): a rejected
 * vector's payload is sometimes DELIBERATELY malformed (an invented `workoutType`
 * discriminator, both `ops` and `formatParams` present at once) — re-validating it
 * structurally here would defeat the point of feeding it through the real schema in
 * `format_proposal.test.ts`.
 */
const FormatProposalVectorSchema = z
  .object({
    name: z.string().min(1),
    templateWorkoutType: z.string().min(1),
    payload: z.object({
      templateId: z.string().min(1),
      ops: z.array(z.record(z.string(), z.unknown())),
      newExercises: z.array(z.record(z.string(), z.unknown())),
      formatParams: z.record(z.string(), z.unknown()).optional(),
    }),
    accepted: z.boolean(),
    reason: z.enum(FORMAT_PROPOSAL_REASON_CODES).nullable(),
    note: z.string().min(1).optional(),
  })
  .refine((v) => (v.accepted ? v.reason === null : v.reason !== null), {
    message: 'accepted vectors must have reason=null; rejected vectors must have a non-null reason',
  });

/**
 * Phase 135-04 (SCHED-01, D-12/D-13): the crypto-parity fixture proving the MCP
 * decrypts an app-written `PlannedWorkoutSnapshot` correctly. `keyB64` is a FIXED
 * TEST KEY (bytes 0x00..0x1F) — never a real key, matching `tests/vectors/parity-vector.ts`.
 * `expectedPlaintext` is deliberately a loose record, not a re-modelled shape here — the
 * plaintext is the app's own `PlannedWorkoutSnapshot` shape, checked against by the
 * replay itself (`tests/shared-vectors.test.ts`), not re-declared as a second schema
 * that could drift from what `PlannedWorkoutSyncHandler.kt` actually writes.
 */
const PlannedWorkoutCipherVectorSchema = z.object({
  name: z.string().min(1),
  keyB64: z.string().min(1),
  ciphertextJson: z.string().min(1),
  expectedPlaintext: z.record(z.string(), z.unknown()),
});

/**
 * Phase 151 (FB-09, D-30): the `sessionCipher` corpus section — the crypto-parity fixture
 * proving the MCP decrypts an app-written session payload (`docs/COACH-PLANNING-PROTOCOL.md`
 * §1.3 "The session payload") correctly, including the eight new feedback/goal-snapshot keys
 * alongside the pre-existing `st`/`et`. `keyB64` is the SAME fixed test key
 * `plannedWorkoutCipher` uses (bytes 0x00..0x1F) — never a real key.
 *
 * `expectedPlaintext` is deliberately a loose record (mirrors `PlannedWorkoutCipherVectorSchema`
 * above) — the plaintext is the app's own session-payload shape, checked against by the replay
 * itself (`tests/shared-vectors.test.ts`), not re-declared as a second schema that could drift.
 * `expectedDecoded` is the NORMATIVE MCP output form both parity tests are checked against
 * (protocol §1.3 "MCP output form") — also loose here for the same reason; the replay owns the
 * concrete shape assertion. `byteRoundTrip` records whether the vector's `expectedPlaintext`
 * re-serializes byte-for-byte to `expectedPlaintextString` (some vectors deliberately do not,
 * e.g. an unrecognized state word the writer included but no reader ever re-emits).
 */
const SessionCipherVectorSchema = z.object({
  name: z.string().min(1),
  keyB64: z.string().min(1),
  ciphertextJson: z.string().min(1),
  expectedPlaintextString: z.string().min(1),
  expectedPlaintext: z.record(z.string(), z.unknown()),
  expectedDecoded: z.record(z.string(), z.unknown()),
  byteRoundTrip: z.boolean(),
});

/**
 * Phase 155 (FA-08): the `foreignActivityCipher` corpus section — the crypto-parity fixture
 * proving the MCP decrypts an app-written `foreign_activity` payload (the frozen v1 form of
 * `ForeignSnapshotGoldenTest.kt`) correctly. Same form as `SessionCipherVectorSchema` above:
 * same fixed test key (bytes 0x00..0x1F), loose `expectedPlaintext`/`expectedDecoded` records
 * whose concrete shape the replay (`tests/shared-vectors.test.ts`) owns. `expectedDecoded` is
 * the §1.6 normal form `decryptForeignActivity` (cache.ts) must return exactly.
 */
const ForeignActivityCipherVectorSchema = z.object({
  name: z.string().min(1),
  keyB64: z.string().min(1),
  ciphertextJson: z.string().min(1),
  expectedPlaintextString: z.string().min(1),
  expectedPlaintext: z.record(z.string(), z.unknown()),
  expectedDecoded: z.record(z.string(), z.unknown()),
  byteRoundTrip: z.boolean(),
});

/**
 * Phase 155 (FA-08): `foreignActivityTypeCipher` (own types, an archived one included) and
 * `plannedForeignActivityCipher` (appointment roots, `deletedOccurrences` as the raw stored
 * string) — same form and same fixed test key as `ForeignActivityCipherVectorSchema` above.
 */
const ForeignActivityTypeCipherVectorSchema = ForeignActivityCipherVectorSchema;
const PlannedForeignActivityCipherVectorSchema = ForeignActivityCipherVectorSchema;

/**
 * Phase 156 (REN-01, D-11): `exerciseNameOverrideCipher` — own names of catalog exercises
 * (kind `exercise_name_override`, protocol §1.7), a hostile name at `NAME_MAX` without a
 * description and a name with a description at `DESCRIPTION_MAX` in another language. Same
 * form and same fixed test key as the foreign sport cipher sections above; `expectedDecoded`
 * is the §1.7 normal form `decryptExerciseNameOverride` (cache.ts) must return exactly.
 */
const ExerciseNameOverrideCipherVectorSchema = z.object({
  name: z.string().min(1),
  keyB64: z.string().min(1),
  ciphertextJson: z.string().min(1),
  expectedPlaintextString: z.string().min(1),
  expectedPlaintext: z.record(z.string(), z.unknown()),
  expectedDecoded: z.record(z.string(), z.unknown()),
  byteRoundTrip: z.boolean(),
});

/**
 * Phase 156 gap round (D-22, plan 156-26): `exerciseNameOverrideCipherV2` — the plaintext
 * form version 2 of §1.7, a description-only override (`name: null`) and a version-2 row
 * that carries a name (read-only, the writer never produces it). Same form and same fixed
 * test key as `exerciseNameOverrideCipher`; `expectedDecoded.name` is a string or `null`.
 */
const ExerciseNameOverrideCipherV2VectorSchema = z.object({
  name: z.string().min(1),
  keyB64: z.string().min(1),
  ciphertextJson: z.string().min(1),
  expectedPlaintextString: z.string().min(1),
  expectedPlaintext: z.record(z.string(), z.unknown()),
  expectedDecoded: z.object({
    exerciseId: z.string(),
    languageCode: z.string(),
    name: z.string().nullable(),
    description: z.string().nullable(),
    updatedAt: z.number().int(),
  }),
  byteRoundTrip: z.boolean(),
});

/**
 * Phase 156 gap round (WR-MCP-03, IN-TC-07, plan 156-26): `exerciseNameOverrideDecode` —
 * the decoding rules of §1.7 "Decoded rows" at the plaintext level (no encryption). Each
 * vector names the row's `clientLocalId` and the plaintext, and expects either the normal
 * form (`readable: true`) or the reason of the first failing rule (`readable: false`).
 */
const ExerciseNameOverrideDecodeVectorSchema = z.object({
  name: z.string().min(1),
  clientLocalId: z.string(),
  plaintext: z.string(),
  expected: z.discriminatedUnion('readable', [
    z.object({
      readable: z.literal(true),
      decoded: z.object({
        exerciseId: z.string(),
        languageCode: z.string(),
        name: z.string().nullable(),
        description: z.string().nullable(),
        updatedAt: z.number().int(),
      }),
    }),
    z.object({
      readable: z.literal(false),
      reason: z.enum(['malformed_payload', 'unknown_version']),
    }),
  ]),
});

/**
 * Phase 164 (CRYPT-01, D-25): the normal form of a decoded own exercise (protocol §1.9
 * "Decoded rows") — the plaintext object without `v`, in the same key order. `.strict()` on
 * purpose: Zod's default object parse would STRIP an extra key a corpus edit added, and the
 * `toStrictEqual` replays would then compare against a shape the corpus no longer has.
 */
const OwnExerciseDecodedSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mode: z.enum(['REPS', 'TIME', 'MAX']),
    usesWeight: z.boolean(),
    description: z.string().nullable(),
    updatedAt: z.number().int(),
    muscleGroups: z.array(
      z.object({ id: z.string(), level: z.enum(['PRIMARY', 'SECONDARY', 'STABILIZER']).nullable() }).strict(),
    ),
    equipment: z.array(z.object({ id: z.string(), optional: z.boolean() }).strict()),
    capabilities: z.array(
      z.object({ id: z.string(), level: z.enum(['HAUPTREIZ', 'MITTRAINIERT', 'GERING']).nullable() }).strict(),
    ),
  })
  .strict();

/** Phase 164: the normal form of a decoded translation of an own exercise (§1.9). */
const OwnExerciseTranslationDecodedSchema = z
  .object({
    id: z.string(),
    exerciseId: z.string(),
    languageCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  })
  .strict();

/** The three reasons of §1.9 "Decoded rows" (rule 2 only reachable through a ciphertext). */
const OwnExerciseReasonSchema = z.enum(['malformed_payload', 'decrypt_failed', 'unknown_version']);

/**
 * Phase 164 (CRYPT-01): `ownExerciseCipher` — app-written ciphertexts of own exercises under
 * the fixed corpus test key (bytes 0x00..0x1F, never a real key). A vector either decrypts to
 * `expectedPlaintextString` and decodes to `expectedDecoded`, or names the `expectedReason`
 * of the first failing rule (the tampered vector, `decrypt_failed`).
 */
const OwnExerciseCipherVectorSchema = z.union([
  z
    .object({
      name: z.string().min(1),
      keyB64: z.string().min(1),
      rowId: z.string().min(1),
      ciphertextJson: z.string().min(1),
      expectedPlaintextString: z.string().min(1),
      expectedDecoded: OwnExerciseDecodedSchema,
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      keyB64: z.string().min(1),
      rowId: z.string().min(1),
      ciphertextJson: z.string().min(1),
      expectedReason: OwnExerciseReasonSchema,
    })
    .strict(),
]);

/**
 * Phase 164 (CRYPT-01): `ownExerciseTranslationCipher` — the translation twin of
 * `ownExerciseCipher`. The row's plaintext `exerciseId` and `languageCode` are those of
 * `expectedDecoded` (§1.9: both equal the row's own fields).
 */
const OwnExerciseTranslationCipherVectorSchema = z
  .object({
    name: z.string().min(1),
    keyB64: z.string().min(1),
    rowId: z.string().min(1),
    ciphertextJson: z.string().min(1),
    expectedPlaintextString: z.string().min(1),
    expectedDecoded: OwnExerciseTranslationDecodedSchema,
  })
  .strict();

/**
 * Phase 164 (CRYPT-01): `ownExerciseDecode` — the decoding rules of §1.9 "Decoded rows" at the
 * plaintext level (no encryption). A vector of kind `translation` names the row's own
 * `rowExerciseId` and `rowLanguageCode`; each vector expects either `decoded` or `reason`.
 */
const OwnExerciseDecodeVectorSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['exercise', 'translation']),
    rowId: z.string().min(1),
    rowExerciseId: z.string().min(1).optional(),
    rowLanguageCode: z.string().min(1).optional(),
    plaintext: z.string(),
    decoded: z.union([OwnExerciseDecodedSchema, OwnExerciseTranslationDecodedSchema]).optional(),
    reason: OwnExerciseReasonSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.decoded === undefined) === (v.reason === undefined)) {
      ctx.addIssue({ code: 'custom', message: `${v.name}: exactly one of decoded and reason` });
    }
    if (v.kind === 'translation' && (v.rowExerciseId === undefined || v.rowLanguageCode === undefined)) {
      ctx.addIssue({ code: 'custom', message: `${v.name}: a translation vector names rowExerciseId and rowLanguageCode` });
    }
  });

/**
 * Phase 164 (protocol §1.10 "The key check"): `keyCheck` — the HMAC-SHA256 of the label
 * `calicomp:key-check:v1` under a key, lower-case hex. Test keys only (corpus key, all 0xFF,
 * all 0x00).
 */
const KeyCheckVectorSchema = z
  .object({
    name: z.string().min(1),
    keyB64: z.string().min(1),
    keyCheck: z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char lowercase hex digest'),
  })
  .strict();

/**
 * Phase 155 (E-15): the three predefined foreign types — key, deterministic id and the
 * English and German name. `src/foreign-types.ts`'s `FOREIGN_BUILTIN_TYPES` must equal this
 * section exactly (`tests/shared-vectors.test.ts`), the app's own table is checked against
 * the same section on the Kotlin side.
 */
const ForeignActivityTypesEntrySchema = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
  nameEn: z.string().min(1),
  nameDe: z.string().min(1),
});

/**
 * Phase 155 (FA-06, D-13): the `foreignFulfilment` section — the day rule of protocol §1.6 as
 * hand-derived vectors over ALREADY EXPANDED occurrences (the expansion itself is proved by
 * `expansion`). `src/training-state/foreign-adherence.ts`'s `assignForeignFulfilment` replays
 * every vector exactly (`tests/shared-vectors.test.ts`); the Kotlin twin replays the same
 * section. `customTypes[]` (own type rows, informative for the name side) and each activity's
 * `deletedAt` are part of the shape — the objects are deliberately not `.strict()`, so an
 * informative field added later cannot break the load.
 */
const ForeignFulfilmentOccurrenceSchema = z.object({
  rootId: z.string().min(1),
  typeId: z.string().min(1),
  date: ISO_DATE,
  scheduledTime: z.string().nullable(),
});

const ForeignFulfilmentActivitySchema = z.object({
  id: z.string().min(1),
  typeId: z.string().min(1),
  performedOn: ISO_DATE,
  performedTime: z.string().nullable(),
  createdAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
});

const ForeignFulfilmentOpenSchema = z.object({ rootId: z.string().min(1), date: ISO_DATE });

const ForeignFulfilmentVectorSchema = z.object({
  name: z.string().min(1),
  asOfDate: ISO_DATE,
  customTypes: z.array(
    z.object({ id: z.string().min(1), name: z.string(), deletedAt: z.number().int().nullable() }),
  ),
  occurrences: z.array(ForeignFulfilmentOccurrenceSchema),
  removedDates: z.array(ForeignFulfilmentOpenSchema),
  activities: z.array(ForeignFulfilmentActivitySchema),
  expected: z.object({
    fulfilled: z.array(ForeignFulfilmentOpenSchema.extend({ activityId: z.string().min(1) })),
    missed: z.array(ForeignFulfilmentOpenSchema),
    upcoming: z.array(ForeignFulfilmentOpenSchema),
    unplannedActivityIds: z.array(z.string().min(1)),
    counts: z.object({
      planned: z.number().int(),
      fulfilled: z.number().int(),
      missed: z.number().int(),
      upcoming: z.number().int(),
      removed: z.number().int(),
    }),
    fulfilmentRatio: z.number().nullable(),
  }),
});

/**
 * Phase 136-01 (TRACER SLICE): the `plannedUpdate` corpus section — proves the
 * MCP-side producer (`proposePlannedUpdate`/`buildMoveOccurrenceEnvelope`,
 * `src/tools/propose_planned_update.ts`) emits the pinned envelope AND the pinned
 * `seriesHash` for a given before-state. `intent` reuses `ProposePlannedUpdateSchema`
 * directly rather than a parallel hand-copied shape — the corpus's intent shape can
 * therefore never drift from the tool's own validated input shape, and grows
 * automatically as later plans add members to that same discriminated union.
 *
 * `beforeRoots` mirrors `DecryptedPlannedWorkout`'s shape (the decrypted snapshot
 * roots the tool reads via `cache.ts`'s decode boundary) — NOT `SeriesHashRoot`,
 * which is a post-hashing-reduction shape the producer derives internally.
 *
 * `expectedEnvelope` mirrors the wire shape of `PlannedUpdateEnvelope`
 * (`propose_planned_update.ts`) — the SAME shape `PlannedUpdatePayload`/
 * `ProposedRoot` (Kotlin, `PlannedUpdatePayload.kt`) decodes on the other side of
 * the language boundary. `expectedSeriesHash` is constrained to 64 lowercase hex
 * characters at the schema level, so a hand-typed digest fails loudly at load
 * time rather than silently mismatching at assertion time.
 */
const PlannedUpdateBeforeRootSchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  scheduledDate: z.number().int(),
  scheduledTime: z.string().nullable(),
  note: z.string().nullable(),
  recurrenceRule: z.string().nullable(),
  recurrenceGroupId: z.string().nullable(),
  deletedOccurrencesRaw: z.string().nullable(),
  completedSessionId: z.string().nullable(),
});

/**
 * Phase 136-08 (D-04, protocol §2 "Proposal Chain Reference"): a `create` root of a
 * chained `schedule_workout` carries `chainSuggestionId` instead of `templateId` —
 * both fields optional at the shape level, exactly one required by the `.superRefine`
 * below, mirroring `ProposePlannedUpdateSchema`'s own `schedule_workout` exclusivity
 * refinement (`src/schemas.ts`) so the corpus fixture can never accept a shape the
 * real producer would reject, or reject one it would accept.
 */
const PlannedUpdateRootWireSchema = z
  .object({
    id: z.string().min(1),
    templateId: z.string().min(1).optional(),
    chainSuggestionId: z.string().min(1).optional(),
    scheduledDate: ISO_DATE,
    scheduledTime: z.string().nullable(),
    note: z.string().nullable(),
    recurrenceRule: z.string().nullable(),
    recurrenceGroupId: z.string().nullable(),
    deletedOccurrences: z.array(ISO_DATE),
  })
  .superRefine((d, ctx) => {
    const hasTemplateId = d.templateId !== undefined;
    const hasChain = d.chainSuggestionId !== undefined;
    if (hasTemplateId === hasChain) {
      ctx.addIssue(
        'CHAIN_EXCLUSIVITY: a root record carries exactly one of templateId or ' +
          'chainSuggestionId, never both, never neither',
      );
    }
  });

const PlannedUpdateEnvelopeSchema = z.object({
  kind: z.enum(['occurrence', 'rule']),
  scope: z.enum(['this_occurrence', 'this_and_following', 'whole_series']),
  roots: z
    .array(
      z.object({
        operation: z.enum(['create', 'replace', 'delete']),
        root: PlannedUpdateRootWireSchema,
      }),
    )
    .min(1),
});

const PlannedUpdateVectorSchema = z.object({
  name: z.string().min(1),
  intent: ProposePlannedUpdateSchema,
  beforeRoots: z.array(PlannedUpdateBeforeRootSchema).min(1),
  expectedEnvelope: PlannedUpdateEnvelopeSchema,
  expectedSeriesHash: z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char lowercase hex digest'),
});

/**
 * Phase 137-01 (STATE-02, D-04 TRACER SLICE): the `streak` corpus section — proves
 * `src/training-state/consistency.ts`'s TypeScript port of `TrainingStreakCalculator.kt`
 * agrees with the real Kotlin calculator for the same `sortedWeeks`/`currentWeekKey`
 * input. `sortedWeeks` is `z.array(z.number().int())` rather than a stricter shape —
 * the corpus vectors are hand-selected to already be ascending and distinct (matching
 * the calculator's own precondition), so re-asserting that here would duplicate the
 * replay assertion in shared-vectors.test.ts rather than guard anything new.
 */
const StreakVectorSchema = z.object({
  name: z.string().min(1),
  sortedWeeks: z.array(z.number().int()),
  currentWeekKey: z.number().int(),
  expectedLongest: z.number().int(),
  expectedCurrent: z.number().int(),
});

/**
 * Phase 137-07 (STATE-02, D-04): the `muscleBalance` corpus section — proves
 * `src/training-state/muscle-balance.ts`'s `toRadarValues` (a TypeScript port of
 * `MuscleBalanceCalculator.toRadarValues`) agrees with the real Kotlin calculator for
 * the same `muscleSetCounts` input. `expectedRadar` is a plain `Record<string, number>`
 * — not restricted to exactly `RADAR_CATEGORIES`' six keys at the schema level — because
 * the replay itself (not this shape) is what asserts the six-category contract; the
 * schema only guards against a malformed/empty corpus edit (D-02).
 *
 * Phase 138-12 (MUSC-06, D-12/D-17): `levelCounts`/`expectedWeighted` are now MANDATORY
 * on every vector — the section was regenerated wholesale (this is no longer an optional
 * opt-in a handful of vectors carry). A vector missing either field fails Zod validation
 * here, so a future edit cannot silently drop the two-step (stage→factor→radar) proof
 * D-17 requires. Every vector now proves BOTH replay steps: `levelCounts` through the real
 * `weightedCounts` (a port of `MuscleInvolvementWeighting.weightedCounts`) into
 * `expectedWeighted`, and that same weighted map (`muscleSetCounts`) through the real
 * `toRadarValues` into `expectedRadar`.
 */
const MuscleBalanceLevelCountSchema = z.object({
  muscleGroupKey: z.string().min(1),
  involvementLevel: z.enum(['PRIMARY', 'SECONDARY', 'STABILIZER'] as const).nullable(),
  setCount: z.number().int(),
});

const MuscleBalanceVectorSchema = z.object({
  name: z.string().min(1),
  levelCounts: z.array(MuscleBalanceLevelCountSchema),
  expectedWeighted: z.record(z.string(), z.number()),
  muscleSetCounts: z.record(z.string(), z.number()),
  expectedRadar: z.record(z.string(), z.number()),
});

/**
 * Phase 138.1 (CAP-01/CAP-05, plan `138.1-16`/`138.1-17`) — the `capabilityBalance`
 * corpus section. Proves `src/training-state/capability-balance.ts`'s `weightedCounts`
 * (a verbatim TypeScript port of `CapabilityInvolvementWeighting.weightedCounts`) agrees
 * with the real Kotlin calculator for the same `levelCounts` input.
 *
 * Unlike `muscleBalance`, this section proves only ONE step, not two: D-14 of Phase
 * 138.1 requires the capability breakdown to be read out over ALL axes at once rather
 * than densified into a handful of radar categories, so there is no second many-to-few
 * grouping function for this section to parity-check — a vector with only
 * `levelCounts`/`expectedWeighted` is the complete parity claim, not a truncated one.
 *
 * `expectRejection: true` (instead of `expectedWeighted`) pins the D-04-across-the-
 * language-boundary case: a `levelCounts` row with `capabilityLevel: null` has no
 * default level (unlike the muscle axis's null-means-PRIMARY rule, D-03 of Phase 138) —
 * both `CapabilityInvolvementWeighting.weightFor` and this port's `weightFor` must
 * throw/reject rather than silently default. Exactly one of
 * `expectedWeighted`/`expectRejection` is meaningful per vector; the schema does not
 * enforce mutual exclusivity because the replay itself (not this shape) is what asserts
 * it — the same precedent `MuscleBalanceVectorSchema`'s own doc-comment above sets for
 * this corpus (D-02).
 */
const CapabilityBalanceLevelCountSchema = z.object({
  capabilityAxisKey: z.string().min(1),
  capabilityLevel: z.enum(['HAUPTREIZ', 'MITTRAINIERT', 'GERING'] as const).nullable(),
  setCount: z.number().int(),
});

const CapabilityBalanceVectorSchema = z.object({
  name: z.string().min(1),
  levelCounts: z.array(CapabilityBalanceLevelCountSchema),
  expectedWeighted: z.record(z.string(), z.number()).optional(),
  expectRejection: z.boolean().optional(),
});

/**
 * Phase 137-09 (STATE-02, D-20): the `formatProgress` corpus section — proves
 * `src/training-state/format-progress.ts`'s `amrapSummary`/`deathBySummary`/
 * `emomIntervals` (a line-for-line port of `FormatSummary.kt`) agree with the real Kotlin
 * functions for the same ordered row list. `rows` carries only `completedReps` (the one
 * field all three functions read) and its ARRAY ORDER IS the already-sorted
 * `(startedAt ?? createdAt)` order the port's KDoc/doc-header contract requires — a vector
 * is never re-sorted by the replay. `exercisesPerRound`/`roundCap` are optional because
 * only AMRAP/DEATH_BY vectors carry them; EMOM vectors carry neither. `expected` is a
 * loose partial-shape object (all fields optional) because each workoutType only ever
 * populates its own subset — the replay itself (not this schema) asserts which fields a
 * given `workoutType` must carry.
 *
 * PARITY BOUNDARY: only this per-session value is parity-bound to `FormatSummary.kt` —
 * the longitudinal series `computeFormatProgress` builds across multiple sessions has no
 * app equivalent anywhere (`SessionDetailViewModel.kt` always shows exactly one session)
 * and is therefore NOT part of this corpus section.
 */
const FormatProgressVectorSchema = z.object({
  name: z.string().min(1),
  workoutType: z.enum(['AMRAP', 'DEATH_BY', 'EMOM'] as const),
  rows: z.array(z.object({ completedReps: z.number().int().nullable() })),
  exercisesPerRound: z.number().int().optional(),
  roundCap: z.number().int().optional(),
  expected: z.object({
    rounds: z.number().int().optional(),
    reps: z.number().int().optional(),
    highestFullRound: z.number().int().optional(),
    complete: z.boolean().optional(),
    intervals: z.number().int().optional(),
  }),
});

/**
 * Phase 150-08 (COACH-05, D-22/D-24): the `newPlan` corpus section — proves
 * `ProposeNewPlanSchema`/`buildNewPlanPayload` accept and correctly build the new
 * optional `standalone[]` field (blockless entries sharing the top-level `orderIndex`
 * space with `blocks[]`, docs/COACH-PLANNING-PROTOCOL.md §2.6) exactly as the protocol
 * specifies, while a pure-blocks plan stays byte-identical (D-30).
 *
 * `input` is deliberately a loosely-typed record, not `ProposeNewPlanSchema`'s own shape
 * (mirrors `FormatProposalVectorSchema.payload` above): a rejected vector's `input` is
 * sometimes DELIBERATELY malformed (an empty plan, a duplicate top-level `orderIndex`, a
 * dangling `tempId`) — re-validating it structurally here would defeat the point of
 * feeding it through the real schema in the replay (`shared-vectors.test.ts`).
 * `expectedPayload` is loose for the same reason — it is the return shape of
 * `buildNewPlanPayload`, asserted deep-equal by the replay, not re-modelled here.
 * `expectedTopLevelOrder` (accepted vectors only) names the shared top-level order as
 * `block:<tempBlockId>` / `standalone:<orderIndex>` tokens, in ascending `orderIndex`.
 */
const NewPlanVectorSchema = z.object({
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  expectedPayload: z.record(z.string(), z.unknown()).optional(),
  expectedTopLevelOrder: z.array(z.string()).optional(),
  expectRejection: z.boolean().optional(),
  expectedIssue: z.string().optional(),
});

/**
 * Phase 166 (plan 166-04, STAT-01, D-01): the `strengthHeatmapSelection` corpus section — Rule S
 * of protocol §1.11 over the population of Rule P. Each vector carries a small database (catalog
 * exercises with their capability links and muscle-group links, workout exercises, sessions, set
 * logs; `deleted: true` is a soft-deleted row), a window start `sinceMs` and the expected level
 * rows `{ muscleGroupKey, involvementLevel, setCount }`; the per-session vectors additionally carry
 * `sessionId` and `expectedSessionLevelCounts`. The MCP replays it against the function behind
 * `get_training_state.muscleBalance` (`strengthLevelSetCounts`), the app against its Room SQL. An
 * unrated capability link (`capabilityLevel: null`) is in the corpus on purpose: the MCP's catalog
 * projection drops it, the app's rule ignores it (§1.11 "Unrated links do not count").
 */
const CorpusSessionSchema = z.object({
  id: z.string().min(1),
  startTime: z.number().int(),
  endTime: z.number().int().nullable(),
  deleted: z.boolean(),
});

const CorpusTemplateExerciseSchema = z.object({
  id: z.string().min(1),
  exerciseId: z.string().min(1),
  mode: z.string().min(1),
  deleted: z.boolean(),
});

const CorpusSetLogSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  exerciseId: z.string().min(1).nullable(),
  workoutExerciseId: z.string().min(1).nullable(),
  completedReps: z.number().int().nullable(),
  completedTimeSeconds: z.number().int().nullable(),
  createdAt: z.number().int(),
  deleted: z.boolean(),
});

const StrengthLevelCountSchema = z.object({
  muscleGroupKey: z.string().min(1),
  involvementLevel: z.enum(['PRIMARY', 'SECONDARY', 'STABILIZER'] as const),
  setCount: z.number().int(),
});

const StrengthHeatmapSelectionVectorSchema = z.object({
  name: z.string().min(1),
  exercises: z.array(z.object({
    id: z.string().min(1),
    defaultMode: z.string().min(1),
    isSkill: z.boolean(),
    capabilities: z.array(z.object({
      capabilityAxisKey: z.string().min(1),
      capabilityLevel: z.enum(['HAUPTREIZ', 'MITTRAINIERT', 'GERING'] as const).nullable(),
    })),
    muscleGroups: z.array(z.object({
      muscleGroupKey: z.string().min(1),
      involvementLevel: z.enum(['PRIMARY', 'SECONDARY', 'STABILIZER'] as const),
    })),
  })).min(1),
  templateExercises: z.array(CorpusTemplateExerciseSchema),
  sessions: z.array(CorpusSessionSchema).min(1),
  setLogs: z.array(CorpusSetLogSchema).min(1),
  sinceMs: z.number().int(),
  sessionId: z.string().min(1).optional(),
  expectedLevelCounts: z.array(StrengthLevelCountSchema),
  expectedSessionLevelCounts: z.array(StrengthLevelCountSchema).optional(),
});

export type StrengthHeatmapSelectionVector = z.infer<typeof StrengthHeatmapSelectionVectorSchema>;

export const CoachPlanningVectorsSchema = z.object({
  _provenance: ProvenanceSchema,
  expansion: z.array(ExpansionVectorSchema).min(1),
  seriesHash: z.array(SeriesHashVectorSchema).min(1),
  seriesFields: z.array(SeriesFieldsVectorSchema).min(1),
  rruleAllowlist: z.array(RruleAllowlistCaseSchema).min(1),
  formatProposal: z.array(FormatProposalVectorSchema).min(1),
  plannedWorkoutCipher: PlannedWorkoutCipherVectorSchema,
  sessionCipher: z.array(SessionCipherVectorSchema).min(1),
  // Phase 155: listed here or Zod's default object parse would silently DROP the section
  // (Pitfall 3) and every replay over it would pass vacuously.
  foreignActivityTypes: z.array(ForeignActivityTypesEntrySchema).min(1),
  foreignActivityTypeCipher: z.array(ForeignActivityTypeCipherVectorSchema).min(1),
  foreignActivityCipher: z.array(ForeignActivityCipherVectorSchema).min(1),
  plannedForeignActivityCipher: z.array(PlannedForeignActivityCipherVectorSchema).min(1),
  foreignFulfilment: z.array(ForeignFulfilmentVectorSchema).min(1),
  // Phase 156: listed for the same reason as the Phase 155 sections above — an unlisted
  // section would be silently dropped by the parse and its replay would pass vacuously.
  exerciseNameOverrideCipher: z.array(ExerciseNameOverrideCipherVectorSchema).min(1),
  // Phase 156 gap round (156-26): same reason again — both sections must be listed, or the
  // parse drops them and the replays in shared-vectors.test.ts measure nothing.
  exerciseNameOverrideCipherV2: z.array(ExerciseNameOverrideCipherV2VectorSchema).min(1),
  exerciseNameOverrideDecode: z.array(ExerciseNameOverrideDecodeVectorSchema).min(1),
  // Phase 164 (CRYPT-01): listed for the same reason as every section above — an unlisted
  // section would be silently dropped by the parse and its replay would measure nothing.
  ownExerciseCipher: z.array(OwnExerciseCipherVectorSchema).min(1),
  ownExerciseTranslationCipher: z.array(OwnExerciseTranslationCipherVectorSchema).min(1),
  ownExerciseDecode: z.array(OwnExerciseDecodeVectorSchema).min(1),
  keyCheck: z.array(KeyCheckVectorSchema).min(1),
  plannedUpdate: z.array(PlannedUpdateVectorSchema).min(1),
  streak: z.array(StreakVectorSchema).min(1),
  muscleBalance: z.array(MuscleBalanceVectorSchema).min(1),
  formatProgress: z.array(FormatProgressVectorSchema).min(1),
  capabilityBalance: z.array(CapabilityBalanceVectorSchema).min(1),
  newPlan: z.array(NewPlanVectorSchema).min(1),
  // Phase 166 (plan 166-04): listed for the same reason as every section above — an unlisted
  // section would be silently dropped by the parse and its replay would measure nothing.
  strengthHeatmapSelection: z.array(StrengthHeatmapSelectionVectorSchema).min(10),
});

export type CoachPlanningVectors = z.infer<typeof CoachPlanningVectorsSchema>;

/**
 * Load and validate the shared corpus. [fromDir] exists so the failure path (D-02) is
 * testable without touching the real corpus file — pass a directory with no
 * coach-planning-vectors.json anywhere above it to exercise the throw.
 */
export function loadCoachPlanningVectors(fromDir?: string): CoachPlanningVectors {
  const path = resolveCorpusPath(fromDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Shared coach-planning-vectors.json not found at ${path}. This test requires ` +
        'CalisthenicsCompanion-MCP to be checked out as a submodule of the CaliCompanion ' +
        'super-repo — a standalone clone cannot pass this test by design (D-02). See ' +
        `docs/COACH-PLANNING-PROTOCOL.md. (${(err as Error).message})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Shared coach-planning-vectors.json at ${path} is not valid JSON (D-02). See ` +
        `docs/COACH-PLANNING-PROTOCOL.md. (${(err as Error).message})`,
    );
  }

  // Zod parse failures propagate — a malformed corpus edit must fail loudly here, not
  // produce silently wrong test results downstream.
  return CoachPlanningVectorsSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Phase 166 (plan 166-04): the small databases of §1.11 corpus vectors as MCP inputs
// ---------------------------------------------------------------------------

/** The database part shared by the §1.11 corpus sections (`strengthHeatmapSelection`, `personalRecordsByTrainingMode`). */
export interface CorpusDatabase {
  exercises: {
    id: string;
    defaultMode: string;
    isSkill?: boolean;
    capabilities?: { capabilityAxisKey: string; capabilityLevel: 'HAUPTREIZ' | 'MITTRAINIERT' | 'GERING' | null }[];
    muscleGroups?: { muscleGroupKey: string; involvementLevel: 'PRIMARY' | 'SECONDARY' | 'STABILIZER' }[];
  }[];
  templateExercises: { id: string; exerciseId: string; mode: string; deleted: boolean }[];
  sessions: { id: string; startTime: number; endTime: number | null; deleted: boolean }[];
  setLogs: {
    id: string;
    sessionId: string;
    exerciseId: string | null;
    workoutExerciseId: string | null;
    completedReps: number | null;
    completedTimeSeconds: number | null;
    createdAt: number;
    deleted: boolean;
  }[];
}

/**
 * The catalog of a corpus database, in the MCP's normalized form. A capability link without a
 * level is dropped exactly as `cache.ts` `projectUserExerciseToCatalog` drops it (the curated
 * catalog never carries one): that is how the MCP sees an unrated link.
 */
export function corpusCatalog(db: CorpusDatabase): CatalogExercise[] {
  return db.exercises.map((ex) => ({
    id: ex.id,
    key: ex.id,
    nameEn: ex.id,
    mode: ex.defaultMode,
    usesWeight: false,
    lastModifiedAt: 0,
    translations: [],
    muscleGroups: (ex.muscleGroups ?? []).map((mg) => ({
      id: `mg-${mg.muscleGroupKey}`,
      key: mg.muscleGroupKey,
      translations: [],
      involvementLevel: mg.involvementLevel,
    })),
    equipment: [],
    isSkill: ex.isSkill ?? false,
    capabilities: (ex.capabilities ?? [])
      .filter((c) => c.capabilityLevel !== null)
      .map((c) => ({
        id: `ax-${c.capabilityAxisKey}`,
        key: c.capabilityAxisKey,
        translations: [],
        capabilityLevel: c.capabilityLevel as 'HAUPTREIZ' | 'MITTRAINIERT' | 'GERING',
      })),
    origin: 'CATALOG' as const,
  }));
}

/** The decrypted snapshot of a corpus database; `deleted: true` becomes a `deletedAt`, `null` an absent key. */
export function corpusSnapshot(db: CorpusDatabase): DecryptedSnapshot {
  const DELETED_AT = 1;
  return {
    syncedAt: 0,
    exercises: [],
    exerciseTranslations: [],
    templates: [],
    blocks: [],
    templateExercises: db.templateExercises.map((te, i) => ({
      id: te.id,
      templateId: 'corpus-template',
      exerciseId: te.exerciseId,
      exerciseSource: 'CATALOG',
      mode: te.mode,
      restTimeSeconds: 0,
      sets: 1,
      orderIndex: i,
      createdAt: 0,
      updatedAt: 0,
      ...(te.deleted ? { deletedAt: DELETED_AT } : {}),
    })),
    sessions: db.sessions.map((s) => ({
      id: s.id,
      startTime: s.startTime,
      ...(s.endTime !== null ? { endTime: s.endTime } : {}),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: s.startTime,
      updatedAt: s.startTime,
      ...(s.deleted ? { deletedAt: DELETED_AT } : {}),
    })),
    setLogs: db.setLogs.map((sl) => ({
      id: sl.id,
      sessionId: sl.sessionId,
      ...(sl.exerciseId !== null ? { exerciseId: sl.exerciseId } : {}),
      ...(sl.workoutExerciseId !== null ? { workoutExerciseId: sl.workoutExerciseId } : {}),
      exerciseSource: 'CATALOG',
      completedReps: sl.completedReps,
      completedTimeSeconds: sl.completedTimeSeconds,
      weightUsed: null,
      startedAt: sl.createdAt,
      measuredTimeSeconds: null,
      createdAt: sl.createdAt,
      updatedAt: sl.createdAt,
      ...(sl.deleted ? { deletedAt: DELETED_AT } : {}),
    })),
    hrSamples: [],
    plannedWorkouts: [],
    settings: [{ key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' }],
  };
}
