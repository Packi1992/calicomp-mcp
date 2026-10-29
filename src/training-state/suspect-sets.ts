/**
 * Suspect sets (Phase 166, plan 166-06; protocol 1.48 §1.11 "Suspect sets", D-05, D-17,
 * STAT-05): the MCP marks sets that are probably entry errors, for every user, READ ONLY. No
 * function of this module changes or deletes anything; the athlete decides in the app whether
 * to correct a set (D-17). Zero sets in never finished sessions that an athlete keeps on
 * purpose carry the mark `zero_set` and nothing else changes for them.
 *
 * The marks read the shared population of Rule P (`resolveSetPopulation`) WITHOUT the
 * finished-session requirement — a set in a session that was never finished is marked too,
 * because such sessions carry artefacts as well. A deleted set, a set of a deleted or missing
 * session and a set whose exercise does not resolve to a live catalog exercise belong to no
 * count and carry no mark. "Records a time" is Rule M (`PopulationSet.recordsTime`).
 *
 * | Reason                  | A set carries the mark when | Exception |
 * |-------------------------|-----------------------------|-----------|
 * | `reps_on_time_station`  | it records a time, the catalog mode of its exercise is `TIME`, and `completedReps > 0` | its workout exercise has `targetReps > 0` |
 * | `zero_set`              | its value is `0`: the value of its kind (`completedTimeSeconds` if it records a time, otherwise `completedReps`), or, when that value is absent, the other value | none |
 * | `measured_time_missing` | it records a time, `completedTimeSeconds` is set and `measuredTimeSeconds` is not, it was created after the first set of the same exercise that has a `measuredTimeSeconds`, and at least 80 % of the timed sets of that exercise created after that first measured set have one | manual sessions and quick challenges, which never measure; both also take no part in the first measured set and in the share |
 *
 * Both rules since protocol 1.51 (gap plan 166-21, findings 166-17-FUND-01 and 166-17-FUND-02):
 * before app plan 165-02 the app chose the input field by the catalog mode, so a repetition
 * exercise at a TIME station took the counted repetitions. Rule M reads such a set as one that
 * records a time (unchanged). Its repetitions are real counts, so only `reps_on_time_station`
 * asks the catalog mode of the resolved exercise: on an exercise whose catalog mode is TIME the
 * app never offered a repetition field outside the exception (166-17-FUND-02). Its zero stands
 * in `completedReps` without a time, so `zero_set` falls back to the other value when the value
 * of the set's kind is absent (166-17-FUND-01).
 *
 * The thresholds of `measured_time_missing` are chosen values (Claude's Discretion to D-05,
 * assumption A5 of Phase 166), not measurements. A set can carry more than one reason; the
 * reasons stand in the order of the table. Every explanation is the protocol's fixed English
 * sentence and names no exercise, template or note (T-166-17).
 *
 * Exports:
 *   SuspectReason, SuspectMark, DataQuality, DataQualityEntry — the output shapes
 *   SUSPECT_REASONS, SUSPECT_EXPLANATIONS — the reasons in table order, their fixed texts
 *   MEASURED_TIME_SHARE_THRESHOLD           — 0.8
 *   suspectMarksFor(snapshot, catalog)      — setLogId → marks, only sets with a finding
 *   computeDataQuality(snapshot, catalog, timeZoneId) — `get_training_state.dataQuality`
 */

import type { CatalogExercise, DecryptedSnapshot } from '../types.js';
import { resolveSetPopulation, type PopulationSet } from './set-population.js';
import { toCalendarDay } from './time-zone.js';

export const SUSPECT_REASONS = ['reps_on_time_station', 'zero_set', 'measured_time_missing'] as const;
export type SuspectReason = (typeof SUSPECT_REASONS)[number];

/** The fixed explanation of each reason (protocol §1.11 "Suspect sets"), verbatim. */
export const SUSPECT_EXPLANATIONS: Readonly<Record<SuspectReason, string>> = {
  reps_on_time_station:
    'This set records a time in its training mode but also carries repetitions; the repetitions are probably an entry error.',
  zero_set: 'This set has a value of zero; it may be an empty or unintended entry.',
  measured_time_missing:
    'This timed set has no measured time, although most later timed sets of the same exercise have one.',
};

/** At least this share of the later timed sets must carry a measured time (A5, chosen). */
export const MEASURED_TIME_SHARE_THRESHOLD = 0.8;

/** At most this many entries in `dataQuality.newest`. */
export const DATA_QUALITY_NEWEST_LIMIT = 20;

export interface SuspectMark {
  reason: SuspectReason;
  explanation: string;
}

export interface DataQualityEntry {
  setLogId: string;
  /** The set's day in the training time zone (§1.4), `YYYY-MM-DD`. */
  date: string;
  reasons: SuspectReason[];
}

export interface DataQuality {
  /** The number of marked sets, each set once. */
  suspectSetCount: number;
  /** Reason → number of sets with that reason (every reason present, `0` without a set). */
  byReason: Record<SuspectReason, number>;
  /** At most 20 of the most recently created marked sets, newest first (tie: `setLogId` ascending). */
  newest: DataQualityEntry[];
}

/** A session kind that never measures: a manual session or a quick challenge. */
function neverMeasures(entry: PopulationSet): boolean {
  return entry.session.isManual || entry.session.isQuickChallenge;
}

