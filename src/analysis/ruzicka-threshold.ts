/**
 * Ruzicka threshold derivation — the PERMANENT analysis tool behind MUSC-07 (Phase 138,
 * D-11/D-19). Re-derives the two `classifySimilarity` thresholds
 * (`matchThreshold`/`uncertainThreshold`, `coach-parameters.ts`) against real production
 * data whenever the training history has grown enough to move them — which it will,
 * repeatedly, as the athlete keeps training. D-19 asked for a tool that stays in the repo
 * with its own test, not a throwaway script, precisely because this derivation is meant to
 * be RE-RUN, not reconstructed from memory each time.
 *
 * Ground truth (D-11): a session with a set `templateId` is a KNOWN fact about which plan
 * it came from — every such session forms one POSITIVE pair (against its own template) and
 * one NEGATIVE pair against every other live template (`buildLabelledPairs`). A session
 * without a `templateId`, or with one pointing at a deleted/unknown template, is exactly the
 * case `classifySimilarity` exists to resolve — it teaches nothing about where the threshold
 * belongs and is excluded from both classes, counted rather than silently dropped.
 *
 * Why deleted rows are filtered out (`deletedAt !== undefined`) on sessions, set-logs AND
 * template-exercises: a soft-deleted set the athlete removed, or a template exercise they
 * pulled out of a plan, never happened as training history — counting it would calibrate
 * the threshold against a past that does not exist (mirrors `adherence.ts`'s own
 * `session.deletedAt`/`setLog.deletedAt` discipline, extended here to template-exercises,
 * which the live adherence path does not currently filter but which this offline derivation
 * — reading a frozen copy, not the live path — chooses to filter deliberately, so a plan
 * edited after the fact does not distort the vector its own past sessions are compared
 * against).
 *
 * THE TARGET, why it governs both thresholds (state this so a later re-run optimizes the
 * SAME thing, not a different one by accident): a false MATCH is more expensive than a
 * missed one. A session wrongly pinned to the wrong plan corrupts the adherence number it
 * feeds into; a session left unmatched only makes that number a little less complete. Both
 * thresholds are therefore chosen to maximize true-positive rate MINUS a false-positive
 * PENALTY that is strictly greater than 1 for `matchThreshold` (a confirmed match must be
 * rare to get wrong) and smaller for `uncertainThreshold` (an 'uncertain' verdict is never
 * treated as a confirmed match downstream — `classifySimilarity`, D-23 — so tolerating more
 * false candidates in that tier is the deliberate, cheaper trade).
 *
 * This module computes vectors with `buildCombinedVector` (the default, since Phase 138.1,
 * plan `138.1-22`) and compares them with `ruzickaSimilarity` — THE SAME functions
 * `adherence.ts` calls in production. There is no second similarity formula here; a
 * derivation that calibrated a different measure than the one actually running would be
 * worse than no derivation, because it would look calibrated while quietly measuring
 * something else (T-138-35).
 *
 * D-17 (Phase 138.1, plan `138.1-22`) added ONE optional third parameter to
 * `buildLabelledPairs` — `vectorBuilder` — so the identical pairing/labelling/rounds logic
 * below could be run once against the plain `buildMuscleVector` and once against
 * `buildCombinedVector` (muscle groups PLUS capability axes,
 * `training-state/muscle-similarity.ts`) over the SAME snapshot, to decide empirically
 * whether the capability dimensions improve the match/non-match separation this file's
 * whole derivation exists to measure. The result
 * (`.planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md`): they do,
 * consistently, across every measured distribution statistic — so `buildCombinedVector` is
 * now the DEFAULT here, matching what `adherence.ts` calls in production (a derivation
 * calibrating a vector production no longer uses would be exactly the T-138-35 risk this
 * file's own header already warns against). Passing `buildMuscleVector` explicitly still
 * works (proven by this file's own test suite) for anyone who wants the muscle-only
 * comparison again in a future re-derivation. `ruzickaSimilarity` and `classifySimilarity`
 * themselves are still untouched — this is a second vector CONSTRUCTION, never a second
 * similarity MEASURE.
 *
 * `classifySimilarity` and `COACH_PARAMETER_RANGES` are NOT touched by this module — the
 * two thresholds remain caller-supplied parameters, never module constants (D-23,
 * unaffected by this phase). This tool only proposes new DEFAULT values; Task 2 decides,
 * by hand, whether the data backing them is sufficient to adopt them.
 *
 * Exports:
 *   buildLabelledPairs      — snapshot + catalog → positive/negative (session, template)
 *                              pairs, plus the data-basis counts the doc/derivation reports
 *   similarityDistribution  — pairs → per-class sorted similarity list, count, median, quartiles
 *   chooseThresholds        — distribution + options → the two thresholds, or
 *                              `{ sufficient: false }` when the positive sample is too small
 *                              to trust (Edge MUSC-07) — no threshold is ever invented from
 *                              too few data points
 *   ThresholdDerivation     — the result shape Task 2 writes into
 *                              `docs/RUZICKA-THRESHOLDS.md`: data-basis sizes, both
 *                              distributions as figures, the chosen values (or the
 *                              insufficient-data verdict), and whether the two classes overlap
 *
 * Hard boundaries (T-138-33, T-138-05): no filesystem import, no HTTP client, no database
 * driver, no write path anywhere in this module, and no console output (stdout is the
 * JSON-RPC channel — T-120-18). This is a pure, read-only, in-memory evaluation module: it
 * accepts already-loaded plain data and returns plain data. Reading that data off disk, if
 * the caller chose the local-snapshot-export path (Task 0), is the CALLER's job via
 * `file-channel.ts` — this module never touches the filesystem itself.
 *
 * Security (threat model):
 *   T-138-05: this module never decrypts anything, opens no connection, and reads no
 *             credential — a caller-supplied snapshot is a plain in-memory object.
 *   T-138-33: no write path exists in this file (grep-gated in the plan's `<verify>`).
 *   T-138-34: `chooseThresholds` refuses to invent a threshold when `positive.count` is
 *             below the caller-supplied `minPositiveCount` — it reports the shortfall
 *             instead (`sufficient: false`), so an under-powered result can never be
 *             mistaken for a calibrated one.
 *   T-138-35: only `buildMuscleVector`/`buildCombinedVector`/`ruzickaSimilarity`
 *             (imported from `training-state/muscle-similarity.ts`) compute vectors and
 *             similarity here — no second implementation of either.
 *
 * Patterns: src/training-state/adherence.ts (the production consumer this derivation
 *           mirrors), src/training-state/muscle-similarity.ts (the functions imported),
 *           138-CONTEXT.md D-11/D-19, 138-14-PLAN.md.
 */

