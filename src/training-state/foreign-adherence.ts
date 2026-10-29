/**
 * Foreign sport adherence — the day rule for planned foreign sport appointments (Phase 155,
 * FA-06, D-09 … D-13).
 *
 * Source: docs/COACH-PLANNING-PROTOCOL.md §1.6 "Foreign sport: fulfilment, adherence and
 * load" — the single source of the rule. The app calendar (Kotlin, `domain/foreign`) and this
 * module replay the SAME corpus section `foreignFulfilment` (docs/coach-planning-vectors.json,
 * `tests/shared-vectors.test.ts`); neither may deviate from it (D-13).
 *
 * The rule, in short:
 *   - D-09: an expanded occurrence `(rootId, typeId, date)` is fulfilled when a not deleted
 *     activity with the SAME `typeId` (id, never name) and `performedOn === date` is assigned
 *     to it. Tolerance 0 days; `toleranceDays` of the template adherence never applies here.
 *     Dates compare as plain strings, zone-free (§1.4 Rule 4) — only "today" needs a zone.
 *   - D-10: one-to-one, greedy, in a fixed order: occurrences by `(date, scheduledTime with
 *     null last, rootId)`, activities by `(performedOn, performedTime with null last,
 *     createdAt, id)`. Strings compare code unit by code unit (`<`), never `localeCompare`.
 *   - D-11: an occurrence without an activity is `upcoming` while `date >= asOfDate` (an
 *     appointment today stays upcoming until the day ends), `missed` from the next day on.
 *   - D-12: `fulfilmentRatio = fulfilled / (fulfilled + missed)`, `null` when that is 0.
 *   - Cancelled dates (`deletedOccurrences` of a foreign root) produce no occurrence; they
 *     are counted as removed, never as planned, missed or fulfilled.
 *
 * Its own pass (§1.6 "What fulfilment never does"): `get_adherence` runs this BEFORE the
 * template passes of `computeAdherence`; it shares no input with them and writes nothing back.
 * Fulfilment is computed at read time and stored nowhere.
 *
 * Exports:
 *   FOREIGN_ADHERENCE_EXPLANATION — verbatim from §1.6 "Verbatim explanations"
 *   assignForeignFulfilment       — the pure day rule over expanded occurrences (corpus replay)
 *   foreignFulfilmentRatio        — fulfilled / (fulfilled + missed), or null (D-12)
 *   expandForeignRoots            — expand foreign roots into occurrences + removed dates; the
 *                                   removed dates over every live foreign root, unlike the template
 *                                   side (IN-01, D-08, protocol § 1.6 "Removed occurrences: why the
 *                                   two sides count differently")
 *   computeForeignAdherence       — the `get_adherence.foreignSport` block
 *
 * Pure, no I/O, never logs (T-120-18): notes and own type names are athlete free text.
 */

