/**
 * muscle-similarity.ts unit tests (Phase 137, D-21; Phase 138, MUSC-06).
 *
 * Covers buildMuscleVector's catalog resolution AND weighting (Phase 138 — weightFor
 * applied per muscle-group hit), ruzickaSimilarity's formula properties (identity,
 * disjointness, the empty-vector no-NaN guard, and the magnitude-sensitivity case D-21
 * exists to fix — including that the formula itself is weighting-agnostic), and
 * classifySimilarity's inclusive boundary behavior with caller-supplied thresholds.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMuscleVector,
  buildCombinedVector,
  ruzickaSimilarity,
  classifySimilarity,
  type MuscleHit,
} from '../../src/training-state/muscle-similarity.js';
import { normalizeCatalog } from '../../src/cache.js';
import type {
  CatalogExercise,
  CatalogCapabilityAxis,
  MuscleInvolvementLevel,
  CapabilityInvolvementLevel,
} from '../../src/types.js';

function buildExercise(
  id: string,
  muscleKeys: Array<string | [string, MuscleInvolvementLevel]>,
  capabilities: Array<[string, CapabilityInvolvementLevel]> = [],
): CatalogExercise {
  return {
    id,
    key: id,
    nameEn: id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [],
    muscleGroups: muscleKeys.map((entry, i) => {
      const [key, involvementLevel] = Array.isArray(entry) ? entry : [entry, 'PRIMARY' as const];
      return {
        id: `${id}-mg-${i}`,
        key,
        translations: [],
        involvementLevel,
      };
    }),
    equipment: [],
    capabilities: capabilities.map(
      ([key, capabilityLevel], i): CatalogCapabilityAxis => ({
        id: `${id}-cap-${i}`,
        key,
        translations: [],
        capabilityLevel,
      }),
    ),
    origin: 'CATALOG',
  };
}

const EX_THREE = buildExercise('ex-three', ['chest', 'triceps', 'shoulders']);
const EX_BACK = buildExercise('ex-back', ['back', 'lats']);

function catalogMap(...exercises: CatalogExercise[]): Map<string, CatalogExercise> {
  return new Map(exercises.map((ex) => [ex.id, ex]));
}

// ---------------------------------------------------------------------------
// buildMuscleVector
// ---------------------------------------------------------------------------

describe('buildMuscleVector', () => {
  it('an exercise hitting three muscles with two sets contributes 2 to each of the three keys', () => {
    const hits: MuscleHit[] = [{ exerciseId: 'ex-three', setCount: 2 }];
    const vector = buildMuscleVector(hits, catalogMap(EX_THREE));
    expect(vector.get('chest')).toBe(2);
    expect(vector.get('triceps')).toBe(2);
    expect(vector.get('shoulders')).toBe(2);
    expect(vector.size).toBe(3);
  });

  it('an exercise not present in the catalog contributes nothing and raises no error', () => {
    const hits: MuscleHit[] = [{ exerciseId: 'unknown-exercise', setCount: 5 }];
    const vector = buildMuscleVector(hits, catalogMap(EX_THREE));
    expect(vector.size).toBe(0);
  });

  it('two exercises with overlapping muscles sum per key', () => {
    const overlapping = buildExercise('ex-overlap', ['chest', 'back']);
    const hits: MuscleHit[] = [
      { exerciseId: 'ex-three', setCount: 1 },
      { exerciseId: 'ex-overlap', setCount: 1 },
    ];
    const vector = buildMuscleVector(hits, catalogMap(EX_THREE, overlapping));
    expect(vector.get('chest')).toBe(2);
    expect(vector.get('back')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Phase 138 (MUSC-06) — weighted vector construction
  // -------------------------------------------------------------------------

  it('a PRIMARY + SECONDARY exercise hit with setCount 4 yields { chest: 4, triceps: 2 }', () => {
    const exercise = buildExercise('ex-primary-secondary', [
      ['chest', 'PRIMARY'],
      ['triceps', 'SECONDARY'],
    ]);
    const hits: MuscleHit[] = [{ exerciseId: 'ex-primary-secondary', setCount: 4 }];
    const vector = buildMuscleVector(hits, catalogMap(exercise));
    expect(vector.get('chest')).toBe(4);
    expect(vector.get('triceps')).toBe(2);
  });

  it('adding a STABILIZER group to the same exercise additionally yields { abs: 1 }', () => {
    const exercise = buildExercise('ex-with-stabilizer', [
      ['chest', 'PRIMARY'],
      ['triceps', 'SECONDARY'],
      ['abs', 'STABILIZER'],
    ]);
    const hits: MuscleHit[] = [{ exerciseId: 'ex-with-stabilizer', setCount: 4 }];
    const vector = buildMuscleVector(hits, catalogMap(exercise));
    expect(vector.get('chest')).toBe(4);
    expect(vector.get('triceps')).toBe(2);
    expect(vector.get('abs')).toBe(1);
  });

  it('a catalog entry whose groups are all PRIMARY yields exactly the unweighted vector (backward-compat case, D-03)', () => {
    const hits: MuscleHit[] = [{ exerciseId: 'ex-three', setCount: 2 }];
    const vector = buildMuscleVector(hits, catalogMap(EX_THREE));
    expect(vector.get('chest')).toBe(2);
    expect(vector.get('triceps')).toBe(2);
    expect(vector.get('shoulders')).toBe(2);
  });

  it('two hits on the same muscle group from different exercises sum, each with its own factor', () => {
    const primaryChest = buildExercise('ex-chest-primary', [['chest', 'PRIMARY']]);
    const secondaryChest = buildExercise('ex-chest-secondary', [['chest', 'SECONDARY']]);
    const hits: MuscleHit[] = [
      { exerciseId: 'ex-chest-primary', setCount: 2 }, // 2 * 1.0 = 2
      { exerciseId: 'ex-chest-secondary', setCount: 4 }, // 4 * 0.5 = 2
    ];
    const vector = buildMuscleVector(hits, catalogMap(primaryChest, secondaryChest));
    expect(vector.get('chest')).toBe(4);
  });

  it('an exercise not present in the catalog still contributes nothing and does not throw when other hits are weighted', () => {
    const secondaryChest = buildExercise('ex-chest-secondary', [['chest', 'SECONDARY']]);
    const hits: MuscleHit[] = [
      { exerciseId: 'unknown-exercise', setCount: 5 },
      { exerciseId: 'ex-chest-secondary', setCount: 2 },
    ];
    expect(() => buildMuscleVector(hits, catalogMap(secondaryChest))).not.toThrow();
    const vector = buildMuscleVector(hits, catalogMap(secondaryChest));
    expect(vector.size).toBe(1);
    expect(vector.get('chest')).toBe(1);
  });

  it('ruzickaSimilarity over two weighted vectors matches the same numbers built unweighted — the formula itself knows nothing of levels', () => {
    const secondaryTriceps = buildExercise('ex-secondary-triceps', [['triceps', 'SECONDARY']]);
    // setCount 4 at SECONDARY (0.5) => vector value 2, same as an unweighted PRIMARY hit of setCount 2
    const weightedHits: MuscleHit[] = [{ exerciseId: 'ex-secondary-triceps', setCount: 4 }];
    const weightedVector = buildMuscleVector(weightedHits, catalogMap(secondaryTriceps));

    const unweightedEquivalent = new Map([['triceps', 2]]);
    const other = new Map([['triceps', 2]]);

    expect(ruzickaSimilarity(weightedVector, other)).toBe(
      ruzickaSimilarity(unweightedEquivalent, other),
    );
  });
});

// ---------------------------------------------------------------------------
// buildCombinedVector (Phase 138.1, D-17, plan 138.1-22)
// ---------------------------------------------------------------------------

describe('buildCombinedVector', () => {
  it('for a session without any capability assignment, returns the same vector as buildMuscleVector — additive extension', () => {
    const hits: MuscleHit[] = [{ exerciseId: 'ex-three', setCount: 2 }];
    const muscleOnly = buildMuscleVector(hits, catalogMap(EX_THREE));
    const combined = buildCombinedVector(hits, catalogMap(EX_THREE));
    expect(combined).toEqual(muscleOnly);
  });

  it('for a session with a capability assignment, the vector carries an additional dimension whose key never collides with a muscle-group key', () => {
    const withCapability = buildExercise('ex-with-balance', ['chest'], [['balance', 'HAUPTREIZ']]);
    const hits: MuscleHit[] = [{ exerciseId: 'ex-with-balance', setCount: 3 }];
    const combined = buildCombinedVector(hits, catalogMap(withCapability));
    expect(combined.get('chest')).toBe(3);
    const capabilityKeys = [...combined.keys()].filter((k) => k !== 'chest');
    expect(capabilityKeys).toHaveLength(1);
    // Whatever the exact prefix scheme is, it must never equal the bare axis key 'balance' —
    // that would be indistinguishable from a (hypothetical) muscle-group key of the same name.
    expect(capabilityKeys[0]).not.toBe('balance');
    expect(combined.get(capabilityKeys[0])).toBe(3);
  });

  it('capability dimensions are weighted by capability-balance.ts weightFor — HAUPTREIZ full credit, MITTRAINIERT half, GERING quarter, never a second factor set', () => {
    const exercise = buildExercise('ex-graded-capability', [], [
      ['balance', 'HAUPTREIZ'],
      ['coordination', 'MITTRAINIERT'],
      ['mobility', 'GERING'],
    ]);
    const hits: MuscleHit[] = [{ exerciseId: 'ex-graded-capability', setCount: 4 }];
    const combined = buildCombinedVector(hits, catalogMap(exercise));
    // Locate each dimension by which axis key it ends with, independent of the exact prefix.
    const balanceEntry = [...combined.entries()].find(([k]) => k.endsWith('balance'));
    const coordinationEntry = [...combined.entries()].find(([k]) => k.endsWith('coordination'));
    const mobilityEntry = [...combined.entries()].find(([k]) => k.endsWith('mobility'));
    expect(balanceEntry?.[1]).toBe(4); // 4 * 1.0
    expect(coordinationEntry?.[1]).toBe(2); // 4 * 0.5
    expect(mobilityEntry?.[1]).toBe(1); // 4 * 0.25
  });

  it('two sessions with identical muscles but different capability axes have LOWER similarity in the combined vector than in the pure muscle vector', () => {
    const sessionAExercise = buildExercise('ex-session-a', ['chest', 'triceps'], [['balance', 'HAUPTREIZ']]);
    const sessionBExercise = buildExercise('ex-session-b', ['chest', 'triceps'], [['power', 'HAUPTREIZ']]);
    const catalog = catalogMap(sessionAExercise, sessionBExercise);
    const hitsA: MuscleHit[] = [{ exerciseId: 'ex-session-a', setCount: 3 }];
    const hitsB: MuscleHit[] = [{ exerciseId: 'ex-session-b', setCount: 3 }];

    const muscleSimilarity = ruzickaSimilarity(buildMuscleVector(hitsA, catalog), buildMuscleVector(hitsB, catalog));
    const combinedSimilarity = ruzickaSimilarity(buildCombinedVector(hitsA, catalog), buildCombinedVector(hitsB, catalog));

    expect(muscleSimilarity).toBe(1); // identical muscle content
    expect(combinedSimilarity).toBeLessThan(muscleSimilarity);
  });

  it('two empty vectors yield a defined result instead of a division by zero — the pure-Breathhold case reachable since 138.1-15', () => {
    // An exercise with no muscle link at all (like Breathhold post-138.1-15) but a capability
    // axis: buildMuscleVector alone would produce two EMPTY vectors here (ruzickaSimilarity
    // returns 0 = 'none', wrongly, for two literally identical sessions — the finding 138.1-15
    // handed to this plan). buildCombinedVector must not reproduce that: the capability
    // dimension makes the vector non-empty, and two identical sessions score a defined 1.0.
    const breathlike = buildExercise('ex-breathlike', [], [['breath', 'HAUPTREIZ']]);
    const hits: MuscleHit[] = [{ exerciseId: 'ex-breathlike', setCount: 5 }];
    const catalog = catalogMap(breathlike);

    const muscleVectorA = buildMuscleVector(hits, catalog);
    const muscleVectorB = buildMuscleVector(hits, catalog);
    expect(muscleVectorA.size).toBe(0);
    expect(ruzickaSimilarity(muscleVectorA, muscleVectorB)).toBe(0); // the pre-existing, honest-but-unhelpful result

    const combinedVectorA = buildCombinedVector(hits, catalog);
    const combinedVectorB = buildCombinedVector(hits, catalog);
    expect(combinedVectorA.size).toBeGreaterThan(0);
    const result = ruzickaSimilarity(combinedVectorA, combinedVectorB);
    expect(result).toBe(1);
    expect(Number.isNaN(result)).toBe(false);

    // And two exercises with NEITHER muscles NOR capabilities still yield the pre-existing,
    // defined 0 — buildCombinedVector never manufactures a NaN or a false "perfect match"
    // out of genuinely empty content.
    const trulyEmpty = buildExercise('ex-truly-empty', [], []);
    const emptyHits: MuscleHit[] = [{ exerciseId: 'ex-truly-empty', setCount: 1 }];
    const emptyCatalog = catalogMap(trulyEmpty);
    const combinedEmptyA = buildCombinedVector(emptyHits, emptyCatalog);
    const combinedEmptyB = buildCombinedVector(emptyHits, emptyCatalog);
    expect(combinedEmptyA.size).toBe(0);
    const emptyResult = ruzickaSimilarity(combinedEmptyA, combinedEmptyB);
    expect(emptyResult).toBe(0);
    expect(Number.isNaN(emptyResult)).toBe(false);
  });

  it('the existing buildMuscleVector construction is unaffected by buildCombinedVector existing alongside it', () => {
    const hits: MuscleHit[] = [{ exerciseId: 'ex-three', setCount: 2 }];
    const vector = buildMuscleVector(hits, catalogMap(EX_THREE));
    expect(vector.get('chest')).toBe(2);
    expect(vector.get('triceps')).toBe(2);
    expect(vector.get('shoulders')).toBe(2);
    expect(vector.size).toBe(3);
  });

  // CAP-05 gap-closure (2026-09-06, WINDOWS.md #12): this is the sibling `adherence.ts`
  // consumer the ledger already tracked — `buildCombinedVector` iterates `exercise.capabilities`
  // unguarded (see this function's own source). Before `cache.ts`'s `normalizeCatalog()` seam
  // existed, a catalog entry sourced from the real wire (which OMITS `capabilities` entirely for
  // 75/189 live exercises) reaching this function via `adherence.ts` threw TypeError. Proves the
  // fetch-boundary fix (not a change to this file) closes it: normalize a genuinely
  // field-omitting wire entry through the real seam, then feed the result in here.
  it('does not throw when the catalog was normalized from wire data that omitted `capabilities` entirely (WINDOWS.md #12, adherence.ts sibling)', () => {
    const wireExercise = {
      id: 'ex-wire-omitted',
      key: 'ex-wire-omitted',
      nameEn: 'ex-wire-omitted',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      // capabilities/equipment/isSkill deliberately absent — the real wire shape.
    };
    const [normalized] = normalizeCatalog([wireExercise]);
    const hits: MuscleHit[] = [{ exerciseId: 'ex-wire-omitted', setCount: 1 }];

    expect(() => buildCombinedVector(hits, catalogMap(normalized))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ruzickaSimilarity
// ---------------------------------------------------------------------------

describe('ruzickaSimilarity', () => {
  it('is 1 for two identical vectors', () => {
    const a = new Map([['chest', 3], ['triceps', 2]]);
    const b = new Map([['chest', 3], ['triceps', 2]]);
    expect(ruzickaSimilarity(a, b)).toBe(1);
  });

  it('is 0 for two disjoint vectors', () => {
    const a = new Map([['chest', 3]]);
    const b = new Map([['quads', 3]]);
    expect(ruzickaSimilarity(a, b)).toBe(0);
  });

  it('is 0 for two empty vectors — no division by zero, no NaN', () => {
    const result = ruzickaSimilarity(new Map(), new Map());
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('is 0 when exactly one side is empty', () => {
    const a = new Map([['chest', 3]]);
    expect(ruzickaSimilarity(a, new Map())).toBe(0);
  });

  it(
    'D-21 magnitude case, with the research numbers: {chest:1,triceps:1,shoulders:1} vs ' +
      '{chest:6,triceps:6,shoulders:6} is 3/18 ≈ 0.167, NOT 1, and falls below the default uncertainThreshold',
    () => {
      const oneSet = new Map([['chest', 1], ['triceps', 1], ['shoulders', 1]]);
      const fullTemplate = new Map([['chest', 6], ['triceps', 6], ['shoulders', 6]]);
      const similarity = ruzickaSimilarity(oneSet, fullTemplate);
      expect(similarity).toBeCloseTo(3 / 18, 10);
      expect(similarity).toBeLessThan(0.25); // default uncertainThreshold (D-23)
    },
  );

  it('partial overlap: {chest:3,triceps:3} vs {chest:3,quads:3} is 3/9 ≈ 0.333', () => {
    const a = new Map([['chest', 3], ['triceps', 3]]);
    const b = new Map([['chest', 3], ['quads', 3]]);
    expect(ruzickaSimilarity(a, b)).toBeCloseTo(3 / 9, 10);
  });
});

// ---------------------------------------------------------------------------
// classifySimilarity
// ---------------------------------------------------------------------------

describe('classifySimilarity', () => {
  const matchThreshold = 0.5;
  const uncertainThreshold = 0.25;

  it('classifies default matched values (>= 0.5) as matched, boundary inclusive', () => {
    expect(classifySimilarity(0.5, matchThreshold, uncertainThreshold)).toBe('matched');
    expect(classifySimilarity(0.9, matchThreshold, uncertainThreshold)).toBe('matched');
  });

  it('classifies default uncertain values (0.25..0.49) as uncertain, boundary inclusive', () => {
    expect(classifySimilarity(0.25, matchThreshold, uncertainThreshold)).toBe('uncertain');
    expect(classifySimilarity(0.49, matchThreshold, uncertainThreshold)).toBe('uncertain');
  });

  it('classifies default none values (< 0.25) as none', () => {
    expect(classifySimilarity(0.24, matchThreshold, uncertainThreshold)).toBe('none');
    expect(classifySimilarity(0, matchThreshold, uncertainThreshold)).toBe('none');
  });

  it('uses the supplied thresholds, not module constants — 0.5 is no longer matched against matchThreshold=0.9', () => {
    expect(classifySimilarity(0.5, 0.9, uncertainThreshold)).not.toBe('matched');
  });
});
