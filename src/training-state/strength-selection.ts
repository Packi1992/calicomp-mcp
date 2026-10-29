/**
 * Rule S of protocol §1.11 (Phase 166, D-01, STAT-01) — stub of plan 166-04 (red commit).
 */

import type { CatalogExercise } from '../types.js';

export const STRETCH_AXIS_KEYS = ['mobility', 'flexibility'] as const;

/** Stub: no behavior yet. */
export function isStretchOnly(exercise: CatalogExercise): boolean {
  void exercise;
  return false;
}
