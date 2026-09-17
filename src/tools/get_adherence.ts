/**
 * get_adherence — plan adherence over a caller-chosen window and tolerance (Phase
 * 137, STATE-03, D-05/D-06/D-13/D-19/D-21).
 *
 * The detail tool for "how well does the athlete keep to the plan": quota, matched
 * pairs (with their confidence), missed occurrences, the neutral removed-occurrence
 * count, and the sentence explaining what that count does NOT mean. `get_training_state`
 * carries only the short-form summary; this tool is where the pairs and the honesty
 * text live. All arithmetic is `computeAdherence` (src/training-state/adherence.ts) —
 * this file only resolves the window/tolerance defaults, loads the coach's own
 * parameters, and shapes the tool result.
 *
 * Exports:
 *   getAdherence(args, data, nowMs)   — pure function
 *   registerToolGetAdherence(server, cfg) — registers the tool with the MCP server
 *
 * Time zone (Protocol §1.4 Rule 3):
 *   The default window's "today" and every session-to-occurrence day mapping bind to
 *   the athlete's synchronized `training_timezone_id` via `resolveTimeZoneId` — never
 *   the MCP host's own clock. A snapshot without that key fails this tool loudly and
 *   by name (`TimeZoneUnavailableError`), caught by the handler's try/catch below.
 *
 * Security (threat model):
 *   T-120-17: catch → { isError:true }; never include key/PAT in error text
 *   T-120-18: no console.* — stdout is JSON-RPC only; ESLint enforces this
 *   T-137-05: the `outputFile` export path is exclusively `writeExportFile` from
 *     `file-channel.ts` — fixed location, mode 0600, UUID filename, TTL cleanup, and
 *     ONLY on the caller's explicit request.
 *   T-137-08: `matches[]` carries `confidence`/`similarity` per entry; `uncertainCount`
 *     is a field of its own and is never folded into `adherenceRatio`'s numerator.
 *
 * Patterns: src/tools/get_training_state.ts (pure function + registerTool split,
 *           coach-parameter loading, error handling), src/tools/get_history.ts
 *           (the outputFile branch shape)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetAdherenceSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { writeExportFile } from '../file-channel.js';
import { loadCoachParameters } from '../coach-parameters.js';
import { resolveTimeZoneId, toCalendarDay } from '../training-state/time-zone.js';
import { parseIsoDate, formatIsoDate, plusDays } from '../recurrence.js';
import { computeAdherence, ADHERENCE_EXPLANATION, type AdherenceResult } from '../training-state/adherence.js';
import type { DecryptedSnapshot, CatalogExercise } from '../types.js';
import type { CoachParameters } from '../coach-parameters.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetAdherenceArgs {
  from?: string;
  to?: string;
  toleranceDays?: number;
  windowWeeks?: number;
  outputFile?: boolean;
}

export interface GetAdherenceResult extends AdherenceResult {
  parametersSource: 'server' | 'defaults';
}

// ---------------------------------------------------------------------------
// Pure function — window/tolerance resolution, then computeAdherence
// ---------------------------------------------------------------------------

/**
 * Resolve the effective window and tolerance, then run `computeAdherence`.
 *
 * Window rangfolge (each step tried only if the previous did not apply):
 *   1. `args.from` AND `args.to` BOTH given → use them verbatim.
 *   2. Otherwise: `to` is the athlete's current calendar day; `from` is `windowWeeks`
 *      (argument, else the coach's persisted `adherenceWindowWeeks`) weeks earlier.
 * Tolerance: `args.toleranceDays`, else the coach's persisted `toleranceDays`.
 *
 * @param args  Validated args from `GetAdherenceSchema`.
 * @param data  Decrypted snapshot + catalog + the already-loaded coach parameters.
 * @param nowMs Epoch ms for "now" — caller supplies `Date.now()` in production, a
 *              fixed value in tests.
 * @throws TimeZoneUnavailableError if the athlete's time zone cannot be resolved.
 */
export function getAdherence(
  args: GetAdherenceArgs,
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[]; coachParameters: CoachParameters },
  nowMs: number,
): AdherenceResult {
  const timeZoneId = resolveTimeZoneId(data.snapshot);

  let from: string;
  let to: string;
  if (args.from !== undefined && args.to !== undefined) {
    from = args.from;
    to = args.to;
  } else {
    to = toCalendarDay(nowMs, timeZoneId);
    const weeks = args.windowWeeks ?? data.coachParameters.adherenceWindowWeeks;
    from = formatIsoDate(plusDays(parseIsoDate(to), -weeks * 7));
  }
  const toleranceDays = args.toleranceDays ?? data.coachParameters.toleranceDays;

  return computeAdherence(
    {
      from,
      to,
      toleranceDays,
      matchThreshold: data.coachParameters.matchThreshold,
      uncertainThreshold: data.coachParameters.uncertainThreshold,
    },
    { snapshot: data.snapshot, catalog: data.catalog, timeZoneId },
  );
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_adherence` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetAdherence(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_adherence',
    {
      title: 'Get Plan Adherence',
      description:
        'Answer "how well does the athlete keep to the plan" over a window and tolerance you ' +
        'choose. Without `from`/`to`, the window ends today (the athlete\'s own calendar day) and ' +
        'spans back `windowWeeks` (default: the coach\'s own adherenceWindowWeeks parameter). ' +
        '`toleranceDays` and `windowWeeks` override the coach\'s persisted parameters for this one ' +
        'call only, without saving them. The result reports plannedCount, matchedCount, ' +
        'uncertainCount, missedCount, removedOccurrenceCount, adherenceRatio, the matched pairs ' +
        '(with their confidence and, for similarity-derived matches, the similarity value), the ' +
        'missed occurrences, and an explanation sentence describing what removedOccurrenceCount ' +
        'does and does NOT mean (verbatim: "' + ADHERENCE_EXPLANATION + '"). Set `outputFile: true` ' +
        'to write the full pair/missed lists to a local file instead of returning them inline.',
      inputSchema: GetAdherenceSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data = await getSnapshot(pat, keyB64, serverUrl);
        const { params, source } = await loadCoachParameters({ pat, serverUrl });
        const result = getAdherence(
          args as GetAdherenceArgs,
          { snapshot: data.snapshot, catalog: data.catalog, coachParameters: params },
          Date.now(),
        );
        const full: GetAdherenceResult = { ...result, parametersSource: source };

        if ((args as GetAdherenceArgs).outputFile) {
          const itemCount = result.matches.length + result.missed.length;
          const handle = await writeExportFile(full, itemCount);
          const summary = {
            outputFile: { path: handle.path, bytes: handle.bytes, itemCount: handle.itemCount },
            window: result.window,
            toleranceDays: result.toleranceDays,
            plannedCount: result.plannedCount,
            matchedCount: result.matchedCount,
            uncertainCount: result.uncertainCount,
            missedCount: result.missedCount,
            removedOccurrenceCount: result.removedOccurrenceCount,
            adherenceRatio: result.adherenceRatio,
            explanation: result.explanation,
            parametersSource: source,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(full) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Adherence error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
