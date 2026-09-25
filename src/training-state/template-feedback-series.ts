/**
 * Per-template feedback and goal-attainment series for `get_training_state` (Phase 151,
 * FB-12, D-27/D-28/D-29).
 *
 * PARITAETSFREI: unlike `consistency.ts`'s streak port, nothing here mirrors a Kotlin
 * calculator byte-for-byte against a shared corpus — the app never computes this series
 * itself. The per-set goal-attainment rule below is new TypeScript arithmetic that
 * reproduces `ProgressionAnalyzer.sessionMeetsTarget`'s existing semantics
 * (`TrainCounter/.../domain/ProgressionAnalyzer.kt:160-212`) by construction — round-target
 * aware, MAX and weight never counted, a set with no `workoutExerciseId` counted toward
 * neither side — not by a replayed test vector.
 *
 * Source: `docs/COACH-PLANNING-PROTOCOL.md` §1.3 "Goal snapshot and goal attainment".
 *
 * Selection (D-27): only sessions `classifySession` reports as `sessionKind === 'template'`,
 * not soft-deleted, and completed (`endTime !== undefined`) — a QuickChallenge, a
 * templateless session, a still-running session, or a soft-deleted session never appears.
 * Sessions are grouped by `templateId`, newest first, capped at `MAX_SERIES_SESSIONS` per
 * template (T-137-37-style response-size guard); templates are then ordered by their own
 * newest session and capped at `MAX_SERIES_TEMPLATES`.
 *
 * Goal attainment (D-28/D-29): when a session carries a stored goal snapshot (`tg`, decoded
 * as `DecryptedSession.goalSnapshot`), attainment is computed against it and reported with
 * `basis: 'stored_goals'`. When it does not — every session from before app 4.4, and every
 * free/group/QuickChallenge session by construction (excluded above anyway) — attainment is
 * computed against the template's CURRENT goals instead (`snapshot.templateExercises`,
 * live rows only) and reported as `basis: 'approximation_current_template'`. Either way, a
 * set counts only if it carries a `workoutExerciseId` resolving to a non-`MAX` goal entry
 * AND that entry has a target for its own mode (`targetReps` for `REPS`, `targetTimeSeconds`
 * for `TIME`); weight is never part of the check. The *n*-th such set of a given
 * `workoutExerciseId` (ordered by `createdAt`) is judged against that entry's round-*n*
 * `roundTargets` row where one exists (falling back field-by-field to the entry's own
 * target, exactly like `ProgressionAnalyzer`'s `rt?.field ?: exercise.field`), otherwise
 * against the entry's own target directly. If nothing ends up counted — no goal snapshot AND
 * no live template to approximate against, or simply no set logs match any goal entry —
 * `goalAttainment` is `null`, never a fabricated `0/0`.
 *
 * The comment never travels here (D-26/D-27) — only `hasComment`. A session missing
 * `feedback` altogether (a fixture predating this field) reads `never_asked` on both scales,
 * the same fallback `cache.ts`'s own `decryptSession` already applies for a legacy row.
 *
 * Exports:
 *   MAX_SERIES_SESSIONS, MAX_SERIES_TEMPLATES — the D-27/T-137-37 response-size caps
 *   TemplateFeedbackSeriesEntry, TemplateFeedbackSeries — the result shapes
 *   computeGoalAttainment       — one session's achieved/total sets + basis, or null
 *   computeTemplateFeedbackSeries — snapshot + zone + optional name resolver -> the series
 *
 * Security (threat model):
 *   T-151-48: the comment text never enters this module's output — only `hasComment`.
 *   T-151-49: `MAX_SERIES_SESSIONS`/`MAX_SERIES_TEMPLATES` bound the response size.
 *   T-151-50: this module is additive-only; it is consulted by `get_training_state.ts`
 *             strictly AFTER `buildNarrative`, so it can never change an existing field.
 */

import type {
  DecryptedSession,
  DecryptedSetLog,
  DecryptedSnapshot,
  SessionFeedback,
  SessionGoal,
  SessionScaleFeedback,
} from '../types.js';
import { classifySession, buildTemplateIndex, type TemplateStatus } from '../session-kind.js';
import { toCalendarDay } from './time-zone.js';
import type { ExerciseNameResolver } from '../exercise-names.js';

/** At most this many of a template's most recent completed sessions appear (D-27, T-137-37). */
export const MAX_SERIES_SESSIONS = 8;

/** At most this many templates appear, ordered by their own most recent session (D-27, T-137-37). */
export const MAX_SERIES_TEMPLATES = 20;

/** The empty feedback both scales read when a session carries no `feedback` at all — the
 *  same fallback `cache.ts`'s private `emptySessionFeedback()` applies for a legacy row;
 *  duplicated here rather than imported since that helper is not exported. */
const NEVER_ASKED_FEEDBACK: SessionFeedback = {
  execution: { value: null, state: 'never_asked', setLaterAt: null },
  feel: { value: null, state: 'never_asked', setLaterAt: null },
  comment: null,
};

