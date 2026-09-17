/**
 * sourceLlm provenance helper (D-01).
 *
 * Derives a `sourceLlm` string from the connected MCP client's self-reported
 * `clientInfo` (captured during the MCP `initialize` handshake). `McpServer`
 * exposes the low-level `Server` instance as a public field `server.server`,
 * whose `getClientVersion()` returns the stored `clientInfo` (or `undefined`
 * before/without a compliant handshake).
 *
 * Truncation: the server column `PlanSuggestions.sourceLlm` is `varchar(64)`
 * (Tables.kt) and McpRoutes.kt only checks non-blank, never length — so this
 * module truncates defensively client-side (T-121-05a) to avoid a raw DB
 * length-constraint 500 from an oversized or misbehaving MCP host.
 *
 * Source: node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js
 * (verified against installed SDK 1.29.0 — see RESEARCH.md Pattern 2).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SOURCE_LLM_MAX_LEN = 64;

/**
 * Return a truncated `<clientName>/<clientVersion>` string, or `'unknown'`
 * when the connected host has no (or an incomplete) clientInfo handshake.
 */
export function getSourceLlm(server: McpServer): string {
  const info = server.server.getClientVersion();
  if (!info || !info.name) return 'unknown';
  return `${info.name}/${info.version ?? '0'}`.slice(0, SOURCE_LLM_MAX_LEN);
}
