/**
 * get_history — faithful chronological workout history tool for TARGETED lookups.
 *
 * Returns sessions + their set-logs within a date range, newest-first, with
 * optional exercise UUID filter and a limit cap. D-17 (Phase 137): this tool's
 * capability is unchanged — default limit 200, ceiling 500, the date and
 * exercise filters — only its ROLE changes. It is framed as a targeted detail
 * lookup for a specific window or exercise; `get_training_state` is the
 * standard entry point for "where does the athlete stand overall".
 *
 * D-15 (protocol v1.15 §1.5): an explicit, opt-in `outputFile` switch writes
 * the full result to a local file via `file-channel.ts` instead of returning
 * it inline, returning only path, byte size and scope. Without the switch,
 * behavior is byte-identical to before this plan.
 *
 * Exports:
 *   getHistory(args, snapshot)      — pure function; importable by Phase 121 WRITE tools
 *   registerToolGetHistory(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-120-17: catch → { isError:true }; never include key/PAT in error text
 *   T-120-18: no console.* — stdout is JSON-RPC only; ESLint enforces this
 *   T-120-19: limit max 500 enforced by GetHistorySchema; default 200
 *   T-137-05/T-137-06/T-137-07: file-channel.ts owns every rule governing the
 *     `outputFile` write path; this module never touches node:fs directly.
 *
 * Patterns: RESEARCH.md §Tool Error Handling, §Tool Registration API
 *           PATTERNS.md §src/tools/get_history.ts lines 327–362
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetHistorySchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { writeExportFile } from '../file-channel.js';
import type { DecryptedSnapshot, DecryptedSession, DecryptedSetLog } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetHistoryArgs {
  from:        string;
  to:          string;
  exercise?:   string;
  limit:       number;   // always present — Zod default is 200
  outputFile?: boolean;
}

export interface GetHistoryResult {
  sessions: DecryptedSession[];
  setLogs:  DecryptedSetLog[];
}

// ---------------------------------------------------------------------------
// Pure transform — importable for Phase 121 WRITE tools
// ---------------------------------------------------------------------------

/**
 * Filter and sort a decrypted snapshot into chronological workout history.
 *
 * Algorithm:
 *   1. Convert ISO-date strings to UTC epoch bounds (start-of-day `from`,
 *      end-of-day `to`).
 *   2. Keep sessions whose startTime is in [fromEpoch, toEpoch].
 *   3. If `exercise` is set, additionally keep only sessions that have
 *      at least one setLog with that exerciseId.
 *   4. Sort remaining sessions newest-first (descending startTime).
 *   5. Slice to `limit`.
 *   6. Return those sessions + ALL setLogs whose sessionId is in the result set.
 *
 * @param args     Validated args (GetHistorySchema output — limit is always a number).
 * @param snapshot Pre-decrypted snapshot from the cache layer.
 */
export function getHistory(args: GetHistoryArgs, snapshot: DecryptedSnapshot): GetHistoryResult {
  const { from, to, exercise, limit } = args;

  // Step 1: ISO-date → UTC epoch bounds
  // new Date('YYYY-MM-DD') treats the string as UTC midnight per ECMAScript spec.
  const fromEpoch = new Date(from).getTime();                         // 2024-03-01T00:00:00.000Z
  const toEpoch   = new Date(to + 'T23:59:59.999Z').getTime();       // end-of-day UTC inclusive

  // Step 2: Filter by date range
  let sessions: DecryptedSession[] = snapshot.sessions.filter(
    s => s.startTime >= fromEpoch && s.startTime <= toEpoch,
  );

  // Step 3: Optional exercise filter — keep sessions with ≥1 matching setLog
  if (exercise !== undefined) {
    const sessionIdsWithExercise = new Set<string>(
      snapshot.setLogs
        .filter(sl => sl.exerciseId === exercise)
        .map(sl => sl.sessionId),
    );
    sessions = sessions.filter(s => sessionIdsWithExercise.has(s.id));
  }

  // Step 4: Newest-first
  sessions = [...sessions].sort((a, b) => b.startTime - a.startTime);

  // Step 5: Apply limit
  sessions = sessions.slice(0, limit);

  // Step 6: Collect all setLogs belonging to the retained sessions
  const retainedSessionIds = new Set<string>(sessions.map(s => s.id));
  const setLogs: DecryptedSetLog[] = snapshot.setLogs.filter(
    sl => retainedSessionIds.has(sl.sessionId),
  );

  return { sessions, setLogs };
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts (Phase 120-07)
// ---------------------------------------------------------------------------

/**
 * Register the `get_history` tool with the MCP server.
 *
 * Naming convention (expected by 120-07 index.ts wiring):
 *   registerToolGetHistory(server, { pat, keyB64, serverUrl })
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetHistory(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_history',
    {
      title:       'Get Workout History',
      description:
        'Return sessions and set-logs within a date range (YYYY-MM-DD), newest-first, ' +
        'for a TARGETED detail lookup — a specific window, a specific exercise. ' +
        'For the athlete\'s overall standing, call `get_training_state` first; use this ' +
        'tool once you need the underlying raw sessions and set-logs. ' +
        'Optionally filter by exercise UUID. Results are capped by `limit` (default 200, max 500). ' +
        'Set `outputFile: true` to write the full result to a local file instead of returning it ' +
        'inline — the tool result then reports only the file path, byte size and item count.',
      inputSchema: GetHistorySchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data   = await getSnapshot(pat, keyB64, serverUrl);
        const result = getHistory(args as GetHistoryArgs, data.snapshot);

        if ((args as GetHistoryArgs).outputFile) {
          const itemCount = result.sessions.length + result.setLogs.length;
          const handle    = await writeExportFile(result, itemCount);
          const summary   = {
            outputFile: { path: handle.path, bytes: handle.bytes, itemCount: handle.itemCount },
            from:       (args as GetHistoryArgs).from,
            to:         (args as GetHistoryArgs).to,
            exercise:   (args as GetHistoryArgs).exercise,
            limit:      (args as GetHistoryArgs).limit,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `History error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
