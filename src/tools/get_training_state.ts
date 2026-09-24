/**
 * get_training_state — the coach's standard entry point for "where does the athlete stand"
 * (Phase 137, D-14, completed by Plan 137-12).
 *
 * Plan 137-01 shipped the consistency block (tracer slice, D-01). Plan 137-07 added
 * `muscleBalance`. This plan (137-12) brings the tool to its final, additive-only shape:
 * the adherence short form (Plan 137-08's `computeAdherence`, counts and `explanation`
 * only — the full pair lists stay in `get_adherence`), the most recently trained
 * exercises with their direction labels (Plan 137-10's `computeExerciseProgress`, header
 * data only — the full point series stays in `get_progress`), all-time personal records
 * (Plan 137-11's `computePersonalRecords`), and `narrative` — a deterministic one-to-two
 * sentence summary (D-18, `src/training-state/narrative.ts`) built from the numbers this
 * tool has already computed, never a second LLM call.
 *
 * D-14 is why this tool stays narrow even as it grows: it answers "how is the athlete
 * doing" in one call, but it carries no point series and no pair lists — `get_progress`,
 * `get_adherence` and `get_history` are where depth lives. `GetTrainingStateSchema` stays
 * argument-less; this tool has nothing left to configure per call.
 *
 * Time zone (Protocol §1.4 Rule 3, D-02): `resolveTimeZoneId` is called EXACTLY ONCE in
 * this file — the resolved zone is then threaded as a plain parameter into every
 * calculator this tool calls. No calculator in this file's call graph resolves the zone a
 * second time. A snapshot without the synced `training_timezone_id` key fails this tool
 * loudly and by name (`TimeZoneUnavailableError`), never silently substituting the MCP
 * host's own zone.
 *
 * Exports:
 *   getTrainingState(args, data, nowMs) — pure function
 *   registerToolGetTrainingState(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model):
 *   T-137-36: the narrative sentence over-claims beyond what the numbers support.
 *             Mitigated entirely inside `narrative.ts` — see that file's own header.
 *   T-137-20: a failed coach-parameters fetch silently changes which numbers get
 *             computed. Mitigated by carrying `parametersSource`/`parameters` in every
 *             result — the fallback is visible, the call never fails because of it.
 *   T-137-09: two calculators resolve the athlete's time zone differently. Mitigated by
 *             the single-resolution-then-thread pattern above; a grep gate in this
 *             plan's own `<verify>` counts call sites in this file.
 *   T-137-37: the overview grows into the same response-size limit that made the
 *             file-channel export necessary. Mitigated by carrying no point series and
 *             no pair lists — only header/summary fields from each detail calculator.
 *   T-120-17: catch → { isError:true }; never include key/PAT in error text.
 *   T-120-18: no console.* anywhere — stdout is JSON-RPC only.
 *
 * Patterns: src/tools/get_adherence.ts, src/tools/get_progress.ts (pure function +
 *           registerTool… split, coach-parameter loading, error handling)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetTrainingStateSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { loadCoachParameters, type CoachParameters } from '../coach-parameters.js';
import { resolveTimeZoneId, toCalendarDay } from '../training-state/time-zone.js';
import { parseIsoDate, formatIsoDate, plusDays } from '../recurrence.js';
import {
  computeConsistency,
  computePersonalRecords,
  type ConsistencyResult,
  type PersonalRecord,
} from '../training-state/consistency.js';
import { computeMuscleBalance, type MuscleBalanceWindow } from '../training-state/muscle-balance.js';
import { computeAdherence } from '../training-state/adherence.js';
import {
  computeExerciseProgress,
  type ExerciseProgressMetric,
  type DirectionOutcome,
} from '../training-state/exercise-progress.js';
import { buildNarrative } from '../training-state/narrative.js';
import { decodeReportOf, assertEntitiesReadable, assertTimeZoneReadable } from '../read-guard.js';
import { createExerciseNameResolver, type ExerciseNameFields, type ExerciseNameResolver } from '../exercise-names.js';
import type { DecryptedSnapshot, CatalogExercise, UnreadableRow } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Phase 150, D-14: the only argument, optional — localizes exercise names additively. */
export interface GetTrainingStateArgs {
  lang?: string;
}

/**
 * The adherence SHORT FORM this overview carries — counts, ratio and `explanation` only.
 * Deliberately WITHOUT `matches` and `missed` (D-14: the overview stays narrow; the pair
 * lists are `get_adherence`'s reason to exist).
 */