import type { CatalogExercise } from '../types.js';
import {
  buildCombinedVector,
  ruzickaSimilarity,
  type MuscleHit,
} from '../training-state/muscle-similarity.js';

/**
 * D-17 (Phase 138.1, plan `138.1-22`) — the vector construction `buildLabelledPairs` uses,
 * injectable so the SAME pairing/labelling/rounds-multiplier logic can be run once with
 * `buildMuscleVector` (muscle groups only) and once with `buildCombinedVector` (muscle
 * groups PLUS capability axes) against the same snapshot. The derivation this parameter
 * enabled decided FOR the capability dimensions
 * (`.planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md`) — the
 * default is therefore `buildCombinedVector`, matching what `adherence.ts` now calls in
 * production. Passing `buildMuscleVector` explicitly still reproduces the pre-138.1-22
 * behavior exactly (proven by this file's test suite) for a future muscle-only comparison.
 * This is still exactly ONE similarity MEASURE (`ruzickaSimilarity`, unchanged) — only the
 * vector fed into it is swappable, per this file's own header warning against a second
 * implementation (T-138-35/T-138.1-55).
 */
type VectorBuilder = (hits: MuscleHit[], catalogById: Map<string, CatalogExercise>) => Map<string, number>;

// ---------------------------------------------------------------------------
// Input shapes — deliberately narrow (only the fields this module reads), so the SAME
// call works against a decrypted MCP snapshot (`lokaler-snapshot-export`) and against a
// `SELECT`-built JSON export from a frozen `pg_dump` copy (`pgdump-woertlich`) alike.
// ---------------------------------------------------------------------------

