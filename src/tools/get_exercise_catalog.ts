/**
 * get_exercise_catalog — exercise catalog read tool.
 *
 * Returns the full exercise catalog from cache (populated by the unauthenticated
 * GET /api/exercises endpoint). Optionally localizes names via the `lang` param;
 * always includes `muscleGroups[].key` for cross-referencing with `get_stats { by: 'muscle' }`.
 *
 * Exports:
 *   getExerciseCatalog(args, catalog)             — pure function; importable by Phase 121 WRITE tools
 *   registerToolGetExerciseCatalog(server, cfg)   — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-120-21: no console.* anywhere — stdout is JSON-RPC only; ESLint enforces this.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §get_exercise_catalog (lines 383–404)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetExerciseCatalogSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import type { CatalogExercise } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Exercise from the catalog with an optional localized name added when `lang` is provided. */
export interface CatalogExerciseWithLocale extends CatalogExercise {
  /** Localized display name for the requested language; falls back to `nameEn` when absent. */
  localizedName?: string;
}

// ---------------------------------------------------------------------------
// Pure transform — importable for Phase 121 WRITE tools
// ---------------------------------------------------------------------------

/**
 * Return the exercise catalog, optionally with a localized name field.
 *
 * Algorithm:
 *   - If `args.lang` is not provided: return the catalog array unchanged.
 *     (muscleGroups[].key is always present — no projection needed.)
 *   - If `args.lang` is provided: for each exercise, look up the matching
 *     translation in `ex.translations` by `languageCode === args.lang`.
 *     Add `localizedName = translation.name ?? ex.nameEn` (fallback to English
 *     when no translation exists for the requested language).
 *   - `muscleGroups` are always returned in full (key + translations[] + id) so the
 *     LLM can cross-reference `muscleGroups[].key` with `get_stats { by: 'muscle' }`.
 *
 * @param args     Validated args (GetExerciseCatalogSchema — optional lang BCP-47 tag).
 * @param catalog  Cached exercise catalog array from the cache layer.
 */
export function getExerciseCatalog(
  args: { lang?: string },
  catalog: CatalogExercise[],
): CatalogExerciseWithLocale[] {
  if (!args.lang) {
    // No localization requested — return catalog as-is.
    // CatalogExercise already carries muscleGroups[] including .key.
    return catalog as CatalogExerciseWithLocale[];
  }

  // Localization requested: add localizedName with fallback to nameEn.
  return catalog.map(ex => {
    const translation = ex.translations.find(t => t.languageCode === args.lang);
    return {
      ...ex,
      localizedName: translation ? translation.name : ex.nameEn,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts (Phase 120-07)
// ---------------------------------------------------------------------------

/**
 * Register the `get_exercise_catalog` tool with the MCP server.
 *
 * Naming convention (expected by 120-07 index.ts wiring):
 *   registerToolGetExerciseCatalog(server, { pat, keyB64, serverUrl })
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetExerciseCatalog(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_exercise_catalog',
    {
      title:       'Get Exercise Catalog',
      description:
        'Return the full exercise catalog with muscle groups, equipment, and optional ' +
        'localized names. Provide `lang` (e.g. "de", "fr") to add a `localizedName` field ' +
        '(falls back to `nameEn` when no translation exists). Use `muscleGroups[].key` ' +
        'with `get_stats { by: "muscle" }` to query aggregates by muscle group.',
      inputSchema: GetExerciseCatalogSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data   = await getSnapshot(pat, keyB64, serverUrl);
        const result = getExerciseCatalog(args as { lang?: string }, data.catalog);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Exercise catalog error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
