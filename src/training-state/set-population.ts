/**
 * Rule P of protocol §1.11 (Phase 166, D-03) — stub of plan 166-04 (red commit).
 */

import type { CatalogExercise, DecryptedSession, DecryptedSetLog, DecryptedSnapshot, NormalizedTemplateExercise } from '../types.js';

export interface PopulationSet {
  setLog: DecryptedSetLog;
  session: DecryptedSession;
  exerciseId: string;
  exercise: CatalogExercise;
  workoutExercise: NormalizedTemplateExercise | undefined;
  trainingMode: string | undefined;
  recordsTime: boolean;
}

export interface SetPopulationOptions {
  requireFinishedSession: boolean;
  sinceMs?: number;
}

/** Stub: no behavior yet. */
export function isMarkedDeleted(row: { deletedAt?: number | null }): boolean {
  void row;
  return false;
}

/** Stub: no behavior yet. */
export function resolveSetPopulation(
  snapshot: DecryptedSnapshot,
  catalogById: ReadonlyMap<string, CatalogExercise>,
  options: SetPopulationOptions,
): PopulationSet[] {
  void snapshot;
  void catalogById;
  void options;
  return [];
}

/** Stub: no behavior yet. */
export function trainingModeOf(
  setLog: DecryptedSetLog,
  templateExerciseById: ReadonlyMap<string, NormalizedTemplateExercise>,
  catalogMode: string | undefined,
): string | undefined {
  void setLog;
  void templateExerciseById;
  void catalogMode;
  return undefined;
}

/** Stub: no behavior yet. */
export function recordsTime(mode: string | undefined, catalogMode: string | undefined): boolean {
  void mode;
  void catalogMode;
  return false;
}