export interface GetTrainingStateAdherence {
  window: { from: string; to: string };
  toleranceDays: number;
  plannedCount: number;
  matchedCount: number;
  uncertainCount: number;
  missedCount: number;
  removedOccurrenceCount: number;
  adherenceRatio: number | null;
  explanation: string;
}

/**
 * One recently trained exercise's HEADER data — deliberately WITHOUT `points` (same
 * schmalheit reasoning; the full series is `get_progress`'s job).
 *
 * `exerciseKey`/`exerciseDeleted`/`exerciseUnknown` are additive (Phase 150, D-16) —
 * present ONLY when the tool's `nameResolver` is supplied (always true for the
 * registered handler; `Partial` keeps a caller who omits it byte-identical).
 */
export interface GetTrainingStateRecentExercise extends Partial<Pick<ExerciseNameFields, 'exerciseKey' | 'exerciseDeleted' | 'exerciseUnknown'>> {
  exerciseId: string;
  exerciseName: string | null;
  metric: ExerciseProgressMetric;
  lastTrainedOn: string;
  bestSetDirection: DirectionOutcome;
  sessionTotalDirection: DirectionOutcome;
  rule: string;
}

/** One personal record, additively named (Phase 150, D-16) — same additivity story as above. */
export type PersonalRecordWithName = PersonalRecord & Partial<Pick<ExerciseNameFields, 'exerciseKey' | 'exerciseDeleted' | 'exerciseUnknown'>>;

/** `computePersonalRecords`'s result shape, additively named (Phase 150, D-16). */
export interface GetTrainingStatePersonalRecords {
  maxReps: PersonalRecordWithName[];
  maxHoldSeconds: PersonalRecordWithName[];
}

/** The tool's final, additive-only result shape (D-14/D-22). */
export interface GetTrainingStateResult {
  timeZoneId: string;
  asOfDate: string;
  parametersSource: 'server' | 'defaults';
  parameters: CoachParameters;
  consistency: ConsistencyResult;
  muscleBalance: {
    last7Days: MuscleBalanceWindow;
    last30Days: MuscleBalanceWindow;
    allTime: MuscleBalanceWindow;
  };
  /**
   * `null` when the training calendar is unreadable (Phase 150, D-32) — never reused for
   * "nothing was scheduled", which stays inside `GetTrainingStateAdherence.adherenceRatio`.
   * See `adherenceUnavailableReason` for why.
   */
  adherence: GetTrainingStateAdherence | null;
  /**
   * Present ONLY when `adherence` is `null` — a conditional spread, never set to
   * `undefined`, so a readable calendar's result stays byte-identical to before this
   * field existed (D-32).
   */
  adherenceUnavailableReason?: 'calendar_unreadable';
  recentExercises: GetTrainingStateRecentExercise[];
  personalRecords: GetTrainingStatePersonalRecords;
  narrative: string;
}

// ---------------------------------------------------------------------------
// Pure exportable function
// ---------------------------------------------------------------------------

/**
 * Compute the athlete's current training state — the full overview.
 *
 * @param args  Validated args from GetTrainingStateSchema — only an optional `lang` (D-14).
 * @param data  Decrypted snapshot + catalog + the already-loaded coach parameters and
 *              their source. The caller (the registered handler below) is the one place
 *              that knows whether `coachParameters` came from the server or the defaults.
 * @param nowMs Epoch ms for "now" — caller supplies `Date.now()` in production, a fixed
 *              value in tests. Two calls with the same snapshot and the same `nowMs`
 *              produce a deeply equal result, including an identical `narrative`.
 * @throws TimeZoneUnavailableError if the athlete's time zone cannot be resolved.
 */
