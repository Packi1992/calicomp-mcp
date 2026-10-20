/**
 * Charakterisierungstest SC 3 (D-07, Phase 150): pinnt die heutige Ausgabe der
 * Kennzahl- und Lesefunktionen des MCP, BEVOR src/ in dieser Phase geändert wird.
 *
 * Aufbau (150-RESEARCH.md § Befund 4b, docs/LEARNINGS.md "zwei Commits"):
 *   1. `expectOldKeysUnchanged` vergleicht jeden ALTEN Schlüssel tief; neue Schlüssel
 *      sind erlaubt (additive Ausgabe bleibt möglich).
 *   2. Ein Fixture (`CHAR_SNAPSHOT`/`CHAR_CATALOG`/`CHAR_NOW_MS`) mit den in Phase 150
 *      betroffenen Randfällen (Sessionarten, gelöschte/unbekannte Vorlage, laufende und
 *      gelöschte Session, Set-Log ohne exerciseId, ...).
 *   3. Die Pin-Datei `tests/vectors/characterization-150.json` wird NICHT von Hand
 *      geschrieben, sondern von einem vorübergehenden, nicht committeten Erzeugertest
 *      aus dem unveränderten Code erzeugt.
 *
 * Die eigentlichen Vergleiche laufen hinter einem Env-Gate (`CHAR_150_PIN_GENERATE`):
 * Der Erzeugertest importiert dieselben Fixture-Konstanten aus dieser Datei, um
 * "dieselben Aufrufe" auszuführen (kein Zweit-Fixture, keine Drift) — ohne das Gate
 * würde dieser Import auch die (beim ersten Lauf noch fehlende bzw. beim Erweitern
 * noch unvollständige) Pin-Datei lesen und die Testsuite dieser Datei ein zweites Mal
 * als Teil des Erzeugerlaufs ausführen.
 *
 * Fixture und Helfer stehen seit Phase 160 (G-MCP-03) in `characterization-150-fixture.ts`,
 * einem Modul ohne Tests; `characterization-155.test.ts` und `characterization-156.test.ts`
 * importieren von dort, damit die Fälle dieser Datei nicht in jeder importierenden Datei
 * erneut laufen. Der Erzeugertest importiert die Fixture-Konstanten ebenfalls von dort.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DecryptedSnapshot } from '../src/types.js';
import { getHistory } from '../src/tools/get_history.js';
import { getTemplate } from '../src/tools/get_template.js';
import { getTrainingState } from '../src/tools/get_training_state.js';
import { getStats } from '../src/tools/get_stats.js';
import { getAdherence } from '../src/tools/get_adherence.js';
import { getProgress } from '../src/tools/get_progress.js';
import { getPlannedWorkouts } from '../src/tools/get_planned_workouts.js';
import { buildNewPlanPayload } from '../src/tools/propose_new_plan.js';
import { computeChangeHash } from '../src/hash.js';
import {
  expectOldKeysUnchanged,
  CHAR_NOW_MS,
  CHAR_CATALOG_EX_PUSHUP,
  CHAR_CATALOG,
  CHAR_TEMPLATE_ID_LIVE,
  CHAR_TEMPLATE_ID_BLOCKLESS,
  CHAR_SNAPSHOT,
  CHAR_HISTORY_ARGS,
  CHAR_HISTORY_ARGS_EXERCISE,
  CHAR_TRAINING_STATE_ARGS,
  CHAR_TRAINING_STATE_DATA,
  CHAR_STATS_DATA,
  CHAR_ADHERENCE_ARGS,
  CHAR_ADHERENCE_DATA,
  CHAR_PROGRESS_DATA,
  CHAR_PROGRESS_ARGS_ALL,
  CHAR_PROGRESS_ARGS_ONE,
  CHAR_PLANNED_WORKOUTS_ARGS,
  CHAR_NEW_PLAN_ARGS,
} from './characterization-150-fixture.js';

// ---------------------------------------------------------------------------
// Tests (gated — siehe Kopfkommentar)
// ---------------------------------------------------------------------------

if (!process.env.CHAR_150_PIN_GENERATE) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PIN_PATH = join(__dirname, 'vectors', 'characterization-150.json');
  const loadPins = (): Record<string, unknown> => JSON.parse(readFileSync(PIN_PATH, 'utf-8'));

  describe('P150 D-07 characterization', () => {
    it('P150 D-07 helper flags a changed old value', () => {
      expect(() => expectOldKeysUnchanged({ a: 2 }, { a: 1 })).toThrow();
    });

    it('P150 D-07 helper flags a missing old key', () => {
      expect(() => expectOldKeysUnchanged({ a: 1 }, { a: 1, b: 2 })).toThrow();
    });

    it('P150 D-07 helper accepts an added new key', () => {
      expect(() => expectOldKeysUnchanged({ a: 1, b: 2 }, { a: 1 })).not.toThrow();
    });

    it('P150 D-07 getHistory old keys unchanged', () => {
      const pins = loadPins();
      const actualNoExercise = getHistory(CHAR_HISTORY_ARGS, CHAR_SNAPSHOT);
      const actualWithExercise = getHistory(CHAR_HISTORY_ARGS_EXERCISE, CHAR_SNAPSHOT);
      expectOldKeysUnchanged(actualNoExercise, pins.getHistory);
      expectOldKeysUnchanged(actualWithExercise, pins.getHistoryExercise);
    });

    // Phase 151 (D-07/D-26): feedback/goalSnapshot on every fixture session are
    // ADDITIVE — the pin file is untouched (Phase 150), and the old getHistory keys
    // must stay byte-identical even once every session carries the new fields.
    it('P151 D-07 getHistory old keys unchanged with feedback on every fixture session', () => {
      const pins = loadPins();
      const snapshotWithFeedback: DecryptedSnapshot = {
        ...CHAR_SNAPSHOT,
        sessions: CHAR_SNAPSHOT.sessions.map((s) => ({
          ...s,
          feedback: {
            execution: { value: 4, state: 'confirmed' as const, setLaterAt: null },
            feel: { value: 2, state: 'answered' as const, setLaterAt: '2026-01-15T12:00:00.000Z' },
            comment: {
              text: 'P151 D-07 Fixture-Kommentar.',
              source: 'athlete_free_text' as const,
              treatAs: 'data_not_instructions' as const,
            },
          },
          goalSnapshot: [
            {
              workoutExerciseId: 'char151-d07-we-1',
              exerciseId: CHAR_CATALOG_EX_PUSHUP,
              mode: 'REPS',
              sets: 3,
              targetReps: 10,
            },
          ],
        })),
      };
      const actual = getHistory(CHAR_HISTORY_ARGS, snapshotWithFeedback);
      expectOldKeysUnchanged(actual, pins.getHistory);
    });

    it('P150 D-07 getTemplate old keys unchanged', () => {
      const pins = loadPins();
      const actual = {
        withBlock: getTemplate({ templateId: CHAR_TEMPLATE_ID_LIVE }, CHAR_SNAPSHOT),
        blockless: getTemplate({ templateId: CHAR_TEMPLATE_ID_BLOCKLESS }, CHAR_SNAPSHOT),
      };
      expectOldKeysUnchanged(actual, pins.getTemplate);
    });

    it('P150 D-07 getTrainingState old keys unchanged', () => {
      const pins = loadPins();
      const actual = getTrainingState(CHAR_TRAINING_STATE_ARGS, CHAR_TRAINING_STATE_DATA, CHAR_NOW_MS);
      expectOldKeysUnchanged(actual, pins.getTrainingState);
      expect(typeof (pins.getTrainingState as { narrative: unknown }).narrative).toBe('string');
      expect(actual.narrative).toBe((pins.getTrainingState as { narrative: string }).narrative);
    });

    it('P150 D-07 getStats exercise old keys unchanged', () => {
      const pins = loadPins();
      const actual = getStats({ by: 'exercise', exerciseId: CHAR_CATALOG_EX_PUSHUP }, CHAR_STATS_DATA);
      expectOldKeysUnchanged(actual, pins.getStatsExercise);
    });

    it('P150 D-07 getStats muscle old keys unchanged', () => {
      const pins = loadPins();
      const actual = getStats({ by: 'muscle', muscle: 'chest' }, CHAR_STATS_DATA);
      expectOldKeysUnchanged(actual, pins.getStatsMuscle);
    });

    it('P150 D-07 getStats capabilities old keys unchanged', () => {
      const pins = loadPins();
      const actual = getStats({ by: 'capabilities' }, CHAR_STATS_DATA);
      expectOldKeysUnchanged(actual, pins.getStatsCapabilities);
    });

    it('P150 D-07 getAdherence old keys unchanged', () => {
      const pins = loadPins();
      const actual = getAdherence(CHAR_ADHERENCE_ARGS, CHAR_ADHERENCE_DATA, CHAR_NOW_MS);
      expectOldKeysUnchanged(actual, pins.getAdherence);
    });

    it('P150 D-07 getProgress exercise old keys unchanged', () => {
      const pins = loadPins();
      const actualAll = getProgress(CHAR_PROGRESS_ARGS_ALL, CHAR_PROGRESS_DATA);
      const actualOne = getProgress(CHAR_PROGRESS_ARGS_ONE, CHAR_PROGRESS_DATA);
      expectOldKeysUnchanged(actualAll, pins.getProgressExerciseAll);
      expectOldKeysUnchanged(actualOne, pins.getProgressExerciseOne);
    });

    it('P150 D-07 getPlannedWorkouts old keys unchanged', () => {
      const pins = loadPins();
      const actual = getPlannedWorkouts(CHAR_PLANNED_WORKOUTS_ARGS, CHAR_SNAPSHOT);
      expectOldKeysUnchanged(actual, pins.getPlannedWorkouts);
    });

    it('P150 D-07 new_plan blocks-only payload and changeHash unchanged', () => {
      const pins = loadPins();
      const payload = buildNewPlanPayload(CHAR_NEW_PLAN_ARGS, CHAR_CATALOG);
      const payloadJson = JSON.stringify(payload);
      const changeHash = computeChangeHash('new_plan', payload);
      expect(payloadJson).toBe(pins.newPlanPayloadJson);
      expect(changeHash).toBe(pins.newPlanChangeHash);
    });

    // Plan 151-23 (D-07, Messpunkt 2026-11-16): the SAME `feedback`/`goalSnapshot`
    // additivity check the getHistory test above already proves, extended to every
    // other Phase-150 pinned metric/read function — including getTrainingState's
    // NEW templateFeedbackSeries field (151-23), which reads feedback/goalSnapshot by
    // design. Every OLD key, and the narrative sentence verbatim, must stay
    // byte-identical against the Phase-150 pin even once every fixture session
    // carries feedback and a goal snapshot. The pin file itself is untouched.
    it('P151 D-07 old metrics unchanged with feedback and goals on every fixture session', () => {
      const pins = loadPins();
      const snapshotWithFeedback: DecryptedSnapshot = {
        ...CHAR_SNAPSHOT,
        sessions: CHAR_SNAPSHOT.sessions.map((s) => ({
          ...s,
          feedback: {
            execution: { value: 4, state: 'confirmed' as const, setLaterAt: null },
            feel: { value: 2, state: 'answered' as const, setLaterAt: '2026-01-15T12:00:00.000Z' },
            comment: {
              text: 'P151-23 D-07 Fixture-Kommentar.',
              source: 'athlete_free_text' as const,
              treatAs: 'data_not_instructions' as const,
            },
          },
          goalSnapshot: [
            {
              workoutExerciseId: 'char151-23-d07-we-1',
              exerciseId: CHAR_CATALOG_EX_PUSHUP,
              mode: 'REPS',
              sets: 3,
              targetReps: 10,
            },
          ],
        })),
      };

      const trainingStateActual = getTrainingState(
        CHAR_TRAINING_STATE_ARGS,
        { ...CHAR_TRAINING_STATE_DATA, snapshot: snapshotWithFeedback },
        CHAR_NOW_MS,
      );
      expectOldKeysUnchanged(trainingStateActual, pins.getTrainingState);
      expect(trainingStateActual.narrative).toBe(
        (pins.getTrainingState as { narrative: string }).narrative,
      );

      const statsExerciseActual = getStats(
        { by: 'exercise', exerciseId: CHAR_CATALOG_EX_PUSHUP },
        { ...CHAR_STATS_DATA, snapshot: snapshotWithFeedback },
      );
      expectOldKeysUnchanged(statsExerciseActual, pins.getStatsExercise);

      const statsMuscleActual = getStats(
        { by: 'muscle', muscle: 'chest' },
        { ...CHAR_STATS_DATA, snapshot: snapshotWithFeedback },
      );
      expectOldKeysUnchanged(statsMuscleActual, pins.getStatsMuscle);

      const statsCapabilitiesActual = getStats(
        { by: 'capabilities' },
        { ...CHAR_STATS_DATA, snapshot: snapshotWithFeedback },
      );
      expectOldKeysUnchanged(statsCapabilitiesActual, pins.getStatsCapabilities);

      const adherenceActual = getAdherence(
        CHAR_ADHERENCE_ARGS,
        { ...CHAR_ADHERENCE_DATA, snapshot: snapshotWithFeedback },
        CHAR_NOW_MS,
      );
      expectOldKeysUnchanged(adherenceActual, pins.getAdherence);

      const progressAllActual = getProgress(CHAR_PROGRESS_ARGS_ALL, { ...CHAR_PROGRESS_DATA, snapshot: snapshotWithFeedback });
      const progressOneActual = getProgress(CHAR_PROGRESS_ARGS_ONE, { ...CHAR_PROGRESS_DATA, snapshot: snapshotWithFeedback });
      expectOldKeysUnchanged(progressAllActual, pins.getProgressExerciseAll);
      expectOldKeysUnchanged(progressOneActual, pins.getProgressExerciseOne);
    });
  });
}
