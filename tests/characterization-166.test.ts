/**
 * Characterization test of Phase 166 (plan 166-04, D-04 in the version E-15 of the athlete,
 * 2026-10-29): pins the state BEFORE 166 for every field of `get_training_state`,
 * `get_stats` (`exercise`, `muscle`, `capabilities`), `get_history` and `get_adherence`,
 * and admits a change only as a declared delta.
 *
 * Phase 166 corrects existing fields in place (the MCP counts like the app at once). The
 * pins in `tests/vectors/characterization-166.json` were written in the first commit of plan
 * 166-04 from the unchanged code by a temporary, uncommitted generator test that called
 * `collectPinnedOutputs166()` (`characterization-166-fixture.ts`); the file never changes
 * again. Every plan that changes a pinned value (166-04, 166-06, 166-07, 166-10) declares the
 * change first, in its red `test(…)` commit, in `tests/vectors/characterization-166-deltas.json`
 * (old value equal to the pin, new value derived by hand from the rule, rule, plan, reason);
 * a new key is allowed only as a declared addition. Everything else stays pinned
 * (`characterization-166-deltas.ts`). No silent change.
 *
 * The fixture makes every rule of the phase visible: S, M, P, D-10 and IN-02 (see the head of
 * `characterization-166-fixture.ts`).
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyDeclaredDeltas,
  checkDeltaFile,
  expectPinsWithDeltas,
  loadDeltaFile,
  loadPinFile,
  PIN_FILES,
  type DeltaFile,
  type PinFile,
} from './characterization-166-deltas.js';
import {
  collectPinnedOutputs166,
  CHAR166_PIN_KEYS,
  CHAR166_SNAPSHOT,
  CHAR166_CATALOG,
  CHAR166_EX_STRETCH,
  CHAR166_EX_MIXED,
  CHAR166_SESSION_D10_FEW,
  CHAR166_SESSION_D10_MANY,
} from './characterization-166-fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIN_166: PinFile = 'characterization-166.json';

if (!process.env.CHAR_166_PIN_GENERATE) {
  describe('P166 characterization — pins of the state before 166 with declared deltas', () => {
    const pins = loadPinFile(PIN_166);
    const actual = collectPinnedOutputs166();

    it('P166 the fixture carries every rule case of the phase', () => {
      const stretch = CHAR166_CATALOG.find((e) => e.id === CHAR166_EX_STRETCH);
      const mixed = CHAR166_CATALOG.find((e) => e.id === CHAR166_EX_MIXED);
      expect(stretch?.capabilities.map((c) => c.key).sort()).toEqual(['flexibility', 'mobility']);
      expect(mixed?.capabilities.map((c) => c.key).sort()).toEqual(['mobility', 'power']);
      expect(CHAR166_SNAPSHOT.sessions.some((s) => s.endTime === undefined)).toBe(true);
      expect(CHAR166_SNAPSHOT.sessions.some((s) => s.deletedAt !== undefined)).toBe(true);
      expect(CHAR166_SNAPSHOT.setLogs.some((s) => s.deletedAt !== undefined)).toBe(true);
      expect(CHAR166_SNAPSHOT.setLogs.some((s) => s.exerciseId === undefined && s.workoutExerciseId !== undefined)).toBe(true);
      expect(CHAR166_SNAPSHOT.setLogs.some((s) => s.completedReps === 0)).toBe(true);
      const setsOf = (id: string) => CHAR166_SNAPSHOT.setLogs.filter((s) => s.sessionId === id).length;
      expect(CHAR166_SESSION_D10_FEW < CHAR166_SESSION_D10_MANY).toBe(true);
      expect(setsOf(CHAR166_SESSION_D10_FEW)).toBeLessThan(setsOf(CHAR166_SESSION_D10_MANY));
      expect(CHAR166_SNAPSHOT.plannedWorkouts.some((p) => p.recurrenceRule !== null && p.deletedOccurrencesRaw !== null)).toBe(true);
      expect(Object.keys(pins)).toEqual([...CHAR166_PIN_KEYS]);
    });

    it('P166 getTrainingState keeps its pins except declared deltas', () => {
      expectPinsWithDeltas(actual.getTrainingState, PIN_166, 'getTrainingState', pins.getTrainingState);
    });

    it('P166 getStats exercise keeps its pins except declared deltas', () => {
      expectPinsWithDeltas(actual.getStatsExercise, PIN_166, 'getStatsExercise', pins.getStatsExercise);
    });

    it('P166 getStats muscle keeps its pins except declared deltas', () => {
      expectPinsWithDeltas(actual.getStatsMuscle, PIN_166, 'getStatsMuscle', pins.getStatsMuscle);
    });

    it('P166 getStats capabilities keeps its pins except declared deltas', () => {
      expectPinsWithDeltas(actual.getStatsCapabilities, PIN_166, 'getStatsCapabilities', pins.getStatsCapabilities);
    });

    it('P166 getHistory keeps its pins except declared deltas', () => {
      expectPinsWithDeltas(actual.getHistory, PIN_166, 'getHistory', pins.getHistory);
    });

    it('P166 getAdherence keeps its pins except declared deltas', () => {
      expectPinsWithDeltas(actual.getAdherence, PIN_166, 'getAdherence', pins.getAdherence);
    });

    it('P166 every declared delta matches its pin and names its rule', () => {
      const file = loadDeltaFile();
      expect(Array.isArray(file.deltas)).toBe(true);
      expect(Array.isArray(file.additions)).toBe(true);
      const allPins: Partial<Record<PinFile, Record<string, unknown>>> = {};
      for (const name of PIN_FILES) {
        if (existsSync(join(__dirname, 'vectors', name))) allPins[name] = loadPinFile(name);
      }
      expect(checkDeltaFile(file, allPins)).toEqual([]);
      // The scope rules themselves reject what they must reject (planted cases).
      const planted: DeltaFile = {
        deltas: [
          { pinFile: PIN_166, pinKey: 'getAdherence', path: '/plannedCount', before: 1, after: 2, rule: 'S', plan: '166-04', why: 'Planted.' },
          { pinFile: 'tests/vectors/characterization-166.json', pinKey: 'getTrainingState', path: '/asOfDate', before: 'x', after: 'y', rule: 'S', plan: '166-04', why: 'Planted.' },
          { pinFile: PIN_166, pinKey: 'getTrainingState', path: '/personalRecords', before: null, after: 1, rule: 'M', plan: '166-11', why: '' },
        ],
        additions: [
          { pinFile: PIN_166, pinKey: 'getTrainingState', path: '/strengthMuscleBalance', rule: 'STAT-03', plan: '166-04', why: 'Planted.' },
          { pinFile: PIN_166, pinKey: 'getTrainingState', path: '/muscleBalance/allTime/strengthOnly', rule: 'IN-06', plan: '166-10', why: 'Planted.' },
        ],
      };
      planted.deltas.push({
        pinFile: PIN_166, pinKey: 'getTrainingState', path: '/muscleBalance/allTime/radar', before: null, after: 0, rule: 'S', plan: '166-04', why: 'Planted.',
      });
      const problems = checkDeltaFile(planted, allPins);
      expect(problems.some((p) => p.includes('deltas[0]') && p.includes('rule S acts only'))).toBe(true);
      expect(problems.some((p) => p.includes('deltas[1]') && p.includes('bare pin file name'))).toBe(true);
      expect(problems.some((p) => p.includes('deltas[2]') && p.includes('plan must be'))).toBe(true);
      expect(problems.some((p) => p.includes('deltas[2]') && p.includes('why is missing'))).toBe(true);
      expect(problems.some((p) => p.includes('deltas[3]') && p.includes('before differs'))).toBe(true);
      expect(problems.some((p) => p.includes('additions[0]') && p.includes('STAT-03 adds only'))).toBe(true);
      expect(problems.some((p) => p.includes('additions[1]') && p.includes('parallel field'))).toBe(true);
    });

    it('P166 an undeclared change or addition fails the pin check', () => {
      // Self-contained: the base is the pin with its declared deltas applied, so this control
      // measures the check, not the code under test.
      // The base carries the declared deltas but no declared addition (166-06: the declared
      // additions of getTrainingState are not part of the pin, so a file with them would
      // reject the base as "does not carry"); the controls below measure the check alone.
      const deltasOnly: DeltaFile = { deltas: loadDeltaFile().deltas, additions: [] };
      const pinned = pins.getTrainingState as Record<string, unknown>;
      const expected = applyDeclaredDeltas(PIN_166, 'getTrainingState', pinned, deltasOnly) as Record<string, unknown>;
      expect(() => expectPinsWithDeltas(structuredClone(expected), PIN_166, 'getTrainingState', pinned, deltasOnly)).not.toThrow();

      const changedNumber = structuredClone(expected) as { consistency: { trainingWeekCount: number } };
      changedNumber.consistency.trainingWeekCount += 1;
      expect(() => expectPinsWithDeltas(changedNumber, PIN_166, 'getTrainingState', pinned, deltasOnly)).toThrow(/value changed/);

      const addedKey = { ...structuredClone(expected), strengthMuscleBalance: {} };
      expect(() => expectPinsWithDeltas(addedKey, PIN_166, 'getTrainingState', pinned, deltasOnly)).toThrow(/neither pinned nor declared/);

      const wrongBefore: DeltaFile = {
        deltas: [
          { pinFile: PIN_166, pinKey: 'getTrainingState', path: '/asOfDate', before: '1999-01-01', after: '2000-01-01', rule: 'IN-06', plan: '166-10', why: 'Planted.' },
        ],
        additions: [],
      };
      expect(() => applyDeclaredDeltas(PIN_166, 'getTrainingState', pinned, wrongBefore)).toThrow(/differs from the pin/);

      const unusedAddition: DeltaFile = {
        deltas: loadDeltaFile().deltas,
        additions: [{ pinFile: PIN_166, pinKey: 'getTrainingState', path: '/capabilityBalance', rule: 'STAT-03', plan: '166-06', why: 'Planted.' }],
      };
      expect(() => expectPinsWithDeltas(structuredClone(expected), PIN_166, 'getTrainingState', pinned, unusedAddition)).toThrow(/does not carry/);
    });
  });
}
