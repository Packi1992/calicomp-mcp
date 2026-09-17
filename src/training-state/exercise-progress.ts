/**
 * Per-exercise progress across ALL sessions the exercise ever appeared in (Phase 137,
 * STATE-05, D-11, D-12, D-25) — no `templateId` join, no `templateId` filter, anywhere in
 * this file's filter path.
 *
 * D-11 (both series, named): every point carries TWO figures — the best single set of the
 * session (peak performance, consistent with e1RM and the app's own record cards) and the
 * sum across the whole session (work actually done). Together they make DOUBLE
 * PROGRESSION visible: a flat best set alongside a rising session total means "more volume
 * at the same performance" — the exact distinction COACH-CONTEXT Finding 4 names as the
 * point where a naive plateau notion misreads calisthenics training.
 *
 * D-25 (metric choice): e1RM carries no meaning for a bodyweight exercise — a number
 * without added weight makes no performance claim, so it must never be shown as a
 * performance metric just because it happens to be computable (T-137-31). Metric
 * selection is `catalog[exerciseId].usesWeight`/`.mode`: `usesWeight` true → `e1rm`
 * (`bestE1rm`, imported from `../e1rm.js`, never re-derived); `usesWeight` false and
 * `mode === 'TIME'` → `timeSeconds`; every other case (REPS, MAX, or an exercise absent
 * from the catalog) → `reps` — a MAX station is logged in reps (see the flagged assumption
 * on this specific choice in 137-10-PLAN.md).
 *
 * Correction to the earlier CONTEXT rationale — does NOT change STATE-05 itself, only its
 * justification: STATE-05 has previously been argued for with "the app cannot show
 * progress per exercise". That is factually wrong for the Analytics "weekly progression"
 * metric — `AnalyticsDao.getSetHistoryForExercise` (TrainCounter) does NOT filter by
 * `templateId` and already covers sessions without a template; the earlier reasoning
 * confused it with `getSetLogsForTemplate` (a different, template-scoped view feeding
 * `SessionDetailViewModel`). STATE-05 remains a valid requirement — the MCP genuinely is
 * simpler here (`snapshot.setLogs` filtered by `exerciseId`, no template join needed at
 * all) — only the earlier justification was wrong. This note exists so a future parity
 * discussion does not reopen it.
 *
 * Exports:
 *   DirectionLabel, DirectionOutcome  — the D-12 classifier's result shape
 *   DIRECTION_RULE                    — the plain-text rule every direction result carries
 *                                       alongside its label — a deterministic SUGGESTION,
 *                                       never a verdict (T-137-30)
 *   directionOf                       — first-half vs second-half mean, 3% dead band, at
 *                                       least four usable (non-null) values required
 *   ExerciseProgressPoint,
 *   ExerciseProgressMetric,
 *   ExerciseProgressSeries            — per plan interface_contract
 *   computeExerciseProgress           — assembles one series per exercise, no templateId
 *                                       join anywhere
 *
 * Security (threat model):
 *   T-137-30 (Repudiation): a direction label read as a verdict instead of a suggestion.
 *             Mitigated by always shipping the raw half-means, the relative change, and
 *             `DIRECTION_RULE` verbatim alongside the label — never the label alone.
 *   T-137-31 (Repudiation): an e1RM number for a bodyweight exercise claiming a progress
 *             it does not measure. Mitigated by the `usesWeight`/`mode` metric switch
 *             above; `metric` is itself a field of the result, so the chosen metric never
 *             has to be guessed.
 *   T-120-17/T-120-18: this module performs no I/O and throws nothing; the surrounding
 *             tool's try/catch and no-console discipline is unaffected by this file.
 *
 * Patterns: src/tools/get_stats.ts (bestE1rm import, the volume-sum computation this
 *           module reuses for the e1RM sessionTotal), src/training-state/muscle-balance.ts
 *           (the `setLog.exerciseId ?? workoutExerciseId` exercise-resolution chain, the
 *           soft-delete/ongoing-session guards this module's filter loop mirrors)
 */

