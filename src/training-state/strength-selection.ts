/**
 * Rule S of protocol §1.11 (Phase 166, plan 166-04; D-01, STAT-01): which exercises the
 * strength heatmap counts.
 *
 * An exercise is excluded from the strength heatmap if and only if it has at least one RATED
 * capability axis and every rated axis lies in the stretch axis list `mobility`,
 * `flexibility`. Everything else stays in: an exercise without any axis, a mixed exercise (a
 * stretch axis plus any other rated axis), and an exercise whose only links are unrated.
 * `isSkill` and the catalog mode play no part.
 *
 * Parity with the app: `STRETCH_AXIS_KEYS` mirrors
 * `TrainCounter/app/src/main/java/com/gehlich/calisthenicscompanion/domain/MobilityStretchCapabilityAxes.kt`
 * (`AXIS_KEYS`), the list the app passes to its heatmap queries. The app ignores an unrated
 * link by `capabilityLevel IS NOT NULL`; the MCP never carries one, because both catalog forms
 * hold rated axes only (the curated catalog always rates, and `cache.ts`
 * `projectUserExerciseToCatalog` drops an own exercise's link without a level). The corpus
 * section `strengthHeatmapSelection` (docs/coach-planning-vectors.json) proves both sides.
 *
 * Exports:
 *   STRETCH_AXIS_KEYS — the stretch axis list of Rule S
 *   isStretchOnly     — true when the exercise is excluded from the strength heatmap
 */

import type { CatalogExercise } from '../types.js';

/** The stretch axis list of Rule S, as `MobilityStretchCapabilityAxes.AXIS_KEYS` in the app. */
export const STRETCH_AXIS_KEYS = ['mobility', 'flexibility'] as const;

const STRETCH_AXIS_KEY_SET: ReadonlySet<string> = new Set(STRETCH_AXIS_KEYS);

/**
 * True when every rated capability axis of the exercise is a stretch axis and it has at least
 * one: such an exercise counts nowhere in the strength heatmap (Rule S). `capabilities` of the
 * catalog form contains rated axes only (see the module header).
 */
export function isStretchOnly(exercise: CatalogExercise): boolean {
  return exercise.capabilities.length > 0 && exercise.capabilities.every((axis) => STRETCH_AXIS_KEY_SET.has(axis.key));
}
