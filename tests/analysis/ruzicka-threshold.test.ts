/**
 * Tests for the permanent Ruzicka-threshold derivation tool (Phase 138, Plan 14, MUSC-07).
 * Exclusively synthetic fixtures — never real training data, per the plan's own instruction.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLabelledPairs,
  similarityDistribution,
  chooseThresholds,
  type LabelledPairsSnapshot,
  type BuildLabelledPairsResult,
} from '../../src/analysis/ruzicka-threshold.js';
import { buildMuscleVector, buildCombinedVector } from '../../src/training-state/muscle-similarity.js';
import type { CatalogExercise } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared synthetic catalog — three single-muscle exercises, all PRIMARY so the
// weighting factor is always 1.0 and vector arithmetic stays easy to hand-check.
// ---------------------------------------------------------------------------

function catalogExercise(id: string, muscleKey: string): CatalogExercise {
  return {
    id,
    key: id,
    nameEn: id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 0,
    translations: [],
    equipment: [],
    muscleGroups: [
      {
        id: `mg-${muscleKey}`,
        key: muscleKey,
        translations: [],
        involvementLevel: 'PRIMARY',
      },
    ],
    capabilities: [],
    origin: 'CATALOG',
  };
}

const EX_A = catalogExercise('ex-A', 'm1');
const EX_B = catalogExercise('ex-B', 'm2');
const EX_C = catalogExercise('ex-C', 'm3');
const catalog: CatalogExercise[] = [EX_A, EX_B, EX_C];

// ---------------------------------------------------------------------------
// buildLabelledPairs
// ---------------------------------------------------------------------------

describe('buildLabelledPairs', () => {
  function baseSnapshot(): LabelledPairsSnapshot {
    return {
      templates: [
        { id: 'template-1' },
        { id: 'template-2' },
        { id: 'template-deleted', deletedAt: 1_000 },
      ],
      blocks: [],
      templateExercises: [
        { id: 'te-1', templateId: 'template-1', exerciseId: 'ex-A', sets: 3 },
        { id: 'te-2', templateId: 'template-1', exerciseId: 'ex-B', sets: 3 },
        { id: 'te-3', templateId: 'template-2', exerciseId: 'ex-C', sets: 5 },
        // Deleted template-exercise on a LIVE template — must not contribute to the vector.
        { id: 'te-4', templateId: 'template-1', exerciseId: 'ex-C', sets: 99, deletedAt: 2_000 },
      ],
      sessions: [
        { id: 'session-1', templateId: 'template-1' },
        { id: 'session-2', templateId: 'template-2' },
        { id: 'session-3' }, // no templateId at all
        { id: 'session-4', templateId: 'template-deleted' }, // unresolvable
        { id: 'session-5', templateId: 'template-1', deletedAt: 3_000 }, // soft-deleted session
      ],
      setLogs: [
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
        { sessionId: 'session-2', exerciseId: 'ex-C' },
        { sessionId: 'session-2', exerciseId: 'ex-C' },
        { sessionId: 'session-2', exerciseId: 'ex-C' },
        { sessionId: 'session-2', exerciseId: 'ex-C' },
        { sessionId: 'session-2', exerciseId: 'ex-C' },
        // Deleted set-log — must not contribute.
        { sessionId: 'session-1', exerciseId: 'ex-C', deletedAt: 4_000 },
      ],
    };
  }

  it('counts live sessions and excludes soft-deleted ones from every bucket', () => {
    const result = buildLabelledPairs(baseSnapshot(), catalog);
    // session-5 is soft-deleted and must not appear anywhere.
    expect(result.totalSessions).toBe(4);
  });

  it('builds exactly one positive pair and one negative pair per session with a resolvable templateId', () => {
    const result = buildLabelledPairs(baseSnapshot(), catalog);
    expect(result.sessionsWithTemplateId).toBe(2); // session-1, session-2
    expect(result.templateCount).toBe(2); // template-deleted excluded
    expect(result.pairs).toHaveLength(4); // 2 sessions * 2 live templates

    const positives = result.pairs.filter((p) => p.label === 'positive');
    const negatives = result.pairs.filter((p) => p.label === 'negative');
    expect(positives).toHaveLength(2);
    expect(negatives).toHaveLength(2);

    const s1Positive = positives.find((p) => p.sessionId === 'session-1');
    expect(s1Positive?.templateId).toBe('template-1');
    const s2Positive = positives.find((p) => p.sessionId === 'session-2');
    expect(s2Positive?.templateId).toBe('template-2');
  });

  it('produces no pair for a session without a templateId, but counts it', () => {
    const result = buildLabelledPairs(baseSnapshot(), catalog);
    expect(result.sessionsWithoutTemplateId).toBe(1); // session-3
    expect(result.pairs.some((p) => p.sessionId === 'session-3')).toBe(false);
  });

  it('produces no pair for a session whose templateId points at a deleted template, but counts it', () => {
    const result = buildLabelledPairs(baseSnapshot(), catalog);
    expect(result.sessionsWithUnresolvableTemplateId).toBe(1); // session-4
    expect(result.pairs.some((p) => p.sessionId === 'session-4')).toBe(false);
  });

  it('excludes deleted template-exercises and deleted set-logs from vector construction', () => {
    const result = buildLabelledPairs(baseSnapshot(), catalog);
    const template1Vector = result.pairs.find(
      (p) => p.sessionId === 'session-1' && p.templateId === 'template-1',
    )!.templateVector;
    // te-4 (ex-C, sets:99, deleted) must not appear in template-1's vector.
    expect(template1Vector.get('m3')).toBeUndefined();
    expect(template1Vector.get('m1')).toBe(3);
    expect(template1Vector.get('m2')).toBe(3);

    const session1Vector = result.pairs.find(
      (p) => p.sessionId === 'session-1' && p.templateId === 'template-1',
    )!.sessionVector;
    // The deleted set-log (ex-C) must not appear in session-1's vector.
    expect(session1Vector.get('m3')).toBeUndefined();
  });

  it('resolves an exerciseId via workoutExerciseId when exerciseId is absent on the set-log', () => {
    const snapshot: LabelledPairsSnapshot = {
      templates: [{ id: 'template-1' }],
      blocks: [],
      templateExercises: [{ id: 'te-1', templateId: 'template-1', exerciseId: 'ex-A', sets: 2 }],
      sessions: [{ id: 'session-1', templateId: 'template-1' }],
      setLogs: [
        { sessionId: 'session-1', workoutExerciseId: 'te-1' },
        { sessionId: 'session-1', workoutExerciseId: 'te-1' },
      ],
    };
    const result = buildLabelledPairs(snapshot, catalog);
    const pair = result.pairs.find((p) => p.sessionId === 'session-1' && p.templateId === 'template-1')!;
    expect(pair.sessionVector.get('m1')).toBe(2);
    expect(pair.label).toBe('positive');
  });

  // -------------------------------------------------------------------------
  // WR-01 / MUSC-07 regression (138-15): templateVectorFor must multiply
  // templateExercise.sets by the containing block's rounds, not use sets alone.
  // This is the exact bug 138-14's own plausibility-floor check found: an
  // unchanged "A - KB Kraft" session scored 0.153 against its own template
  // instead of ~1.0, because a 3-round circuit block's sets:1 rows were
  // counted as 1 set instead of 3. Proven against the pre-fix code (no rounds
  // multiplier existed at all): this test failed with templateVector.get('m1')
  // === 1, not 3, before the fix below was applied.
  // -------------------------------------------------------------------------

  it('WR-01/MUSC-07 regression: multiplies templateExercise.sets by the containing block rounds, not sets alone', () => {
    const snapshot: LabelledPairsSnapshot = {
      templates: [{ id: 'template-1' }],
      blocks: [{ id: 'block-1', rounds: 3 }],
      templateExercises: [
        { id: 'te-1', templateId: 'template-1', blockId: 'block-1', exerciseId: 'ex-A', sets: 1 },
      ],
      sessions: [{ id: 'session-1', templateId: 'template-1' }],
      setLogs: [],
    };
    const result = buildLabelledPairs(snapshot, catalog);
    const pair = result.pairs.find((p) => p.sessionId === 'session-1' && p.templateId === 'template-1')!;
    // sets(1) * block.rounds(3) = 3, weight PRIMARY = 1.0 → m1: 3, NOT 1 (the pre-fix value).
    expect(pair.templateVector.get('m1')).toBe(3);
  });

  it('a template exercise with no blockId is unaffected — rounds defaults to 1', () => {
    const snapshot: LabelledPairsSnapshot = {
      templates: [{ id: 'template-1' }],
      blocks: [],
      templateExercises: [{ id: 'te-1', templateId: 'template-1', exerciseId: 'ex-A', sets: 5 }],
      sessions: [{ id: 'session-1', templateId: 'template-1' }],
      setLogs: [],
    };
    const result = buildLabelledPairs(snapshot, catalog);
    const pair = result.pairs.find((p) => p.sessionId === 'session-1' && p.templateId === 'template-1')!;
    expect(pair.templateVector.get('m1')).toBe(5);
  });

  it('a templateExercise whose blockId points at an unknown block falls back to rounds 1', () => {
    const snapshot: LabelledPairsSnapshot = {
      templates: [{ id: 'template-1' }],
      blocks: [],
      templateExercises: [
        { id: 'te-1', templateId: 'template-1', blockId: 'block-missing', exerciseId: 'ex-A', sets: 4 },
      ],
      sessions: [{ id: 'session-1', templateId: 'template-1' }],
      setLogs: [],
    };
    const result = buildLabelledPairs(snapshot, catalog);
    const pair = result.pairs.find((p) => p.sessionId === 'session-1' && p.templateId === 'template-1')!;
    expect(pair.templateVector.get('m1')).toBe(4);
  });

  it('the result contains only ids and numbers — no name/description fields ever appear', () => {
    const result = buildLabelledPairs(baseSnapshot(), catalog);
    const serialized = JSON.stringify(result, (_key, value) => (value instanceof Map ? [...value] : value));
    expect(serialized).not.toMatch(/nameEn|nameDe|description|translations/i);
  });

  // -------------------------------------------------------------------------
  // D-17 (Phase 138.1, plan 138.1-22) — injectable vectorBuilder
  // -------------------------------------------------------------------------

  it('the default vectorBuilder is buildCombinedVector (D-17 adoption) — omitting it matches passing buildCombinedVector explicitly', () => {
    const explicit = buildLabelledPairs(baseSnapshot(), catalog, buildCombinedVector);
    const omitted = buildLabelledPairs(baseSnapshot(), catalog);
    const serialize = (r: BuildLabelledPairsResult) =>
      JSON.stringify(r, (_key, value) => (value instanceof Map ? [...value] : value));
    expect(serialize(omitted)).toBe(serialize(explicit));
  });

  it('on a catalog with no capability data, the default (buildCombinedVector) still matches the pre-138.1-22 buildMuscleVector-only output', () => {
    // The shared `catalog` fixture carries `capabilities: []` on every exercise — proves the
    // D-17 adoption is additive for callers/fixtures that never touch capabilities at all.
    const muscleOnlyExplicit = buildLabelledPairs(baseSnapshot(), catalog, buildMuscleVector);
    const omittedDefault = buildLabelledPairs(baseSnapshot(), catalog);
    const serialize = (r: BuildLabelledPairsResult) =>
      JSON.stringify(r, (_key, value) => (value instanceof Map ? [...value] : value));
    expect(serialize(omittedDefault)).toBe(serialize(muscleOnlyExplicit));
  });

  it('passing buildCombinedVector as vectorBuilder folds in capability-axis dimensions on the SAME pairing logic', () => {
    const catalogWithCapability: CatalogExercise[] = [
      {
        ...EX_A,
        capabilities: [{ id: 'axis-balance', key: 'balance', translations: [], capabilityLevel: 'HAUPTREIZ' }],
      },
      EX_B,
      EX_C,
    ];
    const muscleOnly = buildLabelledPairs(baseSnapshot(), catalogWithCapability, buildMuscleVector);
    const combined = buildLabelledPairs(baseSnapshot(), catalogWithCapability, buildCombinedVector);

    // Same snapshot, same catalog ids → identical pair COUNT and labelling; only the vectors differ.
    expect(combined.pairs).toHaveLength(muscleOnly.pairs.length);
    expect(combined.sessionsWithTemplateId).toBe(muscleOnly.sessionsWithTemplateId);

    const muscleOnlyPair = muscleOnly.pairs.find(
      (p) => p.sessionId === 'session-1' && p.templateId === 'template-1',
    )!;
    const combinedPair = combined.pairs.find(
      (p) => p.sessionId === 'session-1' && p.templateId === 'template-1',
    )!;
    // ex-A carries the capability now — its vector must gain a dimension the muscle-only run
    // never has, while the muscle dimension itself (m1) stays identical.
    expect(muscleOnlyPair.sessionVector.get('m1')).toBe(combinedPair.sessionVector.get('m1'));
    expect(combinedPair.sessionVector.size).toBeGreaterThan(muscleOnlyPair.sessionVector.size);
  });
});

// ---------------------------------------------------------------------------
// similarityDistribution
// ---------------------------------------------------------------------------

describe('similarityDistribution', () => {
  it('splits pairs into a sorted positive and negative distribution with count/median/quartiles', () => {
    const pairs = [
      { sessionId: 's1', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m1', 1]]) }, // 1.0
      { sessionId: 's2', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m1', 2]]) }, // 0.5
      { sessionId: 's1', templateId: 't2', label: 'negative' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m2', 1]]) }, // 0
      { sessionId: 's2', templateId: 't2', label: 'negative' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m2', 1]]) }, // 0
    ];
    const dist = similarityDistribution(pairs);
    expect(dist.positive.count).toBe(2);
    expect(dist.positive.values).toEqual([0.5, 1]);
    expect(dist.positive.median).toBeGreaterThanOrEqual(0.5);
    expect(dist.negative.count).toBe(2);
    expect(dist.negative.values).toEqual([0, 0]);
    expect(dist.negative.median).toBe(0);
    expect(dist.negative.q1).toBe(0);
    expect(dist.negative.q3).toBe(0);
  });

  it('returns count 0 and no crash for an empty class', () => {
    const dist = similarityDistribution([]);
    expect(dist.positive.count).toBe(0);
    expect(dist.positive.values).toEqual([]);
    expect(dist.negative.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chooseThresholds
// ---------------------------------------------------------------------------

describe('chooseThresholds', () => {
  it('reports sufficient:false with the actual positive count when below the minimum', () => {
    const distribution = similarityDistribution([
      { sessionId: 's1', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m1', 1]]) },
    ]);
    const result = chooseThresholds(distribution, { minPositiveCount: 5, falsePositivePenalty: 2 });
    expect(result.sufficient).toBe(false);
    if (!result.sufficient) {
      expect(result.positiveCount).toBe(1);
      expect(result.minPositiveCount).toBe(5);
    }
  });

  it('picks a matchThreshold strictly between the largest negative and smallest positive value when classes are clearly separated', () => {
    const distribution = similarityDistribution([
      { sessionId: 's1', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 3], ['m2', 3]]), templateVector: new Map([['m1', 3], ['m2', 3]]) }, // 1.0
      { sessionId: 's2', templateId: 't2', label: 'positive' as const, sessionVector: new Map([['m3', 5]]), templateVector: new Map([['m3', 5]]) }, // 1.0
      { sessionId: 's1', templateId: 't2', label: 'negative' as const, sessionVector: new Map([['m1', 3], ['m2', 3]]), templateVector: new Map([['m3', 5]]) }, // 0
      { sessionId: 's2', templateId: 't1', label: 'negative' as const, sessionVector: new Map([['m3', 5]]), templateVector: new Map([['m1', 3], ['m2', 3]]) }, // 0
    ]);
    const result = chooseThresholds(distribution, { minPositiveCount: 2, falsePositivePenalty: 2 });
    expect(result.sufficient).toBe(true);
    if (result.sufficient) {
      expect(result.overlap).toBe(false);
      expect(result.matchThreshold).toBeGreaterThan(0);
      expect(result.matchThreshold).toBeLessThan(1);
      expect(result.uncertainThreshold).toBeLessThan(result.matchThreshold);
      expect(result.uncertainThreshold).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports overlap:true and still returns valid, ordered thresholds when the distributions overlap', () => {
    // Positive values [0, 0.75, 0.75], negative values [0.4, 0.4, 0.5] — min(positive)=0 <= max(negative)=0.5.
    const distribution = similarityDistribution([
      { sessionId: 's1', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 2], ['m2', 1]]), templateVector: new Map([['m1', 2], ['m2', 2]]) }, // 0.75
      { sessionId: 's1', templateId: 't2', label: 'negative' as const, sessionVector: new Map([['m1', 2], ['m2', 1]]), templateVector: new Map([['m1', 2], ['m3', 2]]) }, // 0.4
      { sessionId: 's2', templateId: 't2', label: 'positive' as const, sessionVector: new Map([['m1', 2], ['m3', 1]]), templateVector: new Map([['m1', 2], ['m3', 2]]) }, // 0.75
      { sessionId: 's2', templateId: 't1', label: 'negative' as const, sessionVector: new Map([['m1', 2], ['m3', 1]]), templateVector: new Map([['m1', 2], ['m2', 2]]) }, // 0.4
      { sessionId: 's3', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m3', 2]]), templateVector: new Map([['m1', 2], ['m2', 2]]) }, // 0
      { sessionId: 's3', templateId: 't2', label: 'negative' as const, sessionVector: new Map([['m3', 2]]), templateVector: new Map([['m1', 2], ['m3', 2]]) }, // 0.5
    ]);
    expect(distribution.positive.values[0]).toBe(0);
    expect(distribution.negative.values[distribution.negative.count - 1]).toBeCloseTo(0.5);

    const result = chooseThresholds(distribution, { minPositiveCount: 2, falsePositivePenalty: 2 });
    expect(result.sufficient).toBe(true);
    if (result.sufficient) {
      expect(result.overlap).toBe(true);
      expect(result.matchThreshold).toBeGreaterThanOrEqual(0);
      expect(result.matchThreshold).toBeLessThanOrEqual(1);
      expect(result.uncertainThreshold).toBeLessThan(result.matchThreshold);
    }
  });

  it('never returns an uncertainThreshold >= matchThreshold (D-23 invariant)', () => {
    const distribution = similarityDistribution([
      { sessionId: 's1', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m1', 1]]) },
      { sessionId: 's2', templateId: 't1', label: 'positive' as const, sessionVector: new Map([['m1', 1]]), templateVector: new Map([['m1', 1]]) },
    ]);
    const result = chooseThresholds(distribution, { minPositiveCount: 2, falsePositivePenalty: 2 });
    expect(result.sufficient).toBe(true);
    if (result.sufficient) {
      expect(result.uncertainThreshold).toBeLessThan(result.matchThreshold);
    }
  });
});
