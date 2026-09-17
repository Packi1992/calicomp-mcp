/**
 * Athlete time-zone resolution and instant-to-calendar-day mapping (Phase 137, D-01/D-02).
 *
 * Every real-instant mapping onto a calendar day this MCP performs — a training-state
 * consistency calculation today, plan-adherence and staleness checks in later Phase 137
 * plans — binds to the synchronized `settings` key `training_timezone_id`
 * (Protocol §1.4 Rule 3), never to the MCP process's own host zone. The MCP runs on the
 * LLM client's machine, not on the training device; its host clock's zone has no
 * relationship to the athlete's training zone.
 *
 * `scheduledDate` (Protocol §1.4 Rule 2) is deliberately OUTSIDE this module's concern —
 * it is zone-free by construction and read in UTC by its own consumers. This module is
 * for genuine wall-clock instants only (a completed session's `startTime`, "today").
 *
 * Exports:
 *   TRAINING_TIMEZONE_SETTING_KEY — the settings key name carrying the IANA zone id
 *   TimeZoneUnavailableError      — thrown when the zone cannot be resolved
 *   resolveTimeZoneId             — reads the zone out of a decrypted snapshot
 *   toCalendarDay                 — maps an epoch-ms instant to a YYYY-MM-DD string in a zone
 *   isoWeekKey                    — maps a YYYY-MM-DD string to WEEK_BASED_YEAR*100+WEEK
 *
 * Security (threat model T-137-09, T-137-10):
 *   T-137-09: `resolveTimeZoneId` is the ONLY zone source; it never falls back to the host
 *             zone, and `toCalendarDay` takes the zone as a mandatory parameter with no
 *             default branch.
 *   T-120-17: error messages carry only the missing key name and the reason — never a
 *             PAT, never CALICOMP_KEY, never a decrypted value.
 *   T-120-18: no console.* anywhere — stdout is JSON-RPC only.
 */

import type { DecryptedSnapshot } from '../types.js';

/** The synchronized `settings` key carrying the app's IANA time-zone identifier. */
export const TRAINING_TIMEZONE_SETTING_KEY = 'training_timezone_id';

/**
 * Thrown when the athlete's IANA time zone cannot be resolved from the decrypted
 * snapshot — either because the app has never synced `settings` (or predates the
 * `training_timezone_id` key), or because the synced value is not a zone
 * `Intl.supportedValuesOf('timeZone')` recognizes. Never falls back to the MCP
 * process's own host zone (Protocol §1.4 Rule 3) — that substitution is exactly
 * what this error class exists to rule out.
 */
export class TimeZoneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeZoneUnavailableError';
  }
}

/**
 * Resolve the athlete's IANA time-zone identifier from a decrypted snapshot's
 * `settings` array.
 *
 * @throws TimeZoneUnavailableError if the `training_timezone_id` key is missing, or its
 *   value is not a zone `Intl.supportedValuesOf('timeZone')` recognizes.
 */
export function resolveTimeZoneId(snapshot: DecryptedSnapshot): string {
  const row = snapshot.settings.find((s) => s.key === TRAINING_TIMEZONE_SETTING_KEY);
  if (!row) {
    throw new TimeZoneUnavailableError(
      `Missing synchronized settings key "${TRAINING_TIMEZONE_SETTING_KEY}" — the app has not ` +
        'synced its time zone yet (Protocol §1.4 Rule 3). This tool cannot fall back to a host ' +
        'zone; the athlete must open the app once so it can sync.',
    );
  }
  const knownZones = Intl.supportedValuesOf('timeZone');
  if (!knownZones.includes(row.value)) {
    throw new TimeZoneUnavailableError(
      `Synchronized settings key "${TRAINING_TIMEZONE_SETTING_KEY}" carries an unrecognized ` +
        `time-zone value — this is not a valid IANA zone identifier (Protocol §1.4 Rule 3).`,
    );
  }
  return row.value;
}

/**
 * Map a real instant (epoch milliseconds) onto the calendar day it falls on in the given
 * IANA time zone. Uses `Intl.DateTimeFormat('en-CA', …)`, whose `en-CA` locale formats
 * dates as `YYYY-MM-DD` — Node ships the IANA database itself, so no third-party zone
 * library or hand-built offset table is needed.
 */
export function toCalendarDay(epochMs: number, timeZoneId: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZoneId,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(epochMs));
}

/**
 * Map a `YYYY-MM-DD` calendar date to its ISO-8601 week key, encoded as
 * `WEEK_BASED_YEAR * 100 + WEEK_OF_WEEK_BASED_YEAR` — the same encoding
 * `TrainingStreakCalculator.kt` names as the contract in its own KDoc, matching
 * `java.time.temporal.WeekFields.ISO` exactly (Monday-start weeks, the week containing
 * the year's first Thursday is week 1).
 *
 * Standard ISO-8601 week algorithm: shift the date to "its" Thursday (the ISO week's
 * anchor day), then count whole weeks between that Thursday and the first Thursday of
 * its own calendar year. The week-based year is the Thursday's calendar year — this is
 * what correctly assigns late-December dates to week 1 of the *following* year, and
 * early-January dates to week 52/53 of the *previous* year.
 */
export function isoWeekKey(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Shift to the Thursday of this ISO week (Mon=0 .. Sun=6 → Thursday is offset 3).
  const isoDayIndex = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - isoDayIndex + 3);

  const weekBasedYear = date.getUTCFullYear();

  // First Thursday of the week-based year.
  const firstThursday = new Date(Date.UTC(weekBasedYear, 0, 4));
  const firstThursdayIsoDayIndex = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayIsoDayIndex + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));

  return weekBasedYear * 100 + week;
}
