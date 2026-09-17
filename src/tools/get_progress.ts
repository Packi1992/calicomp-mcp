/**
 * get_progress — merged detail tool for per-exercise and per-format progress (Phase 137,
 * STATE-05, D-11/D-12/D-13/D-22/D-25/D-27 c).
 *
 * D-22 merges two originally separate tools (`get_exercise_progress`/`get_format_progress`)
 * into ONE tool with a `kind` discriminator, following the project's own
 * `get_stats(by: 'exercise' | 'muscle')` precedent (`schemas.ts`) and Anthropic's guidance
 * that more tools do not always lead to better outcomes. `kind: 'exercise'` computes
 * `computeExerciseProgress` (this phase's Plan 137-10); `kind: 'format'` computes
 * `computeFormatProgress` (Plan 137-09) — arithmetic for both branches lives entirely in
 * their own `src/training-state/*.ts` modules; this file only resolves shared defaults
 * (points, time zone, coach parameters) and shapes the tool result.
 *
 * D-27 c: a call with no matching data (an unknown `exerciseId`, or a `templateId` with no
 * format sessions) returns a structurally empty result — `points: []` and unset `isError`
 * — never an error, consistent with `get_stats`/`get_history`.
 *
 * Exports:
 *   getProgress(args, data, nowMs)   — pure function
 *   registerToolGetProgress(server, cfg) — registers the tool with the MCP server
 *
 * Time zone (Protocol §1.4 Rule 3):
 *   Every session-to-calendar-day mapping in both branches binds to the athlete's
 *   synchronized `training_timezone_id` via `resolveTimeZoneId` — never the MCP host's
 *   own clock. A snapshot without that key fails this tool loudly and by name
 *   (`TimeZoneUnavailableError`), caught by the handler's try/catch below.
 *
 * Security (threat model):
 *   T-120-17: catch → { isError:true }; never include key/PAT in error text
 *   T-120-18: no console.* — stdout is JSON-RPC only; ESLint enforces this
 *   T-137-05: the `outputFile` export path is exclusively `writeExportFile` from
 *     `file-channel.ts` — fixed location, mode 0600, UUID filename, TTL cleanup, and
 *     ONLY on the caller's explicit request.
 *   T-137-30/T-137-31: see src/training-state/exercise-progress.ts's own doc-header —
 *     this file never strips the direction label's raw series/rule, or the metric field,
 *     from either the inline or outputFile response shape.
 *
 * Patterns: src/tools/get_adherence.ts (pure function + registerTool… split, coach-
 *           parameter loading, the outputFile branch shape this file copies verbatim),
 *           src/schemas.ts's GetStatsSchema (the `by`/discriminatedUnion precedent D-22
 *           follows for this tool's own `kind` discriminator)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetProgressSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { writeExportFile } from '../file-channel.js';
import { loadCoachParameters } from '../coach-parameters.js';
import { resolveTimeZoneId } from '../training-state/time-zone.js';
import {
  computeExerciseProgress,
  type ExerciseProgressSeries,
} from '../training-state/exercise-progress.js';
import { computeFormatProgress, type FormatProgressSeries } from '../training-state/format-progress.js';
import type { DecryptedSnapshot, CatalogExercise } from '../types.js';
import type { CoachParameters } from '../coach-parameters.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GetProgressArgs =
  | { kind: 'exercise'; exerciseId?: string; points?: number; outputFile?: boolean }
  | { kind: 'format'; templateId?: string; points?: number; outputFile?: boolean };

/**
 * The pure function's own result — deliberately WITHOUT `parametersSource`: this function
 * only computes from the `coachParameters` it was handed, it never learns where they came
 * from (server or defaults). The registered handler below is the one place that knows
 * `loadCoachParameters`'s `source` and attaches it, exactly like `get_adherence.ts` does.
 */
export interface GetProgressExerciseResult {
  kind: 'exercise';
  series: ExerciseProgressSeries[];
}

export interface GetProgressFormatResult {
  kind: 'format';
  series: FormatProgressSeries[];
}