/** One counted set's goal-attainment outcome — internal to this module. */
interface CountedSet {
  exerciseId: string;
  achieved: boolean;
}

/** The basis a session's goal attainment was computed against (D-28/D-29). */
export type GoalAttainmentBasis = 'stored_goals' | 'approximation_current_template';

/** `computeGoalAttainment`'s result shape. */
export interface GoalAttainmentResult {
  achievedSets: number;
  totalSets: number;
  basis: GoalAttainmentBasis;
}

/** One entry in a template's feedback series — one completed session. */
export interface TemplateFeedbackSeriesEntry {
  sessionId: string;
  date: string;
  execution: SessionScaleFeedback;
  feel: SessionScaleFeedback;
  goalAttainment: GoalAttainmentResult | null;
  missedExercises: Array<{ exerciseId: string; exerciseName: string | null; exerciseKey: string | null }>;
  hasComment: boolean;
}

/** One template's feedback series — up to `MAX_SERIES_SESSIONS` sessions, newest first. */
export interface TemplateFeedbackSeries {
  templateId: string;
  templateName: string | null;
  templateStatus: TemplateStatus;
  sessions: TemplateFeedbackSeriesEntry[];
}

/**
 * Builds the approximation goal list (D-29) from the template's CURRENT, live
 * template-exercises — used only when the session carries no stored goal snapshot. Mirrors
 * `SessionGoal`'s own field names; `roundTargets` is passed through unchanged (same shape as
 * `SessionGoalRoundTarget`).
 */
function buildApproximationGoals(session: DecryptedSession, snapshot: DecryptedSnapshot): SessionGoal[] {
  if (session.templateId === undefined) return [];
  return snapshot.templateExercises
    .filter((te) => te.templateId === session.templateId && te.deletedAt == null)
    .map((te) => ({
      workoutExerciseId: te.id,
      exerciseId: te.exerciseId,
      mode: te.mode,
      sets: te.sets,
      targetReps: te.targetReps,
      targetTimeSeconds: te.targetTimeSeconds,
      targetWeight: te.targetWeight,
      roundTargets: te.roundTargets,
    }));
}

/**
 * Evaluates every set log of `session` against its goal (stored snapshot or the current-
 * template approximation), returning only the sets that COUNT (D-27/D-28/D-29: a
 * `workoutExerciseId` resolving to a non-`MAX` goal entry that carries a target for its own
 * mode). Order matches `createdAt` ascending — the same order both the per-exercise
 * round-ordinal assignment and "first miss" detection rely on.
 */