import {
  expandDates,
  epochMsToUtcCalDate,
  formatIsoDate,
  parseDeletedOccurrences,
  parseIsoDate,
  RecurrenceRuleError,
} from '../recurrence.js';
import { resolveForeignType, type ForeignTypeFields } from '../foreign-types.js';
import type { ForeignSportAvailability, ForeignUnavailableReason } from '../read-guard.js';
import type { DecryptedPlannedForeignActivity, DecryptedSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Explanation (D-09 … D-12) — verbatim from protocol §1.6, never derived per call.
// ---------------------------------------------------------------------------

export const FOREIGN_ADHERENCE_EXPLANATION =
  'A planned foreign sport appointment counts as fulfilled when an activity of the same type, compared by type id and never by name, is recorded on the same calendar day. One activity fulfils at most one appointment. An appointment today without an activity is upcoming until the day ends and counts as missed from the next day on. fulfilmentRatio is fulfilled divided by fulfilled plus missed; upcoming and cancelled appointments are not in the denominator. These numbers are separate from the template adherence fields (plannedCount, matchedCount and the others), which count template trainings only; toleranceDays does not apply to foreign sport.';

/** The rule name written into every available result (§1.6 "Tool outputs"). */
export const FOREIGN_FULFILMENT_RULE = 'same_calendar_day_same_type_one_to_one' as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One expanded foreign occurrence as the day rule needs it. */
export interface ForeignOccurrenceInput {
  rootId: string;
  typeId: string;
  date: string;
  scheduledTime: string | null;
}

/** One foreign activity as the day rule needs it. `deletedAt` set → it does not exist for the rule. */
export interface ForeignActivityInput {
  id: string;
  typeId: string;
  performedOn: string;
  performedTime: string | null;
  createdAt: number;
  deletedAt: number | null;
}

/** An occurrence the rule could not (yet) pair with an activity. */
export interface ForeignOpenOccurrence {
  rootId: string;
  typeId: string;
  date: string;
}

/** An occurrence paired with the activity that fulfils it. */
export interface ForeignFulfilledOccurrence extends ForeignOpenOccurrence {
  activityId: string;
}

/** The result of the day rule — every list in its deterministic order. */
export interface ForeignAssignment {
  /** In occurrence order. */
  fulfilled: ForeignFulfilledOccurrence[];
  /** In occurrence order. */
  missed: ForeignOpenOccurrence[];
  /** In occurrence order. */
  upcoming: ForeignOpenOccurrence[];
  /** Live activities no occurrence took, in activity order. */
  unplannedActivityIds: string[];
}

/** One expanded occurrence of a foreign root, as `expandForeignRoots` emits it. */
export interface ForeignExpandedOccurrence extends ForeignOccurrenceInput {
  /** The root's note, raw (athlete free text — wrap it before it leaves the MCP). */
  note: string | null;
  isRecurring: boolean;
}

/** One cancelled date of a foreign root inside the window. */
export interface ForeignRemovedDate {
  rootId: string;
  date: string;
}

/** One `byType[]` entry: the resolved type fields plus the four appointment counters. */
export interface ForeignAdherenceByType extends ForeignTypeFields {
  typeId: string;
  plannedCount: number;
  fulfilledCount: number;
  missedCount: number;
  upcomingCount: number;
}

/** The `get_adherence.foreignSport` block when foreign sport cannot be read (E-8, E-9). */
export interface ForeignAdherenceUnavailable {
  available: false;
  reason: ForeignUnavailableReason;
  explanation: string;
}

/** The `get_adherence.foreignSport` block when foreign sport is readable (§1.6 "Tool outputs"). */
export interface ForeignAdherenceAvailable {
  available: true;
  window: { from: string; to: string };
  asOfDate: string;
  plannedCount: number;
  fulfilledCount: number;
  missedCount: number;
  upcomingCount: number;
  removedOccurrenceCount: number;
  fulfilmentRatio: number | null;
  byType: ForeignAdherenceByType[];
  fulfilled: ForeignFulfilledOccurrence[];
  missed: ForeignOpenOccurrence[];
  upcoming: ForeignOpenOccurrence[];
  unplannedActivityIds: string[];
  rule: typeof FOREIGN_FULFILMENT_RULE;
  explanation: string;
}

export type ForeignAdherenceResult = ForeignAdherenceAvailable | ForeignAdherenceUnavailable;

// ---------------------------------------------------------------------------
// Ordering helpers — plain string comparison, code unit by code unit (§1.6)
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** `null` sorts after every string. */
function compareNullLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

function compareOccurrences(a: ForeignOccurrenceInput, b: ForeignOccurrenceInput): number {
  return (
    compareStrings(a.date, b.date) ||
    compareNullLast(a.scheduledTime, b.scheduledTime) ||
    compareStrings(a.rootId, b.rootId)
  );
}

function compareActivities(a: ForeignActivityInput, b: ForeignActivityInput): number {
  return (
    compareStrings(a.performedOn, b.performedOn) ||
    compareNullLast(a.performedTime, b.performedTime) ||
    (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1) ||
    compareStrings(a.id, b.id)
  );
}

// ---------------------------------------------------------------------------
// assignForeignFulfilment — the pure day rule (D-09 … D-11)
// ---------------------------------------------------------------------------

/**
 * Assign activities to already expanded occurrences under the day rule of §1.6.
 *
 * @param occurrences Expanded, not cancelled occurrences (any order — sorted here).
 * @param activities  Foreign activities (any order — sorted here); deleted ones are dropped.
 * @param asOfDate    The athlete's own "today" (`YYYY-MM-DD`).
 */
export function assignForeignFulfilment(
  occurrences: readonly ForeignOccurrenceInput[],
  activities: readonly ForeignActivityInput[],
  asOfDate: string,
): ForeignAssignment {
  const sortedOccurrences = [...occurrences].sort(compareOccurrences);
  const liveActivities = activities.filter((a) => a.deletedAt === null).sort(compareActivities);
  const used = new Array<boolean>(liveActivities.length).fill(false);

  const fulfilled: ForeignFulfilledOccurrence[] = [];
  const missed: ForeignOpenOccurrence[] = [];
  const upcoming: ForeignOpenOccurrence[] = [];

  for (const occ of sortedOccurrences) {
    const index = liveActivities.findIndex(
      (a, i) => !used[i] && a.typeId === occ.typeId && a.performedOn === occ.date,
    );
    const open: ForeignOpenOccurrence = { rootId: occ.rootId, typeId: occ.typeId, date: occ.date };
    if (index >= 0) {
      used[index] = true;
      fulfilled.push({ ...open, activityId: liveActivities[index].id });
    } else if (occ.date >= asOfDate) {
      upcoming.push(open);
    } else {
      missed.push(open);
    }
  }

  const unplannedActivityIds = liveActivities.filter((_, i) => !used[i]).map((a) => a.id);
  return { fulfilled, missed, upcoming, unplannedActivityIds };
}

/**
 * `fulfilmentRatio = fulfilled / (fulfilled + missed)` (D-12): upcoming and cancelled
 * appointments are not in the denominator; a denominator of 0 is `null`, never 0 or 1.
 */
export function foreignFulfilmentRatio(fulfilledCount: number, missedCount: number): number | null {
  const denominator = fulfilledCount + missedCount;
  return denominator === 0 ? null : fulfilledCount / denominator;
}

// ---------------------------------------------------------------------------
// expandForeignRoots — the same expansion the template calendar uses (§1.6 "Terms")
// ---------------------------------------------------------------------------

/**
 * Expand live foreign roots into their occurrences inside `[from, to]` (both inclusive) and
 * collect their cancelled dates inside the same window.
 *
 * Expansion is `expandDates` with `epochMsToUtcCalDate(scheduledDate)` as DTSTART and the
 * parsed `deletedOccurrences` as the excluded set — exactly what `getPlannedWorkouts` does for
 * template roots. `removed` holds every date of a root's `deletedOccurrences` that lies in the
 * window, over EVERY live foreign root passed in. This is deliberately NOT the way step 2 of
 * `computeAdherence` counts the template side: the template `removedOccurrenceCount` counts only
 * over the roots with at least one live occurrence in the window (`denom.roots`, the gap D-07 of
 * Phase 155), so a weekly series whose only date in the window is cancelled reports 1 here and 0
 * there. The difference is wanted and stays (Phase 166, D-08, review finding IN-01 of
 * `155-REVIEW.md`): the template count is a measuring figure of the adherence, the foreign count
 * the more complete one. See protocol § 1.6 "Removed occurrences: why the two sides count
 * differently". Occurrences come back in occurrence order `(date, scheduledTime null last, rootId)`,
 * `removed` in `(date, rootId)` order.
 *
 * @throws RecurrenceRuleError for a recurrence rule the expander refuses (INTERVAL < 1,
 *         BYMONTHDAY < 1) — `computeForeignAdherence` turns that into an unavailable block.
 */
export function expandForeignRoots(
  roots: readonly DecryptedPlannedForeignActivity[],
  from: string,
  to: string,
): { occurrences: ForeignExpandedOccurrence[]; removed: ForeignRemovedDate[] } {
  const rangeStart = parseIsoDate(from);
  const rangeEnd = parseIsoDate(to);
  const occurrences: ForeignExpandedOccurrence[] = [];
  const removed: ForeignRemovedDate[] = [];

  for (const root of roots) {
    const deleted = parseDeletedOccurrences(root.deletedOccurrencesRaw);
    const isRecurring = root.recurrenceRule !== null && root.recurrenceRule.trim() !== '';
    const dates = expandDates(
      epochMsToUtcCalDate(root.scheduledDate),
      root.recurrenceRule,
      rangeStart,
      rangeEnd,
      new Set(deleted),
      root.id,
    );
    for (const date of dates) {
      occurrences.push({
        rootId: root.id,
        typeId: root.typeId,
        date: formatIsoDate(date),
        scheduledTime: root.scheduledTime,
        note: root.note,
        isRecurring,
      });
    }
    for (const date of deleted) {
      if (date >= from && date <= to) removed.push({ rootId: root.id, date });
    }
  }

  occurrences.sort(compareOccurrences);
  removed.sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.rootId, b.rootId));
  return { occurrences, removed };
}