export interface LabelledPairsSessionInput {
  id: string;
  templateId?: string;
  deletedAt?: number;
}

export interface LabelledPairsSetLogInput {
  sessionId: string;
  exerciseId?: string;
  workoutExerciseId?: string;
  deletedAt?: number;
}

export interface LabelledPairsTemplateInput {
  id: string;
  deletedAt?: number;
}

/**
 * WR-01/MUSC-07 fix (138-15): `rounds` is the containing block's round count — the
 * multiplier `templateVectorFor` was previously missing entirely. A template exercise's
 * TRUE prescribed volume is `sets * (containing block).rounds`, never `sets` alone; see
 * `adherence.ts`'s `blockById` lookup, which this mirrors exactly (same production
 * consumer this derivation is meant to model).
 */
export interface LabelledPairsBlockInput {
  id: string;
  rounds: number;
  deletedAt?: number;
}

export interface LabelledPairsTemplateExerciseInput {
  id: string;
  templateId: string;
  exerciseId: string;
  sets: number;
  /** The containing block, if any. Absent → rounds defaults to 1 (no multiplier). */
  blockId?: string;
  deletedAt?: number;
}

export interface LabelledPairsSnapshot {
  sessions: LabelledPairsSessionInput[];
  setLogs: LabelledPairsSetLogInput[];
  templates: LabelledPairsTemplateInput[];
  templateExercises: LabelledPairsTemplateExerciseInput[];
  blocks: LabelledPairsBlockInput[];
}

// ---------------------------------------------------------------------------
// buildLabelledPairs — ground-truth construction (D-11)
// ---------------------------------------------------------------------------

/** One (session, template) comparison, labelled by whether the template is the session's own. */
export interface LabelledPair {
  sessionId: string;
  templateId: string;
  label: 'positive' | 'negative';
  sessionVector: Map<string, number>;
  templateVector: Map<string, number>;
}

export interface BuildLabelledPairsResult {
  pairs: LabelledPair[];
  /** Live (non-deleted) sessions considered at all. */
  totalSessions: number;
  /** Live sessions with a `templateId` that resolves to a live template — the ground truth. */
  sessionsWithTemplateId: number;
  /** Live sessions with no `templateId` at all — excluded, counted, never silently dropped. */
  sessionsWithoutTemplateId: number;
  /** Live sessions whose `templateId` points at a deleted or unknown template — excluded, counted. */
  sessionsWithUnresolvableTemplateId: number;
  /** Live templates considered as negative candidates. */
  templateCount: number;
}

/**
 * Builds the ground-truth (session, template) pairs: one POSITIVE pair per session with a
 * resolvable `templateId` (against its own template) and one NEGATIVE pair against every
 * OTHER live template. Deleted sessions, set-logs and template-exercises are excluded
 * throughout (see file header). A session without a `templateId`, or with one pointing at a
 * deleted/unknown template, produces no pair and is counted separately rather than dropped.
 */
