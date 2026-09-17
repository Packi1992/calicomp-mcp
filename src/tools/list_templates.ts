/**
 * list_templates — workout template listing tool.
 *
 * Returns all non-deleted templates with denormalized block/exercise counts
 * so the LLM can survey the user's training library at a glance.
 *
 * Exports:
 *   listTemplates(snapshot)                 — pure function; importable by Phase 121 WRITE tools
 *   registerToolListTemplates(server, cfg)  — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-120-21: no console.* anywhere — stdout is JSON-RPC only; ESLint enforces this.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §list_templates (line 322)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListTemplatesSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import type { DecryptedSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateListItem {
  id:                  string;
  name:                string;
  isFavoriteForWatch:  boolean;
  blockCount:          number;
  exerciseCount:       number;
  // Phase 134 (G-134-12). `workoutType` only — `formatParams` is deliberately NOT projected
  // here: a list is an overview, and the coach only needs the full parameter block once it has
  // selected one template via `get_template` (Protocol v1.7 §2.5).
  workoutType?:        string;
}

// ---------------------------------------------------------------------------
// Pure transform — importable for Phase 121 WRITE tools
// ---------------------------------------------------------------------------

/**
 * Filter and denormalize the template list.
 *
 * Algorithm:
 *   1. Exclude templates where `deletedAt` is non-null (soft-deleted).
 *   2. For each surviving template, count how many blocks and template-exercises
 *      belong to it by joining on `templateId`.
 *   3. Return the thin result array (no nested join — callers use `get_template`
 *      for the full detail).
 *
 * @param snapshot  Pre-decrypted snapshot from the cache layer.
 */
export function listTemplates(snapshot: DecryptedSnapshot): TemplateListItem[] {
  return snapshot.templates
    .filter(t => t.deletedAt == null)
    .map(t => ({
      id:                  t.id,
      name:                t.name,
      isFavoriteForWatch:  t.isFavoriteForWatch,
      blockCount:          snapshot.blocks.filter(b => b.templateId === t.id).length,
      exerciseCount:       snapshot.templateExercises.filter(te => te.templateId === t.id).length,
      // CR-01 (134-REVIEW.md): `!= null` catches both `undefined` (CLASSIC/pre-Phase-134 row)
      // and `null` (a post-migration row not yet re-synced — the server emits an explicit wire
      // `null`, see SyncTemplateDto's KDoc) — a strict `!== undefined` let `null` through verbatim.
      ...(t.workoutType != null ? { workoutType: t.workoutType } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts (Phase 120-07)
// ---------------------------------------------------------------------------

/**
 * Register the `list_templates` tool with the MCP server.
 *
 * Naming convention (expected by 120-07 index.ts wiring):
 *   registerToolListTemplates(server, { pat, keyB64, serverUrl })
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolListTemplates(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'list_templates',
    {
      title:       'List Workout Templates',
      description:
        'Return all non-deleted workout templates with their block and exercise counts. ' +
        'Use `get_template` to fetch a specific template\'s full detail (blocks + exercises).',
      inputSchema: ListTemplatesSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const data   = await getSnapshot(pat, keyB64, serverUrl);
        const result = listTemplates(data.snapshot);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `List templates error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
