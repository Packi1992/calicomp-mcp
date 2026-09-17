/**
 * get_coach_parameters — the coach's self-description entry point for the seven
 * tuning parameters (Phase 137, D-09, STATE-06).
 *
 * Read-only. Returns, in one call, the current value, the default value, the
 * allowed range, and a short description for each of the seven keys — D-09 makes
 * this self-description a requirement, not a convenience ("the MCP has to be
 * able to tell the agent what is possible"). Reading current-or-default
 * parameters mutates nothing server-side (Plan 137-04, protocol v1.15 §5.5), so
 * this tool needs no allowlist entry of its own, exactly like `get_suggestions`.
 *
 * Exports:
 *   getCoachParameters(cfg)                    — the network-calling producer
 *   registerToolGetCoachParameters(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-137-18/T-120-17: errors never interpolate the PAT or CALICOMP_KEY.
 *   T-120-18: no console.* anywhere — stdout is JSON-RPC only; ESLint enforces this.
 *
 * Patterns: RESEARCH.md §Tool Registration API, get_profile.ts's narrow read-tool
 *           shape (no snapshot filtering — this tool talks only to the coach-
 *           parameters route, never the encrypted-snapshot cache).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetCoachParametersSchema } from '../schemas.js';
import { loadCoachParameters, describeCoachParameters, type CoachParametersDescription } from '../coach-parameters.js';

// ---------------------------------------------------------------------------
// Network-calling producer — importable/testable without MCP scaffolding
// ---------------------------------------------------------------------------

/**
 * Load the current coach parameters and describe them (D-09): value, default,
 * range and description per key, plus provenance (`source: 'server' | 'defaults'`).
 */
export async function getCoachParameters(cfg: {
  pat: string;
  serverUrl: string;
}): Promise<CoachParametersDescription> {
  const { params, source } = await loadCoachParameters(cfg);
  return describeCoachParameters(params, source);
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_coach_parameters` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key (unused here), server base URL.
 */
export function registerToolGetCoachParameters(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  server.registerTool(
    'get_coach_parameters',
    {
      title: 'Get Coach Parameters',
      description:
        'Report the seven training-state tuning parameters: their default values, allowed ranges, ' +
        'and current values in one call. Call this BEFORE calling set_coach_parameters — it is the ' +
        'right first step to learn what can be set and what it currently is, rather than discovering ' +
        'the ranges by trial and error.',
      inputSchema: GetCoachParametersSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await getCoachParameters(cfg);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Coach parameters error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
