/**
 * Shared test fixture for CalisthenicsCompanion-MCP tool tests.
 *
 * Provides a pre-decrypted DecryptedSnapshot and CatalogExercise[] with:
 *   - 2 sessions with known startTime/endTime (already decrypted; no encryptedPayload)
 *   - ≥3 setLogs per session with known weightUsed / completedReps / exerciseId
 *   - 2 templates with blocks + templateExercises
 *   - 3 catalog exercises (ex-push-up + ex-pull-up share "back"; ex-squat is "quads")
 *     → two exercises sharing a muscle key, enabling by-muscle stats tests
 *
 * exerciseId values in setLogs cross-reference catalog ids for muscle lookups.
 *
 * Shape source: SyncDtos.kt (wire shapes) + Dtos.kt (catalog shape)
 *
 * Phase 138 (MUSC-06): every `CatalogMuscleGroup` link below carries
 * `involvementLevel: 'PRIMARY'` — the required field's default, chosen deliberately so
 * every pre-138 test built on this shared fixture keeps its exact numbers (D-03: an
 * uncurated/PRIMARY link resolves to the full weight, identical to the flat pre-138
 * counting). Tests exercising SECONDARY/STABILIZER weighting build their own local
 * catalog fixtures instead of overriding this shared one (see
 * tests/training-state/muscle-similarity.test.ts and tests/tools/get_stats.test.ts).
 */

import type { DecryptedSnapshot, CatalogExercise } from '../src/types.js';

// ---------------------------------------------------------------------------
// Catalog exercises (from GET /api/exercises — public, unauthenticated)
// Two exercises (push-up, pull-up) share the 'back' muscle key for muscle stats tests.
// ---------------------------------------------------------------------------

export const CATALOG_EXERCISE_ID_PUSHUP  = 'aaaaaaaa-0001-4000-a000-000000000001';
export const CATALOG_EXERCISE_ID_PULLUP  = 'aaaaaaaa-0001-4000-a000-000000000002';
export const CATALOG_EXERCISE_ID_SQUAT   = 'aaaaaaaa-0001-4000-a000-000000000003';

export const mockCatalog: CatalogExercise[] = [
  {
    id: CATALOG_EXERCISE_ID_PUSHUP,
    key: 'push_up',
    nameEn: 'Push-Up',
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [{ languageCode: 'de', name: 'Liegestütz' }],
    muscleGroups: [
      {
        id: 'mg-chest',
        key: 'chest',
        translations: [{ languageCode: 'de', name: 'Brust' }],
        involvementLevel: 'PRIMARY',
      },
      {
        id: 'mg-back-1',
        key: 'back',
        translations: [{ languageCode: 'de', name: 'Rücken' }],
        involvementLevel: 'PRIMARY',
      },
    ],
    equipment: [],
    capabilities: [],
  },
  {
    id: CATALOG_EXERCISE_ID_PULLUP,
    key: 'pull_up',
    nameEn: 'Pull-Up',
    mode: 'REPS',
    usesWeight: true,
    lastModifiedAt: 1_700_000_000_000,
    translations: [{ languageCode: 'de', name: 'Klimmzug' }],
    muscleGroups: [
      {
        id: 'mg-back-2',
        key: 'back',
        translations: [{ languageCode: 'de', name: 'Rücken' }],
        involvementLevel: 'PRIMARY',
      },
      {
        id: 'mg-lats',
        key: 'lats',
        translations: [{ languageCode: 'de', name: 'Latissimus' }],
        involvementLevel: 'PRIMARY',
      },
    ],
    equipment: [],
    capabilities: [],
  },
  {
    id: CATALOG_EXERCISE_ID_SQUAT,
    key: 'squat',
    nameEn: 'Squat',
    mode: 'REPS',
    usesWeight: true,
    lastModifiedAt: 1_700_000_000_000,
    translations: [{ languageCode: 'de', name: 'Kniebeuge' }],
    muscleGroups: [
      {
        id: 'mg-quads',
        key: 'quads',
        translations: [{ languageCode: 'de', name: 'Quadrizeps' }],
        involvementLevel: 'PRIMARY',
      },
      {
        id: 'mg-glutes',
        key: 'glutes',
        translations: [{ languageCode: 'de', name: 'Gesäß' }],
        involvementLevel: 'PRIMARY',
      },
    ],
    equipment: [],
    capabilities: [],
  },
];

