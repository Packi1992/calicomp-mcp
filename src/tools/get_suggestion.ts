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
 * Resolved copies (Phase 150, D-35): the registered handler additionally fetches the
 * decrypted snapshot ONLY to name catalog exercises inside `payload`/`appliedPayload` —
 * `payloadResolved`/`appliedPayloadResolved` are deep, DEEP-WALKED copies in which every
 * `{ source: 'catalog', exerciseId }` reference (`ops[].exercise`, `blocks[].exercises[]`
 * `.exercise`, every `formatParams` entry form, and any future shape carrying the same
 * marker) additively gets `exerciseName`/`exerciseKey` next to its `exerciseId` —
 * `{ source: 'new', tempId }` refs are left untouched. `payload`/`appliedPayload`
 * themselves are NEVER mutated (D-16, T-150-22) — resolution only ever produces a new
 * value alongside them. A payload that fails `JSON.parse`, or a snapshot fetch that
 * throws, still returns the row — with `payloadResolvedSkipped`/
 * `appliedPayloadResolvedSkipped` naming why (`unparsable_payload` | `catalog_unavailable`,
 * T-150-23/T-150-24) — never a silent gap and never an `isError` for either cause. This
 * tool itself reads no encrypted training data (session/set-log/etc.) and therefore never
 * carries an `unreadable` list (D-33) — the snapshot fetch here is solely for the
 * (plaintext) exercise catalog.
 *
 * Exports:
 *   getSuggestion(args, cfg)               — the network-calling producer (UNCHANGED —
 *                                             returns the server's row verbatim; all
 *                                             resolution lives in the registered handler)
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
 *   T-150-22: resolution is response-only — `annotateCatalogRefs` builds a new value;
 *             `payload`/`appliedPayload` on the returned row are never reassigned.
 *   T-150-23: a payload that fails `JSON.parse` yields `payloadResolvedSkipped:
 *             'unparsable_payload'` — caught, never thrown, the tool stays usable.
 *   T-150-24: a snapshot fetch failure yields `payloadResolvedSkipped:
 *             'catalog_unavailable'` and the row is still returned — resolution is
 *             best-effort, never a reason to withhold the suggestion itself.
 *
 * Patterns: RESEARCH.md §Tool Registration API, PATTERNS.md §get_template,
 *           exercise-names.ts (the shared resolver every 150-05/150-06 tool builds).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetSuggestionSchema } from '../schemas.js';
import { fetchSuggestion } from '../http.js';
import { getSnapshot } from '../cache.js';
import { createExerciseNameResolver, type ExerciseNameResolver } from '../exercise-names.js';
import type { SuggestionDtoResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetSuggestionArgs {
  id: string;
  /** Localizes every name added to payloadResolved/appliedPayloadResolved (D-14). */
  lang?: string;
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
// Payload resolution (Phase 150, D-35) — response-only, never mutates the stored
// payload/appliedPayload string (D-16, T-150-22).
// ---------------------------------------------------------------------------

/** Either the resolved copy, or the reason it could not be produced (D-35). */
type PayloadResolveOutcome = { resolved: unknown } | { skipped: 'unparsable_payload' };

/**
 * Deep-walks a parsed payload/appliedPayload value and additively annotates every
 * `{ source: 'catalog', exerciseId }` reference — `ops[].exercise`,
 * `blocks[].exercises[].exercise`, every `formatParams` entry form, and any future shape
 * carrying the same marker (e.g. a `standalone[]` array) — with the resolver's name
 * fields, directly next to `exerciseId`. Shape-driven, not path-driven: no call site needs
 * to enumerate where an `ExerciseRef` can appear. `{ source: 'new', tempId }` refs (a
 * proposal-local temp exercise, not yet in the catalog) are left untouched — there is no
 * `exerciseId` to resolve. Always builds a NEW value; never mutates its input.
 */
function annotateCatalogRefs(value: unknown, resolver: ExerciseNameResolver): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => annotateCatalogRefs(item, resolver));
  }
  if (value !== null && typeof value === 'object') {
    const walked: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      walked[key] = annotateCatalogRefs(v, resolver);
    }
    if (walked.source === 'catalog' && typeof walked.exerciseId === 'string') {
      Object.assign(walked, resolver.forExerciseId(walked.exerciseId));
    }
    return walked;
  }
  return value;
}

/** Parses a stored payload string and annotates it via `annotateCatalogRefs` (D-35). */
function resolvePayloadString(payload: string, resolver: ExerciseNameResolver): PayloadResolveOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { skipped: 'unparsable_payload' };
  }
  return { resolved: annotateCatalogRefs(parsed, resolver) };
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
        'if the proposal is not found (unknown id, or an id that is not one of yours). Also ' +
        'returns payloadResolved (and appliedPayloadResolved, when appliedPayload is present) — a ' +
        'deep copy of the same payload in which every catalog exercise reference additionally ' +
        'carries exerciseName and exerciseKey next to its exerciseId (optional lang, default ' +
        'English). payload/appliedPayload themselves are never changed. If a resolved copy ' +
        'cannot be produced, payloadResolvedSkipped/appliedPayloadResolvedSkipped names why: ' +
        '"unparsable_payload" or "catalog_unavailable" — the row is still returned either way. ' +
        'This tool reads no encrypted training data and therefore carries no unreadable list.',
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

        const output: Record<string, unknown> = { ...result };
        let resolver: ExerciseNameResolver | undefined;
        try {
          const data = await getSnapshot(cfg.pat, cfg.keyB64, cfg.serverUrl);
          resolver = createExerciseNameResolver({
            catalog:  data.catalog,
            snapshot: data.snapshot,
            lang:     typedArgs.lang,
          });
        } catch {
          resolver = undefined;
        }

        const hasAppliedPayload = result.appliedPayload !== undefined && result.appliedPayload !== null;

        if (resolver === undefined) {
          output.payloadResolvedSkipped = 'catalog_unavailable';
          if (hasAppliedPayload) {
            output.appliedPayloadResolvedSkipped = 'catalog_unavailable';
          }
        } else {
          const payloadOutcome = resolvePayloadString(result.payload, resolver);
          if ('skipped' in payloadOutcome) {
            output.payloadResolvedSkipped = payloadOutcome.skipped;
          } else {
            output.payloadResolved = payloadOutcome.resolved;
          }

          if (hasAppliedPayload) {
            // hasAppliedPayload already excludes null/undefined above.
            const appliedOutcome = resolvePayloadString(result.appliedPayload as string, resolver);
            if ('skipped' in appliedOutcome) {
              output.appliedPayloadResolvedSkipped = appliedOutcome.skipped;
            } else {
              output.appliedPayloadResolved = appliedOutcome.resolved;
            }
          }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Get suggestion error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