// ---------------------------------------------------------------------------
// byType — one entry per planned type, resolved type fields (§1.6 "Tool outputs")
// ---------------------------------------------------------------------------

/**
 * One entry per `typeId` that has at least one occurrence in the window, sorted by `typeId`
 * (plain string order). The type fields come from `resolveForeignType`: a predefined type as a
 * plain string in `lang` (English without `lang`), an own type in the free-text envelope (also
 * when archived), an unknown id with `typeName: null`, `typeUnknown: true` (E-15).
 */
function buildByType(
  occurrences: readonly ForeignOccurrenceInput[],
  assignment: ForeignAssignment,
  lang: string | undefined,
  snapshot: DecryptedSnapshot,
): ForeignAdherenceByType[] {
  const counters = new Map<string, { planned: number; fulfilled: number; missed: number; upcoming: number }>();
  const counterFor = (typeId: string) => {
    let c = counters.get(typeId);
    if (!c) {
      c = { planned: 0, fulfilled: 0, missed: 0, upcoming: 0 };
      counters.set(typeId, c);
    }
    return c;
  };
  for (const occ of occurrences) counterFor(occ.typeId).planned++;
  for (const f of assignment.fulfilled) counterFor(f.typeId).fulfilled++;
  for (const m of assignment.missed) counterFor(m.typeId).missed++;
  for (const u of assignment.upcoming) counterFor(u.typeId).upcoming++;

  return [...counters.keys()].sort(compareStrings).map((typeId) => {
    const c = counters.get(typeId)!;
    return {
      typeId,
      ...resolveForeignType(typeId, lang, snapshot.foreignActivityTypes),
      plannedCount: c.planned,
      fulfilledCount: c.fulfilled,
      missedCount: c.missed,
      upcomingCount: c.upcoming,
    };
  });
}

