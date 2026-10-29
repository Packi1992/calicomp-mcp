/**
 * propose_new_plan — full new-plan structure proposal, no stale-guard hash (A3).
 *
 * A brand-new plan has no existing templateId to diff against, so the payload is
 * the full new-plan structure (name + blocks with exercises), not an op-list
 * (Pattern 7). Before hashing/POSTing, every `newExercises[]` entry is run
 * through the same catalog-dedupe as `propose_new_exercise` (A2): a match drops
 * the entry from `newExercises[]` and rewrites every `{source:'new', tempId}`
 * reference to that tempId across all blocks AND `standalone[]` into
 * `{source:'catalog', exerciseId}`. Never mutates directly — the proposal is
 * transported to the coach inbox for accept/reject.
 *
 * Phase 150 (D-22/D-24/D-30, Protocol §2.6): `blocks` is now optional and an
 * optional `standalone[]` — blockless exercise entries sharing the top-level
 * `orderIndex` space with `blocks[]` — is threaded through the same dedupe/rewrite
 * pipeline. `standalone` is OMITTED from the returned payload entirely when there
 * are no standalone entries — never an empty array — so a pure-blocks plan stays
 * byte-identical to the pre-150-08 payload shape, including its `changeHash`
 * (`hash.ts`'s `canonicalStringify` sorts keys; an absent key contributes nothing
 * to that sort either way).
 *
 * Exports:
 *   buildNewPlanPayload(args, catalog)          — pure helper; inline-dedupe + rewrite
 *   registerToolProposeNewPlan(server, cfg)     — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-121-02: payload references exercises by UUID/tempId only — never a spread
 *             CatalogExercise or DecryptedSnapshot; only allowlisted fields carried.
 *   T-121-01: on HttpError, console.error logs only the status; isError text carries
 *             only `HTTP <status>` — never the PAT or request body.
 *   T-121-07: handler body wrapped in try/catch — never an uncaught throw, never a
 *             byte on stdout (D-05).
 *   T-121-04: only console.error permitted (ESLint no-console allow:['error']).
 *
 * Patterns: RESEARCH.md Pattern 1 (registerTool convention), Pattern 5 (inline-newExercises
 * dedupe = A2), Pattern 7 (propose_new_plan payload shape).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeNewPlanSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { findCatalogMatch } from '../dedupe.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';
import { catalogLinkVocabulary, findUnknownLinkKey } from './propose_new_exercise.js';
import type { CatalogExercise, ExerciseRef, NewExerciseDef, RoundTargetInput } from '../types.js';

// ---------------------------------------------------------------------------
// Types (mirror ProposeNewPlanSchema — the Zod-validated shape of `args`)
// ---------------------------------------------------------------------------

export interface NewPlanExerciseInput {
  exercise:           ExerciseRef;
  mode:               'REPS' | 'TIME' | 'MAX';
  targetReps?:        number;
  targetTimeSeconds?: number;
  restTimeSeconds:    number;
  sets:               number;
  targetWeight?:      number;
  orderIndex:         number;
  roundTargets?:      RoundTargetInput[];
}

export interface NewPlanBlockInput {
  tempBlockId: string;
  rounds:      number;
  orderIndex:  number;
  exercises:   NewPlanExerciseInput[];
}

export interface ProposeNewPlanArgs {
  name:          string;
  rationale:     string;
  newExercises?: NewExerciseDef[];
  blocks?:       NewPlanBlockInput[];
  standalone?:   NewPlanExerciseInput[];
}

/**
 * The full new-plan structure sent as `SuggestRequestBody.payload` (JSON-stringified).
 * `standalone` is optional and present ONLY when at least one blockless entry exists
 * (D-22/D-30) — never `standalone: []`, never `standalone: undefined` as a present key.
 */
export interface NewPlanPayload {
  name:         string;
  blocks:       NewPlanBlockInput[];
  newExercises: NewExerciseDef[];
  standalone?:  NewPlanExerciseInput[];
}

// ---------------------------------------------------------------------------
// Pure helper — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Build the full new-plan payload with inline-newExercises dedupe applied (A2).
 *
 * Algorithm:
 *   1. For each `args.newExercises[]` entry, run `findCatalogMatch(entry.name, catalog)`.
 *      On a match: record `tempId -> matchedUuid`, drop the entry from the output
 *      `newExercises[]`. On no match: keep the entry (genuinely novel).
 *   2. Walk every block's exercises; rewrite any `{ source: 'new', tempId }` ref whose
 *      tempId matched into `{ source: 'catalog', exerciseId: matchedUuid }`. Refs with
 *      an unmatched tempId, or already `source: 'catalog'`, pass through unchanged.
 *   3. Return `{ name, blocks, newExercises: <remaining novel entries> }` — no spread of
 *      a full CatalogExercise/DecryptedSnapshot; only allowlisted fields per exercise.
 *
 * @param args     Validated propose_new_plan args (ProposeNewPlanSchema).
 * @param catalog  Cached exercise catalog array from the cache layer.
 */
