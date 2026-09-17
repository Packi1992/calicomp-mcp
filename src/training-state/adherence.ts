/**
 * Plan adherence — geplant gegen tatsaechlich absolviert, ueber ein Fenster
 * (Phase 137, STATE-03, D-05/D-06/D-07/D-19/D-21).
 *
 * Three load-bearing decisions govern this module, all three because the naive
 * version of "adherence" lies:
 *
 *   1. FULL ORIGINAL DENOMINATOR (D-05). The denominator is the raw RRULE expansion
 *      from `getPlannedWorkouts` — imported, never rebuilt — which already excludes
 *      only genuinely cancelled dates (`deletedOccurrences`) and does NOT hide an
 *      occurrence just because it has a completed session. A user who deletes past
 *      occurrences they never trained is the exact usage pattern that would push a
 *      "hide what's gone" quota toward a permanent, meaningless 100%.
 *   2. NEUTRAL REMOVED-OCCURRENCE COUNT, NO CLAIM OF INTENT (D-05). Every occurrence
 *      the athlete removed inside the window is counted separately, under a field
 *      name that makes no claim about *why* it was removed — the stored data carries
 *      no timestamp that could distinguish a cancellation made ahead of the date from
 *      a missed occurrence tidied up afterward.
 *   3. THE ACCEPTED GAP FOR FULLY DELETED ROOTS (D-07). A recurring root (or a
 *      single-occurrence root) with EVERY occurrence inside the window removed never
 *      appears in `getPlannedWorkouts`'s `roots` array at all — there is no live
 *      occurrence left to anchor it to. This calculation cannot see it and does not
 *      pretend to; `ADHERENCE_EXPLANATION` says so explicitly rather than silently
 *      under-counting.
 *
 * The second axis (D-19/D-21) lets a session with no exact `templateId` match still
 * fulfil a planned occurrence via muscle-content similarity — the athlete trains
 * freely as well as from templates. Two separate assignment passes, never one merged
 * pass: an exact `templateId` match is the strong signal and is never additionally
 * scored for similarity (see the pass-2 loop below, which only ever sees the
 * candidates pass 1 left unassigned).
 *
 * D-17 (Phase 138.1, plan `138.1-22`): the similarity vector `planVectorFor`/
 * `sessionVectorFor` build is `buildCombinedVector` (muscle groups PLUS capability
 * axes), not the plain `buildMuscleVector` this file used through Phase 137/138. A
 * derivation against real production data (`.planning/phases/138.1-faehigkeiten-neben-
 * muskeln/138.1-VECTOR-DERIVATION.md`) showed the capability dimensions move the
 * positive and negative similarity distributions consistently further apart — higher
 * true-positive rate AND lower false-positive rate at the same asymmetric target this
 * file's threshold-derivation tool optimizes. `matchThreshold`/`uncertainThreshold`
 * (`coach-parameters.ts`) were re-derived against the SAME combined vector in the same
 * plan — never left calibrated against a vector this file no longer uses.
 *
 * Exports:
 *   AdherenceMatch      — one assigned (occurrence, session) pair
 *   AdherenceResult     — the full computation result
 *   ADHERENCE_EXPLANATION — the D-05/D-07 honesty statement, verbatim in every result
 *   computeAdherence    — the pure calculator
 *
 * Security (threat model):
 *   T-137-08: a similarity-derived match must never read as a certain one — `matches[]`
 *     carries both `confidence` and `similarity` per entry, and `uncertainCount` is a
 *     separate field the ratio does NOT include.
 *   T-137-26: the removed-occurrence count must never be silently dropped from the
 *     denominator, and must never be reported under a name that claims deliberate
 *     intent — see decisions 1 and 2 above.
 *
 * Patterns: src/tools/get_planned_workouts.ts (the denominator), src/training-state/
 *           muscle-similarity.ts (the similarity axis), src/training-state/time-zone.ts
 *           (calendar-day mapping)
 */

import { getPlannedWorkouts, type PlannedOccurrenceOut } from '../tools/get_planned_workouts.js';
import { epochDay, parseIsoDate, formatIsoDate, plusDays } from '../recurrence.js';
import { toCalendarDay } from './time-zone.js';
import {
  buildCombinedVector,
  ruzickaSimilarity,
  classifySimilarity,
  type MuscleHit,
  type SimilarityVerdict,
} from './muscle-similarity.js';
import type { DecryptedSnapshot, DecryptedSession, CatalogExercise } from '../types.js';

// ---------------------------------------------------------------------------
// Explanation (D-05, D-07) — verbatim in every result, never derived per call.
// ---------------------------------------------------------------------------

