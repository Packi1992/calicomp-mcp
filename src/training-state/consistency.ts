/**
 * Training streak / consistency calculation — a line-for-line port of
 * `TrainingStreakCalculator.kt` (Phase 137, D-01/D-04 tracer slice).
 *
 * `areConsecutiveWeeks`, `calculateLongestStreak` and `calculateCurrentStreak` mirror the
 * Kotlin object's semantics exactly, including its empty-list handling and its year-end
 * transition branch (`year2 === year1 + 1 && w1 >= 52 && w2 === 1`). The shared corpus
 * section `streak` (`docs/coach-planning-vectors.json`) is what proves parity — both this
 * TypeScript port and `CoachPlanningVectorsTest.kt`'s replay against the real Kotlin
 * calculator run the same vectors and must agree. `TrainingStreakCalculator.kt` remains
 * the source of truth; this file is the port, never the other way around.
 *
 * `trainingWeekKeys` and `computeStreaks` are the MCP-side glue this phase's tracer needs
 * on top of the ported calculator: mapping a snapshot's sessions to week keys through the
 * athlete's own time zone (`time-zone.ts`), and assembling the `get_training_state` result
 * shape from them.
 *
 * `computeFrequency` and `computePersonalRecords` (Phase 137-11, STATE-02) are a
 * different kind of artifact than the streak port above, and the difference matters:
 * the streak calculation is PARITAETSPFLICHTIG — a line-for-line port of
 * `TrainingStreakCalculator.kt`, proven byte-identical via the shared `streak` corpus
 * section both this file and `CoachPlanningVectorsTest.kt` replay. Frequency and personal
 * records are PARITAETSFREI: `AnalyticsViewModel.loadFrequencyData()` and
 * `AnalyticsDao.getMaxRepsPerExercise`/`getMaxTimePerExercise` have no pure Kotlin
 * calculator to port — the logic lives in a ViewModel (session dates from Room) and in
 * raw SQL. These two functions are new TypeScript arithmetic reproducing that same
 * semantics over the decrypted snapshot; their correctness rests on matching the app's
 * query behavior by construction (window boundaries, filter conditions, exercise
 * resolution), not on a shared corpus replay — verified manually against a real device
 * (`137-VALIDATION.md`), unresolved by any automated test in this file.
 *
 * Naming (RESEARCH.md Pitfall 4 / 137-CONTEXT.md specifics #1): the app's own UiState
 * carries the two four-week windows under names that each promise a span the window does
 * not measure — a rolling four-week window is not a calendar month. The field names below
 * say what they actually measure instead of reusing the app's own misleading ones.
 *
 * Exports:
 *   areConsecutiveWeeks, calculateLongestStreak, calculateCurrentStreak — the port
 *   trainingWeekKeys — sessions → distinct, ascending week keys (excludes soft-deleted)
 *   computeStreaks    — sessions + zone + now → { currentStreakWeeks, longestStreakWeeks, trainingWeekCount }
 *   computeFrequency  — sessions + zone + now → four session counts (ISO week, two 4-week windows, all-time)
 *   computePersonalRecords — snapshot + catalog + zone → all-time max reps / hold-time per exercise
 *   computeConsistency — snapshot + catalog + zone + now → the streak fields plus the frequency fields, in one object
 */

import type { DecryptedSession, DecryptedSnapshot, CatalogExercise } from '../types.js';
import { toCalendarDay, isoWeekKey } from './time-zone.js';

// ---------------------------------------------------------------------------
// Port of TrainingStreakCalculator.kt
// ---------------------------------------------------------------------------

/**
 * Returns true when `week2` immediately follows `week1` in ISO calendar terms.
 * Handles year-end transitions (week 52/53 → week 1 of the next year).
 *
 * Mirrors TrainingStreakCalculator.kt's `areConsecutiveWeeks` exactly.
 */
export function areConsecutiveWeeks(week1: number, week2: number): boolean {
  const year1 = Math.floor(week1 / 100);
  const w1 = week1 % 100;
  const year2 = Math.floor(week2 / 100);
  const w2 = week2 % 100;
  return (year1 === year2 && w2 === w1 + 1) || (year2 === year1 + 1 && w1 >= 52 && w2 === 1);
}

