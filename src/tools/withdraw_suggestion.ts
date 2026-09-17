/**
 * withdraw_suggestion — the coach's single named exception to propose-only
 * (Phase 136, D-08, PROP-11): retract one of its own proposals that is still
 * `pending`. Talks to the live PAT-authed server route
 * (`POST /api/mcp/coach/suggestions/{id}/withdraw`, src/http.ts's `postWithdraw`),
 * which sends no request body and recognises exactly one transition —
 * `pending` -> `withdrawn`. The route accepts no status parameter of any kind, so
 * this tool can express nothing else; the propose-only boundary stays enforced
 * where the project treats it as a security property (PROJECT.md), the server's
 * auth layer, not here.
 *
 * The row is never deleted. `status = "withdrawn"` is written exactly like any
 * other status transition — the audit row survives with its full `payload`
 * history intact and stays readable through `get_suggestion` (PROP-11's own
 * rule, protocol v1.11 §5.5). This tool's own description states that plainly
 * and never uses deletion vocabulary — a description implying deletion would
 * teach the coach a false model of a boundary this project treats as load-
 * bearing, not cosmetic.
 *
 * Exports:
 *   withdrawSuggestion(args, cfg)               — the network-calling producer
 *   registerToolWithdrawSuggestion(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-136-19 (Information Disclosure, high): the server answers an identical 404
 *             for a foreign id, an unknown id, and an already-decided own row —
 *             `postWithdraw` folds all three into the single `'not-withdrawable'`
 *             outcome (http.ts), and this tool returns ONE fixed error message
 *             for that outcome, never inferring or naming which cause applied.
 *             A distinguishing message would reconstruct the existence oracle
 *             the server route deliberately closes.
 *   T-136-23 (Elevation of Privilege, high): the tool sends no status and no
 *             body — WithdrawSuggestionSchema (schemas.ts) carries only `id`, so
 *             there is no argument through which a caller could ask for a
 *             different transition even if they wanted to.
 *   T-136-20/T-136-21: no console.* anywhere — stdout is JSON-RPC only; ESLint
 *             enforces this. No error path interpolates the PAT or the key.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §propose_plan_update
 *           (WRITE-tool response shape, isError handling — this tool reuses that
 *           shape without the payload building or hashing).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WithdrawSuggestionSchema } from '../schemas.js';
import { postWithdraw, HttpError } from '../http.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WithdrawSuggestionArgs {
  id: string;
}

export interface WithdrawSuggestionResult {
  id: string;
  status: 'withdrawn';
}

/**
 * Thrown when the server's withdraw route answers 404 — a foreign id, an
 * unknown id, or an already-decided own row (T-136-19). The message is fixed
 * and never varies with the cause; it is the SAME string regardless of which
 * of the three situations actually applied, so the tool cannot leak which one
 * it was even by accident.
 */
export class SuggestionNotWithdrawableError extends Error {
  constructor() {
    super('Suggestion not withdrawable: unknown, not yours, or no longer pending.');
    this.name = 'SuggestionNotWithdrawableError';
  }
}

// ---------------------------------------------------------------------------
// Network-calling producer — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Withdraw one of the calling coach's own still-pending proposals.
 *
 * @param args  Validated args — `id` is a UUID string.
 * @param cfg   Runtime config: PAT, encryption key (unused here), server base URL.
 * @throws {SuggestionNotWithdrawableError} on the server's identical-404 outcome
 *   (foreign id, unknown id, or an own row in any status other than
 *   pending/withdrawn) — never distinguishes the three causes (T-136-19).
 */
export async function withdrawSuggestion(
  args: WithdrawSuggestionArgs,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): Promise<WithdrawSuggestionResult> {
  const outcome = await postWithdraw(cfg, args.id);
  if (outcome === 'not-withdrawable') {
    throw new SuggestionNotWithdrawableError();
  }
  return { id: args.id, status: 'withdrawn' };
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `withdraw_suggestion` tool with the MCP server.
 *
 * Not annotated `readOnlyHint` — it mutates (writes `status = "withdrawn"`).
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolWithdrawSuggestion(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  server.registerTool(
    'withdraw_suggestion',
    {
      title: 'Withdraw Coach Suggestion',
      description:
        'Retract one of your own proposals that is still pending — the single named exception to ' +
        'the propose-only boundary. Sets its status to withdrawn; the proposal is NOT deleted, its ' +
        'audit row survives and stays fully readable through `get_suggestion`. Withdrawing an ' +
        'already-withdrawn proposal is a harmless no-op. Fails with an error, worded identically ' +
        'regardless of cause, for an id that is unknown, not yours, or no longer pending (already ' +
        'accepted, rejected, or expired).',
      inputSchema: WithdrawSuggestionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as WithdrawSuggestionArgs;
        const result = await withdrawSuggestion(typedArgs, cfg);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof SuggestionNotWithdrawableError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: err.message }],
          };
        }
        if (err instanceof HttpError) {
          console.error(`withdraw_suggestion: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected withdraw: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Withdraw suggestion error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
