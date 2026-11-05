/**
 * The section "Reine Kraft" of protocol §1.11 "Pure strength" (Phase 168.1, D-06, assumption
 * A9): exercises without a capability axis appear in no capability evaluation although the
 * athlete trains them, so they stand beside the axes with their amount and their progress.
 * The section is never a key in `setCounts`, never an eighth axis.
 *
 * Why not the metric of `get_progress`: `computeExerciseProgress` follows `usesWeight`, and
 * `pull_up` carries `usesWeight`, so a pull-up without weight would read `insufficient-data`
 * for ever. That function stays unchanged; this file has the rule of §1.11, which the corpus
 * section `pureStrength` (docs/coach-planning-vectors.json) pins in both languages. A
 * disagreement with the corpus means this file is wrong, never the corpus.
 *
 * Without an axis: `exercise.capabilities.length === 0`. Both catalog forms hold rated axes
 * only (see `strength-selection.ts`), and `data.catalog` is the effective catalog, so a
 * personal list that gives an exercise an axis moves it out of the section, retroactively.
 *
 * Amount and direction read the same population (Rule P with finished sessions). The period
 * selects the rows and their set counts; the direction always rests on the whole history.
 *
 * Exports:
 *   pureStrengthProgress — the progress rule of §1.11 over the sessions of one exercise
 *   computePureStrength  — the rows of the section over a snapshot and a catalog
 */

import { bestE1rm } from '../e1rm.js';
import { createExerciseNameResolver } from '../exercise-names.js';
import { directionOf, type DirectionLabel } from './exercise-progress.js';
import { resolveSetPopulation } from './set-population.js';
import type { AthleteFreeText, CatalogExercise, DecryptedSnapshot } from '../types.js';

/** Sessions with a set above 0 kg from which the series uses `e1rm` (§1.11, step 2). */
const MIN_LOADED_SESSIONS = 4;

/** The direction looks at this many sessions of the chosen series (§1.11, step 4). */
const LAST_SESSIONS = 12;

export type PureStrengthMetric = 'reps' | 'e1rm' | 'timeSeconds';

/** One set in the form of the corpus section `pureStrength`. */
export interface PureStrengthSet {
  reps: number | null;
  timeSec: number | null;
  weight: number | null;
}

export interface PureStrengthSession {
  startTime: number;
  sets: PureStrengthSet[];
}

export interface PureStrengthProgress {
  metric: PureStrengthMetric;
  /** One value per session in `startTime` order, after the cut to the last 12 sessions. */
  values: Array<number | null>;
  direction: DirectionLabel;
}

/** One row of the section: the amount in the period, the progress of the whole history. */
export interface PureStrengthRow {
  exerciseId: string;
  name: string | null;
  setCount: number;
  metric: PureStrengthMetric;
  direction: DirectionLabel;
  /** Only for an own exercise: its name is the athlete's free text (protocol §1.7). */
  exerciseNameFreeText?: AthleteFreeText;
}

function bestOf(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

/**
 * The progress rule of §1.11: `mode = TIME` reads `timeSeconds`; otherwise at least four
 * sessions with a set above 0 kg read `e1rm` over exactly these sessions; otherwise `reps`
 * over all sessions. A session without such a value stands as `null`. The direction is
 * `directionOf` over the last 12 sessions of the chosen series.
 */
export function pureStrengthProgress(sessions: PureStrengthSession[], mode: string): PureStrengthProgress {
  const ordered = [...sessions].sort((a, b) => a.startTime - b.startTime);
  const loaded = ordered.filter((s) => s.sets.some((set) => (set.weight ?? 0) > 0));

  let metric: PureStrengthMetric;
  let series: Array<number | null>;
  if (mode === 'TIME') {
    metric = 'timeSeconds';
    series = ordered.map((s) => bestOf(s.sets.map((set) => set.timeSec)));
  } else if (loaded.length >= MIN_LOADED_SESSIONS) {
    metric = 'e1rm';
    series = loaded.map((s) => bestE1rm(s.sets.map((set) => ({ weightUsed: set.weight, completedReps: set.reps }))));
  } else {
    metric = 'reps';
    series = ordered.map((s) => bestOf(s.sets.map((set) => set.reps)));
  }

  const values = series.slice(-LAST_SESSIONS);
  return { metric, values, direction: directionOf(values).label };
}

/**
 * The rows of the section for the period starting at `sinceMs`: one per exercise without an
 * axis that has a set in the period, the most sets first. `lang` is the language of the
 * names, as for every tool (`createExerciseNameResolver`). The mode of the rule is the mode
 * of the exercise.
 */
export function computePureStrength(
  snapshot: DecryptedSnapshot,
  catalog: CatalogExercise[],
  sinceMs: number,
  lang?: string,
): PureStrengthRow[] {
  const catalogById = new Map<string, CatalogExercise>(catalog.map((ex) => [ex.id, ex]));
  const population = resolveSetPopulation(snapshot, catalogById, { requireFinishedSession: true });

  interface Accumulator {
    exercise: CatalogExercise;
    setCount: number;
    sessions: Map<string, PureStrengthSession>;
  }
  const byExercise = new Map<string, Accumulator>();

  for (const { exercise, exerciseId, session, setLog } of population) {
    if (exercise.capabilities.length !== 0) continue;

    let acc = byExercise.get(exerciseId);
    if (acc === undefined) {
      acc = { exercise, setCount: 0, sessions: new Map() };
      byExercise.set(exerciseId, acc);
    }
    if (setLog.createdAt >= sinceMs) acc.setCount += 1;

    let row = acc.sessions.get(session.id);
    if (row === undefined) {
      row = { startTime: session.startTime, sets: [] };
      acc.sessions.set(session.id, row);
    }
    row.sets.push({ reps: setLog.completedReps, timeSec: setLog.completedTimeSeconds, weight: setLog.weightUsed });
  }

  const names = createExerciseNameResolver({ catalog, snapshot, lang });
  const rows: PureStrengthRow[] = [];
  for (const [exerciseId, acc] of byExercise) {
    if (acc.setCount === 0) continue;
    const { metric, direction } = pureStrengthProgress([...acc.sessions.values()], acc.exercise.mode);
    const { exerciseName, exerciseNameFreeText } = names.forExerciseId(exerciseId);
    rows.push({
      exerciseId,
      name: exerciseName,
      setCount: acc.setCount,
      metric,
      direction,
      ...(exerciseNameFreeText !== undefined ? { exerciseNameFreeText } : {}),
    });
  }

  return rows.sort((a, b) => b.setCount - a.setCount || a.exerciseId.localeCompare(b.exerciseId));
}
