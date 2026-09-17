/**
 * Format-specific progression scores — the THIRD Kotlin→TypeScript port this phase makes
 * (D-20), and the metric that distinguishes this project from generic dumbbell-tracker
 * apps: EMOM intervals, AMRAP rounds+reps, Death-By highest full round.
 *
 * PARITY BOUNDARY (read this before touching anything below): the value for a SINGLE
 * session — what `amrapSummary`/`deathBySummary`/`emomIntervals` return for one session's
 * ordered set-log rows — is parity-bound to `FormatSummary.kt`, because
 * `SessionDetailViewModel.kt` shows exactly that number in the app's Session-Detail
 * screen. The shared `formatProgress` corpus section (docs/coach-planning-vectors.json)
 * proves this, replayed by both this file's own test suite and `CoachPlanningVectorsTest.kt`
 * against the real Kotlin functions.
 *
 * The LONGITUDINAL SERIES `computeFormatProgress` builds across multiple sessions has NO
 * app equivalent anywhere — `SessionDetailScreen` is the only place the app ever shows one
 * of these numbers, and it always shows exactly one session at a time. The series is
 * therefore new and explicitly parity-FREE; only the per-session value inside each point
 * carries the parity obligation above.
 *
 * `amrapSummary`/`deathBySummary`/`emomIntervals` are a line-for-line port of
 * `FormatSummary.kt` (TrainCounter, EXEC-07). The one real portability trap: Kotlin's `Int`
 * division truncates toward zero; `Math.floor` reproduces that here for the non-negative
 * operands this function ever sees (a negative `exercisesPerRound` never occurs — the
 * app's format editors only ever write non-negative counts).
 *
 * Callers MUST pass `rows` pre-ordered by `(startedAt ?? createdAt)` — exactly like the
 * Kotlin functions, these three do not sort internally. `computeFormatProgress` performs
 * that sort itself before ever calling one of them.
 *
 * Exports:
 *   AmrapScore, DeathByScore              — the two port result shapes
 *   amrapSummary, deathBySummary,
 *   emomIntervals                         — the port, verbatim
 *   FORMAT_SUMMARY_TYPES                  — the same 3-value set
 *                                            SessionDetailViewModel.FORMAT_SUMMARY_TYPES uses
 *   FormatProgressPoint,
 *   FormatProgressSeries                  — the new, parity-free longitudinal series shape
 *   computeFormatProgress                 — assembles the series, one per format template
 *
 * Security (threat model):
 *   T-137-28: a session whose template carries no recognized workoutType must never be
 *             sorted into a format series (Repudiation — a progress claim with no basis).
 *             Mitigated by the nullish (not `!== undefined`) check against
 *             FORMAT_SUMMARY_TYPES and the Pitfall-5 test cases in this module's test file.
 *   T-137-29: unparsable or hostile `formatParams` must never crash the calculation or
 *             silently propagate a wrong number — mitigated by a fully fault-tolerant parse
 *             step that falls back to the SAME defaults the app's own UI uses (0 for AMRAP's
 *             exercisesPerRound, 30 for Death-By's roundCap).
 *   T-120-17/T-120-18: this module performs no I/O and throws nothing; the surrounding
 *             tool's try/catch and no-console discipline is unaffected by this file.
 *
 * Patterns: TrainCounter/.../domain/format/FormatSummary.kt (port target),
 *           src/training-state/muscle-balance.ts (the Phase 137-07 port precedent this
 *           file's doc-header and export shape follow)
 */

import type { DecryptedSetLog, DecryptedSession, DecryptedSnapshot } from '../types.js';
import { toCalendarDay } from './time-zone.js';

// ---------------------------------------------------------------------------
// Port of FormatSummary.kt
// ---------------------------------------------------------------------------

/** AMRAP score: full rounds completed + reps into the trailing partial round. */
export interface AmrapScore {
  rounds: number;
  reps: number;
}

/** Death-By score: highest full round/minute reached + whether the fixed round cap was hit. */
export interface DeathByScore {
  highestFullRound: number;
  complete: boolean;
}

/**
 * AMRAP score from ordered per-exercise set-log rows.
 *
 * `exercisesPerRound === 0` is guarded (no divide-by-zero) — returns `rounds: 0`. The reps
 * (M) value sums `completedReps` of the trailing partial-round rows only; TIME rows
 * (`completedReps === null`) contribute 0, matching the mixed REPS/TIME station model
 * (D-03). The round-count division is deliberately truncating (`Math.floor`), mirroring
 * Kotlin's `Int` division exactly — the one real portability trap in this file.
 */
