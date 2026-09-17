/**
 * get_suggestion — the coach's single-fetch read-back of one of its own
 * proposals in full (Phase 136, D-08/D-09, PROP-10) — includes `payload`,
 * `appliedPayload` (present only for status `accepted_modified`) and
 * `seriesHash`. The precedent this mirrors is `get_template`'s null-to-
 * structured-error contract — this tool exists precisely for a fresh LLM
 * session that no longer holds the original proposal text in its own
 * conversation history and no longer knows any id in advance except the one
 * `get_suggestions` just handed it.
 *
 * Talks to the live PAT-authed server route (`GET /api/mcp/coach/suggestions/{id}`,
 * src/http.ts's `fetchSuggestion`) rather than the decrypted snapshot cache —
 * `plan_suggestions` is already stored plaintext server-side (Phase 133).
 *
 * Exports:
 *   getSuggestion(args, cfg)               — the network-calling producer
 *   registerToolGetSuggestion(server, cfg) — registers the tool with the MCP server
 *
 * Error contract:
 *   Unknown or foreign id -> `{ isError: true, content: [...] }` in the MCP handler.
 *   `getSuggestion` itself returns `null` (fetchSuggestion's own 404 contract);
 *   the register fn converts it. Never throws from the MCP handler layer.
 *
 * Security (threat model):
 *   T-136-15: a foreign id and an unknown id both surface as `null` here — the
 *             server's identical-404 no-leak body (T-118-05/T-133-02) is
 *             preserved verbatim; this tool never distinguishes the two causes
 *             in its own error text, matching get_template's own precedent of
 *             a single "not found" message regardless of cause.
 *   T-136-20/T-136-21: no console.* anywhere — stdout is JSON-RPC only; ESLint
 *             enforces this. Errors carry only `HTTP <status>` or a generic
 *             message, never the PAT or key.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §get_template.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetSuggestionSchema } from '../schemas.js';
import { fetchSuggestion } from '../http.js';
import type { SuggestionDtoResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetSuggestionArgs {
  id: string;
}

// ---------------------------------------------------------------------------
// Network-calling producer — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Fetch one of the calling coach's own proposals in full.
 *
 * @param args  Validated args — `id` is a UUID string.
 * @param cfg   Runtime config: PAT, encryption key (unused here), server base URL.
 * @returns the full row, or `null` if the id is unknown or belongs to another user.
 */
export async function getSuggestion(
  args: GetSuggestionArgs,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): Promise<SuggestionDtoResponse | null> {
  return fetchSuggestion(cfg, args.id);
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_suggestion` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetSuggestion(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  server.registerTool(
    'get_suggestion',
    {
      title: 'Get Coach Suggestion',
      description:
        'Return one of the coach\'s own proposals in full, including `payload` and — for a ' +
        'modified accept — `appliedPayload`. Pass an id from `get_suggestions`. Returns an error ' +
        'if the proposal is not found (unknown id, or an id that is not one of yours).',
      inputSchema: GetSuggestionSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as GetSuggestionArgs;
        const result = await getSuggestion(typedArgs, cfg);
        if (!result) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Suggestion not found: ${typedArgs.id}` }],
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Get suggestion error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
