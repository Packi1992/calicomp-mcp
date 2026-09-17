/**
 * get_suggestions — the coach's cheap read-back of its own proposals (Phase 136,
 * D-08/D-09, PROP-10). Returns one summary row per proposal — id, type, status,
 * created date, a human-readable target label, and a short rationale — never
 * `payload`/`appliedPayload`. Mirrors this MCP's existing list-plus-single
 * precedent (`list_templates`/`get_template`): call this tool first, newest
 * first; call `get_suggestion` only for the one row that needs its full payload.
 *
 * Unlike every other READ tool in this MCP, this one talks to a live PAT-authed
 * server route (`GET /api/mcp/coach/suggestions`, src/http.ts's
 * `fetchSuggestions`) rather than the decrypted snapshot cache — `plan_suggestions`
 * is already stored plaintext server-side (Phase 133), so there is no decryption
 * boundary to cross here and no cache staleness to reconcile.
 *
 * Exports:
 *   getSuggestions(args, cfg)               — the network-calling producer
 *   registerToolGetSuggestions(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-136-16: the summary DTO (types.ts's SuggestionSummaryDtoResponse) carries no
 *             `payload`/`appliedPayload` member — enforced at the type level; the
 *             server itself never sends them on this route.
 *   T-136-22: `limit` is clamped client-side to 1..500 (default 200) IN ADDITION
 *             to the server's own `coerceIn(1, 500)`, so a malformed or absent
 *             argument can never request an unbounded read even if the Zod
 *             boundary is somehow bypassed.
 *   T-136-20/T-136-21: no console.* anywhere — stdout is JSON-RPC only; ESLint
 *             enforces this. Errors carry only `HTTP <status>` or a generic
 *             message, never the PAT or key.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §list_templates/get_template.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetSuggestionsSchema } from '../schemas.js';
import { fetchSuggestions } from '../http.js';
import type { SuggestionSummaryDtoResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetSuggestionsArgs {
  status?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Clamp — client-side belt on top of the server's own clamp (T-136-22)
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

/**
 * Clamp an optional caller-supplied limit into the inclusive range 1..500,
 * defaulting to 200 when absent — mirrors the server's own
 * `SuggestionService.listSuggestionsForCoach`'s `limit.coerceIn(1, 500)`.
 */
export function clampSuggestionsLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, limit));
}

// ---------------------------------------------------------------------------
// Network-calling producer — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Fetch the calling coach's own proposals as summary rows, newest first.
 *
 * @param args  Validated args — optional `status` filter, optional `limit`.
 * @param cfg   Runtime config: PAT, encryption key (unused here), server base URL.
 */
export async function getSuggestions(
  args: GetSuggestionsArgs,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): Promise<SuggestionSummaryDtoResponse[]> {
  return fetchSuggestions(cfg, args.status, clampSuggestionsLimit(args.limit));
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_suggestions` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetSuggestions(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  server.registerTool(
    'get_suggestions',
    {
      title: 'Get Coach Suggestions',
      description:
        'List the coach\'s own proposals as cheap summary rows, newest first: id, type, status, ' +
        'created date, a human-readable target label, and a short rationale. No payload included. ' +
        'Call this first; call `get_suggestion` with one id only when you need the full proposal, ' +
        'including its outcome (`appliedPayload` for a modified accept). Optional `status` filter ' +
        '(pending, accepted, accepted_modified, rejected, expired, withdrawn, obsolete); optional ' +
        '`limit` (default 200, clamped to 1..500). Empty array, never an error, when you have no proposals.',
      inputSchema: GetSuggestionsSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const result = await getSuggestions(args as GetSuggestionsArgs, cfg);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Get suggestions error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