export const ADHERENCE_EXPLANATION =
  'removedOccurrenceCount counts how many planned occurrences the athlete removed from the ' +
  'calendar inside this window. The stored data carries no timestamp for a removal, so it ' +
  'cannot say whether a given occurrence was cancelled ahead of its date on purpose or cleaned ' +
  'up afterward because it was missed — ask the athlete rather than assuming either reading. A ' +
  'planned occurrence that was removed entirely (its whole recurring series, or its only single ' +
  'date) leaves no trace inside this window at all, and this calculation treats it exactly as if ' +
  'nothing had ever been planned on that day.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One assigned (planned occurrence, absolved session) pair. */
export interface AdherenceMatch {
  date: string;
  rootId: string;
  templateId: string;
  sessionId: string;
  sessionDate: string;
  dateDistanceDays: number;
  via: 'templateId' | 'muscleSimilarity';
  similarity: number | null;
  confidence: SimilarityVerdict;
}

export interface AdherenceResult {
  window: { from: string; to: string };
  toleranceDays: number;
  plannedCount: number;
  matchedCount: number;
  missedCount: number;
  uncertainCount: number;
  removedOccurrenceCount: number;
  adherenceRatio: number | null;
  matches: AdherenceMatch[];
  missed: PlannedOccurrenceOut[];
  unplannedSessionIds: string[];
  explanation: string;
}

// ---------------------------------------------------------------------------
// Internal candidate shapes
// ---------------------------------------------------------------------------

interface CandidateSession {
  session: DecryptedSession;
  calDay: string;
}

interface ExactCandidate {
  occKey: string;
  occ: PlannedOccurrenceOut;
  session: DecryptedSession;
  calDay: string;
  dateDistanceDays: number;
}

interface SimilarityCandidate extends ExactCandidate {
  similarity: number;
  verdict: SimilarityVerdict;
}

function occKeyOf(occ: PlannedOccurrenceOut): string {
  return `${occ.date}::${occ.rootId}`;
}

/** Absolute calendar-day distance between two YYYY-MM-DD strings — a magnitude, never a direction (D-06). */
function daysBetween(a: string, b: string): number {
  return Math.abs(epochDay(parseIsoDate(a)) - epochDay(parseIsoDate(b)));
}

