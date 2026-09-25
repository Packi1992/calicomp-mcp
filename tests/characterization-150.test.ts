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
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DecryptedSnapshot, CatalogExercise } from '../src/types.js';
import { getHistory, type GetHistoryArgs } from '../src/tools/get_history.js';
import { getTemplate } from '../src/tools/get_template.js';
import { getTrainingState, type GetTrainingStateArgs } from '../src/tools/get_training_state.js';
import { getStats } from '../src/tools/get_stats.js';
import { getAdherence, type GetAdherenceArgs } from '../src/tools/get_adherence.js';
import { getProgress, type GetProgressArgs } from '../src/tools/get_progress.js';
import { getPlannedWorkouts, type GetPlannedWorkoutsArgs } from '../src/tools/get_planned_workouts.js';
import {
  buildNewPlanPayload,
  type ProposeNewPlanArgs,
} from '../src/tools/propose_new_plan.js';
import { computeChangeHash } from '../src/hash.js';
import { COACH_PARAMETER_DEFAULTS } from '../src/coach-parameters.js';

// ---------------------------------------------------------------------------
// Vergleichshelfer (D-03/D-07): jeder alte Schlüssel muss tief gleich bleiben,
// neue Schlüssel sind erlaubt.
// ---------------------------------------------------------------------------