// ---------------------------------------------------------------------------
// Session IDs + known time values
// ---------------------------------------------------------------------------

export const SESSION_ID_A = 'bbbbbbbb-0002-4000-b000-000000000001';
export const SESSION_ID_B = 'bbbbbbbb-0002-4000-b000-000000000002';

// 2024-03-01T08:00:00Z  (epoch ms)
const SESSION_A_START = 1_709_280_000_000;
const SESSION_A_END   = 1_709_283_600_000; // +1 hour

// 2024-03-08T08:00:00Z  (epoch ms)
const SESSION_B_START = 1_709_884_800_000;
const SESSION_B_END   = 1_709_888_400_000; // +1 hour

// ---------------------------------------------------------------------------
// Template IDs
// ---------------------------------------------------------------------------

export const TEMPLATE_ID_PUSH   = 'cccccccc-0003-4000-c000-000000000001';
export const TEMPLATE_ID_LEGS   = 'cccccccc-0003-4000-c000-000000000002';
export const BLOCK_ID_PUSH_A    = 'dddddddd-0004-4000-d000-000000000001';
export const BLOCK_ID_LEGS_A    = 'dddddddd-0004-4000-d000-000000000002';
export const TE_ID_PUSH_PUSHUP  = 'eeeeeeee-0005-4000-e000-000000000001';
export const TE_ID_PUSH_PULLUP  = 'eeeeeeee-0005-4000-e000-000000000002';
export const TE_ID_LEGS_SQUAT   = 'eeeeeeee-0005-4000-e000-000000000003';

// ---------------------------------------------------------------------------
// Set-log IDs (3 per session)
// ---------------------------------------------------------------------------

const SL_A1 = 'ffffffff-0006-4000-f000-000000000001';
const SL_A2 = 'ffffffff-0006-4000-f000-000000000002';
const SL_A3 = 'ffffffff-0006-4000-f000-000000000003';
const SL_B1 = 'ffffffff-0006-4000-f000-000000000004';
const SL_B2 = 'ffffffff-0006-4000-f000-000000000005';
const SL_B3 = 'ffffffff-0006-4000-f000-000000000006';

// ---------------------------------------------------------------------------
// Shared decrypted snapshot
// ---------------------------------------------------------------------------

