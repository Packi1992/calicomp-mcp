/**
 * Foreign sport load — the windows of the `get_training_state.foreignSport` block (Phase 155,
 * FA-08, D-16).
 *
 * Source: docs/COACH-PLANNING-PROTOCOL.md §1.6 "Tool outputs" (`get_training_state.foreignSport`)
 * and "Verbatim explanations" (`FOREIGN_LOAD_EXPLANATION`).
 *
 * Per window (`from`…`to`, both inclusive, compared as plain strings on `performedOn`, §1.4
 * Rule 4) the coach reads the number of activities, their minutes and the load approximation
 * `intensityMinutes = Σ intensity × durationMinutes`, in total and per type. The approximation
 * is self-assessed and rough — never a measurement, never comparable with strength volume; the
 * explanation below travels verbatim with every result.
 *
 * "Not measured" stays visible (D-16, MEMORY "Stille Verwerfung liest sich als grün"): an
 * activity whose intensity could not be read (`intensity === null` after decoding) counts in
 * `activityCount`, `totalMinutes` and `activitiesWithoutIntensity`, and NEVER as zero in
 * `intensityMinutes`.
 *
 * Read time only: everything here is computed by the MCP when a tool is called. Nothing is
 * stored, cached beyond the snapshot, or sent to the server.
 *
 * Exports:
 *   FOREIGN_LOAD_EXPLANATION — verbatim from §1.6 "Verbatim explanations"
 *   computeForeignLoadWindow — one window of the block
 *
 * Pure, no I/O, never logs (T-120-18): own type names are athlete free text.
 */

import { resolveForeignType, type ForeignTypeFields } from '../foreign-types.js';
import type { DecryptedForeignActivity, DecryptedForeignActivityType } from '../types.js';

// ---------------------------------------------------------------------------
// Explanation (D-16) — verbatim from protocol §1.6, never derived per call.
// ---------------------------------------------------------------------------

export const FOREIGN_LOAD_EXPLANATION =
  "intensityMinutes is a rough approximation, not a measurement: for each foreign sport activity the athlete's own intensity rating (1 = very easy to 5 = all out) is multiplied by its duration in minutes, and the products are summed. It is self-assessed and says nothing about physiological load (no heart rate, pace, power or recovery data), and it must not be compared with or added to the strength volume of template trainings (sets, repetitions, kilograms). An activity whose intensity could not be read is counted in activitiesWithoutIntensity instead of being added as zero.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One `byType[]` entry of a load window: the resolved type fields plus the four counters. */
export interface ForeignLoadByType extends ForeignTypeFields {
  typeId: string;
  activityCount: number;
  totalMinutes: number;
  intensityMinutes: number;
  activitiesWithoutIntensity: number;
}

/** One window of `get_training_state.foreignSport.windows` (§1.6 "Tool outputs"). */
export interface ForeignLoadWindow {
  from: string;
  to: string;
  activityCount: number;
  totalMinutes: number;
  /** Σ intensity × durationMinutes over the activities that HAVE an intensity. */
  intensityMinutes: number;
  /** Activities whose intensity could not be read — counted here, never as zero above. */
  activitiesWithoutIntensity: number;
  /** One entry per type with at least one activity in the window, sorted by `typeId`. */
  byType: ForeignLoadByType[];
}

// ---------------------------------------------------------------------------
// computeForeignLoadWindow
// ---------------------------------------------------------------------------

interface Counters {
  activityCount: number;
  totalMinutes: number;
  intensityMinutes: number;
  activitiesWithoutIntensity: number;
}

function emptyCounters(): Counters {
  return { activityCount: 0, totalMinutes: 0, intensityMinutes: 0, activitiesWithoutIntensity: 0 };
}

function add(counters: Counters, activity: DecryptedForeignActivity): void {
  counters.activityCount++;
  counters.totalMinutes += activity.durationMinutes;
  if (activity.intensity === null) {
    counters.activitiesWithoutIntensity++;
  } else {
    counters.intensityMinutes += activity.intensity * activity.durationMinutes;
  }
}

/** Plain string order, code unit by code unit (§1.6), never a locale collation. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sum the foreign activities with `from <= performedOn <= to` into one load window.
 *
 * @param activities The live, decoded foreign activities (tombstones never reach the MCP).
 * @param from       First day of the window (`YYYY-MM-DD`, inclusive).
 * @param to         Last day of the window (`YYYY-MM-DD`, inclusive) — `asOfDate` in the tool.
 * @param types      The decoded own type rows, for the type fields of `byType`.
 * @param nameLanguage The effective name language (`lang`, otherwise the app language; protocol
 *                     1.50 §1.7, E-16); predefined type names in it, English without one.
 */
export function computeForeignLoadWindow(
  activities: readonly DecryptedForeignActivity[],
  from: string,
  to: string,
  types: DecryptedForeignActivityType[] | undefined,
  nameLanguage: string | null | undefined,
): ForeignLoadWindow {
  const total = emptyCounters();
  const perType = new Map<string, Counters>();

  for (const activity of activities) {
    if (activity.performedOn < from || activity.performedOn > to) continue;
    add(total, activity);
    let counters = perType.get(activity.typeId);
    if (!counters) {
      counters = emptyCounters();
      perType.set(activity.typeId, counters);
    }
    add(counters, activity);
  }

  const byType: ForeignLoadByType[] = [...perType.keys()].sort(compareStrings).map((typeId) => {
    const c = perType.get(typeId)!;
    return {
      typeId,
      ...resolveForeignType(typeId, nameLanguage, types),
      activityCount: c.activityCount,
      totalMinutes: c.totalMinutes,
      intensityMinutes: c.intensityMinutes,
      activitiesWithoutIntensity: c.activitiesWithoutIntensity,
    };
  });

  return {
    from,
    to,
    activityCount: total.activityCount,
    totalMinutes: total.totalMinutes,
    intensityMinutes: total.intensityMinutes,
    activitiesWithoutIntensity: total.activitiesWithoutIntensity,
    byType,
  };
}
