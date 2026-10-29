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
 * (`137-VALIDATION.md`), unresolved by any automated test in this file. Since Phase 166 that
 * no longer holds for personal records: Rule M of protocol §1.11 defines them for both sides,
 * and the corpus section `personalRecordsByTrainingMode` pins them (MCP replay in
 * tests/shared-vectors.test.ts, app replay in `CoachPlanningVectorsTest.kt`).
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
 *   computePersonalRecords — snapshot + catalog + zone → all-time max reps / hold-time per exercise (Rule M since 166) and repetitions in time per exercise, duration and weight class (since protocol 1.52)
 *   computeConsistency — snapshot + catalog + zone + now → the streak fields plus the frequency fields, in one object
 */

import type { DecryptedSession, DecryptedSnapshot, CatalogExercise } from '../types.js';
import { toCalendarDay, isoWeekKey } from './time-zone.js';
import { classifySession, type SessionKind } from '../session-kind.js';
import { resolveSetPopulation } from './set-population.js';

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

/** The 143-Dreiteilung: how many completed sessions fall into each session kind. */
export type SessionsByKind = Record<SessionKind, number>;

/**
 * Counts completed sessions by `sessionKind` (Phase 150, D-03) over the SAME
 * `completedSessions` set `computeFrequency` uses (`deletedAt == null && endTime !==
 * undefined`), so the three counts always sum to `totalCompletedSessions`. Classification
 * runs WITHOUT a template index — `sessionKind` never depends on `templateStatus`.
 */