function hasMeasuredTime(entry: PopulationSet): boolean {
  return entry.setLog.measuredTimeSeconds !== null && entry.setLog.measuredTimeSeconds !== undefined;
}

/**
 * Per exercise: the creation time of its first set with a measured time, and whether at least
 * 80 % of its timed sets created after that set carry one. Manual sessions and quick
 * challenges take no part.
 */
function measuredTimeBaselines(population: PopulationSet[]): Map<string, { firstMeasuredAt: number; shareReached: boolean }> {
  const byExercise = new Map<string, PopulationSet[]>();
  for (const entry of population) {
    if (neverMeasures(entry)) continue;
    const list = byExercise.get(entry.exerciseId);
    if (list === undefined) byExercise.set(entry.exerciseId, [entry]);
    else list.push(entry);
  }

  const baselines = new Map<string, { firstMeasuredAt: number; shareReached: boolean }>();
  for (const [exerciseId, entries] of byExercise) {
    let firstMeasuredAt: number | null = null;
    for (const entry of entries) {
      if (!hasMeasuredTime(entry)) continue;
      if (firstMeasuredAt === null || entry.setLog.createdAt < firstMeasuredAt) firstMeasuredAt = entry.setLog.createdAt;
    }
    if (firstMeasuredAt === null) continue;
    const later = entries.filter((e) => e.recordsTime && e.setLog.createdAt > firstMeasuredAt!);
    const measured = later.filter(hasMeasuredTime).length;
    const shareReached = later.length > 0 && measured / later.length >= MEASURED_TIME_SHARE_THRESHOLD;
    baselines.set(exerciseId, { firstMeasuredAt, shareReached });
  }
  return baselines;
}

/** The reasons of one set, in table order. */
function reasonsOf(entry: PopulationSet, baselines: ReturnType<typeof measuredTimeBaselines>): SuspectReason[] {
  const { setLog, recordsTime, workoutExercise, exercise } = entry;
  const reasons: SuspectReason[] = [];

  const reps = setLog.completedReps;
  const time = setLog.completedTimeSeconds;

  // reps_on_time_station (protocol 1.51, 166-17-FUND-02): only on an exercise whose catalog mode
  // is TIME; repetitions of a repetition exercise at a TIME station are real counts.
  if (recordsTime && exercise.mode === 'TIME' && reps !== null && reps !== undefined && reps > 0) {
    const targetReps = workoutExercise?.targetReps;
    if (!(targetReps !== undefined && targetReps !== null && targetReps > 0)) reasons.push('reps_on_time_station');
  }

  // zero_set (protocol 1.51, 166-17-FUND-01): the value of the set's kind, otherwise the other one.
  const ownValue = recordsTime ? time : reps;
  const value = ownValue === null || ownValue === undefined ? (recordsTime ? reps : time) : ownValue;
  if (value === 0) reasons.push('zero_set');

  if (recordsTime && time !== null && time !== undefined && !hasMeasuredTime(entry) && !neverMeasures(entry)) {
    const baseline = baselines.get(entry.exerciseId);
    if (baseline !== undefined && baseline.shareReached && setLog.createdAt > baseline.firstMeasuredAt) {
      reasons.push('measured_time_missing');
    }
  }

  return reasons;
}

/**
 * The suspect marks of the snapshot: `setLogId` → its marks, ONLY for sets with at least one
 * mark (never an empty list). Pure; reads the population of Rule P without the
 * finished-session requirement.
 */
export function suspectMarksFor(snapshot: DecryptedSnapshot, catalog: CatalogExercise[]): Map<string, SuspectMark[]> {
  const catalogById = new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
  const population = resolveSetPopulation(snapshot, catalogById, { requireFinishedSession: false });
  const baselines = measuredTimeBaselines(population);

  const marks = new Map<string, SuspectMark[]>();
  for (const entry of population) {
    const reasons = reasonsOf(entry, baselines);
    if (reasons.length === 0) continue;
    marks.set(
      entry.setLog.id,
      reasons.map((reason) => ({ reason, explanation: SUSPECT_EXPLANATIONS[reason] })),
    );
  }
  return marks;
}

/**
 * `get_training_state.dataQuality` (protocol §1.11 "Suspect sets", Outputs): the number of
 * marked sets, the number per reason and at most 20 of the most recently created marked sets.
 * Only a hint for the coach — nothing is changed.
 */
export function computeDataQuality(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  timeZoneId: string,
): DataQuality {
  const marks = suspectMarksFor(snapshot, catalog);
  const byReason = Object.fromEntries(SUSPECT_REASONS.map((r) => [r, 0])) as Record<SuspectReason, number>;
  for (const list of marks.values()) {
    for (const mark of list) byReason[mark.reason] += 1;
  }

  const setLogById = new Map(snapshot.setLogs.map((sl) => [sl.id, sl]));
  const marked = [...marks.keys()].map((id) => setLogById.get(id)!);
  marked.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const newest = marked.slice(0, DATA_QUALITY_NEWEST_LIMIT).map((sl) => ({
    setLogId: sl.id,
    date: toCalendarDay(sl.createdAt, timeZoneId),
    reasons: marks.get(sl.id)!.map((m) => m.reason),
  }));

  return { suspectSetCount: marks.size, byReason, newest };
}
