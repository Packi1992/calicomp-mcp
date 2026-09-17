/**
 * propose_plan_update — either an op-list diff against a CLASSIC template, or a
 * whole-parameter replacement (`formatParams`) against a format template
 * (CIRCUIT/EMOM/AMRAP/TABATA/LADDER/FOR_TIME/CHIPPER/DEATH_BY) — Protocol v1.7 §2.5.
 * Carries a planHash stale-guard (D-02) and inline-newExercises dedupe (D-03/A2).
 *
 * A4/SC5 client-side pre-check: the live Phase 118 server does NOT validate
 * `templateId` (it stores the opaque payload verbatim), so this tool calls the
 * importable pure `getTemplate({templateId}, snapshot)` (get_template.ts) and
 * fast-fails with `isError` — NO network call — when the template is absent
 * from the local snapshot OR soft-deleted (`deletedAt != null`, WR-03: a plan
 * the user removed must not accept proposals) (T-121-08).
 *
 * Phase 134 (G-134-12, Protocol v1.7 §2.5): immediately after that pre-check, the
 * target template's own `workoutType` (from `TemplateDetail.workoutType`, Plan
 * 134-18) decides which shape the proposal must take —
 * `validateFormatProposal(tpl.workoutType, typedArgs)` (`../format_proposal.js`) is
 * the SAME decision `FormatProposalApplier.validate` makes on the Kotlin side
 * (TrainCounter, Plans 134-19/134-20), so both enforcement points this protocol
 * section names agree instead of diverging (T-134-21-03). A `refused` verdict
 * returns `isError` with the named reason code — BEFORE `computePlanHash` and
 * before the single network write call below — never a byte on the wire for a
 * payload the contract cannot express. This is the tool-level fix for the UAT round-4 proof row
 * (`2c0b2537`): an op-list `plan_update` against a format template now fails
 * locally with `FORMAT_PARAMS_REQUIRED` instead of reaching the coach inbox as a
 * suggestion the app will later refuse to apply.
 *
 * When the template exists (and is live), every `newExercises[]` entry is run
 * through the same catalog-dedupe as propose_new_plan (A2): a match drops the
 * entry from `newExercises[]` and rewrites every `{source:'new', tempId}` ref —
 * across `ops[]` AND across `formatParams`'s own entry lists — into
 * `{source:'catalog', exerciseId}`. `planHash` is computed over the decrypted
 * snapshot template at propose-time so Phase 122's accept-path can detect drift
 * (unaffected by this plan — `hash.ts` deliberately excludes `workoutType`/
 * `formatParams` from the canonical structure, Protocol §2.5's "known stale-guard
 * gap"); `changeHash` covers the whole payload, `ops` or `formatParams` alike.
 * Never mutates directly — the proposal is transported to the coach inbox for
 * accept/reject.
 *
 * Exports:
 *   buildPlanUpdatePayload(args, catalog)        — pure helper; inline-dedupe + rewrite
 *   registerToolProposePlanUpdate(server, cfg)   — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-121-08: planHash computed from the decrypted snapshot at propose-time;
 *             templateId pre-check rejects a non-existent template before POST.
 *   T-121-02: payload carries ops/formatParams referencing exercises by
 *             UUID/tempId + numeric targets only — never a spread
 *             CatalogExercise/DecryptedSnapshot.
 *   T-121-05b: planHash/changeHash both computed via the shared src/hash.ts
 *              functions — no inline JSON.stringify+createHash in this file.
 *   T-121-01: on HttpError, console.error logs only the status; isError text
 *             carries only `HTTP <status>` or a named refusal reason + short
 *             generic sentence — never the PAT or request body.
 *   T-121-07: handler body wrapped in try/catch — never an uncaught throw, never a
 *             byte on stdout (D-05).
 *   T-121-04: only console.error permitted (ESLint no-console allow:['error']).
 *   T-134-21-02: no second network write call added — the one below remains the only one.
 *   T-134-21-04: every format's entry list carries the same `.max()` DoS bound
 *                `PlanOpSchema` already uses (`schemas.ts`).
 *
 * Patterns: RESEARCH.md Pattern 1 (registerTool convention), Pattern 5 (op vocab +
 * inline new-exercise dedupe), Pitfall 3 (SC5 mocked-response approach).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposePlanUpdateSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { getTemplate } from './get_template.js';
import { findCatalogMatch } from '../dedupe.js';
import { computePlanHash, computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';
import { validateFormatProposal, FORMAT_REFUSAL_MESSAGES } from '../format_proposal.js';
import type { CatalogExercise, ExerciseRef, FormatParamsProposal, NewExerciseDef, PlanOp } from '../types.js';

// ---------------------------------------------------------------------------
// Types (mirror ProposePlanUpdateSchema — the Zod-validated shape of `args`)
// ---------------------------------------------------------------------------

export interface ProposePlanUpdateArgs {
  templateId:     string;
  rationale:      string;
  newExercises?:  NewExerciseDef[];
  ops?:           PlanOp[];
  formatParams?:  FormatParamsProposal;
}

/** The payload sent as `SuggestRequestBody.payload` (JSON-stringified) — either an
 * `ops[]` diff (CLASSIC path, `formatParams` absent) or a `formatParams` whole-
 * parameter replacement (format-template path, `ops` empty). */