export function getTrainingState(
  args: GetTrainingStateArgs,
  data: {
    snapshot: DecryptedSnapshot;
    catalog: CatalogExercise[];
    coachParameters: CoachParameters;
    parametersSource: 'server' | 'defaults';
    /**
     * Whether the training calendar (`planned_workout` rows) is fully readable — default
     * `true`, so every existing caller that never learned about Phase 150 stays
     * byte-identical. The registered handler below is the one place that knows this
     * (`report.failedCount.plannedWorkout === 0`, Phase 150, D-32); this pure function
     * never inspects a `DecodeReport` itself.
     */
    calendarReadable?: boolean;
    /**
     * Optional exercise-name resolver (Phase 150, D-16) — the registered handler below
     * always supplies one, built from `catalog`/`snapshot`/`args.lang`. Omitting it keeps
     * `recentExercises`/`personalRecords` byte-identical to before this plan; it is
     * NEVER consulted while building `narrative` (D-03 — see below).
     */
    nameResolver?: ExerciseNameResolver;
  },
  nowMs: number,
): GetTrainingStateResult {
  const { snapshot, catalog, coachParameters, parametersSource, calendarReadable = true, nameResolver } = data;

  // Exactly ONE resolution for this whole tool call — every calculator below receives
  // `timeZoneId` as a plain parameter, never resolving it again itself.
  const timeZoneId = resolveTimeZoneId(snapshot);
  const asOfDate = toCalendarDay(nowMs, timeZoneId);

  const consistency = computeConsistency(snapshot, catalog, timeZoneId, nowMs);
  const muscleBalance = computeMuscleBalance(snapshot, catalog, nowMs);

  // Adherence short form: window ends on the athlete's own calendar day and spans back
  // the coach's adherenceWindowWeeks parameter — the same rangfolge get_adherence.ts
  // uses for its own no-from/to default.
  //
  // D-32: an unreadable calendar (`calendarReadable === false`) skips `computeAdherence`
  // entirely — running it against a snapshot with unreadable rows silently missing would
  // compute a plausible-looking but wrong ratio. `adherence` degrades to `null` with a
  // named reason instead (never `adherenceRatio: null`, which means something different —
  // "nothing was scheduled" — see this file's own `GetTrainingStateResult` doc).
  let adherence: GetTrainingStateAdherence | null;
  let adherenceUnavailableReason: 'calendar_unreadable' | undefined;
  if (calendarReadable) {
    const adherenceTo = asOfDate;
    const adherenceFrom = formatIsoDate(
      plusDays(parseIsoDate(asOfDate), -coachParameters.adherenceWindowWeeks * 7),
    );
    const fullAdherence = computeAdherence(
      {
        from: adherenceFrom,
        to: adherenceTo,
        toleranceDays: coachParameters.toleranceDays,
        matchThreshold: coachParameters.matchThreshold,
        uncertainThreshold: coachParameters.uncertainThreshold,
      },
      { snapshot, catalog, timeZoneId },
    );
    // Only the short form travels in the overview — `matches`/`missed` stay in get_adherence (D-14).
    adherence = {
      window: fullAdherence.window,
      toleranceDays: fullAdherence.toleranceDays,
      plannedCount: fullAdherence.plannedCount,
      matchedCount: fullAdherence.matchedCount,
      uncertainCount: fullAdherence.uncertainCount,
      missedCount: fullAdherence.missedCount,
      removedOccurrenceCount: fullAdherence.removedOccurrenceCount,
      adherenceRatio: fullAdherence.adherenceRatio,
      explanation: fullAdherence.explanation,
    };
  } else {
    adherence = null;
    adherenceUnavailableReason = 'calendar_unreadable';
  }

  // Recently trained exercises: header data only — no `points` (D-14).
  const progressSeries = computeExerciseProgress(
    { maxPoints: coachParameters.exerciseTrendPoints, recentExerciseCount: coachParameters.recentExerciseCount },
    { snapshot, catalog, timeZoneId },
  );
  const recentExercises: GetTrainingStateRecentExercise[] = progressSeries.map((series) => {
    const lastPoint = series.points[series.points.length - 1];
    return {
      exerciseId: series.exerciseId,
      exerciseName: series.exerciseName,
      metric: series.metric,
      lastTrainedOn: lastPoint?.date ?? asOfDate,
      bestSetDirection: series.bestSetDirection,
      sessionTotalDirection: series.sessionTotalDirection,
      rule: series.rule,
    };
  });

  const personalRecords = computePersonalRecords(snapshot, catalog, timeZoneId);

  // The narrative sees ONLY already-computed numbers — never the snapshot itself (D-18).
  const narrative = buildNarrative({
    currentStreakWeeks: consistency.currentStreakWeeks,
    sessionsLast4Weeks: consistency.sessionsLast4Weeks,
    sessionsPrior4Weeks: consistency.sessionsPrior4Weeks,
    adherence:
      adherence === null
        ? null
        : {
            plannedCount: adherence.plannedCount,
            matchedCount: adherence.matchedCount,
            adherenceRatio: adherence.adherenceRatio,
          },
    recentExercises: recentExercises.map((e) => ({
      exerciseId: e.exerciseId,
      exerciseName: e.exerciseName,
      lastTrainedOn: e.lastTrainedOn,
      direction: e.bestSetDirection.label,
    })),
  });

  // Phase 150 (D-03/D-16): enrichment happens AFTER the narrative is built, from the
  // SAME unenriched recentExercises/personalRecords values the narrative already
  // consumed above — the narrative therefore never sees a resolver-derived name, and
  // stays byte-identical whether or not `lang` is set. Without a resolver, both stay
  // byte-identical to before this plan (`nameResolver` is `undefined` in that case).
  const enrichedRecentExercises: GetTrainingStateRecentExercise[] = nameResolver
    ? recentExercises.map((e) => ({ ...e, ...nameResolver.forExerciseId(e.exerciseId) }))
    : recentExercises;
  const enrichedPersonalRecords: GetTrainingStatePersonalRecords = nameResolver
    ? {
        maxReps: personalRecords.maxReps.map((r) => ({ ...r, ...nameResolver.forExerciseId(r.exerciseId) })),
        maxHoldSeconds: personalRecords.maxHoldSeconds.map((r) => ({ ...r, ...nameResolver.forExerciseId(r.exerciseId) })),
      }
    : personalRecords;

  return {
    timeZoneId,
    asOfDate,
    parametersSource,
    parameters: coachParameters,
    consistency,
    muscleBalance,
    adherence,
    ...(adherenceUnavailableReason !== undefined ? { adherenceUnavailableReason } : {}),
    recentExercises: enrichedRecentExercises,
    personalRecords: enrichedPersonalRecords,
    narrative,
  };
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_training_state` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetTrainingState(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_training_state',
    {
      title: 'Get Training State',
      description:
        'The standard entry point for "how is the athlete doing" — a query-time-computed ' +
        'overview, rather than raw session-by-session history. In one call: the current and ' +
        'longest training streak in weeks plus session-frequency counts (consistency); the same ' +
        'radar-chart muscle balance data as the app\'s Analytics dashboard in all three app ' +
        'windows (muscleBalance); a plan-adherence short form — counts, ratio, and an honesty ' +
        'explanation about what removedOccurrenceCount does and does not mean (adherence); the ' +
        'most recently trained exercises with their direction labels (recentExercises); all-time ' +
        'personal records (personalRecords); and a short, deterministic narrative sentence built ' +
        'from these already-computed numbers, never a second model call. Every entry in ' +
        'recentExercises and personalRecords carries exerciseName and exerciseKey next to its ' +
        'exerciseId (optional lang, default English) — the narrative itself is unaffected by ' +
        'lang. This tool stays ' +
        'narrow on purpose: it carries no point series and no pair lists. For per-exercise or ' +
        'per-format progress series, call get_progress. For the full adherence pair/missed lists, ' +
        'call get_adherence. For raw session history, call get_history. All calendar-day mapping ' +
        'binds to the athlete\'s own synchronized time zone, never the coach\'s own clock. ' +
        'Every result carries unreadable: rows that could not be decrypted or decoded (entity, ' +
        'id, reason and plaintext routing fields); an empty list means every encrypted row was ' +
        'read. If the training calendar is unreadable, adherence is null with ' +
        'adherenceUnavailableReason \'calendar_unreadable\' instead of failing.',
      inputSchema: GetTrainingStateSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data = await getSnapshot(pat, keyB64, serverUrl);
        const report = decodeReportOf(data);
        assertEntitiesReadable(report, ['session', 'setLog', 'setting'], 'Training state error');
        assertTimeZoneReadable(report, 'Training state error');
        const calendarReadable = report.failedCount.plannedWorkout === 0;
        const { params, source } = await loadCoachParameters({ pat, serverUrl });
        const nameResolver = createExerciseNameResolver({
          catalog: data.catalog,
          snapshot: data.snapshot,
          lang: (args as GetTrainingStateArgs).lang,
        });
        const result = getTrainingState(
          args as GetTrainingStateArgs,
          {
            snapshot: data.snapshot,
            catalog: data.catalog,
            coachParameters: params,
            parametersSource: source,
            calendarReadable,
            nameResolver,
          },
          Date.now(),
        );
        const unreadable: UnreadableRow[] = report.unreadable;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, unreadable }) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Training state error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