export function buildLabelledPairs(
  snapshot: LabelledPairsSnapshot,
  catalog: CatalogExercise[],
  vectorBuilder: VectorBuilder = buildCombinedVector,
): BuildLabelledPairsResult {
  const catalogById = new Map(catalog.map((ex) => [ex.id, ex]));

  const liveTemplateIds = new Set(
    snapshot.templates.filter((t) => t.deletedAt === undefined).map((t) => t.id),
  );

  // WR-01/MUSC-07 (138-15): resolve each template-exercise's containing block to its
  // `rounds` count. A missing/unknown block falls back to 1 — no multiplier — which is
  // also the correct behavior for a template-exercise not part of any block.
  const blockById = new Map(snapshot.blocks.map((b) => [b.id, b]));
  function roundsFor(te: LabelledPairsTemplateExerciseInput): number {
    if (te.blockId === undefined) return 1;
    return blockById.get(te.blockId)?.rounds ?? 1;
  }

  const liveTemplateExercisesByTemplateId = new Map<string, { exerciseId: string; sets: number }[]>();
  for (const te of snapshot.templateExercises) {
    if (te.deletedAt !== undefined) continue;
    if (!liveTemplateIds.has(te.templateId)) continue;
    const list = liveTemplateExercisesByTemplateId.get(te.templateId) ?? [];
    // The TRUE prescribed volume is sets * rounds — a rounds:3 block's sets:1 row means
    // the exercise is actually performed 3 times per template, not once (WR-01/MUSC-07).
    list.push({ exerciseId: te.exerciseId, sets: te.sets * roundsFor(te) });
    liveTemplateExercisesByTemplateId.set(te.templateId, list);
  }

  const templateVectorCache = new Map<string, Map<string, number>>();
  function templateVectorFor(templateId: string): Map<string, number> {
    const cached = templateVectorCache.get(templateId);
    if (cached) return cached;
    const hits: MuscleHit[] = (liveTemplateExercisesByTemplateId.get(templateId) ?? []).map((te) => ({
      exerciseId: te.exerciseId,
      setCount: te.sets,
    }));
    const vector = vectorBuilder(hits, catalogById);
    templateVectorCache.set(templateId, vector);
    return vector;
  }

  const liveTemplateExerciseById = new Map(
    snapshot.templateExercises.filter((te) => te.deletedAt === undefined).map((te) => [te.id, te]),
  );

  const setLogsBySessionId = new Map<string, LabelledPairsSetLogInput[]>();
  for (const setLog of snapshot.setLogs) {
    if (setLog.deletedAt !== undefined) continue;
    const list = setLogsBySessionId.get(setLog.sessionId) ?? [];
    list.push(setLog);
    setLogsBySessionId.set(setLog.sessionId, list);
  }

  function sessionVectorFor(sessionId: string): Map<string, number> {
    const hits: MuscleHit[] = [];
    for (const setLog of setLogsBySessionId.get(sessionId) ?? []) {
      const exerciseId =
        setLog.exerciseId ??
        (setLog.workoutExerciseId !== undefined
          ? liveTemplateExerciseById.get(setLog.workoutExerciseId)?.exerciseId
          : undefined);
      if (exerciseId === undefined) continue;
      hits.push({ exerciseId, setCount: 1 });
    }
    return vectorBuilder(hits, catalogById);
  }

  const templateIds = [...liveTemplateIds];
  const liveSessions = snapshot.sessions.filter((s) => s.deletedAt === undefined);

  let sessionsWithTemplateId = 0;
  let sessionsWithoutTemplateId = 0;
  let sessionsWithUnresolvableTemplateId = 0;
  const pairs: LabelledPair[] = [];

  for (const session of liveSessions) {
    if (session.templateId === undefined) {
      sessionsWithoutTemplateId++;
      continue;
    }
    if (!liveTemplateIds.has(session.templateId)) {
      sessionsWithUnresolvableTemplateId++;
      continue;
    }
    sessionsWithTemplateId++;
    const sessionVector = sessionVectorFor(session.id);
    for (const templateId of templateIds) {
      pairs.push({
        sessionId: session.id,
        templateId,
        label: templateId === session.templateId ? 'positive' : 'negative',
        sessionVector,
        templateVector: templateVectorFor(templateId),
      });
    }
  }

  return {
    pairs,
    totalSessions: liveSessions.length,
    sessionsWithTemplateId,
    sessionsWithoutTemplateId,
    sessionsWithUnresolvableTemplateId,
    templateCount: templateIds.length,
  };
}

