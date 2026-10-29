/**
 * propose_exercise_update — propose a change to an existing exercise (Phase 166, plan 166-08,
 * MCP-06, D-11 in the scope of D-15, protocol §2.7 "exercise_update: changing an existing
 * exercise").
 *
 * Never changes the exercise. The tool loads the catalog the coach reads (curated entries plus the
 * athlete's own exercises, `getSnapshot().catalog`), looks the `exerciseId` up there and decides by
 * `origin` whether it is an own exercise (`'CUSTOM'`) or a catalog exercise (`'CATALOG'`):
 *   - not found: `EXERCISE_NOT_FOUND`, no proposal;
 *   - catalog exercise with `muscleGroups` or `capabilities`: `CATALOG_EXERCISE_LINKS_REFUSED`,
 *     no proposal (no personal mechanism before phase 168.1, Pitfall 10, T-166-26); its
 *     `translations` become the athlete's personal override of §1.7 on accept, the shared catalog
 *     never changes;
 *   - a capability key the loaded catalog does not know: `UNKNOWN_CAPABILITY_KEY`, the key named.
 * Otherwise it POSTs a proposal of type `exercise_update` with the allowlisted payload
 * `{ exerciseId, translations?, muscleGroups?, capabilities? }` (each field only when set) and
 * `changeHash = computeChangeHash('exercise_update', payload)`. No stale guard (assumption A4): the
 * app shows the current state beside the proposed one. Only the athlete applies it, by accepting in
 * the app (JWT); the PAT can propose and read back, never apply (T-166-27, Propose-Only Boundary).
 * The server accepts the type once plan 166-03 is deployed (166-16).
 *
 * Exports:
 *   validateExerciseUpdate(args, target, vocabulary) — the tool-side check (corpus replay)
 *   buildExerciseUpdatePayload(args)                 — the allowlisted payload (corpus replay)
 *   registerToolProposeExerciseUpdate(server, cfg)   — registers the tool with the MCP server
 *
 * Security (threat model): T-121-01 (an HttpError surfaces only `HTTP <status>`), T-121-02 (no
 * spread of a catalog entry into the payload), T-121-07 (handler wrapped in try/catch, nothing on
 * stdout), T-166-25 (an unknown key is named, never the payload), T-166-26, T-166-27.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeExerciseUpdateSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';
import { catalogLinkVocabulary, findUnknownLinkKey, type LinkVocabulary } from './propose_new_exercise.js';
import type { CapabilityLinkInput, ExerciseTranslationInput, MuscleLinkInput } from '../types.js';

// ---------------------------------------------------------------------------
// Pure helpers — importable for the corpus replay (tests/shared-vectors.test.ts)
// ---------------------------------------------------------------------------

export interface ProposeExerciseUpdateArgs {
  exerciseId: string;
  rationale?: string;
  translations?: ExerciseTranslationInput[];
  muscleGroups?: MuscleLinkInput[];
  capabilities?: CapabilityLinkInput[];
}

const EXERCISE_NOT_FOUND = 'EXERCISE_NOT_FOUND';
const CATALOG_EXERCISE_LINKS_REFUSED = 'CATALOG_EXERCISE_LINKS_REFUSED';

/**
 * The tool-side check of an `exercise_update` against the exercise the MCP read: `target` is the
 * found exercise's origin, or `undefined` when the id is neither a catalog nor an own exercise.
 * Returns the tool error text, or `undefined` when the proposal may be sent.
 */
export function validateExerciseUpdate(
  args: ProposeExerciseUpdateArgs,
  target: { origin: 'CATALOG' | 'CUSTOM' } | undefined,
  vocabulary: LinkVocabulary,
): string | undefined {
  if (target === undefined) {
    return `${EXERCISE_NOT_FOUND}: no catalog exercise and no own exercise has this exerciseId (${args.exerciseId}).`;
  }
  if (target.origin === 'CATALOG' && (args.muscleGroups !== undefined || args.capabilities !== undefined)) {
    return (
      `${CATALOG_EXERCISE_LINKS_REFUSED}: muscleGroups and capabilities cannot be proposed for a ` +
      'catalog exercise (personal muscles and capabilities of a catalog exercise follow in phase ' +
      '168.1). Propose translations only.'
    );
  }
  return findUnknownLinkKey(args, vocabulary);
}

/** The allowlisted `exercise_update` payload, each optional field only when set (protocol §2.7). */
export function buildExerciseUpdatePayload(args: ProposeExerciseUpdateArgs): Record<string, unknown> {
  return {
    exerciseId: args.exerciseId,
    ...(args.translations !== undefined ? { translations: args.translations } : {}),
    ...(args.muscleGroups !== undefined ? { muscleGroups: args.muscleGroups } : {}),
    ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_exercise_update` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposeExerciseUpdate(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_exercise_update',
    {
      title: 'Propose Exercise Update',
      description:
        'Propose a change to an existing exercise for human review: an own exercise (origin CUSTOM ' +
        'in get_exercise_catalog) or a catalog exercise. Never changes it directly; the proposal goes ' +
        'to the coach inbox, and only the athlete applies it by accepting in the app, where every ' +
        'field stays editable. Pass exerciseId and at least one of translations, muscleGroups and ' +
        'capabilities. For an own exercise every field applies: a translations entry replaces name ' +
        'and description in its language (en changes the base name and description), a language you ' +
        'do not name stays as it is, and a present muscleGroups or capabilities list replaces that ' +
        'list completely while an absent list stays unchanged. For a catalog exercise only ' +
        'translations apply, as the athlete\'s own personal name and description per language; the ' +
        'shared catalog never changes for anyone. muscleGroups and capabilities of a catalog exercise ' +
        'are refused until phase 168.1. Use the muscle and capability keys get_exercise_catalog ' +
        'shows; a capability level is required, a muscle level is optional. An unknown capability ' +
        'key is refused with an error that names it, and an exerciseId that is neither a catalog nor ' +
        'an own exercise with EXERCISE_NOT_FOUND. Never send an empty list. Equipment is not part of ' +
        'this proposal. This proposal type is live only once the server has been deployed with it; ' +
        'before that the server answers with an HTTP error.',
      inputSchema: ProposeExerciseUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposeExerciseUpdateArgs & { rationale: string };

        const data = await getSnapshot(pat, keyB64, serverUrl);
        const found = data.catalog.find((ex) => ex.id === typedArgs.exerciseId);
        const refusal = validateExerciseUpdate(
          typedArgs,
          found === undefined ? undefined : { origin: found.origin },
          catalogLinkVocabulary(data.catalog),
        );
        if (refusal !== undefined) {
          return { isError: true, content: [{ type: 'text' as const, text: refusal }] };
        }

        const payload    = buildExerciseUpdatePayload(typedArgs);
        const changeHash = computeChangeHash('exercise_update', payload);
        const sourceLlm  = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'exercise_update',
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
          console.error(`propose_exercise_update: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose exercise update error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