export function expectOldKeysUnchanged(actual: unknown, pinned: unknown, path = '$'): void {
  if (pinned === null) {
    if (actual !== null) {
      throw new Error(`${path}: expected null, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (Array.isArray(pinned)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${path}: expected array, got ${typeof actual}`);
    }
    if (actual.length !== pinned.length) {
      throw new Error(
        `${path}: array length changed — pinned ${pinned.length}, actual ${actual.length}`,
      );
    }
    pinned.forEach((p, i) => expectOldKeysUnchanged((actual as unknown[])[i], p, `${path}[${i}]`));
    return;
  }
  if (typeof pinned === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      throw new Error(`${path}: expected object, got ${actual === null ? 'null' : typeof actual}`);
    }
    for (const key of Object.keys(pinned as Record<string, unknown>)) {
      if (!(key in (actual as Record<string, unknown>))) {
        throw new Error(`${path}.${key}: key missing in actual`);
      }
      expectOldKeysUnchanged(
        (actual as Record<string, unknown>)[key],
        (pinned as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
    return;
  }
  if (!Object.is(actual, pinned)) {
    throw new Error(
      `${path}: value changed — pinned ${JSON.stringify(pinned)}, actual ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture (D-01…D-17): feste UUIDs/Ids, alle in Phase 150 relevanten Randfälle.
// ---------------------------------------------------------------------------

const D = (iso: string): number => Date.parse(iso);

export const CHAR_NOW_MS = D('2026-01-20T12:00:00Z');

// Katalogübungen
export const CHAR_CATALOG_EX_PUSHUP = 'char150-cat-pushup';
export const CHAR_CATALOG_EX_PULLUP = 'char150-cat-pullup';
export const CHAR_CATALOG_EX_SQUAT = 'char150-cat-squat';

export const CHAR_CATALOG: CatalogExercise[] = [
  {
    id: CHAR_CATALOG_EX_PUSHUP,
    key: 'char150_push_up',
    nameEn: 'P150 Push-Up',
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: D('2026-01-01T00:00:00Z'),
    translations: [{ languageCode: 'de', name: 'P150 Liegestütz' }],
    muscleGroups: [
      {
        id: 'char150-mg-chest',
        key: 'chest',
        translations: [{ languageCode: 'de', name: 'Brust' }],
        involvementLevel: 'PRIMARY',
      },
    ],
    equipment: [],
    capabilities: [],
    origin: 'CATALOG',
  },
  {
    id: CHAR_CATALOG_EX_PULLUP,
    key: 'char150_pull_up',
    nameEn: 'P150 Pull-Up',
    mode: 'REPS',
    usesWeight: true,
    lastModifiedAt: D('2026-01-01T00:00:00Z'),
    translations: [{ languageCode: 'de', name: 'P150 Klimmzug' }],
    muscleGroups: [
      {
        id: 'char150-mg-back',
        key: 'back',
        translations: [{ languageCode: 'de', name: 'Rücken' }],
        involvementLevel: 'PRIMARY',
      },
    ],
    equipment: [],
    capabilities: [],
    origin: 'CATALOG',
  },
  {
    id: CHAR_CATALOG_EX_SQUAT,
    key: 'char150_squat',
    nameEn: 'P150 Squat',
    mode: 'REPS',
    usesWeight: true,
    lastModifiedAt: D('2026-01-01T00:00:00Z'),
    translations: [{ languageCode: 'de', name: 'P150 Kniebeuge' }],
    muscleGroups: [
      {
        id: 'char150-mg-quads',
        key: 'quads',
        translations: [{ languageCode: 'de', name: 'Quadrizeps' }],
        involvementLevel: 'PRIMARY',
      },
    ],
    equipment: [],
    capabilities: [],
    origin: 'CATALOG',
  },
];

// Vorlagen: eine lebende ("live"), eine gelöschte (Tombstone). Eine dritte
// templateId ("unknown-ref") wird nur an einer Session referenziert und taucht
// hier absichtlich NICHT auf (D-02: "gar nicht im Snapshot").
export const CHAR_TEMPLATE_ID_LIVE = 'char150-tpl-live';
export const CHAR_TEMPLATE_ID_DELETED = 'char150-tpl-deleted';
export const CHAR_TEMPLATE_ID_UNKNOWN_REF = 'char150-tpl-unknown-ref';
// Task 2 (getTemplate): eine dritte, lebende Vorlage mit einer blocklosen Übung —
// keine Blöcke, ein templateExercise ohne blockId.
export const CHAR_TEMPLATE_ID_BLOCKLESS = 'char150-tpl-blockless';
const CHAR_BLOCK_ID_LIVE = 'char150-block-live';
export const CHAR_TEMPLATE_EXERCISE_ID_LIVE = 'char150-te-live-1';
const CHAR_TEMPLATE_EXERCISE_ID_BLOCKLESS = 'char150-te-blockless-1';

// Eigenübungen (D-15/D-17): eine lebende mit Set-Logs, eine gelöschte ohne.
export const CHAR_CUSTOM_EX_LIVE = 'char150-custom-live';
export const CHAR_CUSTOM_EX_DELETED = 'char150-custom-deleted';

// Sessions — Vorlagen-Training (live × 2, gelöschte Vorlage, unbekannte Vorlage),
// vorlagenlos × 2, QuickChallenge × 2 (eine davon mit templateId), eine laufende
// (kein endTime), eine gelöschte (deletedAt).
export const CHAR_SESSION_TPL_LIVE_1 = 'char150-session-tpl-live-1';
export const CHAR_SESSION_TPL_LIVE_2 = 'char150-session-tpl-live-2';
const CHAR_SESSION_TPL_DELETED = 'char150-session-tpl-deleted';
const CHAR_SESSION_TPL_UNKNOWN = 'char150-session-tpl-unknown';
const CHAR_SESSION_TEMPLATELESS_1 = 'char150-session-templateless-1';
const CHAR_SESSION_TEMPLATELESS_2 = 'char150-session-templateless-2';
const CHAR_SESSION_QC_1 = 'char150-session-qc-1';
const CHAR_SESSION_QC_WITH_TEMPLATE = 'char150-session-qc-with-template';
const CHAR_SESSION_RUNNING = 'char150-session-running';
const CHAR_SESSION_DELETED = 'char150-session-deleted';

export const CHAR_SNAPSHOT: DecryptedSnapshot = {
  syncedAt: CHAR_NOW_MS,

  exercises: [
    {
      id: CHAR_CUSTOM_EX_LIVE,
      name: 'P150 Eigene Klimmzugvariante',
      mode: 'REPS',
      usesWeight: true,
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
    },
    {
      id: CHAR_CUSTOM_EX_DELETED,
      name: 'P150 Alte Eigenübung',
      mode: 'REPS',
      usesWeight: false,
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-02T00:00:00Z'),
      deletedAt: D('2026-01-02T00:00:00Z'),
    },
  ],
  exerciseTranslations: [],

  templates: [
    {
      id: CHAR_TEMPLATE_ID_LIVE,
      name: 'P150 Vorlage (lebend)',
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
      isFavoriteForWatch: false,
    },
    {
      id: CHAR_TEMPLATE_ID_DELETED,
      name: 'P150 Vorlage (gelöscht)',
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
      deletedAt: D('2026-01-01T00:00:00Z'),
      isFavoriteForWatch: false,
    },
    {
      id: CHAR_TEMPLATE_ID_BLOCKLESS,
      name: 'P150 Vorlage (blocklos)',
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
      isFavoriteForWatch: false,
    },
  ],

  blocks: [
    {
      id: CHAR_BLOCK_ID_LIVE,
      templateId: CHAR_TEMPLATE_ID_LIVE,
      name: 'P150 Block',
      rounds: 3,
      orderIndex: 0,
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
    },
  ],

  templateExercises: [
    {
      id: CHAR_TEMPLATE_EXERCISE_ID_LIVE,
      templateId: CHAR_TEMPLATE_ID_LIVE,
      blockId: CHAR_BLOCK_ID_LIVE,
      exerciseId: CHAR_CATALOG_EX_PUSHUP,
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 10,
      restTimeSeconds: 60,
      sets: 3,
      orderIndex: 0,
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
    },
    {
      id: CHAR_TEMPLATE_EXERCISE_ID_BLOCKLESS,
      templateId: CHAR_TEMPLATE_ID_BLOCKLESS,
      exerciseId: CHAR_CATALOG_EX_SQUAT,
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 5,
      restTimeSeconds: 90,
      sets: 1,
      orderIndex: 0,
      createdAt: D('2026-01-01T00:00:00Z'),
      updatedAt: D('2026-01-01T00:00:00Z'),
    },
  ],

  sessions: [
    {
      id: CHAR_SESSION_TPL_LIVE_1,
      templateId: CHAR_TEMPLATE_ID_LIVE,
      startTime: D('2026-01-03T08:00:00Z'),
      endTime: D('2026-01-03T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-03T08:00:00Z'),
      updatedAt: D('2026-01-03T09:00:00Z'),
    },
    {
      id: CHAR_SESSION_TPL_LIVE_2,
      templateId: CHAR_TEMPLATE_ID_LIVE,
      startTime: D('2026-01-10T08:00:00Z'),
      endTime: D('2026-01-10T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-10T08:00:00Z'),
      updatedAt: D('2026-01-10T09:00:00Z'),
    },
    {
      id: CHAR_SESSION_TPL_DELETED,
      templateId: CHAR_TEMPLATE_ID_DELETED,
      startTime: D('2026-01-05T08:00:00Z'),
      endTime: D('2026-01-05T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-05T08:00:00Z'),
      updatedAt: D('2026-01-05T09:00:00Z'),
    },
    {
      id: CHAR_SESSION_TPL_UNKNOWN,
      templateId: CHAR_TEMPLATE_ID_UNKNOWN_REF,
      startTime: D('2026-01-06T08:00:00Z'),
      endTime: D('2026-01-06T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-06T08:00:00Z'),
      updatedAt: D('2026-01-06T09:00:00Z'),
    },
    {
      id: CHAR_SESSION_TEMPLATELESS_1,
      startTime: D('2026-01-07T08:00:00Z'),
      endTime: D('2026-01-07T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-07T08:00:00Z'),
      updatedAt: D('2026-01-07T09:00:00Z'),
    },
    {
      id: CHAR_SESSION_TEMPLATELESS_2,
      startTime: D('2026-01-08T08:00:00Z'),
      endTime: D('2026-01-08T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-08T08:00:00Z'),
      updatedAt: D('2026-01-08T09:00:00Z'),
    },
    {
      id: CHAR_SESSION_QC_1,
      startTime: D('2026-01-09T08:00:00Z'),
      endTime: D('2026-01-09T08:30:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: true,
      createdAt: D('2026-01-09T08:00:00Z'),
      updatedAt: D('2026-01-09T08:30:00Z'),
    },
    {
      id: CHAR_SESSION_QC_WITH_TEMPLATE,
      templateId: CHAR_TEMPLATE_ID_LIVE,
      startTime: D('2026-01-11T08:00:00Z'),
      endTime: D('2026-01-11T08:30:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: true,
      createdAt: D('2026-01-11T08:00:00Z'),
      updatedAt: D('2026-01-11T08:30:00Z'),
    },
    {
      id: CHAR_SESSION_RUNNING,
      startTime: D('2026-01-12T08:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-12T08:00:00Z'),
      updatedAt: D('2026-01-12T08:00:00Z'),
    },
    {
      id: CHAR_SESSION_DELETED,
      startTime: D('2026-01-04T08:00:00Z'),
      endTime: D('2026-01-04T09:00:00Z'),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: D('2026-01-04T08:00:00Z'),
      updatedAt: D('2026-01-15T00:00:00Z'),
      deletedAt: D('2026-01-15T00:00:00Z'),
    },
  ],

  setLogs: [
    {
      id: 'char150-sl-1',
      sessionId: CHAR_SESSION_TPL_LIVE_1,
      exerciseId: CHAR_CATALOG_EX_PUSHUP,
      exerciseSource: 'CATALOG',
      completedReps: 10,
      completedTimeSeconds: null,
      weightUsed: null,
      startedAt: D('2026-01-03T08:05:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-03T08:05:00Z'),
      updatedAt: D('2026-01-03T08:05:00Z'),
    },
    {
      id: 'char150-sl-2',
      sessionId: CHAR_SESSION_TPL_LIVE_1,
      exerciseId: CHAR_CUSTOM_EX_LIVE,
      exerciseSource: 'CUSTOM',
      completedReps: 5,
      completedTimeSeconds: null,
      weightUsed: 8,
      startedAt: D('2026-01-03T08:15:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-03T08:15:00Z'),
      updatedAt: D('2026-01-03T08:15:00Z'),
    },
    {
      id: 'char150-sl-3',
      sessionId: CHAR_SESSION_TPL_LIVE_2,
      exerciseId: CHAR_CATALOG_EX_PUSHUP,
      exerciseSource: 'CATALOG',
      completedReps: 12,
      completedTimeSeconds: null,
      weightUsed: null,
      startedAt: D('2026-01-10T08:05:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-10T08:05:00Z'),
      updatedAt: D('2026-01-10T08:05:00Z'),
    },
    {
      // Set-Log ohne exerciseId, aber mit workoutExerciseId einer Vorlagenübung (D-07 Fixture).
      id: 'char150-sl-no-exercise-id',
      sessionId: CHAR_SESSION_TPL_LIVE_2,
      workoutExerciseId: CHAR_TEMPLATE_EXERCISE_ID_LIVE,
      exerciseSource: 'CATALOG',
      completedReps: 9,
      completedTimeSeconds: null,
      weightUsed: null,
      startedAt: D('2026-01-10T08:15:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-10T08:15:00Z'),
      updatedAt: D('2026-01-10T08:15:00Z'),
    },
    {
      id: 'char150-sl-4',
      sessionId: CHAR_SESSION_TEMPLATELESS_1,
      exerciseId: CHAR_CATALOG_EX_SQUAT,
      exerciseSource: 'CATALOG',
      completedReps: 8,
      completedTimeSeconds: null,
      weightUsed: 40,
      startedAt: D('2026-01-07T08:05:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-07T08:05:00Z'),
      updatedAt: D('2026-01-07T08:05:00Z'),
    },
    {
      id: 'char150-sl-qc1',
      sessionId: CHAR_SESSION_QC_1,
      exerciseId: CHAR_CATALOG_EX_PULLUP,
      exerciseSource: 'CATALOG',
      completedReps: 6,
      completedTimeSeconds: null,
      weightUsed: null,
      startedAt: D('2026-01-09T08:05:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-09T08:05:00Z'),
      updatedAt: D('2026-01-09T08:05:00Z'),
    },
    {
      id: 'char150-sl-deleted-session',
      sessionId: CHAR_SESSION_DELETED,
      exerciseId: CHAR_CATALOG_EX_PUSHUP,
      exerciseSource: 'CATALOG',
      completedReps: 10,
      completedTimeSeconds: null,
      weightUsed: null,
      startedAt: D('2026-01-04T08:05:00Z'),
      measuredTimeSeconds: null,
      createdAt: D('2026-01-04T08:05:00Z'),
      updatedAt: D('2026-01-04T08:05:00Z'),
    },
  ],

  hrSamples: [],

  plannedWorkouts: [
    {
      id: 'char150-pw-1',
      templateId: CHAR_TEMPLATE_ID_LIVE,
      scheduledDate: D('2026-01-05T00:00:00Z'),
      scheduledTime: null,
      note: null,
      recurrenceRule: null,
      recurrenceGroupId: null,
      deletedOccurrencesRaw: null,
      completedSessionId: null,
    },
    {
      id: 'char150-pw-2',
      templateId: CHAR_TEMPLATE_ID_LIVE,
      scheduledDate: D('2026-01-02T00:00:00Z'),
      scheduledTime: '08:00',
      note: null,
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1',
      recurrenceGroupId: 'char150-pw-group',
      deletedOccurrencesRaw: null,
      completedSessionId: null,
    },
  ],

  settings: [{ key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' }],
};

// ---------------------------------------------------------------------------
// getHistory-Pin (D-07, Aufgabe 1): festes Fenster, limit 200, einmal ohne und
// einmal mit exercise-Filter.
// ---------------------------------------------------------------------------

export const CHAR_HISTORY_ARGS: GetHistoryArgs = { from: '2026-01-01', to: '2026-01-31', limit: 200 };
export const CHAR_HISTORY_ARGS_EXERCISE: GetHistoryArgs = {
  from: '2026-01-01',
  to: '2026-01-31',
  limit: 200,
  exercise: CHAR_CATALOG_EX_PUSHUP,
};

// ---------------------------------------------------------------------------
// Aufgabe 2: Args für die übrigen Kennzahl- und Lesefunktionen. Alle laufen gegen
// dasselbe CHAR_SNAPSHOT/CHAR_CATALOG/CHAR_NOW_MS aus Aufgabe 1.
// ---------------------------------------------------------------------------

export const CHAR_TRAINING_STATE_ARGS: GetTrainingStateArgs = {};
export const CHAR_TRAINING_STATE_DATA = {
  snapshot: CHAR_SNAPSHOT,
  catalog: CHAR_CATALOG,
  coachParameters: COACH_PARAMETER_DEFAULTS,
  parametersSource: 'defaults' as const,
};

export const CHAR_STATS_DATA = { snapshot: CHAR_SNAPSHOT, catalog: CHAR_CATALOG };

export const CHAR_ADHERENCE_ARGS: GetAdherenceArgs = { from: '2026-01-01', to: '2026-01-20' };
export const CHAR_ADHERENCE_DATA = {
  snapshot: CHAR_SNAPSHOT,
  catalog: CHAR_CATALOG,
  coachParameters: COACH_PARAMETER_DEFAULTS,
};

export const CHAR_PROGRESS_DATA = {
  snapshot: CHAR_SNAPSHOT,
  catalog: CHAR_CATALOG,
  coachParameters: COACH_PARAMETER_DEFAULTS,
};
export const CHAR_PROGRESS_ARGS_ALL: GetProgressArgs = { kind: 'exercise' };
export const CHAR_PROGRESS_ARGS_ONE: GetProgressArgs = {
  kind: 'exercise',
  exerciseId: CHAR_CATALOG_EX_PUSHUP,
};

export const CHAR_PLANNED_WORKOUTS_ARGS: GetPlannedWorkoutsArgs = {
  from: '2026-01-01',
  to: '2026-01-31',
};

// Ein reiner Blockplan mit zwei Blöcken; der newExercises-Eintrag dedupt per Name
// gegen CHAR_CATALOG_EX_PULLUP ("P150 Pull-Up").
export const CHAR_NEW_PLAN_ARGS: ProposeNewPlanArgs = {
  name: 'P150 Neuplan (reiner Blockplan)',
  rationale: 'P150 D-07 Fixtur — keine echte Absicht',
  newExercises: [
    { tempId: 'char150-newplan-temp-1', name: 'P150 Pull-Up', mode: 'REPS', usesWeight: true },
  ],
  blocks: [
    {
      tempBlockId: 'char150-newplan-block-1',
      rounds: 3,
      orderIndex: 0,
      exercises: [
        {
          exercise: { source: 'catalog', exerciseId: CHAR_CATALOG_EX_PUSHUP },
          mode: 'REPS',
          restTimeSeconds: 60,
          sets: 3,
          orderIndex: 0,
        },
      ],
    },
    {
      tempBlockId: 'char150-newplan-block-2',
      rounds: 4,
      orderIndex: 1,
      exercises: [
        {
          exercise: { source: 'new', tempId: 'char150-newplan-temp-1' },
          mode: 'REPS',
          targetReps: 8,
          restTimeSeconds: 90,
          sets: 3,
          orderIndex: 0,
        },
      ],
    },
  ],
};

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
  });
}
