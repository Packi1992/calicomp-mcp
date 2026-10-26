/**
 * Own exercises, encrypted — the seam `decryptMerge` (Phase 164, CRYPT-01, D-25, O-6;
 * protocol 1.45 §1.9 "Decoded rows", "Links ride in the payload").
 *
 * Every test runs the REAL `getSnapshot()` → `decryptMerge` → catalog projection path with
 * the REAL `decrypt()`; only the three HTTP fetches are mocked. The rows are built by
 * `own-exercise-fixture.ts` as the server sends them (an encrypted row carries placeholders).
 *
 * Coverage:
 *   - a ciphertext exercise and translation come back as the plaintext row shape, byte for
 *     byte the plaintext twin, without `encryptedPayload`;
 *   - plaintext rows (no `encryptedPayload`) pass unchanged;
 *   - an unreadable row lands in `decodeReport.unreadable` with entity, id and reason only,
 *     is left out of the snapshot and never appears with a placeholder name;
 *   - the decrypted links map onto catalog keys through the catalog the MCP holds; an
 *     unknown id is left out and counted, never invented.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CatalogExerciseWire, SyncPullResponse, UserProfileResponse } from '../src/types.js';

vi.mock('../src/http.js');

import { getSnapshot, __resetCache } from '../src/cache.js';
import { createExerciseNameResolver } from '../src/exercise-names.js';
import * as httpModule from '../src/http.js';
import { OWN_TEST_KEY_B64, encryptForTest, ownExercisePair, ownExercisePlaintext, ownTranslationPair } from './own-exercise-fixture.js';

const mockFetchSnapshot = vi.mocked(httpModule.fetchSnapshot);
const mockFetchProfile = vi.mocked(httpModule.fetchProfile);
const mockFetchCatalog = vi.mocked(httpModule.fetchCatalog);

const PAT = 'test-only-token';
const SERVER = 'https://test.example.com';

const PROFILE: UserProfileResponse = {
  userId: 'user-p164',
  email: 'athlete',
  displayName: 'Athlete',
  avatarUrl: '',
  isPremium: false,
  createdAt: 1_700_000_000_000,
};

const EX_ID = '16400000-0000-4000-8000-0000000000a1';
const EX_ID_2 = '16400000-0000-4000-8000-0000000000a2';
const TR_ID = '16400000-0000-4000-8000-0000000000b1';
const TIMES = { createdAt: 1_792_000_000_000, updatedAt: 1_792_000_000_100 };

function makePull(partial: Partial<SyncPullResponse> = {}): SyncPullResponse {
  return {
    syncedAt: 1_792_000_001_000,
    exercises: [],
    exerciseTranslations: [],
    templates: [],
    blocks: [],
    templateExercises: [],
    sessions: [],
    setLogs: [],
    hrSamples: [],
    trainingState: null,
    ...partial,
  };
}

beforeEach(() => {
  __resetCache();
  vi.resetAllMocks();
  mockFetchProfile.mockResolvedValue(PROFILE);
  mockFetchCatalog.mockResolvedValue([]);
});

describe('decryptMerge: own exercises (Phase 164)', () => {
  it('P164 decryptMerge turns ciphertext rows back into exercise and translation rows', async () => {
    const ex = ownExercisePair(
      { id: EX_ID, name: 'Ringstütz tief', mode: 'TIME', usesWeight: true, description: 'Ellbogen eng.' },
      TIMES,
    );
    const tr = ownTranslationPair(
      { id: TR_ID, exerciseId: EX_ID, languageCode: 'en', name: 'Deep ring support', description: null },
      TIMES,
    );
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ exercises: [ex.encrypted], exerciseTranslations: [tr.encrypted] }));

    const { snapshot, decodeReport } = await getSnapshot(PAT, OWN_TEST_KEY_B64, SERVER);

    // Exactly the plaintext twin: same keys in the same order, no ciphertext left behind.
    expect(snapshot.exercises).toStrictEqual([ex.plaintext]);
    expect(Object.keys(snapshot.exercises[0])).toEqual(Object.keys(ex.plaintext));
    expect(JSON.stringify(snapshot.exercises)).toBe(JSON.stringify([ex.plaintext]));
    expect(snapshot.exerciseTranslations).toStrictEqual([tr.plaintext]);
    expect(JSON.stringify(snapshot.exerciseTranslations)).toBe(JSON.stringify([tr.plaintext]));
    expect(JSON.stringify(snapshot)).not.toContain('encryptedPayload');

    expect(decodeReport?.encryptedCount.exercise).toBe(1);
    expect(decodeReport?.encryptedCount.exerciseTranslation).toBe(1);
    expect(decodeReport?.failedCount.exercise).toBe(0);
    expect(decodeReport?.failedCount.exerciseTranslation).toBe(0);
    expect(decodeReport?.unreadable).toEqual([]);
  });

  it('P164 plaintext rows pass unchanged', async () => {
    const ex = ownExercisePair({ id: EX_ID, name: 'Klimmzug breit', mode: 'REPS', usesWeight: false, description: null }, TIMES);
    const tr = ownTranslationPair({ id: TR_ID, exerciseId: EX_ID, languageCode: 'en', name: 'Wide pull-up', description: 'Slow.' }, TIMES);
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ exercises: [ex.plaintext], exerciseTranslations: [tr.plaintext] }));

    const { snapshot, decodeReport } = await getSnapshot(PAT, OWN_TEST_KEY_B64, SERVER);

    expect(snapshot.exercises).toStrictEqual([ex.plaintext]);
    expect(snapshot.exerciseTranslations).toStrictEqual([tr.plaintext]);
    // A row without ciphertext is no decrypt attempt — it never counts towards a wrong key.
    expect(decodeReport?.encryptedCount.exercise).toBe(0);
    expect(decodeReport?.encryptedCount.exerciseTranslation).toBe(0);
    expect(decodeReport?.unreadable).toEqual([]);
    // Without ciphertext there are no decoded links to carry.
    expect(snapshot.ownExerciseLinks).toBeUndefined();
  });

  it('P164 an unreadable row goes to the decode report and never shows a placeholder name', async () => {
    const good = ownExercisePair({ id: EX_ID, name: 'Lesbar', mode: 'REPS', usesWeight: false, description: null }, TIMES);
    const tamperedId = '16400000-0000-4000-8000-0000000000c1';
    const emptyId = '16400000-0000-4000-8000-0000000000c2';
    const v2Id = '16400000-0000-4000-8000-0000000000c3';
    const tamperedEnvelope = JSON.parse(encryptForTest(ownExercisePlaintext(
      { id: tamperedId, name: 'Geheim eins', mode: 'REPS', usesWeight: false, description: null }, TIMES.updatedAt,
    ))) as { iv: string; ct: string };
    const ctBytes = Buffer.from(tamperedEnvelope.ct, 'base64');
    ctBytes[0] ^= 0xff;
    const placeholders = { name: '', mode: 'REPS', usesWeight: false };
    const rows = [
      good.encrypted,
      { id: tamperedId, ...placeholders, encryptedPayload: JSON.stringify({ iv: tamperedEnvelope.iv, ct: ctBytes.toString('base64') }), ...TIMES },
      { id: emptyId, ...placeholders, encryptedPayload: '', ...TIMES },
      {
        id: v2Id,
        ...placeholders,
        encryptedPayload: encryptForTest(JSON.stringify({ v: 2, id: v2Id, name: 'Geheim zwei' })),
        ...TIMES,
      },
    ];
    const badTranslation = ownTranslationPair(
      // The payload names another exercise than the row: rule 5, malformed.
      { id: TR_ID, exerciseId: EX_ID_2, languageCode: 'en', name: 'Geheim drei', description: null },
      TIMES,
    ).encrypted;
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({ exercises: rows, exerciseTranslations: [{ ...badTranslation, exerciseId: EX_ID }] }),
    );

    const { snapshot, catalog, decodeReport } = await getSnapshot(PAT, OWN_TEST_KEY_B64, SERVER);

    expect(snapshot.exercises).toStrictEqual([good.plaintext]);
    expect(snapshot.exerciseTranslations).toEqual([]);
    expect(decodeReport?.unreadable).toEqual([
      { entity: 'exercise', id: tamperedId, reason: 'decrypt_failed', ...TIMES },
      { entity: 'exercise', id: emptyId, reason: 'malformed_payload', ...TIMES },
      { entity: 'exercise', id: v2Id, reason: 'unknown_version', ...TIMES },
      { entity: 'exerciseTranslation', id: TR_ID, reason: 'malformed_payload', ...TIMES },
    ]);
    // An empty payload is no ciphertext: counted as failed, not as a decrypt attempt.
    expect(decodeReport?.encryptedCount.exercise).toBe(3);
    expect(decodeReport?.failedCount.exercise).toBe(3);
    expect(decodeReport?.encryptedCount.exerciseTranslation).toBe(1);
    expect(decodeReport?.failedCount.exerciseTranslation).toBe(1);

    // Never a placeholder name, never content of an unreadable row anywhere.
    expect(catalog.map((ex) => ex.nameEn)).toEqual(['Lesbar']);
    expect(catalog.some((ex) => ex.nameEn === '')).toBe(false);
    const everything = JSON.stringify({ snapshot, catalog, decodeReport });
    for (const secret of ['Geheim eins', 'Geheim zwei', 'Geheim drei']) expect(everything).not.toContain(secret);
    const resolver = createExerciseNameResolver({ catalog, snapshot });
    for (const id of [tamperedId, emptyId, v2Id]) {
      expect(resolver.forExerciseId(id)).toEqual({ exerciseName: null, exerciseKey: null, exerciseUnknown: true });
    }
  });

  it('P164 links of an own exercise map to catalog keys and an unknown id is reported', async () => {
    const MG_LATS = '16400000-0000-4000-8000-000000000101';
    const MG_BICEPS = '16400000-0000-4000-8000-000000000102';
    const MG_UNKNOWN = '16400000-0000-4000-8000-000000000199';
    const EQ_RINGS = '16400000-0000-4000-8000-000000000201';
    const EQ_UNKNOWN = '16400000-0000-4000-8000-000000000299';
    const CAP_PULL = '16400000-0000-4000-8000-000000000301';
    const CAP_GRIP = '16400000-0000-4000-8000-000000000302';
    const CAP_UNKNOWN = '16400000-0000-4000-8000-000000000399';
    const latsTr = [{ languageCode: 'de', name: 'Breiter Rückenmuskel' }];
    const curated: CatalogExerciseWire[] = [
      {
        id: '16400000-0000-4000-8000-0000000000f1', key: 'pull_up', nameEn: 'Pull-Up', mode: 'REPS', usesWeight: false,
        lastModifiedAt: 1, translations: [],
        muscleGroups: [{ id: MG_LATS, key: 'lats', translations: latsTr, involvementLevel: 'PRIMARY' }],
        equipment: [{ equipmentId: EQ_RINGS, key: 'rings', nameEn: 'Rings', isOptional: false }],
        capabilities: [{ id: CAP_PULL, key: 'pull_strength', translations: [], capabilityLevel: 'HAUPTREIZ' }],
      },
      {
        id: '16400000-0000-4000-8000-0000000000f2', key: 'chin_up', nameEn: 'Chin-Up', mode: 'REPS', usesWeight: false,
        lastModifiedAt: 1, translations: [],
        muscleGroups: [{ id: MG_BICEPS, key: 'biceps', translations: [], involvementLevel: 'SECONDARY' }],
        capabilities: [{ id: CAP_GRIP, key: 'grip', translations: [], capabilityLevel: 'GERING' }],
      },
    ];
    mockFetchCatalog.mockResolvedValueOnce(curated);
    const ex = ownExercisePair(
      {
        id: EX_ID, name: 'Ringklimmzug', mode: 'REPS', usesWeight: false, description: null,
        muscleGroups: [
          { id: MG_LATS, level: 'SECONDARY' },
          { id: MG_BICEPS, level: null },
          { id: MG_UNKNOWN, level: 'PRIMARY' },
        ],
        equipment: [
          { id: EQ_RINGS, optional: true },
          { id: EQ_UNKNOWN, optional: false },
        ],
        capabilities: [
          { id: CAP_PULL, level: 'MITTRAINIERT' },
          { id: CAP_GRIP, level: null },
          { id: CAP_UNKNOWN, level: 'GERING' },
        ],
      },
      TIMES,
    );
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ exercises: [ex.encrypted] }));

    const { catalog, decodeReport, snapshot } = await getSnapshot(PAT, OWN_TEST_KEY_B64, SERVER);

    const own = catalog.find((entry) => entry.id === EX_ID);
    expect(own?.origin).toBe('CUSTOM');
    expect(own?.muscleGroups).toEqual([
      { id: MG_LATS, key: 'lats', translations: latsTr, involvementLevel: 'SECONDARY' },
      // A muscle link without level reads as PRIMARY, the server's and the app's rule (D-03).
      { id: MG_BICEPS, key: 'biceps', translations: [], involvementLevel: 'PRIMARY' },
    ]);
    expect(own?.equipment).toEqual([{ equipmentId: EQ_RINGS, key: 'rings', nameEn: 'Rings', isOptional: true }]);
    // A capability without level has no grade to weigh (D-04): left out and counted, never graded.
    expect(own?.capabilities).toEqual([{ id: CAP_PULL, key: 'pull_strength', translations: [], capabilityLevel: 'MITTRAINIERT' }]);
    expect(own?.isSkill).toBe(false);
    expect(decodeReport?.ownExerciseLinksLeftOut).toEqual({
      unknownMuscleGroup: 1,
      unknownEquipment: 1,
      unknownCapability: 1,
      capabilityWithoutLevel: 1,
    });
    // The snapshot carries the decoded links beside the exercise, keyed by its id.
    expect(snapshot.ownExerciseLinks?.[EX_ID]?.muscleGroups).toHaveLength(3);
    // The old KDoc that denied links to user exercises is gone (D-25).
    const cacheSource = readFileSync(new URL('../src/cache.ts', import.meta.url), 'utf8');
    expect(cacheSource).not.toContain('a user exercise\n * carries none of that server-side');
    expect(cacheSource).not.toContain('carries none of that server-side');
  });
});
