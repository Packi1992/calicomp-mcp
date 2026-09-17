/**
 * Tests for src/coach-parameters.ts (Phase 137, D-09/D-23, STATE-06).
 *
 * Coverage mirrors the <behavior> block from 137-05-PLAN.md Task 1:
 *   - COACH_PARAMETER_DEFAULTS/COACH_PARAMETER_RANGES shape.
 *   - CoachParametersSchema accepts an empty object; rejects out-of-range and
 *     non-integer values per key; enforces the threshold invariant, resolved
 *     against the CURRENT state, not the defaults.
 *   - An unknown key is rejected, not silently dropped.
 *   - mergeCoachParameters / describeCoachParameters.
 *   - loadCoachParameters falls back to defaults on a network failure or a
 *     null (no-row-yet) response, never throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module mock — hoisted before static imports by Vitest.
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    fetchCoachParameters: vi.fn(),
  };
});

import * as httpModule from '../src/http.js';
import {
  CoachParameters,
  COACH_PARAMETER_DEFAULTS,
  COACH_PARAMETER_RANGES,
  CoachParametersSchema,
  coachParametersSchemaFor,
  mergeCoachParameters,
  describeCoachParameters,
  loadCoachParameters,
} from '../src/coach-parameters.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test_secret', serverUrl: 'https://example.test' };

beforeEach(() => {
  vi.mocked(httpModule.fetchCoachParameters).mockReset();
});

const INTEGER_KEYS: (keyof CoachParameters)[] = [
  'toleranceDays',
  'adherenceWindowWeeks',
  'consistencyWindowWeeks',
  'exerciseTrendPoints',
  'recentExerciseCount',
];

describe('COACH_PARAMETER_DEFAULTS / COACH_PARAMETER_RANGES', () => {
  it('has exactly the seven documented keys with the documented default values', () => {
    expect(Object.keys(COACH_PARAMETER_DEFAULTS)).toHaveLength(7);
    // matchThreshold/uncertainThreshold (Plan 138.1-22, D-17): re-derived against real
    // production data (134 positive / 4020 negative pairs) against the COMBINED vector
    // (muscle groups plus capability axes, buildCombinedVector) — see
    // .planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md.
    // Supersedes the 138-15 values (0.537/0.529), which were calibrated against the
    // pure-muscle vector adherence.ts no longer uses.
    expect(COACH_PARAMETER_DEFAULTS).toEqual({
      toleranceDays: 1,
      adherenceWindowWeeks: 4,
      consistencyWindowWeeks: 12,
      exerciseTrendPoints: 10,
      recentExerciseCount: 5,
      matchThreshold: 0.542,
      uncertainThreshold: 0.454,
    });
  });

  it('has a range entry with min/max/integer/non-empty description for every key', () => {
    for (const key of Object.keys(COACH_PARAMETER_DEFAULTS) as (keyof CoachParameters)[]) {
      const range = COACH_PARAMETER_RANGES[key];
      expect(range, `${key} must have a range entry`).toBeDefined();
      expect(typeof range.min).toBe('number');
      expect(typeof range.max).toBe('number');
      expect(typeof range.integer).toBe('boolean');
      expect(range.description.length).toBeGreaterThan(0);
    }
  });
});

describe('CoachParametersSchema — empty object and unknown keys', () => {
  it('accepts an empty object (setting nothing is allowed)', () => {
    expect(CoachParametersSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    const result = CoachParametersSchema.safeParse({ notAKey: 1 });
    expect(result.success).toBe(false);
  });
});

describe('CoachParametersSchema — per-key range checks', () => {
  for (const key of INTEGER_KEYS) {
    const range = COACH_PARAMETER_RANGES[key];

    it(`${key}: accepts min (${range.min}) and max (${range.max})`, () => {
      expect(CoachParametersSchema.safeParse({ [key]: range.min }).success).toBe(true);
      expect(CoachParametersSchema.safeParse({ [key]: range.max }).success).toBe(true);
    });

    it(`${key}: rejects min-1 (${range.min - 1}) and max+1 (${range.max + 1})`, () => {
      expect(CoachParametersSchema.safeParse({ [key]: range.min - 1 }).success).toBe(false);
      expect(CoachParametersSchema.safeParse({ [key]: range.max + 1 }).success).toBe(false);
    });

    it(`${key}: rejects a non-integer value`, () => {
      expect(CoachParametersSchema.safeParse({ [key]: range.min + 0.5 }).success).toBe(false);
    });
  }

  it('matchThreshold: accepts 0 and 1; rejects -0.01 and 1.01', () => {
    // The invariant (uncertainThreshold strictly < matchThreshold) is checked
    // against the CURRENT uncertainThreshold when matchThreshold alone is set
    // (see the "threshold invariant" describe block below). matchThreshold: 0
    // can never satisfy that invariant against the real default (0.25) or any
    // in-range uncertainThreshold (its own minimum is 0) — that is the
    // invariant working as designed, not this test's concern. This test
    // isolates the plain per-field range check by binding to a `current` whose
    // uncertainThreshold sits outside its own valid range, so the boundary
    // value of matchThreshold under test here can never trip the invariant.
    const schema = coachParametersSchemaFor({ ...COACH_PARAMETER_DEFAULTS, uncertainThreshold: -1 });
    expect(schema.safeParse({ matchThreshold: 0 }).success).toBe(true);
    expect(schema.safeParse({ matchThreshold: 1 }).success).toBe(true);
    expect(schema.safeParse({ matchThreshold: -0.01 }).success).toBe(false);
    expect(schema.safeParse({ matchThreshold: 1.01 }).success).toBe(false);
  });
});

describe('CoachParametersSchema — threshold invariant', () => {
  it('rejects equal matchThreshold/uncertainThreshold', () => {
    expect(
      CoachParametersSchema.safeParse({ matchThreshold: 0.5, uncertainThreshold: 0.5 }).success,
    ).toBe(false);
  });

  it('rejects uncertainThreshold greater than matchThreshold', () => {
    expect(
      CoachParametersSchema.safeParse({ matchThreshold: 0.5, uncertainThreshold: 0.6 }).success,
    ).toBe(false);
  });

  it('accepts uncertainThreshold strictly less than matchThreshold', () => {
    expect(
      CoachParametersSchema.safeParse({ matchThreshold: 0.5, uncertainThreshold: 0.4 }).success,
    ).toBe(true);
  });

  it('checks a lone uncertainThreshold against the CURRENT matchThreshold, not the default', () => {
    const current: CoachParameters = { ...COACH_PARAMETER_DEFAULTS, matchThreshold: 0.5 };
    const schema = coachParametersSchemaFor(current);
    expect(schema.safeParse({ uncertainThreshold: 0.9 }).success).toBe(false);
    expect(schema.safeParse({ uncertainThreshold: 0.4 }).success).toBe(true);
  });
});

describe('mergeCoachParameters', () => {
  it('returns exactly the defaults for null', () => {
    expect(mergeCoachParameters(null)).toEqual(COACH_PARAMETER_DEFAULTS);
  });

  it('layers a partial update over the defaults', () => {
    expect(mergeCoachParameters({ toleranceDays: 3 })).toEqual({
      ...COACH_PARAMETER_DEFAULTS,
      toleranceDays: 3,
    });
  });
});

describe('describeCoachParameters', () => {
  it('reports value/default/min/max/description per key and source: defaults', () => {
    const description = describeCoachParameters(COACH_PARAMETER_DEFAULTS, 'defaults');
    expect(description.source).toBe('defaults');
    for (const key of Object.keys(COACH_PARAMETER_DEFAULTS) as (keyof CoachParameters)[]) {
      const entry = description.params[key];
      const range = COACH_PARAMETER_RANGES[key];
      expect(entry.value).toBe(COACH_PARAMETER_DEFAULTS[key]);
      expect(entry.default).toBe(COACH_PARAMETER_DEFAULTS[key]);
      expect(entry.min).toBe(range.min);
      expect(entry.max).toBe(range.max);
      expect(entry.description).toBe(range.description);
    }
  });
});

describe('loadCoachParameters', () => {
  it('falls back to defaults with source: defaults on a network failure, never throwing', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockRejectedValue(new Error('network down'));
    const result = await loadCoachParameters(DUMMY_CFG);
    expect(result).toEqual({ params: COACH_PARAMETER_DEFAULTS, source: 'defaults' });
  });

  it('falls back to defaults with source: defaults on a null (no row yet) response', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue(null);
    const result = await loadCoachParameters(DUMMY_CFG);
    expect(result).toEqual({ params: COACH_PARAMETER_DEFAULTS, source: 'defaults' });
  });

  it('merges a server response over the defaults with source: server', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({
      params: { toleranceDays: 3 },
      updatedAt: 123,
    });
    const result = await loadCoachParameters(DUMMY_CFG);
    expect(result).toEqual({
      params: { ...COACH_PARAMETER_DEFAULTS, toleranceDays: 3 },
      source: 'server',
    });
  });
});
