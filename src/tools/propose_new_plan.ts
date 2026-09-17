/**
 * propose_new_plan — full new-plan structure proposal, no stale-guard hash (A3).
 *
 * A brand-new plan has no existing templateId to diff against, so the payload is
 * the full new-plan structure (name + blocks with exercises), not an op-list
 * (Pattern 7). Before hashing/POSTing, every `newExercises[]` entry is run
 * through the same catalog-dedupe as `propose_new_exercise` (A2): a match drops
 * the entry from `newExercises[]` and rewrites every `{source:'new', tempId}`
 * reference to that tempId across all blocks into `{source:'catalog', exerciseId}`.
 * Never mutates directly — the proposal is transported to the coach inbox for
 * accept/reject.
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
  blocks:        NewPlanBlockInput[];
}

/** The full new-plan structure sent as `SuggestRequestBody.payload` (JSON-stringified). */
export interface NewPlanPayload {
  name:         string;
  blocks:       NewPlanBlockInput[];
  newExercises: NewExerciseDef[];
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

  const blocks: NewPlanBlockInput[] = args.blocks.map((block) => ({
    tempBlockId: block.tempBlockId,
    rounds:      block.rounds,
    orderIndex:  block.orderIndex,
    exercises:   block.exercises.map((ex) => ({
      exercise:           rewriteRef(ex.exercise),
      mode:               ex.mode,
      ...(ex.targetReps !== undefined ? { targetReps: ex.targetReps } : {}),
      ...(ex.targetTimeSeconds !== undefined ? { targetTimeSeconds: ex.targetTimeSeconds } : {}),
      restTimeSeconds:    ex.restTimeSeconds,
      sets:               ex.sets,
      ...(ex.targetWeight !== undefined ? { targetWeight: ex.targetWeight } : {}),
      orderIndex:         ex.orderIndex,
      ...(ex.roundTargets !== undefined ? { roundTargets: ex.roundTargets } : {}),
    })),
  }));

  return { name: args.name, blocks, newExercises: remainingNewExercises };
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
        'Propose a brand-new workout plan (blocks + exercises) for human review. Never ' +
        'creates it directly — the proposal is transported to the coach inbox for accept/reject. ' +
        'Inline `newExercises[]` entries that match an existing catalog exercise are automatically ' +
        'resolved to that catalog UUID instead of being proposed as duplicates.',
      inputSchema: ProposeNewPlanSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposeNewPlanArgs;

        const data       = await getSnapshot(pat, keyB64, serverUrl);
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