export function amrapSummary(rows: DecryptedSetLog[], exercisesPerRound: number): AmrapScore {
  const n = exercisesPerRound > 0 ? Math.floor(rows.length / exercisesPerRound) : 0;
  const partial = rows.slice(n * exercisesPerRound);
  const reps = partial.reduce((sum, r) => sum + (r.completedReps ?? 0), 0);
  return { rounds: n, reps };
}

/**
 * Death-By score from ordered per-minute set-log rows — one row per completed
 * minute/round. `complete` becomes true once `rows.length` reaches `roundCap`.
 */
export function deathBySummary(rows: DecryptedSetLog[], roundCap: number): DeathByScore {
  return { highestFullRound: rows.length, complete: rows.length >= roundCap };
}

/** EMOM intervals completed — one row per completed minute window. */
export function emomIntervals(rows: DecryptedSetLog[]): number {
  return rows.length;
}

/**
 * The three `workoutType` values a format summary is derived for — the same set
 * `SessionDetailViewModel.FORMAT_SUMMARY_TYPES` (Kotlin) uses. CIRCUIT/TABATA/LADDER/
 * FOR_TIME/CHIPPER/CLASSIC never derive a summary line in the app and are excluded here
 * identically.
 */
export const FORMAT_SUMMARY_TYPES = ['AMRAP', 'DEATH_BY', 'EMOM'] as const;

// ---------------------------------------------------------------------------
// The longitudinal series — new, parity-free (see module doc-header)
// ---------------------------------------------------------------------------

/**
 * One session's format-progression point. Only the fields belonging to the session's own
 * `workoutType` are populated; the rest are `null` — a flat shape instead of three
 * separate point types, so the series stays easy for an LLM to read. `rounds` is reused
 * for both AMRAP's full-round count AND Death-By's `highestFullRound` — both represent
 * "how far the session got" for their own format.
 */
export interface FormatProgressPoint {
  sessionId: string;
  date: string;
  workoutType: string;
  rounds: number | null; // AMRAP rounds, or Death-By highestFullRound
  reps: number | null; // AMRAP reps only
  intervals: number | null; // EMOM only
  complete: boolean | null; // Death-By only
}

/** One template's format-progression series, chronologically ascending. */
export interface FormatProgressSeries {
  templateId: string;
  templateName: string | null;
  workoutType: string;
  points: FormatProgressPoint[];
  /**
   * Total count of completed sessions across the WHOLE snapshot excluded because their
   * template carries no recognized (AMRAP/DEATH_BY/EMOM) `workoutType` (Pitfall 5) — never
   * scoped to just this one series, because `computeFormatProgress`'s return shape has no
   * separate top-level object to carry a single snapshot-wide total. Every series produced
   * by one call carries the SAME value, so reading it off any one series gives the whole
   * snapshot's count. This is what makes Pitfall 5's exclusion visible in the result
   * instead of silent.
   */
  skippedSessionCount: number;
}

/**
 * Fault-tolerant read of `AmrapFormatParams.exercises.length` from a template's raw
 * `formatParams` JSON. Falls back to the app's own UI default (0) on `null`/`undefined`,
 * unparsable JSON, or a missing/malformed `exercises` field — never throws.
 */