export interface PlanUpdatePayload {
  templateId:     string;
  ops:            PlanOp[];
  newExercises:   NewExerciseDef[];
  formatParams?:  FormatParamsProposal;
}

// ---------------------------------------------------------------------------
// Pure helpers — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Rewrite every `{source:'new', tempId}` `ExerciseRef` inside a `formatParams`'s
 * own entry list via `rewriteRef` — the SAME rewrite `buildPlanUpdatePayload`
 * already applies to `ops[]` (A2). Without this, a format proposal introducing a
 * brand-new exercise that also matches an existing catalog exercise by name would
 * create a duplicate the `ops[]` path already avoids.
 *
 * Exhaustive `switch` over `FormatParamsProposal.workoutType` with NO `default`
 * branch — mirrors the guardrail Kotlin's sealed-class exhaustive `when`
 * (`FormatProposalApplier`) gives the Kotlin side for free: a ninth member added
 * to `FormatParamsProposal` (types.ts) without a matching `case` here fails the
 * build (TS2366, "function lacks ending return statement") rather than silently
 * skipping the rewrite for that format's entries.
 */
function rewriteFormatParamsRefs(
  formatParams: FormatParamsProposal,
  rewriteRef: (ref: ExerciseRef) => ExerciseRef,
): FormatParamsProposal {
  const rewriteEntry = <E extends { exercise: ExerciseRef }>(entry: E): E => ({
    ...entry,
    exercise: rewriteRef(entry.exercise),
  });

  switch (formatParams.workoutType) {
    case 'CIRCUIT':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
    case 'EMOM':
      return { ...formatParams, stations: formatParams.stations.map(rewriteEntry) };
    case 'AMRAP':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
    case 'TABATA':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
    case 'LADDER':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
    case 'FOR_TIME':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
    case 'CHIPPER':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
    case 'DEATH_BY':
      return { ...formatParams, exercises: formatParams.exercises.map(rewriteEntry) };
  }
}

/**
 * Build the `plan_update` payload with inline-newExercises dedupe applied (A2).
 *
 * Algorithm:
 *   1. For each `args.newExercises[]` entry, run `findCatalogMatch(entry.name, catalog)`.
 *      On a match: record `tempId -> matchedUuid`, drop the entry from the output
 *      `newExercises[]`. On no match: keep the entry (genuinely novel).
 *   2. Walk every op; rewrite any `addExercise` op's `{ source: 'new', tempId }` ref
 *      whose tempId matched into `{ source: 'catalog', exerciseId: matchedUuid }`. Refs
 *      with an unmatched tempId, or already `source: 'catalog'`, pass through unchanged.
 *      Non-`addExercise` ops (removeExercise/updateSetsReps/reorder) pass through unchanged
 *      — they never carry an `ExerciseRef`.
 *   3. If `args.formatParams` is present, apply the identical rewrite to every entry
 *      in its own entry list (`rewriteFormatParamsRefs`).
 *   4. Return `{ templateId, ops: <rewritten>, newExercises: <remaining novel entries>,
 *      formatParams?: <rewritten> }` — no spread of a full CatalogExercise/DecryptedSnapshot;
 *      only allowlisted fields.
 *
 * `args.ops` defaults to `[]` when absent (a format-template proposal carries no
 * `ops` at all) — the caller (the tool handler) is responsible for choosing which
 * of `args.ops`/`args.formatParams` to pass through per `validateFormatProposal`'s
 * verdict; this function itself does not decide that.
 *
 * @param args     Validated propose_plan_update args (ProposePlanUpdateSchema).
 * @param catalog  Cached exercise catalog array from the cache layer.
 */
