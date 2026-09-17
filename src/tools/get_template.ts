/**
 * get_template — workout template detail tool.
 *
 * Returns one template joined with its blocks and template-exercises so the LLM
 * can inspect the full structure of a specific training day.
 *
 * Exports:
 *   getTemplate(args, snapshot)            — pure function; importable by Phase 121 WRITE tools
 *   registerToolGetTemplate(server, cfg)   — registers the tool with the MCP server
 *
 * Error contract:
 *   Unknown templateId → `{ isError: true, content: [...] }` in the MCP handler.
 *   The pure handler returns `null` for an unknown id; the register fn converts it.
 *   Never throws from the MCP handler layer (T-120-22).
 *
 * Security (threat model):
 *   T-120-22: unknown template id → structured isError, never an uncaught throw.
 *   T-120-21: no console.* anywhere — stdout is JSON-RPC only; ESLint enforces this.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §get_template (line 323)
 *
 * Format templates (Phase 134, G-134-12, Protocol v1.7 §2.5): for a format template,
 * `formatParams` is the AUTHORITATIVE authoring structure — `blocks`/`templateExercises` are its
 * compiled, derived image, recomputed from `formatParams` on every save. A coach that wants to
 * propose a change reads `formatParams` and proposes a new `formatParams` (`plan_update`'s
 * `formatParams` field), never an op against `blocks`/`templateExercises`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetTemplateSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import type { DecryptedSnapshot, NormalizedBlock, NormalizedTemplateExercise } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateDetail {
  id:                  string;
  name:                string;
  isFavoriteForWatch:  boolean;
  createdAt:           number;
  updatedAt:           number;
  deletedAt?:          number;
  // CR-01 (134-REVIEW.md): a not-yet-resynced row's column round-trips as a wire `null`, not an
  // absent key (see SyncTemplateDto's KDoc) — this projection is never actually emitted with a
  // `null` value (the spread below normalizes `null` to "key absent"), but the input side must be
  // typed to admit it or the `!= null` guard below has nothing to narrow.
  workoutType?:        string;
  formatParams?:       string;
  blocks:              NormalizedBlock[];
  templateExercises:   NormalizedTemplateExercise[];
}

// ---------------------------------------------------------------------------
// Pure transform — importable for Phase 121 WRITE tools
// ---------------------------------------------------------------------------

/**
 * Fetch one template with its full nested detail.
 *
 * Algorithm:
 *   1. Find the template by id in `snapshot.templates`.
 *   2. Return `null` if not found (the MCP handler converts this to structured isError).
 *   3. Join `snapshot.blocks` where `block.templateId === id`.
 *   4. Join `snapshot.templateExercises` where `te.templateId === id`.
 *   5. Return the assembled `TemplateDetail`.
 *
 * @param args      Validated args — `templateId` is a UUID string.
 * @param snapshot  Pre-decrypted snapshot from the cache layer.
 * @returns `TemplateDetail` if found, `null` if the template does not exist.
 */
export function getTemplate(
  args: { templateId: string },
  snapshot: DecryptedSnapshot,
): TemplateDetail | null {
  const template = snapshot.templates.find(t => t.id === args.templateId);
  if (!template) return null;

  const blocks: NormalizedBlock[] = snapshot.blocks.filter(
    b => b.templateId === args.templateId,
  );

  const templateExercises: NormalizedTemplateExercise[] = snapshot.templateExercises.filter(
    te => te.templateId === args.templateId,
  );

  return {
    id:                 template.id,
    name:               template.name,
    isFavoriteForWatch: template.isFavoriteForWatch,
    createdAt:          template.createdAt,
    updatedAt:          template.updatedAt,
    ...(template.deletedAt !== undefined ? { deletedAt: template.deletedAt } : {}),
    // CR-01 (134-REVIEW.md): `!= null` catches BOTH `undefined` (a pre-Phase-134/CLASSIC row,
    // the key never existed) AND `null` (a post-migration row whose column has not been
    // (re-)written since deploy, the server emits an explicit JSON `null` — see
    // SyncTemplateDto's KDoc). A strict `!== undefined` check let a `null` through verbatim,
    // violating this projection's declared `string`-only optional type.
    ...(template.workoutType != null ? { workoutType: template.workoutType } : {}),
    ...(template.formatParams != null ? { formatParams: template.formatParams } : {}),
    blocks,
    templateExercises,
  };
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts (Phase 120-07)
// ---------------------------------------------------------------------------

/**
 * Register the `get_template` tool with the MCP server.
 *
 * Naming convention (expected by 120-07 index.ts wiring):
 *   registerToolGetTemplate(server, { pat, keyB64, serverUrl })
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetTemplate(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_template',
    {
      title:       'Get Workout Template',
      description:
        'Return one workout template with its blocks and template-exercises joined. ' +
        'Pass the UUID from `list_templates`. Returns an error if the template is not found.',
      inputSchema: GetTemplateSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data   = await getSnapshot(pat, keyB64, serverUrl);
        const result = getTemplate(args as { templateId: string }, data.snapshot);
        if (!result) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Template not found: ${args.templateId}` }],
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Get template error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
