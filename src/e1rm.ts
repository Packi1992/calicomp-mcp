/**
 * Epley e1RM (estimated 1-rep-max) — 1:1 port of WorkoutLoadCalculator.kt.
 *
 * Source analogue: TrainCounter/.../domain/WorkoutLoadCalculator.kt lines 19–33
 *
 * Formula:    weight × (1.0 + Math.min(reps, REP_CAP) / 30.0)
 * REP_CAP:    12  — Epley degrades above ~12 reps (endurance, not strength)
 * Rounding:   NONE — Kotlin returns Double; TypeScript returns number
 * Null gates: weight <= 0 OR reps < 1 → null (bodyweight + time-only sets excluded)
 *
 * The output of setE1rm() is used by get_stats to compute per-exercise / per-muscle
 * aggregates that must match what the app shows. Do not modify the formula.
 */

/** Epley formula rep cap — mirrors WorkoutLoadCalculator.kt const val REP_CAP = 12. */
export const REP_CAP = 12;

/**
 * Epley 1RM estimate for a single weighted set.
 *
 * Mirrors WorkoutLoadCalculator.kt:
 *   fun setE1rm(weightKg: Float?, reps: Int?): Double? {
 *     val w = weightKg ?: 0f
 *     val r = reps ?: 0
 *     if (w <= 0f || r < 1) return null
 *     return w * (1.0 + minOf(r, REP_CAP) / 30.0)
 *   }
 *
 * @param weightKg - Weight in kg. null or <= 0 → null.
 * @param reps     - Completed reps. null or < 1 → null.
 * @returns Epley e1RM as a floating-point number, or null for bodyweight/time sets.
 */
export function setE1rm(weightKg: number | null, reps: number | null): number | null {
  const w = weightKg ?? 0;
  const r = reps ?? 0;
  if (w <= 0 || r < 1) return null;
  return w * (1.0 + Math.min(r, REP_CAP) / 30.0);
}

/**
 * Best (maximum) e1RM across a list of set-log objects.
 *
 * Mirrors WorkoutLoadCalculator.kt:
 *   fun strengthScore(sets: List<SessionSetLogRow>): Float? =
 *     sets.mapNotNull { setE1rm(it.weightUsed, it.completedReps) }.maxOrNull()?.toFloat()
 *
 * @param sets - Array of set-log objects with weightUsed and completedReps fields.
 * @returns Maximum e1RM across all weighted sets, or null if no weighted sets exist.
 */
export function bestE1rm(
  sets: Array<{ weightUsed: number | null; completedReps: number | null }>
): number | null {
  let best: number | null = null;
  for (const s of sets) {
    const e = setE1rm(s.weightUsed, s.completedReps);
    if (e !== null && (best === null || e > best)) best = e;
  }
  return best;
}
