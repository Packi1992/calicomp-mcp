/**
 * get_planned_workouts — the calendar-read tool: concrete dated occurrences over a
 * required window, produced by the hand-ported RecurrenceExpander (src/recurrence.ts)
 * running behind the MCP's one decode boundary (cache.ts).
 *
 * Returns the RAW expansion — `expandDates()` minus each root's `deletedOccurrences` —
 * with NO completed-session filtering (D-05). The app's own `CalendarViewModel`
 * additionally hides occurrences with a completed session, computed in the phone's
 * system zone; this tool must NOT replicate that hiding, because Phases 136 (stale
 * guard) and 137 (plan adherence) need the complete, unfiltered list as their
 * denominator.
 *
 * Exports:
 *   getPlannedWorkouts(args, snapshot)          — pure function
 *   registerToolGetPlannedWorkouts(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-120-17: catch → { isError:true }; never include key/PAT in error text
 *   T-120-18: no console.* — stdout is JSON-RPC only; ESLint enforces this
 *   T-135-02 (D-15): a malformed recurrence rule (INTERVAL<1, or BYMONTHDAY<1 under
 *     FREQ=MONTHLY — the only two inputs that genuinely hang or crash the real Kotlin
 *     expander) throws a named RecurrenceRuleError instead of hanging or crashing the
 *     stdio process — the whole call fails loudly rather than returning a partial
 *     calendar. A BYMONTHDAY above 31 under FREQ=MONTHLY clamps to month-end exactly as
 *     Kotlin does and does NOT throw (135-05, correcting CR-01).
 *   T-135-01: the 366-day span cap is enforced by GetPlannedWorkoutsSchema, BEFORE any
 *     expansion runs.
 *
 * Patterns: PATTERNS.md §src/tools/get_planned_workouts.ts (get_history.ts template)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetPlannedWorkoutsSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import {
  expandDates,
  parseDeletedOccurrences,
  parseIsoDate,
  formatIsoDate,
  epochMsToUtcCalDate,
  weekOffsetsForGroups,
  renderSeriesFields,
} from '../recurrence.js';
import type { DecryptedSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetPlannedWorkoutsArgs {
  from: string;
  to: string;
}

/**
 * A single expanded occurrence. Mirrors the app's `PlannedOccurrence.kt` with
 * `templateName` added (D-11) — a deleted/unknown template resolves to `null`, NEVER a
 * raw id as a name (precedent 134-30 `resolveTargetLabel`).
 */
export interface PlannedOccurrenceOut {
  date: string;
  rootId: string;
  templateId: string;
  templateName: string | null;
  scheduledTime: string | null;
  note: string | null;
  recurrenceGroupId: string | null;
  isRecurring: boolean;
}

/**
 * A planned-workout root that produced at least one occurrence in the window (D-03).
 * `recurrenceRule` carries the raw rule string ADDITIONALLY to the five derived series
 * fields below (SCHED-02, D-08) — raw and structured are the same truth in two forms,
 * one to read and one to hand back in a Phase 136 proposal. `freq`/`interval`/`byDay`/
 * `until` are `renderSeriesFields(recurrenceRule)`'s output (a null/blank rule yields
 * Kotlin's own literal defaults: `WEEKLY`, `1`, `[]`, `null`); `weekOffset` comes from
 * `weekOffsetsForGroups`, computed once over the WHOLE snapshot (D-07) so it never
 * depends on which window was requested. `deletedOccurrences` is the parsed, sorted,
 * deduplicated array (D-09), never the raw stored string. `completedSessionId` is passed
 * through (D-06); `calendarEventId` and `createdAt` never appear here — there is no field
 * to carry them.
 */
export interface PlannedRootOut {
  id: string;
  templateId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  note: string | null;
  recurrenceRule: string | null;
  recurrenceGroupId: string | null;
  freq: string;
  interval: number;
  byDay: string[];
  until: string | null;
  weekOffset: number;
  deletedOccurrences: string[];
  completedSessionId: string | null;
}

/**
 * `syncedAt` is deliberately NOT emitted — omitting it keeps D-04's byte-identical-
 * output promise literally true for a fixed snapshot (two calls over the same
 * snapshot produce deep-equal results, including no freshness timestamp to diverge).
 */
export interface GetPlannedWorkoutsResult {
  occurrences: PlannedOccurrenceOut[];
  roots: PlannedRootOut[];
}

// ---------------------------------------------------------------------------
// Pure transform
// ---------------------------------------------------------------------------
// epochMsToUtcCalDate is imported from ../recurrence.js (135-05, WR-01) — the
// day-boundary rule lives in exactly one place, shared with the expander.