import { bestE1rm } from '../e1rm.js';
import { toCalendarDay } from './time-zone.js';
import type { DecryptedSetLog, DecryptedSession, DecryptedSnapshot, CatalogExercise } from '../types.js';

// ---------------------------------------------------------------------------
// D-12: deterministic direction classifier
// ---------------------------------------------------------------------------

export type DirectionLabel = 'up' | 'flat' | 'down' | 'insufficient-data';

/** Result shape `directionOf` returns — the raw half-means and relative change travel WITH the label, never separately (T-137-30). */
export interface DirectionOutcome {
  label: DirectionLabel;
  firstHalfMean: number | null;
  secondHalfMean: number | null;
  relativeChange: number | null;
}

/** Relative-change dead band: a change within +/-3% counts as `flat` (D-12, unkalibriert — see 137-10-PLAN.md flagged_assumptions). */
const DEAD_BAND = 0.03;

/** Minimum usable (non-null) values required before a direction can be judged at all. */
const MIN_USABLE_VALUES = 4;

/**
 * The plain-text rule every `DirectionOutcome` carries alongside its label (D-12). Not just
 * documentation — this exact string travels in every `ExerciseProgressSeries.rule` field so
 * an agent can quote the rule it is disagreeing with, rather than trusting the label blind.
 */
export const DIRECTION_RULE =
  'The series is split into a first half and a second half by position (for an odd number ' +
  'of points, the middle point falls into neither half). Null values are excluded when ' +
  "averaging each half. The relative change of the second half's mean versus the first " +
  "half's mean is computed; a change within a 3% dead band counts as flat, below -3% as " +
  'down, and above +3% as up. At least four usable (non-null) values are required overall ' +
  '— fewer, or a half with no usable values, yields insufficient-data.';

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * D-12's deterministic direction classifier — a SUGGESTION with its own rule attached, never
 * a verdict (T-137-30). See `DIRECTION_RULE` for the exact rule this function implements.
 */
export function directionOf(values: Array<number | null>): DirectionOutcome {
  const usableCount = values.filter((v) => v !== null).length;
  if (usableCount < MIN_USABLE_VALUES) {
    return { label: 'insufficient-data', firstHalfMean: null, secondHalfMean: null, relativeChange: null };
  }

  const mid = Math.floor(values.length / 2);
  const isOdd = values.length % 2 === 1;
  const firstHalf = values.slice(0, mid);
  const secondHalf = isOdd ? values.slice(mid + 1) : values.slice(mid);

  const firstHalfMean = mean(firstHalf.filter((v): v is number => v !== null));
  const secondHalfMean = mean(secondHalf.filter((v): v is number => v !== null));

  if (firstHalfMean === null || secondHalfMean === null) {
    return { label: 'insufficient-data', firstHalfMean, secondHalfMean, relativeChange: null };
  }

  const relativeChange =
    firstHalfMean === 0
      ? secondHalfMean === 0
        ? 0
        : secondHalfMean > 0
          ? 1
          : -1
      : (secondHalfMean - firstHalfMean) / Math.abs(firstHalfMean);

  const label: DirectionLabel = relativeChange > DEAD_BAND ? 'up' : relativeChange < -DEAD_BAND ? 'down' : 'flat';

  return { label, firstHalfMean, secondHalfMean, relativeChange };
}

// ---------------------------------------------------------------------------
// The per-exercise series — new, STATE-05
// ---------------------------------------------------------------------------

/** One session's contribution to an exercise's progress series. */
export interface ExerciseProgressPoint {
  sessionId: string;
  date: string;
  setCount: number;
  bestSet: number | null;
  sessionTotal: number | null;
}

/** The metric a series is expressed in — chosen once per exercise via `catalog[exerciseId]` (D-25). */
export type ExerciseProgressMetric = 'e1rm' | 'reps' | 'timeSeconds';

