/**
 * get_profile — user profile read tool.
 *
 * Returns the authenticated user's profile object directly from the cache
 * (sourced from the PAT-authed GET /api/mcp/profile endpoint added in Phase 120-03).
 *
 * Exports:
 *   getProfile(profile)             — pure function; importable by Phase 121 WRITE tools
 *   registerToolGetProfile(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-120-20: catch → { isError:true }; profile fields are the user's own data returned
 *             intentionally; never include key/PAT in error text.
 *   T-120-21: no console.* anywhere — stdout is JSON-RPC only; ESLint enforces this.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §get_profile (lines 282–303)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetProfileSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import type { UserProfileResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Pure transform — importable for Phase 121 WRITE tools
// ---------------------------------------------------------------------------

/**
 * Return the cached user profile unchanged.
 *
 * @param profile  Resolved UserProfileResponse from the cache layer.
 */
export function getProfile(profile: UserProfileResponse): UserProfileResponse {
  return profile;
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts (Phase 120-07)
// ---------------------------------------------------------------------------

/**
 * Register the `get_profile` tool with the MCP server.
 *
 * Naming convention (expected by 120-07 index.ts wiring):
 *   registerToolGetProfile(server, { pat, keyB64, serverUrl })
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetProfile(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_profile',
    {
      title:       'Get User Profile',
      description:
        'Return the authenticated user\'s profile: email, displayName, avatarUrl, ' +
        'isPremium, and account createdAt epoch.',
      inputSchema: GetProfileSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const data   = await getSnapshot(pat, keyB64, serverUrl);
        const result = getProfile(data.profile);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Profile error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