function evaluateGoalSets(
  session: DecryptedSession,
  setLogs: DecryptedSetLog[],
  snapshot: DecryptedSnapshot,
): { basis: GoalAttainmentBasis; countedSets: CountedSet[] } {
  const storedGoals = session.goalSnapshot ?? null;
  const basis: GoalAttainmentBasis = storedGoals !== null ? 'stored_goals' : 'approximation_current_template';
  const goals = storedGoals ?? buildApproximationGoals(session, snapshot);
  const goalsByWorkoutExerciseId = new Map(goals.map((g) => [g.workoutExerciseId, g]));

  const candidates = setLogs
    .filter((sl) => sl.deletedAt == null && sl.workoutExerciseId !== undefined)
    .filter((sl) => {
      const goal = goalsByWorkoutExerciseId.get(sl.workoutExerciseId as string);
      return goal !== undefined && goal.mode !== 'MAX';
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  const ordinalByWorkoutExerciseId = new Map<string, number>();
  const countedSets: CountedSet[] = [];

  for (const setLog of candidates) {
    const workoutExerciseId = setLog.workoutExerciseId as string;
    const goal = goalsByWorkoutExerciseId.get(workoutExerciseId) as SessionGoal;
    const n = (ordinalByWorkoutExerciseId.get(workoutExerciseId) ?? 0) + 1;
    ordinalByWorkoutExerciseId.set(workoutExerciseId, n);

    const roundRow = goal.roundTargets?.find((r) => r.round === n);
    const targetReps = roundRow?.targetReps ?? goal.targetReps;
    const targetTimeSeconds = roundRow?.targetTimeSeconds ?? goal.targetTimeSeconds;

    if (goal.mode === 'REPS' && targetReps !== undefined) {
      countedSets.push({
        exerciseId: goal.exerciseId,
        achieved: setLog.completedReps !== null && setLog.completedReps >= targetReps,
      });
    } else if (goal.mode === 'TIME' && targetTimeSeconds !== undefined) {
      countedSets.push({
        exerciseId: goal.exerciseId,
        achieved: setLog.completedTimeSeconds !== null && setLog.completedTimeSeconds >= targetTimeSeconds,
      });
    }
    // Any other mode, or a target-less entry for its own mode, counts toward neither side.
  }

  return { basis, countedSets };
}

/**
 * One session's goal attainment: how many of its counted sets met their target, out of how
 * many counted sets there were, and against which basis (D-28/D-29). `setLogs` should be the
 * set logs belonging to `session` (deleted rows are filtered internally). Returns `null` when
 * nothing ended up counted — no goal to compare against, or no set log matched one.
 */
export function computeGoalAttainment(
  session: DecryptedSession,
  setLogs: DecryptedSetLog[],
  snapshot: DecryptedSnapshot,
): GoalAttainmentResult | null {
  const { basis, countedSets } = evaluateGoalSets(session, setLogs, snapshot);
  if (countedSets.length === 0) return null;
  const achievedSets = countedSets.filter((c) => c.achieved).length;
  return { achievedSets, totalSets: countedSets.length, basis };
}

/**
 * The exercises that missed their goal in `session`, in FIRST-MISS order (the order their
 * first failing counted set occurred, by `createdAt`), each `exerciseId` appearing once.
 */
function computeMissedExerciseIds(
  session: DecryptedSession,
  setLogs: DecryptedSetLog[],
  snapshot: DecryptedSnapshot,
): string[] {
  const { countedSets } = evaluateGoalSets(session, setLogs, snapshot);
  const seen = new Set<string>();
  const missed: string[] = [];
  for (const c of countedSets) {
    if (!c.achieved && !seen.has(c.exerciseId)) {
      seen.add(c.exerciseId);
      missed.push(c.exerciseId);
    }
  }
  return missed;
}

/**
 * Computes the per-template feedback series for `get_training_state` (D-27/D-28/D-29).
 *
 * @param snapshot     The decrypted snapshot.
 * @param timeZoneId   The athlete's own resolved IANA zone (never re-resolved here).
 * @param resolver     Optional exercise-name resolver (Phase 150, D-16) — when supplied,
 *                      `missedExercises` entries carry `exerciseName`/`exerciseKey`; when
 *                      omitted, both are `null` for every entry.
 */
export function computeTemplateFeedbackSeries(
  snapshot: DecryptedSnapshot,
  timeZoneId: string,
  resolver?: ExerciseNameResolver,
): TemplateFeedbackSeries[] {
  const templatesById = buildTemplateIndex(snapshot.templates);

  const setLogsBySession = new Map<string, DecryptedSetLog[]>();
  for (const setLog of snapshot.setLogs) {
    const bucket = setLogsBySession.get(setLog.sessionId);
    if (bucket) bucket.push(setLog);
    else setLogsBySession.set(setLog.sessionId, [setLog]);
  }

  const sessionsByTemplateId = new Map<string, DecryptedSession[]>();
  for (const session of snapshot.sessions) {
    if (session.deletedAt != null) continue;
    if (session.endTime === undefined) continue;
    const { sessionKind } = classifySession(session, templatesById);
    if (sessionKind !== 'template') continue;
    if (session.templateId === undefined) continue; // guaranteed by sessionKind, guard keeps TS happy
    const bucket = sessionsByTemplateId.get(session.templateId);
    if (bucket) bucket.push(session);
    else sessionsByTemplateId.set(session.templateId, [session]);
  }

  const groups = [...sessionsByTemplateId.entries()].map(([templateId, sessions]) => {
    const sorted = [...sessions].sort((a, b) => b.startTime - a.startTime);
    return { templateId, sessions: sorted.slice(0, MAX_SERIES_SESSIONS) };
  });

  groups.sort((a, b) => {
    const aNewest = a.sessions[0]?.startTime ?? -Infinity;
    const bNewest = b.sessions[0]?.startTime ?? -Infinity;
    if (aNewest !== bNewest) return bNewest - aNewest;
    return a.templateId.localeCompare(b.templateId);
  });

  return groups.slice(0, MAX_SERIES_TEMPLATES).map(({ templateId, sessions }) => {
    const template = templatesById.get(templateId);
    const templateStatus: TemplateStatus =
      template === undefined ? 'unknown' : template.deletedAt !== undefined ? 'deleted' : 'live';
    const templateName = template?.name ?? null;

    const entries: TemplateFeedbackSeriesEntry[] = sessions.map((session) => {
      const feedback = session.feedback ?? NEVER_ASKED_FEEDBACK;
      const sessionSetLogs = setLogsBySession.get(session.id) ?? [];
      const goalAttainment = computeGoalAttainment(session, sessionSetLogs, snapshot);
      const missedExerciseIds = computeMissedExerciseIds(session, sessionSetLogs, snapshot);
      const missedExercises = missedExerciseIds.map((exerciseId) => {
        const names = resolver ? resolver.forExerciseId(exerciseId) : { exerciseName: null, exerciseKey: null };
        return { exerciseId, exerciseName: names.exerciseName, exerciseKey: names.exerciseKey };
      });

      return {
        sessionId: session.id,
        date: toCalendarDay(session.startTime, timeZoneId),
        execution: feedback.execution,
        feel: feedback.feel,
        goalAttainment,
        missedExercises,
        hasComment: feedback.comment !== null,
      };
    });

    return { templateId, templateName, templateStatus, sessions: entries };
  });
}