export type GetProgressResult = GetProgressExerciseResult | GetProgressFormatResult;

// ---------------------------------------------------------------------------
// Pure exportable function
// ---------------------------------------------------------------------------

/**
 * Compute either the per-exercise or the per-format progress view.
 *
 * @param args  Validated args from `GetProgressSchema`.
 * @param data  Decrypted snapshot + catalog + the already-loaded coach parameters.
 * @throws TimeZoneUnavailableError if the athlete's time zone cannot be resolved.
 */
export function getProgress(
  args: GetProgressArgs,
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[]; coachParameters: CoachParameters },
): GetProgressResult {
  const timeZoneId = resolveTimeZoneId(data.snapshot);
  const maxPoints = args.points ?? data.coachParameters.exerciseTrendPoints;

  if (args.kind === 'exercise') {
    const series = computeExerciseProgress(
      {
        exerciseId: args.exerciseId,
        maxPoints,
        recentExerciseCount: data.coachParameters.recentExerciseCount,
      },
      { snapshot: data.snapshot, catalog: data.catalog, timeZoneId },
    );
    return { kind: 'exercise', series };
  }

  const series = computeFormatProgress(
    { templateId: args.templateId, maxPoints },
    { snapshot: data.snapshot, timeZoneId },
  );
  return { kind: 'format', series };
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts
// ---------------------------------------------------------------------------

/**
 * Register the `get_progress` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetProgress(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_progress',
    {
      title: 'Get Training Progress',
      description:
        'Two progress views in one tool, selected by `kind`. `kind: "exercise"` returns the ' +
        'per-exercise progress series across ALL sessions the exercise appears in (even sessions ' +
        'without a template) — each point carries the best single set AND the session total, in ' +
        'the metric appropriate to that exercise (e1RM for weighted exercises, reps or hold time ' +
        'for bodyweight exercises), plus a direction label with its own rule and the raw values it ' +
        'was computed from. Omit `exerciseId` to get the most recently trained exercises instead ' +
        'of one specific exercise. `kind: "format"` returns the format-specific progression ' +
        '(AMRAP rounds+reps, Death-By highest round, EMOM intervals) for one template, or all ' +
        'format templates if `templateId` is omitted. `points` overrides how many recent points ' +
        'each series returns (3-30) for this one call. A call with no matching data returns an ' +
        'empty series, never an error. Set `outputFile: true` to write the full point series to a ' +
        'local file instead of returning it inline.',
      inputSchema: GetProgressSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data = await getSnapshot(pat, keyB64, serverUrl);
        const { params, source } = await loadCoachParameters({ pat, serverUrl });
        const result = getProgress(args as GetProgressArgs, {
          snapshot: data.snapshot,
          catalog: data.catalog,
          coachParameters: params,
        });
        const full = { ...result, parametersSource: source };

        if ((args as GetProgressArgs).outputFile) {
          const itemCount = full.series.reduce((sum, s) => sum + s.points.length, 0);
          const handle = await writeExportFile(full, itemCount);
          const summary =
            full.kind === 'exercise'
              ? {
                  kind: full.kind,
                  outputFile: { path: handle.path, bytes: handle.bytes, itemCount: handle.itemCount },
                  series: full.series.map((s) => ({
                    exerciseId: s.exerciseId,
                    exerciseName: s.exerciseName,
                    mode: s.mode,
                    usesWeight: s.usesWeight,
                    metric: s.metric,
                    bestSetDirection: s.bestSetDirection,
                    sessionTotalDirection: s.sessionTotalDirection,
                    rule: s.rule,
                  })),
                  parametersSource: source,
                }
              : {
                  kind: full.kind,
                  outputFile: { path: handle.path, bytes: handle.bytes, itemCount: handle.itemCount },
                  series: full.series.map((s) => ({
                    templateId: s.templateId,
                    templateName: s.templateName,
                    workoutType: s.workoutType,
                    skippedSessionCount: s.skippedSessionCount,
                  })),
                  parametersSource: source,
                };
          return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(full) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Progress error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