export const mockSnapshot: DecryptedSnapshot = {
  syncedAt: 1_710_000_000_000,

  exercises: [],                // user's own exercises (not catalog)
  exerciseTranslations: [],

  templates: [
    {
      id: TEMPLATE_ID_PUSH,
      name: 'Push Day',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      isFavoriteForWatch: true,
    },
    {
      id: TEMPLATE_ID_LEGS,
      name: 'Leg Day',
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
      isFavoriteForWatch: false,
    },
  ],

  blocks: [
    {
      id: BLOCK_ID_PUSH_A,
      templateId: TEMPLATE_ID_PUSH,
      name: 'Main Block',
      rounds: 3,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    {
      id: BLOCK_ID_LEGS_A,
      templateId: TEMPLATE_ID_LEGS,
      name: 'Squat Block',
      rounds: 4,
      orderIndex: 0,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    },
  ],

  templateExercises: [
    {
      id: TE_ID_PUSH_PUSHUP,
      templateId: TEMPLATE_ID_PUSH,
      blockId: BLOCK_ID_PUSH_A,
      exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 15,
      restTimeSeconds: 60,
      sets: 3,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    {
      id: TE_ID_PUSH_PULLUP,
      templateId: TEMPLATE_ID_PUSH,
      blockId: BLOCK_ID_PUSH_A,
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 8,
      targetWeight: 10,
      restTimeSeconds: 90,
      sets: 3,
      orderIndex: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    {
      id: TE_ID_LEGS_SQUAT,
      templateId: TEMPLATE_ID_LEGS,
      blockId: BLOCK_ID_LEGS_A,
      exerciseId: CATALOG_EXERCISE_ID_SQUAT,
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 5,
      targetWeight: 80,
      restTimeSeconds: 120,
      sets: 5,
      orderIndex: 0,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    },
  ],

  sessions: [
    {
      id: SESSION_ID_A,
      templateId: TEMPLATE_ID_PUSH,
      startTime: SESSION_A_START,
      endTime: SESSION_A_END,
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: SESSION_A_START,
      updatedAt: SESSION_A_END,
    },
    {
      id: SESSION_ID_B,
      templateId: TEMPLATE_ID_LEGS,
      startTime: SESSION_B_START,
      endTime: SESSION_B_END,
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: SESSION_B_START,
      updatedAt: SESSION_B_END,
    },
  ],

  setLogs: [
    // Session A — Push Day: push-ups (bodyweight) + weighted pull-ups
    {
      id: SL_A1,
      sessionId: SESSION_ID_A,
      exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
      exerciseSource: 'CATALOG',
      completedReps: 15,
      completedTimeSeconds: null,
      weightUsed: null,         // bodyweight — e1RM = null
      startedAt: SESSION_A_START + 60_000,
      measuredTimeSeconds: null,
      createdAt: SESSION_A_START,
      updatedAt: SESSION_A_START,
    },
    {
      id: SL_A2,
      sessionId: SESSION_ID_A,
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      exerciseSource: 'CATALOG',
      completedReps: 8,
      completedTimeSeconds: null,
      weightUsed: 10,           // 10 kg added weight → e1RM = 10*(1+8/30) = 12.666...
      startedAt: SESSION_A_START + 180_000,
      measuredTimeSeconds: null,
      createdAt: SESSION_A_START,
      updatedAt: SESSION_A_START,
    },
    {
      id: SL_A3,
      sessionId: SESSION_ID_A,
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      exerciseSource: 'CATALOG',
      completedReps: 6,
      completedTimeSeconds: null,
      weightUsed: 10,           // 10 kg → e1RM = 10*(1+6/30) = 12.0
      startedAt: SESSION_A_START + 300_000,
      measuredTimeSeconds: null,
      createdAt: SESSION_A_START,
      updatedAt: SESSION_A_START,
    },
    // Session B — Leg Day: squats with barbell
    {
      id: SL_B1,
      sessionId: SESSION_ID_B,
      exerciseId: CATALOG_EXERCISE_ID_SQUAT,
      exerciseSource: 'CATALOG',
      completedReps: 5,
      completedTimeSeconds: null,
      weightUsed: 80,           // 80 kg → e1RM = 80*(1+5/30) = 93.333...
      startedAt: SESSION_B_START + 60_000,
      measuredTimeSeconds: null,
      createdAt: SESSION_B_START,
      updatedAt: SESSION_B_START,
    },
    {
      id: SL_B2,
      sessionId: SESSION_ID_B,
      exerciseId: CATALOG_EXERCISE_ID_SQUAT,
      exerciseSource: 'CATALOG',
      completedReps: 5,
      completedTimeSeconds: null,
      weightUsed: 85,           // 85 kg → e1RM = 85*(1+5/30) = 99.166...  ← best
      startedAt: SESSION_B_START + 180_000,
      measuredTimeSeconds: null,
      createdAt: SESSION_B_START,
      updatedAt: SESSION_B_START,
    },
    {
      id: SL_B3,
      sessionId: SESSION_ID_B,
      exerciseId: CATALOG_EXERCISE_ID_SQUAT,
      exerciseSource: 'CATALOG',
      completedReps: 3,
      completedTimeSeconds: null,
      weightUsed: 90,           // 90 kg × 3 reps → e1RM = 90*(1+3/30) = 99.0
      startedAt: SESSION_B_START + 300_000,
      measuredTimeSeconds: null,
      createdAt: SESSION_B_START,
      updatedAt: SESSION_B_START,
    },
  ],

  hrSamples: [],
  plannedWorkouts: [],
  // Phase 137 (D-03): no synced settings by default — tests exercising
  // `training_timezone_id` build their own snapshot via `{ ...mockSnapshot, settings: [...] }`.
  settings: [],
};