// ---------------------------------------------------------------------------
// computeForeignAdherence — the get_adherence.foreignSport block
// ---------------------------------------------------------------------------

/**
 * Compute the `foreignSport` block of `get_adherence` over `[args.from, args.to]`.
 *
 * Unavailable foreign sport (E-8, E-9) yields `{ available: false, reason, explanation }` and
 * never throws — every template number of the tool is still delivered. Otherwise: the roots
 * are expanded inside the window, the activities with `from <= performedOn <= to` are the
 * complete activity input (tolerance 0, §1.6), and the day rule assigns them.
 *
 * @param args  `from`/`to` — the SAME window as the template adherence; `asOfDate` — the
 *              athlete's today (`toCalendarDay(now, training_timezone_id)`); `lang` — unused
 *              by `get_adherence` (no `lang` parameter, English names).
 * @param data  The decrypted snapshot and the foreign availability of this read.
 */
export function computeForeignAdherence(
  args: { from: string; to: string; asOfDate: string; lang?: string },
  data: { snapshot: DecryptedSnapshot; availability: ForeignSportAvailability },
): ForeignAdherenceResult {
  const { from, to, asOfDate } = args;
  const { snapshot, availability } = data;

  if (!availability.available) {
    return { available: false, reason: availability.reason, explanation: FOREIGN_ADHERENCE_EXPLANATION };
  }
  const roots = snapshot.plannedForeignActivities ?? [];
  const activityRows = snapshot.foreignActivities ?? [];

  let expanded: ReturnType<typeof expandForeignRoots>;
  try {
    expanded = expandForeignRoots(roots, from, to);
  } catch (err) {
    // A foreign root whose rule the expander refuses cannot be read into occurrences; it
    // degrades the foreign block only, never the whole tool (E-8).
    if (err instanceof RecurrenceRuleError) {
      return { available: false, reason: 'foreign_rows_unreadable', explanation: FOREIGN_ADHERENCE_EXPLANATION };
    }
    throw err;
  }

  const activities: ForeignActivityInput[] = activityRows
    .filter((a) => a.performedOn >= from && a.performedOn <= to)
    .map((a) => ({
      id: a.id,
      typeId: a.typeId,
      performedOn: a.performedOn,
      performedTime: a.performedTime,
      createdAt: a.createdAt,
      deletedAt: null,
    }));

  const assignment = assignForeignFulfilment(expanded.occurrences, activities, asOfDate);
  const fulfilledCount = assignment.fulfilled.length;
  const missedCount = assignment.missed.length;
  const upcomingCount = assignment.upcoming.length;

  return {
    available: true,
    window: { from, to },
    asOfDate,
    plannedCount: expanded.occurrences.length,
    fulfilledCount,
    missedCount,
    upcomingCount,
    removedOccurrenceCount: expanded.removed.length,
    fulfilmentRatio: foreignFulfilmentRatio(fulfilledCount, missedCount),
    byType: buildByType(expanded.occurrences, assignment, args.lang, snapshot),
    fulfilled: assignment.fulfilled,
    missed: assignment.missed,
    upcoming: assignment.upcoming,
    unplannedActivityIds: assignment.unplannedActivityIds,
    rule: FOREIGN_FULFILMENT_RULE,
    explanation: FOREIGN_ADHERENCE_EXPLANATION,
  };
}
