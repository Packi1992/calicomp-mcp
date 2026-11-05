/**
 * propose_catalog_exercise_links — propose a personal list of muscles or capabilities for a catalog exercise (Phase 168.1,
 * plan 168.1-03, D-01, D-03, D-04, protocol 1.57 §2.9 "Personal Link Proposals").
 *
 * The tool itself changes nothing. It loads the catalog the coach reads, looks the `exerciseId` up there and decides by
 * `origin`:
 *   - not found: `EXERCISE_NOT_FOUND`, no proposal;
 *   - an own exercise (`'CUSTOM'`): `OWN_EXERCISE_LINKS_REFUSED`, no proposal; the error names `propose_exercise_update`;
 *   - a capability key the vocabulary does not know: `UNKNOWN_CAPABILITY_KEY`, the key named. The vocabulary is the catalog
 *     before the personal lists were laid over it (`linkVocabularyCatalog`, Pitfall 6). Muscle keys: the schema.
 * Otherwise it POSTs a proposal of type `catalog_exercise_links` with the allowlisted payload
 * `{ exerciseId, muscleGroups?, capabilities? }` (each list only when set) and
 * `changeHash = computeChangeHash('catalog_exercise_links', payload)`. No stale guard (assumption A4): the app shows the
 * current state beside the proposed one. The app decides by the athlete's rights row `personalize_exercise`; the PAT can
 * propose and read back, never apply (Propose-Only Boundary). Older servers answer 400 until the deploy.
 *
 * Exports:
 *   validateCatalogExerciseLinks(args, target, vocabulary) — the tool-side check
 *   buildCatalogExerciseLinksPayload(args)                 — the allowlisted payload
 *   registerToolProposeCatalogExerciseLinks(server, cfg)   — registers the tool with the MCP server
 *
 * Security (threat model): T-121-01 (an HttpError surfaces only `HTTP <status>`), T-121-02 (no spread of a catalog entry
 * into the payload), T-121-07 (handler wrapped in try/catch, nothing on stdout), T-166-25 (an unknown key is named, never
 * the payload), T-168.1-12.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeCatalogExerciseLinksSchema } from '../schemas.js';
import { AUTO_APPLY_NOTICE } from '../auto-apply-notice.js';
import { getSnapshot } from '../cache.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';
import { catalogLinkVocabulary, findUnknownLinkKey, type LinkVocabulary } from './propose_new_exercise.js';
import type { CapabilityLinkInput, MuscleLinkInput } from '../types.js';

export interface ProposeCatalogExerciseLinksArgs {
  exerciseId: string;
  rationale?: string;
  muscleGroups?: MuscleLinkInput[];
  capabilities?: CapabilityLinkInput[];
}

/**
 * The tool-side check against the exercise the MCP read: `target` is the found exercise's origin, or `undefined` when the
 * id is neither a catalog nor an own exercise. Returns the tool error text, or `undefined` when the proposal may be sent.
 */
export function validateCatalogExerciseLinks(
  args: ProposeCatalogExerciseLinksArgs,
  target: { origin: 'CATALOG' | 'CUSTOM' } | undefined,
  vocabulary: LinkVocabulary,
): string | undefined {
  if (target === undefined) {
    return `EXERCISE_NOT_FOUND: no catalog exercise has this exerciseId (${args.exerciseId}).`;
  }
  if (target.origin === 'CUSTOM') {
    return (
      'OWN_EXERCISE_LINKS_REFUSED: this is an own exercise, which has no catalog list to replace. ' +
      'Use propose_exercise_update to change its muscleGroups or capabilities.'
    );
  }
  return findUnknownLinkKey(args, vocabulary);
}

/** The allowlisted `catalog_exercise_links` payload, each list only when set (protocol §2.9). */
export function buildCatalogExerciseLinksPayload(args: ProposeCatalogExerciseLinksArgs): Record<string, unknown> {
  return {
    exerciseId: args.exerciseId,
    ...(args.muscleGroups !== undefined ? { muscleGroups: args.muscleGroups } : {}),
    ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
  };
}

/**
 * Register the `propose_catalog_exercise_links` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposeCatalogExerciseLinks(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_catalog_exercise_links',
    {
      title: 'Propose Catalog Exercise Links',
      description:
        'Propose to the athlete a personal list of muscles or capabilities for a catalog exercise (origin CATALOG in ' +
        'get_exercise_catalog). The tool itself changes nothing; it sends the proposal to the app. An accepted list ' +
        'replaces the catalog list of that kind for this one athlete, completely, everywhere and retroactively: every ' +
        'evaluation counts with it, also for old sets. The shared catalog changes for no one. Pass exerciseId and at ' +
        'least one of muscleGroups and capabilities; a present list replaces, an absent list leaves that kind as it is. ' +
        'Never send an empty list: an axis can be replaced, not removed. The athlete takes the proposal over as it ' +
        'stands or rejects it, there is no editor at this step; to change a list later, the athlete resets the exercise ' +
        'to the catalog and you propose again. Use the muscle and capability keys get_exercise_catalog shows; a capability ' +
        'level is required, a muscle level is optional. An unknown capability key is refused with an error that names it, ' +
        'an exerciseId that is no exercise with EXERCISE_NOT_FOUND, and an own exercise with an error that names ' +
        'propose_exercise_update. This proposal type is live only once the server has been deployed with it; before ' +
        'that the server answers with an HTTP error. ' +
        AUTO_APPLY_NOTICE,
      inputSchema: ProposeCatalogExerciseLinksSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposeCatalogExerciseLinksArgs & { rationale: string };

        const data = await getSnapshot(pat, keyB64, serverUrl);
        const found = data.catalog.find((ex) => ex.id === typedArgs.exerciseId);
        const refusal = validateCatalogExerciseLinks(
          typedArgs,
          found === undefined ? undefined : { origin: found.origin },
          catalogLinkVocabulary(data.linkVocabularyCatalog),
        );
        if (refusal !== undefined) {
          return { isError: true, content: [{ type: 'text' as const, text: refusal }] };
        }

        const payload    = buildCatalogExerciseLinksPayload(typedArgs);
        const changeHash = computeChangeHash('catalog_exercise_links', payload);
        const sourceLlm  = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'catalog_exercise_links',
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
          console.error(`propose_catalog_exercise_links: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose catalog exercise links error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
