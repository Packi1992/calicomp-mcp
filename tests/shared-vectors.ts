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

export const CoachPlanningVectorsSchema = z.object({
  _provenance: ProvenanceSchema,
  expansion: z.array(ExpansionVectorSchema).min(1),
  seriesHash: z.array(SeriesHashVectorSchema).min(1),
  seriesFields: z.array(SeriesFieldsVectorSchema).min(1),
  rruleAllowlist: z.array(RruleAllowlistCaseSchema).min(1),
  formatProposal: z.array(FormatProposalVectorSchema).min(1),
  plannedWorkoutCipher: PlannedWorkoutCipherVectorSchema,
  plannedUpdate: z.array(PlannedUpdateVectorSchema).min(1),
  streak: z.array(StreakVectorSchema).min(1),
  muscleBalance: z.array(MuscleBalanceVectorSchema).min(1),
  formatProgress: z.array(FormatProgressVectorSchema).min(1),
  capabilityBalance: z.array(CapabilityBalanceVectorSchema).min(1),
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
