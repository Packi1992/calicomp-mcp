/**
 * Tool-boundary guards over the per-row decode report (Phase 150, D-09/D-11/D-12).
 *
 * `decryptMerge` (cache.ts) no longer throws on the first bad row — it decodes every row
 * it can and collects the rest into a `DecodeReport` carried beside the snapshot
 * (`SnapshotCache.decodeReport`). This module is where the strictness the old
 * all-or-nothing behavior provided moves to: each tool decides, at its own boundary,
 * which entity kinds it cannot tolerate a 100% failure of (D-11) or a single unreadable
 * row of (D-09, the calendar tools).
 *
 * Pure — no `console.*` (T-120-18) — and every thrown message names only the entity, the
 * row id(s) and the cause, never plaintext, ciphertext or key material (T-120-17).
 */

import { TimeZoneUnavailableError, TRAINING_TIMEZONE_SETTING_KEY } from './training-state/time-zone.js';
import type { DecodeReport, DecryptedSnapshot, UnreadableEntity } from './types.js';

/** The report a `SnapshotCache` mock that predates this field (or a genuinely empty
 *  decode run) is treated as carrying — no unreadable rows, nothing encrypted. */
export const EMPTY_DECODE_REPORT: DecodeReport = {
  unreadable: [],
  encryptedCount: {
    session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0,
    foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0,
    // Phase 156 (D-10): counted, but read by no guard below — an unreadable own name of a
    // catalog exercise never fails a tool. Phase 164 (§1.9): the same for own exercises and
    // their translations — an unreadable one degrades only itself (`exerciseUnknown`).
    exerciseNameOverride: 0, exercise: 0, exerciseTranslation: 0,
  },
  failedCount: {
    session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0,
    foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0,
    exerciseNameOverride: 0, exercise: 0, exerciseTranslation: 0,
  },
};

/**
 * Read `data.decodeReport`, falling back to `EMPTY_DECODE_REPORT` when it is absent —
 * either because the caller's `SnapshotCache` mock predates this field, or (should it
 * ever happen) because `doFetch` did not populate it.
 */
export function decodeReportOf(data: { decodeReport?: DecodeReport }): DecodeReport {
  return data.decodeReport ?? EMPTY_DECODE_REPORT;
}

/**
 * Throw when EVERY encrypted row of one of `entities` failed to DECRYPT (D-11) — a
 * wrong `CALICOMP_KEY` must never read as "no training", it must fail loudly. An entity
 * with zero encrypted rows (nothing to decrypt, or an all-plaintext pre-encryption
 * account) never trips this guard; the "mindestens eine" edge case (exactly one
 * encrypted row of a kind, and it fails) is accepted by design (D-11).
 *
 * Numerator and denominator are deliberately taken over the SAME row set (WR-01 of the
 * Phase 150 review): `encryptedCount` counts only rows that carry ciphertext — the rows
 * a decrypt was actually attempted on — and the numerator counts only `decrypt_failed`
 * rows of that entity, never `failedCount`. `failedCount` also includes rows that fail
 * WITHOUT a decrypt attempt (the empty-payload tombstone shape of `plannedWorkout` /
 * `setting`, `malformed_payload`) and rows whose decrypt SUCCEEDED but whose content is
 * bad (`malformed_payload`, `unknown_version`). Neither says anything about the key: a
 * wrong key makes AES-GCM authentication fail, which is `decrypt_failed` and nothing
 * else. Comparing `failedCount` against `encryptedCount` raised a false key alarm for
 * "one readable setting + one empty-payload setting" (1 of 1), missed a genuinely wrong
 * key as soon as one empty-payload row pushed `failed` past `encrypted`, and blamed the
 * key for a newer payload version. Those non-key failures stay visible in `unreadable`
 * and are enforced where a tool needs them (`assertCalendarReadable`,
 * `assertTimeZoneReadable`).
 */