function compareTieBreak(
  aDate: string,
  aRootId: string,
  aSessionId: string,
  bDate: string,
  bRootId: string,
  bSessionId: string,
): number {
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  if (aRootId !== bRootId) return aRootId < bRootId ? -1 : 1;
  if (aSessionId !== bSessionId) return aSessionId < bSessionId ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// computeAdherence
// ---------------------------------------------------------------------------

/**
 * Compute plan adherence over `[args.from, args.to]`.
 *
 * Algorithm:
 *   1. Denominator: `getPlannedWorkouts({ from, to }, snapshot)` — imported, never
 *      rebuilt (D-05). `scheduledDate` (and therefore every emitted `date`) is
 *      zone-free and read in UTC (Protocol §1.4 Rule 2) — no `timeZoneId` involved
 *      in this step.
 *   2. `removedOccurrenceCount`: every date in every emitted root's
 *      `deletedOccurrences` that falls inside `[from, to]` (D-07's accepted gap
 *      means a FULLY deleted root never reaches this step at all — it produced no
 *      live occurrence and is therefore absent from `roots`).
 *   3. Candidate sessions: not soft-deleted, has an `endTime`, mapped onto a calendar
 *      day via `toCalendarDay(startTime, timeZoneId)` — a session `startTime` IS a
 *      real instant (Protocol §1.4 Rule 3), so this step (unlike step 1) needs the
 *      athlete's synchronized zone, never the MCP host's own. The search window
 *      extends `toleranceDays` beyond both ends of `[from, to]` so an edge occurrence
 *      can still find its session.
 *   4. Pass 1 (exact): candidate pairs with equal `templateId` and
 *      `dateDistanceDays <= toleranceDays`, sorted ascending by distance then by
 *      `(date, rootId, sessionId)`, assigned greedily one-to-one.
 *   5. Pass 2 (similarity, D-19/D-21): over the occurrences and sessions pass 1 left
 *      unassigned only — an exact match is never additionally scored for similarity.
 *      Candidate pairs within tolerance are scored via `ruzickaSimilarity` over
 *      per-muscle-key vectors (plan vector from the occurrence's `templateExercises`,
 *      session vector from the session's set-logs, same exercise-resolution rule as
 *      `muscle-balance.ts`), classified via `classifySimilarity`, and a `'none'`
 *      verdict excludes the pair. Sorted ascending by distance, then descending by
 *      similarity, then `(date, rootId, sessionId)`; assigned greedily.
 *   6. Assemble the result: `matches`, `missed` (occurrences neither pass assigned),
 *      `unplannedSessionIds` (sessions neither pass assigned, restricted to the
 *      ACTUAL `[from, to]` window — a session found only via the tolerance extension
 *      beyond the window's edge is not "unplanned within this window").
 */
export function computeAdherence(
  args: { from: string; to: string; toleranceDays: number; matchThreshold: number; uncertainThreshold: number },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[]; timeZoneId: string },
): AdherenceResult {
  const { snapshot, catalog, timeZoneId } = data;
  const { from, to, toleranceDays, matchThreshold, uncertainThreshold } = args;

  // Step 1 (D-05): the full original denominator — imported, never rebuilt.
  const denom = getPlannedWorkouts({ from, to }, snapshot);
  const plannedCount = denom.occurrences.length;

  // Step 2 (D-05/D-07): the neutral removed-occurrence count, window-scoped.
  let removedOccurrenceCount = 0;
  for (const root of denom.roots) {
    for (const deletedDate of root.deletedOccurrences) {
      if (deletedDate >= from && deletedDate <= to) removedOccurrenceCount++;
    }
  }

  // Step 3: candidate sessions, mapped onto the athlete's calendar day (Rule 3),
  // over a search window extended by toleranceDays beyond both edges of [from, to].
  const searchStart = formatIsoDate(plusDays(parseIsoDate(from), -toleranceDays));
  const searchEnd = formatIsoDate(plusDays(parseIsoDate(to), toleranceDays));
  const candidateSessions: CandidateSession[] = [];
  for (const session of snapshot.sessions) {
    if (session.deletedAt !== undefined) continue;
    if (session.endTime === undefined) continue;
    const calDay = toCalendarDay(session.startTime, timeZoneId);
    if (calDay < searchStart || calDay > searchEnd) continue;
    candidateSessions.push({ session, calDay });
  }

  const usedOccKeys = new Set<string>();
  const usedSessionIds = new Set<string>();
  const matches: AdherenceMatch[] = [];

  // Pass 1 (exact templateId match) — the strong signal, never additionally scored.
  const exactCandidates: ExactCandidate[] = [];
  for (const occ of denom.occurrences) {
    for (const cs of candidateSessions) {
      if (cs.session.templateId !== occ.templateId) continue;
      const dateDistanceDays = daysBetween(occ.date, cs.calDay);
      if (dateDistanceDays > toleranceDays) continue;
      exactCandidates.push({ occKey: occKeyOf(occ), occ, session: cs.session, calDay: cs.calDay, dateDistanceDays });
    }
  }
  exactCandidates.sort((a, b) => {
    if (a.dateDistanceDays !== b.dateDistanceDays) return a.dateDistanceDays - b.dateDistanceDays;
    return compareTieBreak(
      a.occ.date, a.occ.rootId, a.session.id,
      b.occ.date, b.occ.rootId, b.session.id,
    );
  });
  for (const c of exactCandidates) {
    if (usedOccKeys.has(c.occKey) || usedSessionIds.has(c.session.id)) continue;
    usedOccKeys.add(c.occKey);
    usedSessionIds.add(c.session.id);
    matches.push({
      date: c.occ.date,
      rootId: c.occ.rootId,
      templateId: c.occ.templateId,
      sessionId: c.session.id,
      sessionDate: c.calDay,
      dateDistanceDays: c.dateDistanceDays,
      via: 'templateId',
      similarity: null,
      confidence: 'matched',
    });
  }

  // Pass 2 (muscle similarity, D-19/D-21) — only over what pass 1 left unassigned.
  const catalogById = new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));
  // WR-01/MUSC-07 (138-15): a template-exercise's TRUE prescribed volume is
  // sets * (containing block).rounds, never sets alone — a rounds:3 circuit block's
  // sets:1 row means the exercise is actually performed 3 times per template. Resolve
  // every template-exercise's block up front so planVectorFor below can stay a pure
  // sum over pre-multiplied counts. blockId absent, or pointing at an unknown block,
  // falls back to rounds 1 (no multiplier) — the correct behavior for a
  // template-exercise not part of any block.
  const blockById = new Map(snapshot.blocks.map((b) => [b.id, b]));
  function roundsFor(te: { blockId?: string }): number {
    if (te.blockId === undefined) return 1;
    return blockById.get(te.blockId)?.rounds ?? 1;
  }
  const templateExercisesByTemplateId = new Map<string, { exerciseId: string; sets: number }[]>();
  for (const te of snapshot.templateExercises) {
    const list = templateExercisesByTemplateId.get(te.templateId) ?? [];
    list.push({ exerciseId: te.exerciseId, sets: te.sets * roundsFor(te) });
    templateExercisesByTemplateId.set(te.templateId, list);
  }
  const setLogsBySessionId = new Map<string, typeof snapshot.setLogs>();
  for (const setLog of snapshot.setLogs) {
    if (setLog.deletedAt !== undefined) continue;
    const list = setLogsBySessionId.get(setLog.sessionId) ?? [];
    list.push(setLog);
    setLogsBySessionId.set(setLog.sessionId, list);
  }

  const planVectorCache = new Map<string, Map<string, number>>();
  function planVectorFor(templateId: string): Map<string, number> {
    const cached = planVectorCache.get(templateId);
    if (cached) return cached;
    const hits: MuscleHit[] = (templateExercisesByTemplateId.get(templateId) ?? []).map((te) => ({
      exerciseId: te.exerciseId,
      // WR-01/MUSC-07 (138-15): te.sets is already pre-multiplied by the containing
      // block's rounds — see the blockById-based construction of
      // templateExercisesByTemplateId above (a rounds:3 block's sets:1 row means the
      // exercise is actually performed 3 times per template, not once).
      setCount: te.sets,
    }));
    const vector = buildCombinedVector(hits, catalogById);
    planVectorCache.set(templateId, vector);
    return vector;
  }

  const sessionVectorCache = new Map<string, Map<string, number>>();
  function sessionVectorFor(session: DecryptedSession): Map<string, number> {
    const cached = sessionVectorCache.get(session.id);
    if (cached) return cached;
    const hits: MuscleHit[] = [];
    for (const setLog of setLogsBySessionId.get(session.id) ?? []) {
      const exerciseId =
        setLog.exerciseId ??
        (setLog.workoutExerciseId !== undefined
          ? templateExerciseById.get(setLog.workoutExerciseId)?.exerciseId
          : undefined);
      if (exerciseId === undefined) continue;
      hits.push({ exerciseId, setCount: 1 });
    }
    const vector = buildCombinedVector(hits, catalogById);
    sessionVectorCache.set(session.id, vector);
    return vector;
  }

  const remainingOccs = denom.occurrences.filter((occ) => !usedOccKeys.has(occKeyOf(occ)));
  const remainingSessions = candidateSessions.filter((cs) => !usedSessionIds.has(cs.session.id));

  const similarityCandidates: SimilarityCandidate[] = [];
  for (const occ of remainingOccs) {
    const planVector = planVectorFor(occ.templateId);
    for (const cs of remainingSessions) {
      const dateDistanceDays = daysBetween(occ.date, cs.calDay);
      if (dateDistanceDays > toleranceDays) continue;
      const sessionVector = sessionVectorFor(cs.session);
      const similarity = ruzickaSimilarity(sessionVector, planVector);
      const verdict = classifySimilarity(similarity, matchThreshold, uncertainThreshold);
      if (verdict === 'none') continue;
      similarityCandidates.push({
        occKey: occKeyOf(occ),
        occ,
        session: cs.session,
        calDay: cs.calDay,
        dateDistanceDays,
        similarity,
        verdict,
      });
    }
  }
  similarityCandidates.sort((a, b) => {
    if (a.dateDistanceDays !== b.dateDistanceDays) return a.dateDistanceDays - b.dateDistanceDays;
    if (a.similarity !== b.similarity) return b.similarity - a.similarity; // higher similarity first
    return compareTieBreak(
      a.occ.date, a.occ.rootId, a.session.id,
      b.occ.date, b.occ.rootId, b.session.id,
    );
  });
  for (const c of similarityCandidates) {
    if (usedOccKeys.has(c.occKey) || usedSessionIds.has(c.session.id)) continue;
    usedOccKeys.add(c.occKey);
    usedSessionIds.add(c.session.id);
    matches.push({
      date: c.occ.date,
      rootId: c.occ.rootId,
      templateId: c.occ.templateId,
      sessionId: c.session.id,
      sessionDate: c.calDay,
      dateDistanceDays: c.dateDistanceDays,
      via: 'muscleSimilarity',
      similarity: c.similarity,
      confidence: c.verdict,
    });
  }

  matches.sort((a, b) => compareTieBreak(a.date, a.rootId, a.sessionId, b.date, b.rootId, b.sessionId));

  // Step 6: assemble.
  const missed = denom.occurrences.filter((occ) => !usedOccKeys.has(occKeyOf(occ)));
  const unplannedSessionIds = candidateSessions
    .filter((cs) => cs.calDay >= from && cs.calDay <= to && !usedSessionIds.has(cs.session.id))
    .map((cs) => cs.session.id);

  const matchedCount = matches.filter((m) => m.confidence === 'matched').length;
  const uncertainCount = matches.filter((m) => m.confidence === 'uncertain').length;
  const missedCount = missed.length;
  const adherenceRatio = plannedCount === 0 ? null : matchedCount / plannedCount;

  return {
    window: { from, to },
    toleranceDays,
    plannedCount,
    matchedCount,
    missedCount,
    uncertainCount,
    removedOccurrenceCount,
    adherenceRatio,
    matches,
    missed,
    unplannedSessionIds,
    explanation: ADHERENCE_EXPLANATION,
  };
}