export function computeSessionsByKind(sessions: DecryptedSession[]): SessionsByKind {
  const completedSessions = sessions.filter((s) => s.deletedAt == null && s.endTime !== undefined);

  const sessionsByKind: SessionsByKind = { template: 0, templateless: 0, quick_challenge: 0 };

  for (const session of completedSessions) {
    const { sessionKind } = classifySession(session);
    sessionsByKind[sessionKind] += 1;
  }

  return sessionsByKind;
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

/**
 * One record of the third kind, repetitions in time (protocol 1.52 §1.11 Rule M step 5, gap plan 166-22, E-17):
 * the largest `completedReps` of the station sets of one exercise at one duration and one weight class.
 * `durationSeconds` is the station sets' own `completedTimeSeconds`, `weightKg` the weight class
 * (`round(weightUsed × 100)` hundredths of a kilogram) divided by 100, or `null` for the class without weight.
 */
export interface RepsInTimeRecord {
  exerciseId: string;
  exerciseName: string | null;
  durationSeconds: number;
  weightKg: number | null;
  value: number;
  achievedOn: string;
}

/** Result shape for `computePersonalRecords`. */
export interface PersonalRecordsResult {
  maxReps: PersonalRecord[];
  maxHoldSeconds: PersonalRecord[];
  /** Since protocol 1.52 (166-22, E-17): a genuine addition, one exercise may stand several times. */
  repsInTime: RepsInTimeRecord[];
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
 * All-time maximum reps and hold-time per exercise, by Rule M of protocol §1.11 since Phase 166
 * (plan 166-04; D-02, D-04 in the version E-15 — the existing field, corrected in place):
 *
 *   - **Population:** the population of Rule P (`resolveSetPopulation`) WITHOUT the
 *     finished-session requirement, as the app's `MAX_REPS_PER_EXERCISE`/`MAX_TIME_PER_EXERCISE`:
 *     a set of a session that was never finished counts; a deleted set, a deleted or missing
 *     session and a missing or deleted exercise exclude the set. NO time window.
 *   - **Mode:** the mode the set was trained in — the workout exercise's `mode`, also of a
 *     soft-deleted one, otherwise the catalog mode (`trainingModeOf`). A set records a time when
 *     that mode is `TIME`, or `MAX` on a `TIME` catalog exercise (`recordsTime`).
 *   - **Station set (protocol 1.52, gap plan 166-22, E-17):** a set that records a time, whose
 *     catalog mode is not `TIME` and whose `completedReps` is set (also `0`): a repetition exercise
 *     at a `TIME` station with its counted repetitions.
 *   - **Three records:** `maxReps` is the largest `completedReps` among the sets that do NOT
 *     record a time (a station set records one and never counts there), `maxHoldSeconds` the
 *     largest `completedTimeSeconds` among the sets that do and are no station sets (since 1.52,
 *     in place, D-04 in the version E-15), and `repsInTime` the largest `completedReps` of the
 *     station sets per exercise, duration (the set's `completedTimeSeconds` when greater than 0;
 *     a station set without a duration takes part in no record) and weight class
 *     (`round(weightUsed × 100)` when greater than 0, otherwise the class without weight).
 *     `null` takes no part, `0` is a value. A tie keeps the earlier set.
 *
 * Before 166 the hold list asked only the catalog mode and the repetition list asked no mode at
 * all. The entry form (`exerciseId`, `exerciseName`, `value`, `achievedOn`), the ordering and
 * the signature are unchanged. An exercise with no usable value never appears in that list —
 * never with a `null` value standing in for "no record". `repsInTime` is ordered by
 * `exerciseId`, then `durationSeconds`, then `weightKg` (the class without weight first). The
 * corpus section `personalRecordsByTrainingMode` (docs/coach-planning-vectors.json) proves the rule.
 */
export function computePersonalRecords(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  timeZoneId: string,
): PersonalRecordsResult {
  const catalogById = new Map(catalog.map((ex) => [ex.id, ex]));

  const maxRepsByExercise = new Map<string, RecordCandidate>();
  const maxHoldByExercise = new Map<string, RecordCandidate>();
  const repsInTimeByClass = new Map<string, RecordCandidate>();
  const repsInTimeClasses = new Map<string, { exerciseId: string; durationSeconds: number; weightHundredths: number | null }>();

  for (const entry of resolveSetPopulation(snapshot, catalogById, { requireFinishedSession: false })) {
    const { setLog, exerciseId } = entry;
    if (!entry.recordsTime) {
      if (setLog.completedReps !== null) {
        trackBest(maxRepsByExercise, exerciseId, setLog.completedReps, setLog.createdAt);
      }
      continue;
    }
    const isStationSet = entry.exercise.mode !== 'TIME' && setLog.completedReps !== null;
    if (!isStationSet) {
      if (setLog.completedTimeSeconds !== null) {
        trackBest(maxHoldByExercise, exerciseId, setLog.completedTimeSeconds, setLog.createdAt);
      }
      continue;
    }
    const durationSeconds = setLog.completedTimeSeconds;
    if (durationSeconds === null || !(durationSeconds > 0) || setLog.completedReps === null) continue;
    const weightHundredths = weightClassOf(setLog.weightUsed);
    const classKey = JSON.stringify([exerciseId, durationSeconds, weightHundredths]);
    repsInTimeClasses.set(classKey, { exerciseId, durationSeconds, weightHundredths });
    trackBest(repsInTimeByClass, classKey, setLog.completedReps, setLog.createdAt);
  }

  // Order of protocol 1.52: exerciseId, then durationSeconds, then the weight class (without weight first).
  const repsInTime: RepsInTimeRecord[] = [...repsInTimeClasses.entries()]
    .sort(
      ([, a], [, b]) =>
        a.exerciseId.localeCompare(b.exerciseId) ||
        a.durationSeconds - b.durationSeconds ||
        (a.weightHundredths ?? -1) - (b.weightHundredths ?? -1),
    )
    .flatMap(([classKey, cls]) => {
      const candidate = repsInTimeByClass.get(classKey);
      if (candidate === undefined) return [];
      return [
        {
          exerciseId: cls.exerciseId,
          exerciseName: catalogById.get(cls.exerciseId)?.nameEn ?? null,
          durationSeconds: cls.durationSeconds,
          weightKg: cls.weightHundredths === null ? null : cls.weightHundredths / 100,
          value: candidate.value,
          achievedOn: toCalendarDay(candidate.achievedAtMs, timeZoneId),
        },
      ];
    });

  return {
    maxReps: toSortedRecords(maxRepsByExercise, catalogById, timeZoneId),
    maxHoldSeconds: toSortedRecords(maxHoldByExercise, catalogById, timeZoneId),
    repsInTime,
  };
}

/**
 * The weight class of a station set (protocol 1.52 §1.11 Rule M step 5): `round(weightUsed × 100)`, the weight in
 * hundredths of a kilogram, when that is greater than 0; otherwise (`null` or `0`) `null`, the class without weight.
 * `Math.round` agrees with SQLite's `ROUND(x)` for positive numbers, so the app and the MCP form the same classes.
 */
function weightClassOf(weightUsed: number | null): number | null {
  if (weightUsed === null) return null;
  const hundredths = Math.round(weightUsed * 100);
  return hundredths > 0 ? hundredths : null;
}

// ---------------------------------------------------------------------------
// Consistency overview — Phase 137-11 — the one function Plan 137-12 calls
// ---------------------------------------------------------------------------

/** Combined result shape for `computeConsistency` — the streak fields plus the frequency fields, in one object. */
export interface ConsistencyResult extends StreakResult, FrequencyResult {
  /** The 143-Dreiteilung (Phase 150, D-03) — additive; sums to `totalCompletedSessions`. */
  sessionsByKind: SessionsByKind;
}

/**
 * Assembles the streak fields (`computeStreaks`), the frequency fields
 * (`computeFrequency`) and the session-kind breakdown (`computeSessionsByKind`, Phase 150
 * D-03) into a single object — the one call Plan `137-12`'s overview makes. `catalog` is
 * part of this function's published signature (matching the sibling `compute*` functions
 * in this module that DO need it) even though today's constituent calls only need
 * `snapshot.sessions`, `timeZoneId` and `nowMs`; personal records are deliberately NOT
 * part of this result (see the interface contract this function implements) —
 * `get_training_state`/`get_progress`-style tools that also need records call
 * `computePersonalRecords` separately.
 */
export function computeConsistency(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  timeZoneId: string,
  nowMs: number,
): ConsistencyResult {
  const streaks = computeStreaks(snapshot.sessions, timeZoneId, nowMs);
  const frequency = computeFrequency(snapshot.sessions, timeZoneId, nowMs);
  const sessionsByKind = computeSessionsByKind(snapshot.sessions);
  return { ...streaks, ...frequency, sessionsByKind };
}