function parseAmrapExercisesPerRound(formatParams: string | null | undefined): number {
  if (formatParams == null) return 0;
  try {
    const parsed = JSON.parse(formatParams) as { exercises?: unknown };
    return Array.isArray(parsed.exercises) ? parsed.exercises.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Fault-tolerant read of `DeathByFormatParams.roundCap` from a template's raw
 * `formatParams` JSON. Falls back to the app's own UI default (30) on `null`/`undefined`,
 * unparsable JSON, or a missing/non-numeric `roundCap` field — never throws.
 */
function parseDeathByRoundCap(formatParams: string | null | undefined): number {
  if (formatParams == null) return 30;
  try {
    const parsed = JSON.parse(formatParams) as { roundCap?: unknown };
    return typeof parsed.roundCap === 'number' ? parsed.roundCap : 30;
  } catch {
    return 30;
  }
}

/**
 * Builds one format-progression series per format template (AMRAP/DEATH_BY/EMOM) present
 * in the snapshot, each ordered chronologically ascending and capped to `maxPoints`
 * (keeping the MOST RECENT points when there are more).
 *
 * A session contributes a point only if: its template carries a recognized `workoutType`
 * (Pitfall 5 — `null`, `undefined`, `CLASSIC`, or a missing template row are all silently
 * excluded, never an error), it is not soft-deleted, and it has an `endTime` (an ongoing
 * session contributes nothing). Its set-log rows are filtered for `deletedAt` and sorted
 * by `(startedAt ?? createdAt)` before being handed to the port functions above — the SAME
 * ordering contract `SessionDetailViewModel.kt` applies before calling the Kotlin
 * originals.
 *
 * `formatParams` parsing is fully fault-tolerant (see the two parse helpers above): an
 * unparsable, missing, or field-incomplete payload falls back to the same defaults the
 * app's UI uses, never a thrown error.
 */
export function computeFormatProgress(
  args: { templateId?: string; maxPoints: number },
  data: { snapshot: DecryptedSnapshot; timeZoneId: string },
): FormatProgressSeries[] {
  const { snapshot, timeZoneId } = data;
  const templatesById = new Map(snapshot.templates.map((t) => [t.id, t]));

  // Group non-deleted set-log rows by session, pre-sorted by (startedAt ?? createdAt) —
  // the ordering contract every port function above requires.
  const setLogsBySessionId = new Map<string, DecryptedSetLog[]>();
  for (const log of snapshot.setLogs) {
    if (log.deletedAt !== undefined) continue;
    const bucket = setLogsBySessionId.get(log.sessionId);
    if (bucket) bucket.push(log);
    else setLogsBySessionId.set(log.sessionId, [log]);
  }
  for (const rows of setLogsBySessionId.values()) {
    rows.sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
  }

  // Bucket completed sessions by their format template, counting every completed session
  // excluded for lacking a recognized format (Pitfall 5) — never for being deleted/ongoing,
  // which are excluded before the format check even runs.
  let skippedSessionCount = 0;
  const sessionsByTemplateId = new Map<string, DecryptedSession[]>();

  for (const session of snapshot.sessions) {
    if (session.deletedAt !== undefined) continue;
    if (session.endTime === undefined) continue;
    if (session.templateId === undefined) continue;

    const template = templatesById.get(session.templateId);
    const workoutType = template?.workoutType;
    const isKnownFormat =
      template !== undefined &&
      workoutType !== null &&
      workoutType !== undefined &&
      (FORMAT_SUMMARY_TYPES as readonly string[]).includes(workoutType);

    if (!isKnownFormat) {
      skippedSessionCount += 1;
      continue;
    }

    const bucket = sessionsByTemplateId.get(template.id);
    if (bucket) bucket.push(session);
    else sessionsByTemplateId.set(template.id, [session]);
  }

  const series: FormatProgressSeries[] = [];

  for (const [templateId, sessions] of sessionsByTemplateId) {
    if (args.templateId !== undefined && templateId !== args.templateId) continue;

    const template = templatesById.get(templateId);
    if (template === undefined) continue; // unreachable — templateId is sourced from this same map above
    // Safe: only templates whose workoutType passed the FORMAT_SUMMARY_TYPES check above
    // ever reach sessionsByTemplateId.
    const workoutType = template.workoutType as string;

    const sortedSessions = [...sessions].sort((a, b) => a.startTime - b.startTime);

    const points: FormatProgressPoint[] = sortedSessions.map((session) => {
      const rows = setLogsBySessionId.get(session.id) ?? [];
      const point: FormatProgressPoint = {
        sessionId: session.id,
        date: toCalendarDay(session.startTime, timeZoneId),
        workoutType,
        rounds: null,
        reps: null,
        intervals: null,
        complete: null,
      };

      if (workoutType === 'AMRAP') {
        const score = amrapSummary(rows, parseAmrapExercisesPerRound(template.formatParams));
        point.rounds = score.rounds;
        point.reps = score.reps;
      } else if (workoutType === 'DEATH_BY') {
        const score = deathBySummary(rows, parseDeathByRoundCap(template.formatParams));
        point.rounds = score.highestFullRound;
        point.complete = score.complete;
      } else if (workoutType === 'EMOM') {
        point.intervals = emomIntervals(rows);
      }

      return point;
    });

    const trimmedPoints = points.length > args.maxPoints ? points.slice(points.length - args.maxPoints) : points;

    series.push({
      templateId,
      templateName: template.name,
      workoutType,
      points: trimmedPoints,
      skippedSessionCount,
    });
  }

  return series;
}