/**
 * Expand every planned-workout root over `[args.from, args.to]` into concrete dated
 * occurrences.
 *
 * Algorithm:
 *   1. Parse `from`/`to` (already Zod-validated `YYYY-MM-DD`) into inclusive CalDate
 *      window bounds.
 *   2. For each root: `parseDeletedOccurrences(root.deletedOccurrencesRaw)`, then
 *      `expandDates(dtstart, root.recurrenceRule, rangeStart, rangeEnd, deletedSet,
 *      root.id)` — the root's id is passed through so a D-15 error names it.
 *   3. Drop roots that produced no occurrence in the window (D-03) — every emitted
 *      occurrence's `rootId` is guaranteed to resolve to an emitted root.
 *   4. Build occurrence objects, resolving `templateName` from `snapshot.templates`
 *      (D-11): an unknown or soft-deleted template yields `null`, never a raw id.
 *   5. Sort occurrences by `date` ascending, then `scheduledTime` ascending (`null`
 *      sorting last), then `rootId` (D-04) — deterministic across calls.
 *   6. Build the root objects, converting `scheduledDate` from epoch-ms to an ISO date
 *      read in UTC (Protocol §1.4).
 *   7. `weekOffsetsForGroups` runs ONCE, over `snapshot.plannedWorkouts` in FULL —
 *      before step 3's window filter, not after — so a group's reference Monday never
 *      depends on which of its roots happened to fall inside the requested window
 *      (D-07): the same series reports the same offsets for any window.
 *   8. Attach `freq`/`interval`/`byDay`/`until` (via `renderSeriesFields`) and
 *      `weekOffset` (looked up from step 7's map) to every emitted root (SCHED-02).
 *
 * Does NOT filter against sessions — see this file's header (D-05).
 */
export function getPlannedWorkouts(
  args: GetPlannedWorkoutsArgs,
  snapshot: DecryptedSnapshot,
): GetPlannedWorkoutsResult {
  const rangeStart = parseIsoDate(args.from);
  const rangeEnd = parseIsoDate(args.to);

  const templateNameById = new Map<string, string | null>();
  for (const t of snapshot.templates) {
    templateNameById.set(t.id, t.deletedAt == null ? t.name : null);
  }

  // Step 7 (D-07): computed once, over the WHOLE snapshot — never the window-filtered
  // subset — so the reference Monday of a group cannot shift with the requested window.
  const weekOffsets = weekOffsetsForGroups(snapshot.plannedWorkouts);

  const occurrences: PlannedOccurrenceOut[] = [];
  const rootIdsWithOccurrence = new Set<string>();

  for (const root of snapshot.plannedWorkouts) {
    const dtstart = epochMsToUtcCalDate(root.scheduledDate);
    const deletedOccurrences = parseDeletedOccurrences(root.deletedOccurrencesRaw);
    const dates = expandDates(
      dtstart,
      root.recurrenceRule,
      rangeStart,
      rangeEnd,
      new Set(deletedOccurrences),
      root.id,
    );
    if (dates.length === 0) continue;

    rootIdsWithOccurrence.add(root.id);
    const isRecurring = root.recurrenceRule !== null && root.recurrenceRule.trim() !== '';
    const templateName = templateNameById.get(root.templateId) ?? null;

    for (const date of dates) {
      occurrences.push({
        date: formatIsoDate(date),
        rootId: root.id,
        templateId: root.templateId,
        templateName,
        scheduledTime: root.scheduledTime,
        note: root.note,
        recurrenceGroupId: root.recurrenceGroupId,
        isRecurring,
      });
    }
  }

  occurrences.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.scheduledTime !== b.scheduledTime) {
      if (a.scheduledTime === null) return 1;
      if (b.scheduledTime === null) return -1;
      return a.scheduledTime < b.scheduledTime ? -1 : 1;
    }
    if (a.rootId !== b.rootId) return a.rootId < b.rootId ? -1 : 1;
    return 0;
  });

  const roots: PlannedRootOut[] = snapshot.plannedWorkouts
    .filter((root) => rootIdsWithOccurrence.has(root.id))
    .map((root) => {
      const seriesFields = renderSeriesFields(root.recurrenceRule);
      return {
        id: root.id,
        templateId: root.templateId,
        scheduledDate: formatIsoDate(epochMsToUtcCalDate(root.scheduledDate)),
        scheduledTime: root.scheduledTime,
        note: root.note,
        recurrenceRule: root.recurrenceRule,
        recurrenceGroupId: root.recurrenceGroupId,
        freq: seriesFields.freq,
        interval: seriesFields.interval,
        byDay: seriesFields.byDay,
        until: seriesFields.until,
        // Every root in `snapshot.plannedWorkouts` was fed into `weekOffsets` above
        // (step 7), so this lookup is always defined — `?? 0` is a defensive fallback,
        // never an expected path.
        weekOffset: weekOffsets.get(root.id) ?? 0,
        deletedOccurrences: parseDeletedOccurrences(root.deletedOccurrencesRaw),
        completedSessionId: root.completedSessionId,
      };
    });

  return { occurrences, roots };
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_planned_workouts` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetPlannedWorkouts(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_planned_workouts',
    {
      title: 'Get Planned Workouts',
      description:
        'Return concrete calendar occurrences and their planned-workout roots for a required ' +
        'date window (`from`/`to`, YYYY-MM-DD, both mandatory, span at most 366 days). ' +
        'Cancelled occurrences (deletedOccurrences) are already excluded. Completed occurrences ' +
        'are NOT excluded — a past date alone is not evidence of a missed workout. Each root ' +
        'also carries structured series fields (freq, interval, byDay, until, weekOffset) ' +
        'alongside the raw recurrenceRule, so a series can be described ("every 2 days", ' +
        '"every other week on Monday and Friday") without parsing the RRULE string.',
      inputSchema: GetPlannedWorkoutsSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data = await getSnapshot(pat, keyB64, serverUrl);
        const result = getPlannedWorkouts(args as GetPlannedWorkoutsArgs, data.snapshot);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Planned workouts error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
