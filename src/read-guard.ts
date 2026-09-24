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

import type { DecodeReport, UnreadableEntity } from './types.js';

/** The report a `SnapshotCache` mock that predates this field (or a genuinely empty
 *  decode run) is treated as carrying — no unreadable rows, nothing encrypted. */
export const EMPTY_DECODE_REPORT: DecodeReport = {
  unreadable: [],
  encryptedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
  failedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
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
 * Throw when EVERY encrypted row of one of `entities` failed to decode (D-11) — a
 * wrong `CALICOMP_KEY` must never read as "no training", it must fail loudly. An entity
 * with zero encrypted rows (nothing to decrypt, or an all-plaintext pre-encryption
 * account) never trips this guard; the "mindestens eine" edge case (exactly one
 * encrypted row of a kind, and it fails) is accepted by design (D-11).
 */
export function assertEntitiesReadable(report: DecodeReport, entities: UnreadableEntity[], toolLabel: string): void {
  for (const entity of entities) {
    const encrypted = report.encryptedCount[entity];
    const failed = report.failedCount[entity];
    if (encrypted > 0 && failed === encrypted) {
      throw new Error(
        `${toolLabel}: every encrypted ${entity} row (${failed} of ${encrypted}) failed to decrypt ` +
          "or decode — CALICOMP_KEY most likely does not match this account's key; refusing to " +
          'report an empty result.',
      );
    }
  }
}