/** One exercise's progress series, chronologically ascending. */
export interface ExerciseProgressSeries {
  exerciseId: string;
  exerciseName: string | null;
  mode: string;
  usesWeight: boolean;
  metric: ExerciseProgressMetric;
  points: ExerciseProgressPoint[];
  bestSetDirection: DirectionOutcome;
  sessionTotalDirection: DirectionOutcome;
  rule: string;
}

/**
 * Per-session best-set / session-total for one metric, over an already-resolved set of
 * set-log rows for one exercise in one session. A set with no usable value for the chosen
 * metric contributes to neither figure; if NO row in the session has a usable value, both
 * figures are `null` (never `0`) — the point still belongs in the series, it just carries
 * no performance number (it proves training happened).
 */
function summarizeSession(
  logs: DecryptedSetLog[],
  metric: ExerciseProgressMetric,
): { bestSet: number | null; sessionTotal: number | null } {
  if (metric === 'e1rm') {
    const bestSet = bestE1rm(logs);
    // Volume sum — mirrors get_stats.ts's computeAggregates: reps x weight, only when
    // both are positive (bodyweight/time-only rows contribute nothing, same as the app).
    let sessionTotal: number | null = null;
    for (const log of logs) {
      const w = log.weightUsed;
      const r = log.completedReps;
      if (w !== null && w > 0 && r !== null && r > 0) {
        sessionTotal = (sessionTotal ?? 0) + r * w;
      }
    }
    return { bestSet, sessionTotal };
  }

  let bestSet: number | null = null;
  let sessionTotal: number | null = null;
  for (const log of logs) {
    const value = metric === 'reps' ? log.completedReps : log.completedTimeSeconds;
    if (value === null) continue;
    if (bestSet === null || value > bestSet) bestSet = value;
    sessionTotal = (sessionTotal ?? 0) + value;
  }
  return { bestSet, sessionTotal };
}

/** Builds one exercise's full series (all touched sessions, pre-cap) plus its direction outcomes. */
function buildSeriesForExercise(
  exerciseId: string,
  logs: DecryptedSetLog[],
  ctx: {
    sessionById: Map<string, DecryptedSession>;
    catalogById: Map<string, CatalogExercise>;
    timeZoneId: string;
    maxPoints: number;
  },
): ExerciseProgressSeries {
  const exercise = ctx.catalogById.get(exerciseId);
  const usesWeight = exercise?.usesWeight ?? false;
  const mode = exercise?.mode ?? 'REPS';
  const metric: ExerciseProgressMetric = usesWeight ? 'e1rm' : mode === 'TIME' ? 'timeSeconds' : 'reps';

  const logsBySessionId = new Map<string, DecryptedSetLog[]>();
  for (const log of logs) {
    const bucket = logsBySessionId.get(log.sessionId);
    if (bucket) bucket.push(log);
    else logsBySessionId.set(log.sessionId, [log]);
  }

  const sessionsTouched = [...logsBySessionId.keys()]
    .map((sessionId) => ctx.sessionById.get(sessionId))
    .filter((s): s is DecryptedSession => s !== undefined)
    .sort((a, b) => a.startTime - b.startTime);

  const points: ExerciseProgressPoint[] = sessionsTouched.map((session) => {
    const sessionLogs = logsBySessionId.get(session.id) ?? [];
    const { bestSet, sessionTotal } = summarizeSession(sessionLogs, metric);
    return {
      sessionId: session.id,
      date: toCalendarDay(session.startTime, ctx.timeZoneId),
      setCount: sessionLogs.length,
      bestSet,
      sessionTotal,
    };
  });

  // maxPoints keeps the MOST RECENT points, order stays ascending (same convention as
  // computeFormatProgress).
  const trimmedPoints = points.length > ctx.maxPoints ? points.slice(points.length - ctx.maxPoints) : points;

  return {
    exerciseId,
    exerciseName: exercise?.nameEn ?? null,
    mode,
    usesWeight,
    metric,
    points: trimmedPoints,
    bestSetDirection: directionOf(trimmedPoints.map((p) => p.bestSet)),
    sessionTotalDirection: directionOf(trimmedPoints.map((p) => p.sessionTotal)),
    rule: DIRECTION_RULE,
  };
}