/**
 * Returns the longest consecutive-week streak from a sorted list of week keys.
 *
 * @param sortedWeeks Distinct week keys in ascending order.
 *
 * Mirrors TrainingStreakCalculator.kt's `calculateLongestStreak` exactly.
 */
export function calculateLongestStreak(sortedWeeks: number[]): number {
  if (sortedWeeks.length === 0) return 0;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sortedWeeks.length; i++) {
    if (areConsecutiveWeeks(sortedWeeks[i - 1], sortedWeeks[i])) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

/**
 * Returns the current consecutive-week streak ending at or adjacent to `currentWeekKey`.
 *
 * A streak is "active" if the last training week is `currentWeekKey` or the week
 * immediately before it. Returns 0 if the last training week is older.
 *
 * @param sortedWeeks    Distinct week keys in ascending order.
 * @param currentWeekKey The week key for "this week".
 *
 * Mirrors TrainingStreakCalculator.kt's `calculateCurrentStreak` exactly.
 */
export function calculateCurrentStreak(sortedWeeks: number[], currentWeekKey: number): number {
  if (sortedWeeks.length === 0) return 0;
  const lastWeek = sortedWeeks[sortedWeeks.length - 1];

  if (lastWeek !== currentWeekKey && !areConsecutiveWeeks(lastWeek, currentWeekKey)) return 0;

  let streak = 1;
  for (let i = sortedWeeks.length - 2; i >= 0; i--) {
    if (areConsecutiveWeeks(sortedWeeks[i], sortedWeeks[i + 1])) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ---------------------------------------------------------------------------
// MCP-side glue: sessions → week keys → streaks
// ---------------------------------------------------------------------------

/**
 * Map a snapshot's sessions to their distinct, ascending-sorted week keys in the
 * athlete's own time zone. Sessions with `deletedAt` set are excluded — a soft-deleted
 * session never counts toward the athlete's training consistency.
 */
export function trainingWeekKeys(sessions: DecryptedSession[], timeZoneId: string): number[] {
  const weeks = new Set<number>();
  for (const session of sessions) {
    if (session.deletedAt != null) continue;
    const calendarDay = toCalendarDay(session.startTime, timeZoneId);
    weeks.add(isoWeekKey(calendarDay));
  }
  return [...weeks].sort((a, b) => a - b);
}

/** Result shape for the consistency block of `get_training_state`. */
export interface StreakResult {
  currentStreakWeeks: number;
  longestStreakWeeks: number;
  trainingWeekCount: number;
}

/**
 * Compute the current and longest training streaks (in weeks) for a snapshot, plus the
 * total count of distinct training weeks. `nowMs` is mapped through the SAME zone the
 * sessions themselves are mapped through — a session at 23:30 UTC on Dec 31 falls into
 * the following day's week in `Europe/Berlin`, and "now" must agree with that mapping.
 */
export function computeStreaks(
  sessions: DecryptedSession[],
  timeZoneId: string,
  nowMs: number,
): StreakResult {
  const sortedWeeks = trainingWeekKeys(sessions, timeZoneId);
  const currentWeekKey = isoWeekKey(toCalendarDay(nowMs, timeZoneId));
  return {
    currentStreakWeeks: calculateCurrentStreak(sortedWeeks, currentWeekKey),
    longestStreakWeeks: calculateLongestStreak(sortedWeeks),
    trainingWeekCount: sortedWeeks.length,
  };
}

// ---------------------------------------------------------------------------
// Frequency — Phase 137-11, STATE-02 (paritaetsfrei; see the doc header above)
// ---------------------------------------------------------------------------

/**
 * Shift a `YYYY-MM-DD` calendar day by `days` (may be negative). Pure calendar
 * arithmetic on a UTC-anchored `Date` — the same technique `isoWeekKey` already uses for
 * its own week-boundary math. Never re-enters a time zone; `isoDate` is already the
 * athlete's own calendar day.
 */
function shiftCalendarDay(isoDate: string, days: number): string {
  const [y, mm, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, mm - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Result shape for `computeFrequency` — four session counts, all in the athlete's own zone. */
export interface FrequencyResult {
  sessionsThisIsoWeek: number;
  sessionsLast4Weeks: number;
  sessionsPrior4Weeks: number;
  totalCompletedSessions: number;
}

/**
 * Counts completed sessions across four windows, mirroring `AnalyticsViewModel.kt`'s
 * `loadFrequencyData()` exactly — including its window boundaries — under names that say
 * what each window actually spans instead of reusing the app's own two misleading ones.
 *
 * A "completed" session mirrors `AnalyticsDao.getAllCompletedSessionDates`'s own filter:
 * no `deletedAt`, and `endTime` present (an ongoing session never counts toward any of
 * the four figures).
 *
 * `sessionsLast4Weeks` is inclusive at BOTH ends: the calendar day 28 days before today
 * through today itself. `sessionsPrior4Weeks` is inclusive at its older end and exclusive
 * at its newer end: the day 56 days before today up to (but not including) the day 28
 * days before today — the boundary day belongs to the younger window, exactly as the
 * app's own `!isBefore(fourWeeksAgo)`/`isBefore(fourWeeksAgo)` pairing produces.
 */
export function computeFrequency(
  sessions: DecryptedSession[],
  timeZoneId: string,
  nowMs: number,
): FrequencyResult {
  const completedSessions = sessions.filter((s) => s.deletedAt == null && s.endTime !== undefined);

  const todayIso = toCalendarDay(nowMs, timeZoneId);
  const todayWeekKey = isoWeekKey(todayIso);
  const fourWeeksAgoIso = shiftCalendarDay(todayIso, -28);
  const eightWeeksAgoIso = shiftCalendarDay(todayIso, -56);

  let sessionsThisIsoWeek = 0;
  let sessionsLast4Weeks = 0;
  let sessionsPrior4Weeks = 0;

  for (const session of completedSessions) {
    const dayIso = toCalendarDay(session.startTime, timeZoneId);

    if (isoWeekKey(dayIso) === todayWeekKey) sessionsThisIsoWeek++;
    if (dayIso >= fourWeeksAgoIso && dayIso <= todayIso) sessionsLast4Weeks++;
    if (dayIso >= eightWeeksAgoIso && dayIso < fourWeeksAgoIso) sessionsPrior4Weeks++;
  }

  return {
    sessionsThisIsoWeek,
    sessionsLast4Weeks,
    sessionsPrior4Weeks,
    totalCompletedSessions: completedSessions.length,
  };
}

// ---------------------------------------------------------------------------
// Personal records — Phase 137-11, STATE-02 (paritaetsfrei; see the doc header above)
// ---------------------------------------------------------------------------

/** One athlete personal record — an all-time maximum for one exercise. */
export interface PersonalRecord {
  exerciseId: string;
  exerciseName: string | null;
  value: number;
  achievedOn: string;
}

/** Result shape for `computePersonalRecords`. */
export interface PersonalRecordsResult {
  maxReps: PersonalRecord[];
  maxHoldSeconds: PersonalRecord[];
}

interface RecordCandidate {
  value: number;
  achievedAtMs: number;
}

/**
 * Keeps the highest value seen per exercise; a tie resolves to the EARLIEST
 * `achievedAtMs`, deterministically — the app's own `MAX(...)` SQL query does not
 * guarantee which row's `createdAt` survives a tie, so two runs against the app could
 * disagree on the date for the same value. This port always picks the same one.
 */
function trackBest(map: Map<string, RecordCandidate>, exerciseId: string, value: number, achievedAtMs: number): void {
  const existing = map.get(exerciseId);
  if (
    existing === undefined ||
    value > existing.value ||
    (value === existing.value && achievedAtMs < existing.achievedAtMs)
  ) {
    map.set(exerciseId, { value, achievedAtMs });
  }
}

function toSortedRecords(
  candidates: Map<string, RecordCandidate>,
  catalogById: Map<string, CatalogExercise>,
  timeZoneId: string,
): PersonalRecord[] {
  return [...candidates.entries()]
    .map(([exerciseId, candidate]) => ({
      exerciseId,
      exerciseName: catalogById.get(exerciseId)?.nameEn ?? null,
      value: candidate.value,
      achievedOn: toCalendarDay(candidate.achievedAtMs, timeZoneId),
    }))
    .sort((a, b) => b.value - a.value || a.exerciseId.localeCompare(b.exerciseId));
}

/**
 * All-time maximum reps and hold-time per exercise, mirroring
 * `AnalyticsDao.getMaxRepsPerExercise` / `getMaxTimePerExercise` exactly: NO time window
 * (unlike `computeFrequency` above) — a set counts as long as its own `deletedAt` is
 * unset AND its session exists and is itself not soft-deleted. An ongoing session's sets
 * still count here; there is no `endTime` condition in either app query this mirrors.
 *
 * `maxHoldSeconds` additionally requires the resolved exercise to be present in the
 * CATALOG with `mode === 'TIME'`, mirroring the app's `e.defaultMode = 'TIME'`
 * restriction — a MAX or REPS station logged with a stray time value never counts as a
 * hold-time record. `maxReps` carries no such restriction, matching the app's own
 * unrestricted `getMaxRepsPerExercise`.
 *
 * Exercise resolution mirrors `COALESCE(sl.exerciseId, we.exerciseId)`
 * (`muscle-balance.ts`). An exercise with no usable value for a given metric never
 * appears in that metric's list — never with a `null` value standing in for "no record".
 */
export function computePersonalRecords(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  timeZoneId: string,
): PersonalRecordsResult {
  const catalogById = new Map(catalog.map((ex) => [ex.id, ex]));
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));
  const sessionById = new Map(snapshot.sessions.map((s) => [s.id, s]));

  const maxRepsByExercise = new Map<string, RecordCandidate>();
  const maxHoldByExercise = new Map<string, RecordCandidate>();

  for (const setLog of snapshot.setLogs) {
    if (setLog.deletedAt != null) continue;

    const session = sessionById.get(setLog.sessionId);
    if (session === undefined) continue;
    if (session.deletedAt != null) continue;

    const exerciseId =
      setLog.exerciseId ??
      (setLog.workoutExerciseId !== undefined
        ? templateExerciseById.get(setLog.workoutExerciseId)?.exerciseId
        : undefined);
    if (exerciseId === undefined) continue;

    if (setLog.completedReps !== null) {
      trackBest(maxRepsByExercise, exerciseId, setLog.completedReps, setLog.createdAt);
    }

    const exercise = catalogById.get(exerciseId);
    if (exercise?.mode === 'TIME' && setLog.completedTimeSeconds !== null) {
      trackBest(maxHoldByExercise, exerciseId, setLog.completedTimeSeconds, setLog.createdAt);
    }
  }

  return {
    maxReps: toSortedRecords(maxRepsByExercise, catalogById, timeZoneId),
    maxHoldSeconds: toSortedRecords(maxHoldByExercise, catalogById, timeZoneId),
  };
}

// ---------------------------------------------------------------------------
// Consistency overview — Phase 137-11 — the one function Plan 137-12 calls
// ---------------------------------------------------------------------------

/** Combined result shape for `computeConsistency` — the streak fields plus the frequency fields, in one object. */
export interface ConsistencyResult extends StreakResult, FrequencyResult {}

/**
 * Assembles the streak fields (`computeStreaks`) and the frequency fields
 * (`computeFrequency`) into a single object — the one call Plan `137-12`'s overview
 * makes. `catalog` is part of this function's published signature (matching the sibling
 * `compute*` functions in this module that DO need it) even though today's two
 * constituent calls only need `snapshot.sessions`, `timeZoneId` and `nowMs`; personal
 * records are deliberately NOT part of this result (see the interface contract this
 * function implements) — `get_training_state`/`get_progress`-style tools that also need
 * records call `computePersonalRecords` separately.
 */
export function computeConsistency(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  timeZoneId: string,
  nowMs: number,
): ConsistencyResult {
  const streaks = computeStreaks(snapshot.sessions, timeZoneId, nowMs);
  const frequency = computeFrequency(snapshot.sessions, timeZoneId, nowMs);
  return { ...streaks, ...frequency };
}
