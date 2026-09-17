/**
 * Unit tests for src/e1rm.ts — 1:1 port of WorkoutLoadCalculator.kt (Epley formula).
 *
 * Source analogue: TrainCounter/.../domain/WorkoutLoadCalculator.kt lines 19–33
 * Formula: w * (1.0 + Math.min(r, REP_CAP) / 30.0)  where REP_CAP = 12
 * Gates: weight <= 0 OR reps < 1 → null
 * No rounding (Kotlin returns Double, TypeScript returns number).
 */

import { describe, it, expect } from 'vitest';
import { setE1rm, bestE1rm, REP_CAP } from '../src/e1rm.js';

describe('e1RM (Epley port)', () => {
  describe('REP_CAP constant', () => {
    it('is 12', () => {
      expect(REP_CAP).toBe(12);
    });
  });

  describe('setE1rm — basic formula (no rounding)', () => {
    it('computes 100kg × 5 reps without rounding', () => {
      // Formula: 100 * (1.0 + 5/30.0) = 100 * (1.0 + 0.16666...) = 116.666...
      const expected = 100 * (1.0 + 5 / 30.0);
      expect(setE1rm(100, 5)).toBe(expected);
    });

    it('computes 100kg × 12 reps (rep cap exactly)', () => {
      // Formula: 100 * (1.0 + 12/30.0) = 100 * (1.0 + 0.4) = 140.0
      const expected = 100 * (1.0 + 12 / 30.0);
      expect(setE1rm(100, 12)).toBe(expected);
      expect(setE1rm(100, 12)).toBe(140.0);
    });

    it('clamps reps at 12 when reps > 12 (rep cap)', () => {
      // setE1rm(100, 15) must equal setE1rm(100, 12) — REP_CAP clamps at 12
      expect(setE1rm(100, 15)).toBe(setE1rm(100, 12));
      expect(setE1rm(100, 15)).toBe(140.0);
    });
  });

  describe('setE1rm — null gates', () => {
    it('returns null when weight is 0 (weight gate)', () => {
      expect(setE1rm(0, 10)).toBeNull();
    });

    it('returns null when weight is negative', () => {
      expect(setE1rm(-5, 10)).toBeNull();
    });

    it('returns null when reps is 0 (rep gate)', () => {
      expect(setE1rm(100, 0)).toBeNull();
    });

    it('returns null when reps is negative', () => {
      expect(setE1rm(100, -1)).toBeNull();
    });

    it('returns null when weight is null', () => {
      expect(setE1rm(null, 5)).toBeNull();
    });

    it('returns null when reps is null', () => {
      expect(setE1rm(100, null)).toBeNull();
    });
  });

  describe('bestE1rm — max across sets', () => {
    it('returns max e1RM ignoring null (w=0 gate)', () => {
      // setE1rm(100,5)=116.67, setE1rm(80,10)=106.67, setE1rm(0,5)=null → max = 116.67
      const sets = [
        { weightUsed: 100, completedReps: 5 },
        { weightUsed: 80,  completedReps: 10 },
        { weightUsed: 0,   completedReps: 5 },
      ];
      const expected = setE1rm(100, 5); // 116.666...
      expect(bestE1rm(sets)).toBe(expected);
    });

    it('returns null for empty set array', () => {
      expect(bestE1rm([])).toBeNull();
    });

    it('returns null when all sets have null/zero weight', () => {
      const sets = [
        { weightUsed: 0,    completedReps: 5 },
        { weightUsed: null, completedReps: 5 },
      ];
      expect(bestE1rm(sets)).toBeNull();
    });

    it('returns single set e1RM when only one valid set', () => {
      const sets = [{ weightUsed: 60, completedReps: 3 }];
      expect(bestE1rm(sets)).toBe(setE1rm(60, 3));
    });
  });
});