export function buildNewPlanPayload(
  args: ProposeNewPlanArgs,
  catalog: CatalogExercise[],
): NewPlanPayload {
  const tempIdToUuid: Map<string, string> = new Map();
  const remainingNewExercises: NewExerciseDef[] = [];

  for (const entry of args.newExercises ?? []) {
    const match = findCatalogMatch(entry.name, catalog, (entry.translations ?? []).map((t) => t.name));
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

  const buildExercise = (ex: NewPlanExerciseInput): NewPlanExerciseInput => ({
    exercise:           rewriteRef(ex.exercise),
    mode:               ex.mode,
    ...(ex.targetReps !== undefined ? { targetReps: ex.targetReps } : {}),
    ...(ex.targetTimeSeconds !== undefined ? { targetTimeSeconds: ex.targetTimeSeconds } : {}),
    restTimeSeconds:    ex.restTimeSeconds,
    sets:               ex.sets,
    ...(ex.targetWeight !== undefined ? { targetWeight: ex.targetWeight } : {}),
    orderIndex:         ex.orderIndex,
    ...(ex.roundTargets !== undefined ? { roundTargets: ex.roundTargets } : {}),
  });

  const blocks: NewPlanBlockInput[] = (args.blocks ?? []).map((block) => ({
    tempBlockId: block.tempBlockId,
    rounds:      block.rounds,
    orderIndex:  block.orderIndex,
    exercises:   block.exercises.map(buildExercise),
  }));

  // D-22/D-30: `standalone` is built the same way as a block's own exercises[], but
  // omitted from the returned payload entirely when empty — never `standalone: []` —
  // so a pure-blocks plan stays byte-identical, including its changeHash.
  const standalone = (args.standalone ?? []).map(buildExercise);

  return {
    name: args.name,
    blocks,
    newExercises: remainingNewExercises,
    ...(standalone.length > 0 ? { standalone } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_new_plan` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposeNewPlan(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_new_plan',
    {
      title:       'Propose New Plan',
      description:
        'Propose a brand-new workout plan (blocks and/or standalone exercises) for human review. ' +
        'Never creates it directly — the proposal is transported to the coach inbox for ' +
        'accept/reject. Inline `newExercises[]` entries that match an existing catalog exercise ' +
        'are automatically resolved to that catalog UUID instead of being proposed as duplicates. ' +
        'newExercises[] entries take the same optional fields as propose_new_exercise ' +
        '(translations, muscleGroups, capabilities, equipment); none is required, and an unknown ' +
        'capability or equipment key is refused with an error that names it. ' +
        'A block is an exercise list that is run through rounds times; in a circuit each exercise ' +
        'typically has sets: 1. A standalone entry (standalone[]) is one exercise with all its ' +
        'sets done back to back. A block with rounds: 1 makes no sense — use standalone entries ' +
        'instead. Which form you choose is up to you. Blocks and standalone entries share one ' +
        'top-level orderIndex space and can be placed before, between and after each other; ' +
        'inside a block, exercises have their own orderIndex. A unilateral exercise is two ' +
        'consecutive entries: the first gets only the side-switch rest (about 5-10s: 5s for a ' +
        'pure side switch such as side plank or typewriter, up to 10s when regripping or changing ' +
        'equipment such as clean and press), the second gets the normal rest. A standalone entry ' +
        'with several sets runs them back to back, so a side pair with 3 sets each runs L, L, L, ' +
        'R, R, R; alternating sides across several sets only works as a block with as many rounds ' +
        'as sets. ' +
        'The mode of an exercise decides how a timed set runs: TIME counts down from ' +
        'targetTimeSeconds and ends the set at zero, so TIME is a target, and a set that ran out ' +
        'stores that target; MAX counts up until the athlete stops, so MAX is a measurement. Propose ' +
        'a maximal hold, for example a benchmark hold or any hold whose capacity you want to measure, ' +
        'with MAX, never with TIME; use TIME only where the time is a target not to exceed, such as a ' +
        'stretch held for a set time.',
      inputSchema: ProposeNewPlanSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposeNewPlanArgs;

        const data       = await getSnapshot(pat, keyB64, serverUrl);
        // Phase 166 (plan 166-08, D-11, T-166-25): capability and equipment keys of every
        // newExercises[] entry against the loaded catalog, before any hashing/network call.
        const vocabulary = catalogLinkVocabulary(data.catalog);
        for (const entry of typedArgs.newExercises ?? []) {
          const unknownKey = findUnknownLinkKey(entry, vocabulary);
          if (unknownKey !== undefined) {
            return { isError: true, content: [{ type: 'text' as const, text: unknownKey }] };
          }
        }
        const payload    = buildNewPlanPayload(typedArgs, data.catalog);
        const changeHash = computeChangeHash('new_plan', payload);
        const sourceLlm  = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'new_plan',
            payload:   JSON.stringify(payload),
            rationale: typedArgs.rationale,
            sourceLlm,
            changeHash,
          },
          pat,
          serverUrl,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof HttpError) {
          console.error(`propose_new_plan: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose new plan error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
