/**
 * Format-template `plan_update` enforcement point #1 (Protocol v1.7 §2.5, "Enforcement Points").
 *
 * `validateFormatProposal` is the pure, corpus-testable mirror of the Kotlin
 * `FormatProposalApplier.validate` (TrainCounter, Plans 134-19/134-20,
 * `domain/coach/FormatProposalApplier.kt`) — same six named reason codes, same rule
 * ORDER. The order is part of the contract, not an implementation detail: for a
 * payload that violates more than one rule at once, two implementations that check
 * the same rules in a different order return different reason codes, and the shared
 * corpus (`docs/coach-planning-vectors.json` -> `formatProposal`) is built to catch
 * exactly that divergence.
 *
 * Two of the six reason codes never originate here:
 *   - `UNKNOWN_FORMAT_TYPE` — a `formatParams.workoutType` outside the eight
 *     recognized literals is rejected by `FormatParamsSchema`'s `discriminatedUnion`
 *     itself, before this function is ever reached with a `formatParams` payload.
 *   - `FORMAT_PARAMS_INVALID` — a format's own field constraints (e.g. an EMOM
 *     station whose target is not below its window, an empty exercise list) are
 *     `.superRefine()` checks on `FormatParamsSchema`'s members, for the same reason:
 *     they need only the payload, never the target template's own workoutType.
 * Both live at the Zod boundary in `schemas.ts` instead — see `ProposePlanUpdateSchema`.
 *
 * No MCP SDK dependency and no fetch — pure, importable and testable in isolation,
 * exactly like `buildPlanUpdatePayload` (`tools/propose_plan_update.ts`) and
 * `getTemplate` (`tools/get_template.ts`).
 */

/** The six named refusal reasons from Protocol v1.7 §2.5's rejection table, verbatim. */
export type FormatRefusalReason =
  | 'FORMAT_PARAMS_REQUIRED'
  | 'FORMAT_PARAMS_NOT_ALLOWED'
  | 'FORMAT_TYPE_MISMATCH'
  | 'OPS_AND_FORMAT_PARAMS_EXCLUSIVE'
  | 'UNKNOWN_FORMAT_TYPE'
  | 'FORMAT_PARAMS_INVALID';

/**
 * The one decision `validateFormatProposal` returns — apply the format parameters
 * (`format`), fall through to the pre-134-21 op-list path unchanged (`classicOps`),
 * or refuse before any hashing/network call (`refused`).
 */
export type FormatProposalVerdict =
  | { kind: 'format' }
  | { kind: 'classicOps' }
  | { kind: 'refused'; reason: FormatRefusalReason };

/**
 * Decide what a `plan_update` payload against a template whose own workoutType is
 * `templateWorkoutType` may do — in EXACTLY this rule order, mirroring
 * `FormatProposalApplier.validate` (Kotlin) rule for rule:
 *
 *  1. `templateWorkoutType == null` (`undefined` OR `null`) -> `classicOps`. A
 *     template row whose `workoutType` field is absent (a CLASSIC template never has
 *     this field set, or a pre-Phase-134 legacy row) is deliberately NOT treated as a
 *     format template — this fall-through predates this plan and is preserved
 *     verbatim. `null` is treated identically to `undefined` here (CR-01,
 *     134-REVIEW.md): the server can legitimately emit a literal wire `null` for a
 *     row whose column has not been (re-)written since the format-params migration
 *     landed, and that is exactly the same "no usable format information" case a
 *     missing key already represented — checking only `=== undefined` let that
 *     `null` fall through every rule below to a wrongly-refused `FORMAT_PARAMS_REQUIRED`.
 *  2. Both a non-empty `ops` AND a `formatParams` present ->
 *     `OPS_AND_FORMAT_PARAMS_EXCLUSIVE`. Checked BEFORE the CLASSIC/format split
 *     below — an unknown-workoutType template (rule 1) never reaches this check,
 *     matching the Kotlin fall-through exactly.
 *  3. `templateWorkoutType === 'CLASSIC'` and `formatParams` is present ->
 *     `FORMAT_PARAMS_NOT_ALLOWED`.
 *  4. `templateWorkoutType === 'CLASSIC'` -> `classicOps` (today's unchanged path).
 *  5. `formatParams` is absent -> `FORMAT_PARAMS_REQUIRED` — the UAT-round-4 proof
 *     row (`2c0b2537`) in function form: an op-list `plan_update` against a format
 *     template, refused locally before any network call.
 *  6. `formatParams.workoutType` disagrees with `templateWorkoutType` ->
 *     `FORMAT_TYPE_MISMATCH`.
 *  7. Otherwise -> `format`.
 *
 * @param templateWorkoutType  The target template's own `workoutType`
 *   (`TemplateDetail.workoutType`), or `undefined`/`null` for a CLASSIC/legacy row
 *   (CR-01, 134-REVIEW.md: a not-yet-resynced post-migration row's column is a
 *   genuine wire `null`, not merely an absent key — both must be treated alike).
 * @param payload  The proposal's `ops`/`formatParams` shape — only these two fields
 *   are read; the caller passes the validated `ProposePlanUpdateArgs` (or an
 *   equivalent shape) directly.
 */
export function validateFormatProposal(
  templateWorkoutType: string | null | undefined,
  payload: { ops?: unknown[]; formatParams?: { workoutType: string } },
): FormatProposalVerdict {
  if (templateWorkoutType == null) {
    return { kind: 'classicOps' };
  }

  const hasOps = (payload.ops ?? []).length > 0;
  const hasFormatParams = payload.formatParams !== undefined;

  if (hasOps && hasFormatParams) {
    return { kind: 'refused', reason: 'OPS_AND_FORMAT_PARAMS_EXCLUSIVE' };
  }

  if (templateWorkoutType === 'CLASSIC') {
    if (hasFormatParams) {
      return { kind: 'refused', reason: 'FORMAT_PARAMS_NOT_ALLOWED' };
    }
    return { kind: 'classicOps' };
  }

  if (!hasFormatParams) {
    return { kind: 'refused', reason: 'FORMAT_PARAMS_REQUIRED' };
  }

  // Non-null assertion is safe: hasFormatParams already proved payload.formatParams
  // is defined; TS can't narrow through the `hasFormatParams` local on its own.
  if (payload.formatParams!.workoutType !== templateWorkoutType) {
    return { kind: 'refused', reason: 'FORMAT_TYPE_MISMATCH' };
  }

  return { kind: 'format' };
}

/** Short, PAT/payload-free explanations for the isError text (T-121-01: never the PAT or
 * request body, only the reason code and a short generic sentence). */
export const FORMAT_REFUSAL_MESSAGES: Record<FormatRefusalReason, string> = {
  FORMAT_PARAMS_REQUIRED:
    'This template is a format template — propose formatParams, not an ops[] diff.',
  FORMAT_PARAMS_NOT_ALLOWED: 'This template is CLASSIC — propose ops[], not formatParams.',
  FORMAT_TYPE_MISMATCH: "formatParams.workoutType does not match the target template's own workoutType.",
  OPS_AND_FORMAT_PARAMS_EXCLUSIVE: 'A proposal may carry ops[] or formatParams, never both.',
  UNKNOWN_FORMAT_TYPE: 'formatParams.workoutType is not one of the eight recognized formats.',
  FORMAT_PARAMS_INVALID: 'formatParams violates a constraint the format editor itself enforces.',
};
