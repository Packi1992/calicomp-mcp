/**
 * propose_new_exercise — catalog-dedupe then propose a brand-new exercise (D-04).
 *
 * Never mutates the catalog directly. First checks the cached catalog for a
 * name-normalized match (Pattern 6 `findCatalogMatch`, operating on the same
 * `getSnapshot().catalog` source `get_exercise_catalog` reads — functionally
 * equivalent to calling that handler, no redundant round-trip). On a match,
 * returns `{ dedupedTo: <existingUuid> }` without POSTing. On no match, builds
 * an allowlisted payload (name/mode/usesWeight/description only — never a
 * spread CatalogExercise), computes `changeHash`, stamps `sourceLlm`, and POSTs
 * a `new_exercise` proposal (no stale-guard hash is sent — a brand-new exercise
 * has nothing to stale-guard against).
 *
 * Exports:
 *   registerToolProposeNewExercise(server, cfg)   — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-121-02: payload carries only allowlisted fields; matches referenced by `.id` only.
 *   T-121-01: on HttpError, console.error logs only the status; isError text carries
 *             only `HTTP <status>` — never the PAT or request body.
 *   T-121-07: handler body wrapped in try/catch — never an uncaught throw, never a
 *             byte on stdout (D-05).
 *   T-121-04: only console.error permitted (ESLint no-console allow:['error']).
 *
 * Patterns: RESEARCH.md Pattern 1 (registerTool convention), Pattern 6 (catalog dedupe).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeNewExerciseSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { findCatalogMatch } from '../dedupe.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_new_exercise` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposeNewExercise(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_new_exercise',
    {
      title:       'Propose New Exercise',
      description:
        'Propose a brand-new custom exercise for human review. Never creates it directly — ' +
        'the proposal is transported to the coach inbox for accept/reject. If the name matches ' +
        'an existing catalog exercise, returns the existing UUID instead of proposing a duplicate.',
      inputSchema: ProposeNewExerciseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as {
          name: string;
          mode: 'REPS' | 'TIME' | 'MAX';
          usesWeight: boolean;
          rationale: string;
          description?: string;
        };

        const data  = await getSnapshot(pat, keyB64, serverUrl);
        const match = findCatalogMatch(typedArgs.name, data.catalog);
        if (match) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ dedupedTo: match.id }) }],
          };
        }

        const payload = {
          name:       typedArgs.name,
          mode:       typedArgs.mode,
          usesWeight: typedArgs.usesWeight,
          ...(typedArgs.description ? { description: typedArgs.description } : {}),
        };
        const changeHash = computeChangeHash('new_exercise', payload);
        const sourceLlm  = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'new_exercise',
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
          console.error(`propose_new_exercise: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose new exercise error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