// ---------------------------------------------------------------------------
// similarityDistribution
// ---------------------------------------------------------------------------

export interface ClassDistribution {
  count: number;
  /** Ascending-sorted similarity values. */
  values: number[];
  median: number;
  q1: number;
  q3: number;
}

export interface SimilarityDistributionResult {
  positive: ClassDistribution;
  negative: ClassDistribution;
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.round(p * (sortedAscending.length - 1))),
  );
  return sortedAscending[idx];
}

function summarize(values: number[]): ClassDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    values: sorted,
    median: percentile(sorted, 0.5),
    q1: percentile(sorted, 0.25),
    q3: percentile(sorted, 0.75),
  };
}

/** Applies `ruzickaSimilarity` to every pair and buckets the results by class. */
export function similarityDistribution(pairs: LabelledPair[]): SimilarityDistributionResult {
  const positiveValues: number[] = [];
  const negativeValues: number[] = [];
  for (const pair of pairs) {
    const similarity = ruzickaSimilarity(pair.sessionVector, pair.templateVector);
    (pair.label === 'positive' ? positiveValues : negativeValues).push(similarity);
  }
  return { positive: summarize(positiveValues), negative: summarize(negativeValues) };
}

// ---------------------------------------------------------------------------
// chooseThresholds
// ---------------------------------------------------------------------------

export interface ChooseThresholdsOptions {
  /** Positive pairs below this count make any derived threshold untrustworthy (Edge MUSC-07). */
  minPositiveCount: number;
  /**
   * How much heavier a false MATCH weighs than a missed one, when the two distributions
   * overlap and no single cut separates them cleanly (see file header — the asymmetry is
   * the whole point of this parameter). Must be > 1 to express "costs more than a miss".
   */
  falsePositivePenalty: number;
}

export type ThresholdChoiceResult =
  | {
      sufficient: true;
      matchThreshold: number;
      uncertainThreshold: number;
      /** Whether the smallest positive value falls at/under the largest negative value. */
      overlap: boolean;
      metrics: {
        matchTruePositiveRate: number;
        matchFalsePositiveRate: number;
        uncertainTruePositiveRate: number;
        uncertainFalsePositiveRate: number;
      };
    }
  | { sufficient: false; positiveCount: number; minPositiveCount: number };

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function truePositiveRate(positiveValues: number[], threshold: number): number {
  if (positiveValues.length === 0) return 0;
  return positiveValues.filter((v) => v >= threshold).length / positiveValues.length;
}

function falsePositiveRate(negativeValues: number[], threshold: number): number {
  if (negativeValues.length === 0) return 0;
  return negativeValues.filter((v) => v >= threshold).length / negativeValues.length;
}