export function assertEntitiesReadable(report: DecodeReport, entities: UnreadableEntity[], toolLabel: string): void {
  for (const entity of entities) {
    const encrypted = report.encryptedCount[entity];
    const decryptFailed = report.unreadable.filter((r) => r.entity === entity && r.reason === 'decrypt_failed').length;
    if (encrypted > 0 && decryptFailed >= encrypted) {
      throw new Error(
        `${toolLabel}: every encrypted ${entity} row (${decryptFailed} of ${encrypted}) failed to decrypt ` +
          "— CALICOMP_KEY most likely does not match this account's key; refusing to " +
          'report an empty result.',
      );
    }
  }
}

/**
 * Throw when ANY `planned_workout` row failed to decode (D-09) — the calendar tools
 * (`get_planned_workouts`, `get_adherence`, `propose_planned_update`) keep the
 * all-or-nothing discipline Phase 135 (D-14) established for the whole snapshot, now
 * enforced at their own boundary instead. A tool that never reads the calendar must NOT
 * call this guard — that is exactly what lets a corrupt planned-workout row stop
 * blocking `get_history`/`get_stats`/etc. (Phase 150's core fix).
 */
export function assertCalendarReadable(report: DecodeReport, toolLabel: string): void {
  if (report.failedCount.plannedWorkout > 0) {
    const failed = report.unreadable.filter((r) => r.entity === 'plannedWorkout');
    const detail = failed.map((r) => `${r.id}: ${r.reason}`).join(', ');
    throw new Error(
      `${toolLabel}: the training calendar is unreadable — ${report.failedCount.plannedWorkout} ` +
        `planned_workout row(s) could not be decoded (${detail}); this tool never answers from a ` +
        'partial calendar (Phase 135 D-14).',
    );
  }
}

/**
 * Throw `TimeZoneUnavailableError` when the athlete's `training_timezone_id` settings
 * row is itself unreadable (Claude's discretion, following the D-09 pattern: strict
 * only where a tool actually needs the value). Other kaputte settings rows stay in
 * `unreadable` without failing any tool.
 */
export function assertTimeZoneReadable(report: DecodeReport, toolLabel: string): void {
  const tzRow = report.unreadable.find((r) => r.entity === 'setting' && r.key === TRAINING_TIMEZONE_SETTING_KEY);
  if (tzRow) {
    throw new TimeZoneUnavailableError(
      `${toolLabel}: the athlete's time-zone setting (${TRAINING_TIMEZONE_SETTING_KEY}) could not be ` +
        `decoded (reason: ${tzRow.reason}); this tool cannot fall back to a host zone.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Foreign sport availability (Phase 155, E-8/E-9; protocol §1.6 "Tool outputs")
// ---------------------------------------------------------------------------

/** Why the foreign block of a tool is unavailable: the pull lacks the foreign fields (a
 *  server older than Phase 155, E-9), or a foreign row could not be decoded (E-8). */
export type ForeignUnavailableReason = 'server_without_foreign_sport' | 'foreign_rows_unreadable';

/** The availability of the foreign sport block of one tool result. */
export type ForeignSportAvailability = { available: true } | { available: false; reason: ForeignUnavailableReason };

/**
 * Decide whether the foreign sport block of a tool may be filled (Phase 155, E-8/E-9).
 * Unlike the guards above this NEVER throws: an unavailable foreign block is reported in
 * the tool result (`available: false` plus `reason`), and every template number, session
 * and calendar entry is still delivered — no tool fails because of a foreign row.
 *
 * A missing snapshot list (the matching wire field was absent) wins over unreadable rows:
 * an old server cannot have delivered rows that failed. All three foreign kinds count —
 * an unreadable own type could hide the name behind a type id, an unreadable appointment
 * would turn into a silently missing planned date, so a partial foreign picture is never
 * reported as complete.
 */
export function foreignSportAvailability(snapshot: DecryptedSnapshot, report: DecodeReport): ForeignSportAvailability {
  if (
    snapshot.foreignActivityTypes === undefined ||
    snapshot.foreignActivities === undefined ||
    snapshot.plannedForeignActivities === undefined
  ) {
    return { available: false, reason: 'server_without_foreign_sport' };
  }
  if (
    report.failedCount.foreignActivityType > 0 ||
    report.failedCount.foreignActivity > 0 ||
    report.failedCount.plannedForeignActivity > 0
  ) {
    return { available: false, reason: 'foreign_rows_unreadable' };
  }
  return { available: true };
}
