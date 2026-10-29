/**
 * Suspect sets (Phase 166, plan 166-06; protocol 1.48 §1.11 "Suspect sets", D-05, D-17,
 * STAT-05). Stub without behavior (red commit of plan 166-06); the implementation follows.
 */

import type { CatalogExercise, DecryptedSnapshot } from '../types.js';

export const SUSPECT_REASONS = ['reps_on_time_station', 'zero_set', 'measured_time_missing'] as const;
export type SuspectReason = (typeof SUSPECT_REASONS)[number];

export interface SuspectMark {
  reason: SuspectReason;
  explanation: string;
}

export interface DataQualityEntry {
  setLogId: string;
  date: string;
  reasons: SuspectReason[];
}

export interface DataQuality {
  suspectSetCount: number;
  byReason: Record<SuspectReason, number>;
  newest: DataQualityEntry[];
}

/** Stub. */
export function suspectMarksFor(snapshot: DecryptedSnapshot, catalog: CatalogExercise[]): Map<string, SuspectMark[]> {
  void snapshot;
  void catalog;
  return new Map();
}

/** Stub. */
export function computeDataQuality(snapshot: DecryptedSnapshot, catalog: CatalogExercise[], timeZoneId: string): DataQuality {
  void snapshot;
  void catalog;
  void timeZoneId;
  return { suspectSetCount: 0, byReason: {} as Record<SuspectReason, number>, newest: [] };
}
