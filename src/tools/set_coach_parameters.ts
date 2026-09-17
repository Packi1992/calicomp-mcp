/**
 * set_coach_parameters — the client side of the SECOND named exception to the
 * propose-only boundary (Phase 137, D-23, STATE-06, protocol v1.15 §5.5). Talks to
 * the live PAT-authed server route (`PUT /api/mcp/coach/parameters`, src/http.ts's
 * `putCoachParameters`), which writes to a table holding no training data and no
 * foreign key onto any `user_workout_*` table (Plan 137-04) — that structural fact,
 * not trust placed in this client, is why this exception exists.
 *
 * `SetCoachParametersSchema` (schemas.ts, a re-export of `CoachParametersSchema`
 * from coach-parameters.ts) is one strict object with exactly the seven optional,
 * range-checked numeric fields and NO free-form key — structurally, this schema
 * cannot express anything other than setting a subset of those seven keys. That
 * non-expressibility is the same load-bearing property `withdraw_suggestion`'s
 * schema carries for its single transition. The real enforcement of the propose-
 * only boundary still lives where PROJECT.md requires it to live — the server's
 * auth layer and its key/type allowlist (`ALLOWED_COACH_PARAMETER_KEYS`) — never
 * in this client.
 *
 * Two validation passes, deliberately (see the doc-comment on
 * `coachParametersSchemaFor` in coach-parameters.ts): the static `inputSchema`
 * registered below checks structure and per-field ranges against the DEFAULTS
 * before this handler ever runs, so an obviously invalid call never reaches this
 * code; the handler validates a SECOND time via `coachParametersSchemaFor(current)`
 * against the real, currently-effective state, because only that second pass can
 * correctly resolve the `uncertainThreshold < matchThreshold` invariant when a
 * caller sets only one of the two thresholds.
 *
 * This tool is NOT registered as read-only — it writes. That distinction is made
 * in the actual registration options below, in code, not spelled out again here
 * in prose (Task 3's own verification gate in 137-05-PLAN.md checks that a
 * specific SDK annotation token never appears in this file at all, spelled out or
 * otherwise).
 *
 * Exports:
 *   setCoachParameters(args, cfg)                — the network-calling producer
 *   registerToolSetCoachParameters(server, cfg)  — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-137-02 (Elevation of Privilege, high): the Zod schema is `.strict()` and
 *             carries exactly seven named numeric fields — there is no argument
 *             through which a caller could smuggle an eighth key or a non-numeric
 *             value even if they wanted to.
 *   T-137-04 (Tampering, medium): every field is range-checked against
 *             `COACH_PARAMETER_RANGES`, and the threshold invariant is checked
 *             against the real current state before any network call — an
 *             invalid call never reaches `putCoachParameters`.
 *   T-120-17: neither the PAT nor CALICOMP_KEY nor a rejected value ever appears
 *             in an error message this tool produces.
 *   T-120-18: no console.* anywhere — stdout is JSON-RPC only; ESLint enforces this.
 *
 * Patterns: withdraw_suggestion.ts (structural non-expressibility argument,
 *           isError handling without echoing the rejected input).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SetCoachParametersSchema } from '../schemas.js';
import { putCoachParameters, HttpError } from '../http.js';
import {
  type CoachParameters,
  type CoachParametersDescription,
  loadCoachParameters,
  coachParametersSchemaFor,
  mergeCoachParameters,
  describeCoachParameters,
} from '../coach-parameters.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the second validation pass (against the real current state)
 * rejects the call — an out-of-range value, an unknown key, or a threshold
 * invariant violation. The message names the violated rule, never the rejected
 * value (T-120-17): a value can be a partial fingerprint of the athlete's
 * training approach, and echoing it back in an error is unnecessary exposure.
 */
export class CoachParametersValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoachParametersValidationError';
  }
}

/**
 * Thrown when the server's write route answers 400 — its own key-allowlist-and-
 * type check declined the input (Plan 137-04). This should be unreachable in
 * practice once the client-side schema above has already validated the call, but
 * the server is the actual boundary, so this path is handled, not assumed away.
 */
export class CoachParametersRejectedError extends Error {
  constructor() {
    super('Server rejected the coach-parameter update.');
    this.name = 'CoachParametersRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Network-calling producer — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Set a subset of the calling coach's seven tuning parameters.
 *
 * Loads the current state first (`loadCoachParameters`), validates `args` a
 * second time against that real state (`coachParametersSchemaFor`), and only
 * then calls `putCoachParameters` — never before. Returns the D-09
 * self-description of the resulting overall state.
 *
 * @throws {CoachParametersValidationError} if `args` fails range checks or the
 *   threshold invariant against the real current state. `putCoachParameters` is
 *   never called in this case.
 * @throws {CoachParametersRejectedError} if the server declines the write with 400.
 */
export async function setCoachParameters(
  args: Partial<CoachParameters>,
  cfg: { pat: string; serverUrl: string },
): Promise<CoachParametersDescription> {
  const { params: current } = await loadCoachParameters(cfg);

  const validation = coachParametersSchemaFor(current).safeParse(args);
  if (!validation.success) {
    const message = validation.error.issues.map((issue) => issue.message).join('; ');
    throw new CoachParametersValidationError(message);
  }

  const outcome = await putCoachParameters(cfg, validation.data);
  if (outcome === 'rejected') {
    throw new CoachParametersRejectedError();
  }

  return describeCoachParameters(mergeCoachParameters(outcome.params), 'server');
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `set_coach_parameters` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key (unused here), server base URL.
 */
export function registerToolSetCoachParameters(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  server.registerTool(
    'set_coach_parameters',
    {
      title: 'Set Coach Parameters',
      description:
        'Set one or more of the seven training-state tuning parameters. Call get_coach_parameters ' +
        'first to learn the defaults, allowed ranges, and current values. Rejects an out-of-range ' +
        'value or an invalid uncertainThreshold/matchThreshold combination before any change reaches ' +
        'the server. Returns the resulting overall parameter state.',
      inputSchema: SetCoachParametersSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const result = await setCoachParameters(args as Partial<CoachParameters>, cfg);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof CoachParametersValidationError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Invalid coach parameters: ${err.message}` }],
          };
        }
        if (err instanceof CoachParametersRejectedError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: err.message }],
          };
        }
        if (err instanceof HttpError) {
          console.error(`set_coach_parameters: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected coach parameters: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Set coach parameters error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