/** Picks the candidate threshold maximizing TPR - penalty*FPR (the asymmetric target). */
function bestThreshold(
  candidates: number[],
  positiveValues: number[],
  negativeValues: number[],
  penalty: number,
): number {
  let best = candidates[0] ?? 0;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = truePositiveRate(positiveValues, c) - penalty * falsePositiveRate(negativeValues, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Chooses `matchThreshold` and `uncertainThreshold` from a similarity distribution.
 *
 * - Too few positive pairs (`positive.count < options.minPositiveCount`): returns
 *   `{ sufficient: false, positiveCount, minPositiveCount }` — no value is invented from an
 *   under-powered sample (Edge MUSC-07, T-138-34).
 * - Clearly separated classes (`max(negative) < min(positive)`): `matchThreshold` is the
 *   midpoint between them — strictly above the largest negative value and strictly below
 *   the smallest positive one, with margin rather than the tightest possible bound so a
 *   single future data point near either edge does not immediately flip the classification.
 *   `uncertainThreshold` sits at the midpoint between the negative median (0 if there are no
 *   negatives) and `matchThreshold` — a generous recall floor, safe because 'uncertain' is
 *   never treated as a confirmed match downstream (`classifySimilarity`, D-23).
 * - Overlapping classes: both thresholds are chosen by searching every OBSERVED similarity
 *   value for the one maximizing TPR minus a false-positive penalty — the full penalty for
 *   `matchThreshold`, half of it for `uncertainThreshold` (see file header for why the two
 *   tiers tolerate different amounts of false-positive risk). `overlap: true` is reported so
 *   the caller (and `docs/RUZICKA-THRESHOLDS.md`) can show the cost of the chosen cut rather
 *   than imply the two classes were cleanly separable.
 */
export function chooseThresholds(
  distribution: SimilarityDistributionResult,
  options: ChooseThresholdsOptions,
): ThresholdChoiceResult {
  const { positive, negative } = distribution;

  if (positive.count < options.minPositiveCount) {
    return { sufficient: false, positiveCount: positive.count, minPositiveCount: options.minPositiveCount };
  }

  const posMin = positive.values[0];
  const negMax = negative.count > 0 ? negative.values[negative.count - 1] : undefined;
  const overlap = negMax !== undefined && negMax >= posMin;

  let matchThreshold: number;
  let uncertainThreshold: number;

  if (!overlap) {
    const floor = negMax ?? 0;
    matchThreshold = clamp01((floor + posMin) / 2);
    const uncertainFloor = negative.count > 0 ? negative.median : 0;
    uncertainThreshold = clamp01((uncertainFloor + matchThreshold) / 2);
  } else {
    const candidates = [...new Set([0, 1, ...positive.values, ...negative.values])].sort((a, b) => a - b);
    matchThreshold = bestThreshold(candidates, positive.values, negative.values, options.falsePositivePenalty);
    const lowerCandidates = candidates.filter((c) => c < matchThreshold);
    uncertainThreshold =
      lowerCandidates.length > 0
        ? bestThreshold(lowerCandidates, positive.values, negative.values, options.falsePositivePenalty / 2)
        : clamp01(matchThreshold / 2);
  }

  // Threshold invariant (coach-parameters.ts, D-23): uncertainThreshold must stay strictly
  // below matchThreshold. Guards the degenerate case where the searches above still tie.
  if (uncertainThreshold >= matchThreshold) {
    uncertainThreshold = clamp01(matchThreshold / 2);
  }

  return {
    sufficient: true,
    matchThreshold,
    uncertainThreshold,
    overlap,
    metrics: {
      matchTruePositiveRate: truePositiveRate(positive.values, matchThreshold),
      matchFalsePositiveRate: falsePositiveRate(negative.values, matchThreshold),
      uncertainTruePositiveRate: truePositiveRate(positive.values, uncertainThreshold),
      uncertainFalsePositiveRate: falsePositiveRate(negative.values, uncertainThreshold),
    },
  };
}

// ---------------------------------------------------------------------------
// ThresholdDerivation — the shape Task 2 writes into docs/RUZICKA-THRESHOLDS.md
// ---------------------------------------------------------------------------

/**
 * The full derivation result: data-basis sizes, both distributions as figures, and the
 * chosen thresholds (or the insufficient-data verdict). Contains ONLY counts, ids and
 * computed numbers — no exercise names, session names, timestamps or user identifiers ever
 * flow into this shape, because none of `buildLabelledPairs`/`similarityDistribution`/
 * `chooseThresholds` read or forward any such field to begin with.
 */
export interface ThresholdDerivation {
  dataBasis: {
    totalSessions: number;
    sessionsWithTemplateId: number;
    sessionsWithoutTemplateId: number;
    sessionsWithUnresolvableTemplateId: number;
    templateCount: number;
    positivePairCount: number;
    negativePairCount: number;
  };
  distribution: SimilarityDistributionResult;
  result: ThresholdChoiceResult;
}
