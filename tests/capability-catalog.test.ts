/**
 * capability-catalog.test.ts — Phase 138.1 tracer (Task 2).
 *
 * Proves the MCP catalog type carries the capability axes end to end through
 * `get_exercise_catalog` — unchanged, including `key` and both translations — and pins the
 * D-04 invariant from the plan's assumption-delta block: an exercise with an EMPTY
 * `capabilities` array stays fully resolvable. No axis is ever fabricated, no level is ever
 * substituted for a missing one. Also pins the `CapabilityInvolvementLevel` union: the
 * muscle-involvement vocabulary (`PRIMARY`/`SECONDARY`/`STABILIZER`) is not a valid value
 * (D-03).
 */

import { describe, it, expect } from 'vitest';
import { getExerciseCatalog } from '../src/tools/get_exercise_catalog.js';
import type { CatalogExercise, CapabilityInvolvementLevel } from '../src/types.js';

function buildExercise(overrides: Partial<CatalogExercise> & { id: string }): CatalogExercise {
  return {
    key: overrides.id,
    nameEn: overrides.id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [],
    muscleGroups: [],
    equipment: [],
    capabilities: [],
    ...overrides,
  };
}

describe('capability-catalog', () => {
  it('carries a capabilities axis with key and both translations through get_exercise_catalog unchanged', () => {
    const exercise = buildExercise({
      id: 'ex-breathhold',
      capabilities: [
        {
          id: 'cap-breath',
          key: 'breath',
          translations: [
            { languageCode: 'en', name: 'Breath' },
            { languageCode: 'de', name: 'Atem' },
          ],
          capabilityLevel: 'HAUPTREIZ',
        },
      ],
    });

    const result = getExerciseCatalog({}, [exercise]);

    expect(result).toHaveLength(1);
    expect(result[0].capabilities).toHaveLength(1);
    const axis = result[0].capabilities[0];
    expect(axis.key).toBe('breath');
    expect(axis.capabilityLevel).toBe('HAUPTREIZ');
    expect(axis.translations).toContainEqual({ languageCode: 'en', name: 'Breath' });
    expect(axis.translations).toContainEqual({ languageCode: 'de', name: 'Atem' });
  });

  it('D-04 invariant: an exercise with an empty capabilities array stays fully resolvable — no axis is added, no level is defaulted', () => {
    const exercise = buildExercise({ id: 'ex-plain-strength', capabilities: [] });

    const result = getExerciseCatalog({}, [exercise]);

    expect(result).toHaveLength(1);
    expect(result[0].capabilities).toEqual([]);
    // The exercise itself is still fully present — an empty axis array is the correct D-04
    // representation of "does not train this capability", not a partial/broken resolution.
    expect(result[0].id).toBe('ex-plain-strength');
    expect(result[0].nameEn).toBe('ex-plain-strength');
  });

  it('CapabilityInvolvementLevel allows exactly HAUPTREIZ/MITTRAINIERT/GERING — the muscle vocabulary is not a valid value', () => {
    const hauptreiz: CapabilityInvolvementLevel = 'HAUPTREIZ';
    const mittrainiert: CapabilityInvolvementLevel = 'MITTRAINIERT';
    const gering: CapabilityInvolvementLevel = 'GERING';
    expect([hauptreiz, mittrainiert, gering]).toEqual(['HAUPTREIZ', 'MITTRAINIERT', 'GERING']);

    // @ts-expect-error — the muscle-involvement vocabulary is not a valid CapabilityInvolvementLevel (D-03)
    const invalid: CapabilityInvolvementLevel = 'PRIMARY';
    expect(invalid).toBe('PRIMARY');
  });
});

/**
 * 138.1-21 (CAP-07/D-07) — `CatalogExercise` loses `category` and gains `isSkill`. The four
 * cases below pin the plan's `<behavior>` block: a set flag survives the catalog pass-through
 * unchanged, an absent flag reads as non-skill without error (a server that has not yet
 * deployed 138.1-18 must not break the coach), a still-present legacy `category` field is
 * ignored without error (the window between the 138.1-23 deploy and the next catalog pull),
 * and the 138.1-01 D-04 invariant (an exercise with no capability axis stays fully resolvable)
 * stays green as its own case.
 */
describe('capability-catalog — isSkill (138.1-21, CAP-07/D-07)', () => {
  it('an entry with isSkill set is passed through by get_exercise_catalog with the flag intact', () => {
    const exercise = buildExercise({ id: 'ex-handstand', isSkill: true });

    const result = getExerciseCatalog({}, [exercise]);

    expect(result).toHaveLength(1);
    expect(result[0].isSkill).toBe(true);
  });

  it('an entry with no isSkill field at all reads as non-skill and does not error (pre-138.1-18 server)', () => {
    // Simulates a cached/older catalog entry from before the server started sending isSkill —
    // `isSkill` is intentionally absent, not merely `undefined`, to prove the optional-field
    // contract rather than a JS `undefined`-vs-"key missing" quirk.
    const { isSkill: _omitted, ...withoutIsSkill } = buildExercise({ id: 'ex-plain' });
    void _omitted;

    const result = getExerciseCatalog({}, [withoutIsSkill as CatalogExercise]);

    expect(result).toHaveLength(1);
    expect(result[0].isSkill).toBeFalsy();
    expect(result[0].id).toBe('ex-plain');
  });

  it('an entry still carrying the retired category field is processed without error, the field ignored', () => {
    // Simulates the deploy window between 138.1-23 (server) shipping isSkill and the next
    // catalog fetch replacing an in-flight cached entry that still has the old field — the raw
    // JSON from `res.json()` is never schema-stripped, so extra keys survive at runtime even
    // though the TypeScript type no longer declares them (see cache.ts / http.ts fetchCatalog).
    const legacyShapeExercise = {
      ...buildExercise({ id: 'ex-legacy', isSkill: false }),
      category: 'SKILL',
    } as unknown as CatalogExercise;

    const result = getExerciseCatalog({}, [legacyShapeExercise]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ex-legacy');
    expect(result[0].isSkill).toBe(false);
  });

  it('D-04 invariant (138.1-01) stays green: an exercise with no capability axis stays fully resolvable', () => {
    const exercise = buildExercise({ id: 'ex-no-axis', capabilities: [] });

    const result = getExerciseCatalog({}, [exercise]);

    expect(result).toHaveLength(1);
    expect(result[0].capabilities).toEqual([]);
    expect(result[0].id).toBe('ex-no-axis');
  });
});