export function buildPlanUpdatePayload(
  args: ProposePlanUpdateArgs,
  catalog: CatalogExercise[],
): PlanUpdatePayload {
  const tempIdToUuid: Map<string, string> = new Map();
  const remainingNewExercises: NewExerciseDef[] = [];

  for (const entry of args.newExercises ?? []) {
    const match = findCatalogMatch(entry.name, catalog);
    if (match) {
      tempIdToUuid.set(entry.tempId, match.id);
    } else {
      remainingNewExercises.push(entry);
    }
  }

  const rewriteRef = (ref: ExerciseRef): ExerciseRef => {
    if (ref.source === 'new' && tempIdToUuid.has(ref.tempId)) {
      return { source: 'catalog', exerciseId: tempIdToUuid.get(ref.tempId) as string };
    }
    return ref;
  };

  const ops: PlanOp[] = (args.ops ?? []).map((op) => {
    if (op.op === 'addExercise') {
      return { ...op, exercise: rewriteRef(op.exercise) };
    }
    return op;
  });

  return {
    templateId: args.templateId,
    ops,
    newExercises: remainingNewExercises,
    ...(args.formatParams !== undefined
      ? { formatParams: rewriteFormatParamsRefs(args.formatParams, rewriteRef) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// G-136-R2-7a (Plan 136-24, Task 1) local refusal reason.
//
// Declared here on purpose, NOT added to `FormatRefusalReason` (`format_proposal.ts`).
// That union — its six members, in their fixed rule order — is the cross-language
// parity contract with the Kotlin `FormatProposalApplier`, verified rule-for-rule against
// the shared corpus (docs/coach-planning-vectors.json). A seventh member here would have
// to be mirrored in TrainCounter and in the corpus, which is a far bigger change than this
// call-site guard warrants. Do not "tidy" this into the shared union.
// ---------------------------------------------------------------------------

/**
 * `validateFormatProposal`'s `classicOps` verdict (Rule 1: the target template's own
 * `workoutType` is absent or a literal `null`) is a deliberate fall-through for
 * CLASSIC/legacy rows proposing an `ops[]` diff. It was never meant to also accept a
 * whole-parameter `formatParams` proposal — before this guard, the handler silently
 * dropped `formatParams` in that case (`argsForPayload` below) and posted whatever was
 * left: an empty `ops[]`, no `formatParams`, nothing the app could open or apply (UAT
 * round-2 setup, suggestion `a5801708` against "tabatest", `ff66017b`). Refuse locally,
 * before any hashing/network call, instead of emptying the proposal.
 */
const FORMAT_PARAMS_ON_UNTYPED_TEMPLATE_REASON = 'FORMAT_PARAMS_ON_UNTYPED_TEMPLATE';
const FORMAT_PARAMS_ON_UNTYPED_TEMPLATE_MESSAGE =
  "This template's own format type is not known to the coach yet (its workoutType is " +
  'absent or has not been re-synced) — a whole-parameter formatParams proposal cannot ' +
  'be applied to it. Propose an ops[] diff instead.';

/**
 * Fail-closed invariant guard (Task 2): a built `plan_update` payload with an empty
 * `ops[]` AND no `formatParams` carries nothing to propose. `ProposePlanUpdateSchema`'s
 * "exactly one of ops/formatParams" `.superRefine()` plus the refusal above already make
 * this shape unreachable through any schema-validated call — this guard exists because
 * that is exactly the shape the UAT observed on the wire, and a network boundary is the
 * right place to state an invariant rather than assume one holds. It stays reachable in
 * tests only, via a direct handler call that bypasses Zod (as this file's suite does),
 * which is what keeps it from rotting.
 */
const EMPTY_PLAN_UPDATE_REASON = 'EMPTY_PLAN_UPDATE';
const EMPTY_PLAN_UPDATE_MESSAGE = 'This proposal carries no ops[] and no formatParams — nothing to propose.';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_plan_update` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposePlanUpdate(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_plan_update',
    {
      title:       'Propose Plan Update',
      description:
        'Propose a structural change to an existing workout template for human review. Against a ' +
        'CLASSIC template, pass an `ops[]` diff (add/remove/update-sets-reps/reorder). Against a ' +
        'format template (CIRCUIT/EMOM/AMRAP/TABATA/LADDER/FOR_TIME/CHIPPER/DEATH_BY — check ' +
        '`get_template`\'s `workoutType`), pass `formatParams` instead: the complete new authoring ' +
        'parameters for that format, never an ops[] diff — the compiled rows are recomputed from ' +
        'formatParams on every save and an ops[] diff against them would be silently discarded. ' +
        'Exactly one of `ops`/`formatParams` may be set. Never mutates directly — the proposal is ' +
        'transported to the coach inbox for accept/reject. Fast-fails with an error (no network ' +
        'call) if the templateId is not found in the local snapshot, or if the proposal shape does ' +
        'not match the target template\'s own format. Inline `newExercises[]` entries that match an ' +
        'existing catalog exercise are automatically resolved to that catalog UUID instead of being ' +
        'proposed as duplicates.',
      inputSchema: ProposePlanUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposePlanUpdateArgs;

        const data = await getSnapshot(pat, keyB64, serverUrl);

        // WR-03: treat soft-deleted templates (deletedAt != null) as absent —
        // getTemplate finds them by id, but a deleted plan must not accept proposals.
        const tpl = getTemplate({ templateId: typedArgs.templateId }, data.snapshot);
        if (!tpl || tpl.deletedAt != null) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Template not found: ${typedArgs.templateId}` }],
          };
        }

        // Phase 134 (G-134-12): decide ops[] vs formatParams[] BEFORE any hashing/network
        // call — the second enforcement point named in Protocol §2.5, mirroring
        // FormatProposalApplier.validate (Kotlin) rule for rule.
        const verdict = validateFormatProposal(tpl.workoutType, typedArgs);
        if (verdict.kind === 'refused') {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `${verdict.reason}: ${FORMAT_REFUSAL_MESSAGES[verdict.reason]}` },
            ],
          };
        }
        // G-136-R2-7a (Task 1): a classicOps verdict (Rule 1 — the target template's own
        // workoutType is absent/null) with a caller-supplied formatParams used to fall
        // through to the strip below and post an empty, unapplicable plan_update. Refuse
        // it here, before any hashing/network call, with a reason naming the actual case
        // (no usable workoutType on this template) — not the CLASSIC-mismatch case, which
        // is FORMAT_PARAMS_NOT_ALLOWED above and already covered.
        if (verdict.kind === 'classicOps' && typedArgs.formatParams !== undefined) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${FORMAT_PARAMS_ON_UNTYPED_TEMPLATE_REASON}: ${FORMAT_PARAMS_ON_UNTYPED_TEMPLATE_MESSAGE}`,
              },
            ],
          };
        }

        // classicOps: the unchanged pre-134-21 path. The refusal above means classicOps
        // can only reach this line with formatParams already absent, so the
        // `formatParams: undefined` spread below is a no-op kept for the type shape —
        // it no longer strips anything a caller supplied.
        const argsForPayload: ProposePlanUpdateArgs =
          verdict.kind === 'format' ? typedArgs : { ...typedArgs, formatParams: undefined };

        const payload    = buildPlanUpdatePayload(argsForPayload, data.catalog);

        // G-136-R2-7a (Task 2): fail-closed invariant guard, reachable only via a direct
        // handler call that bypasses ProposePlanUpdateSchema's Zod validation (as the
        // tests here do) — see the constant's own doc comment above for why it exists
        // despite being unreachable through any schema-validated call.
        if (payload.formatParams === undefined && payload.ops.length === 0) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `${EMPTY_PLAN_UPDATE_REASON}: ${EMPTY_PLAN_UPDATE_MESSAGE}` },
            ],
          };
        }

        const planHash    = computePlanHash(typedArgs.templateId, data.snapshot);
        const changeHash  = computeChangeHash('plan_update', payload);
        const sourceLlm   = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'plan_update',
            payload:   JSON.stringify(payload),
            rationale: typedArgs.rationale,
            sourceLlm,
            changeHash,
            planHash,
          },
          pat,
          serverUrl,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof HttpError) {
          console.error(`propose_plan_update: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose plan update error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