/**
 * Builds per-exercise progress series across ALL sessions the exercise ever appeared in —
 * STATE-05's core requirement. Set-logs are filtered by `exerciseId` alone; there is no
 * template join and no `templateId` condition anywhere in this filter path.
 *
 * With `args.exerciseId` set, exactly one series is returned for that exercise — even with
 * zero matching set-logs (D-27 c: a structurally empty series, `points: []`, direction
 * labels `insufficient-data`, never an error). Without it, the `recentExerciseCount` most
 * recently trained exercises are returned, ordered by the date of their own most recent
 * occurrence, descending.
 *
 * @param args.exerciseId          Restrict to one exercise; omit for the recent-exercises view.
 * @param args.maxPoints           Caps each series to its most recent points (ascending order kept).
 * @param args.recentExerciseCount How many exercises the no-`exerciseId` view returns.
 * @param data.snapshot            The decrypted snapshot (setLogs/sessions/templateExercises).
 * @param data.catalog             The exercise catalog — source of `mode`/`usesWeight` (D-25).
 * @param data.timeZoneId          The athlete's resolved IANA zone — every `date` maps through it.
 */
export function computeExerciseProgress(
  args: { exerciseId?: string; maxPoints: number; recentExerciseCount: number },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[]; timeZoneId: string },
): ExerciseProgressSeries[] {
  const { snapshot, catalog, timeZoneId } = data;
  const catalogById = new Map(catalog.map((ex) => [ex.id, ex]));
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]));

  // Group valid set-logs by resolved exerciseId. NO templateId is read anywhere in this
  // loop — STATE-05's whole point is that this progress spans every session the exercise
  // ever appeared in, template-bound or not.
  const setLogsByExerciseId = new Map<string, DecryptedSetLog[]>();
  for (const setLog of snapshot.setLogs) {
    if (setLog.deletedAt !== undefined) continue;

    const session = sessionById.get(setLog.sessionId);
    if (session === undefined) continue;
    if (session.deletedAt !== undefined) continue;
    if (session.endTime === undefined) continue;

    // Exercise resolution mirrors muscle-balance.ts's COALESCE(sl.exerciseId, we.exerciseId).
    const exerciseId =
      setLog.exerciseId ??
      (setLog.workoutExerciseId !== undefined
        ? templateExerciseById.get(setLog.workoutExerciseId)?.exerciseId
        : undefined);
    if (exerciseId === undefined) continue;

    const bucket = setLogsByExerciseId.get(exerciseId);
    if (bucket) bucket.push(setLog);
    else setLogsByExerciseId.set(exerciseId, [setLog]);
  }

  let exerciseIds: string[];
  if (args.exerciseId !== undefined) {
    exerciseIds = [args.exerciseId];
  } else {
    const lastOccurrenceMs = new Map<string, number>();
    for (const [exerciseId, logs] of setLogsByExerciseId) {
      let latest = -Infinity;
      for (const log of logs) {
        const session = sessionById.get(log.sessionId);
        if (session !== undefined && session.startTime > latest) latest = session.startTime;
      }
      lastOccurrenceMs.set(exerciseId, latest);
    }
    exerciseIds = [...lastOccurrenceMs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, args.recentExerciseCount)
      .map(([exerciseId]) => exerciseId);
  }

  return exerciseIds.map((exerciseId) =>
    buildSeriesForExercise(exerciseId, setLogsByExerciseId.get(exerciseId) ?? [], {
      sessionById,
      catalogById,
      timeZoneId,
      maxPoints: args.maxPoints,
    }),
  );
}
