/**
 * cache.ts — getSnapshot() unit tests.
 *
 * Covers the four <behavior> cases from 120-05-PLAN.md:
 *   1. Session with encryptedPayload → decrypt-merge resolves startTime/endTime
 *   2. Session without encryptedPayload → plaintext fields used unchanged
 *   3. SetLog with encryptedPayload → decrypt-merge resolves metric fields
 *   4. SetLog without encryptedPayload → plaintext metrics used (undefined→null)
 *   5. Concurrent first-calls coalesce into ONE fetch (T-120-15)
 *   6. After TTL expiry a subsequent call re-fetches
 *
 * HTTP module and crypto.decrypt are mocked so tests run offline with no
 * real server or real AES keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SyncPullResponse,
  UserProfileResponse,
  CatalogExerciseWire,
  SyncExerciseDto,
  SyncExerciseTranslationDto,
} from '../src/types.js';

// ── Module mocks (hoisted by vitest before static imports) ──────────────────
vi.mock('../src/http.js');
vi.mock('../src/crypto.js');

// ── Imports after mocks ──────────────────────────────────────────────────────
import { getSnapshot, __resetCache, projectUserExerciseToCatalog } from '../src/cache.js';
import * as httpModule from '../src/http.js';
import * as cryptoModule from '../src/crypto.js';

const mockFetchSnapshot = vi.mocked(httpModule.fetchSnapshot);
const mockFetchProfile  = vi.mocked(httpModule.fetchProfile);
const mockFetchCatalog  = vi.mocked(httpModule.fetchCatalog);
const mockDecrypt       = vi.mocked(cryptoModule.decrypt);

// ── Test constants ───────────────────────────────────────────────────────────

const PAT     = 'calicomp_pat_testonly';
const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const URL     = 'https://test.example.com';

const MOCK_PROFILE: UserProfileResponse = {
  userId: 'user-test-1',
  email:  'test@example.com',
  displayName: 'Test User',
  avatarUrl:   'https://example.com/avatar.svg',
  isPremium: false,
  createdAt: 1_700_000_000_000,
};

/** Build a minimal SyncPullResponse, overridable per test. */
function makePull(partial: Partial<SyncPullResponse> = {}): SyncPullResponse {
  return {
    syncedAt:             1_710_000_000_000,
    exercises:            [],
    exerciseTranslations: [],
    templates:            [],
    blocks:               [],
    templateExercises:    [],
    sessions:             [],
    setLogs:              [],
    hrSamples:            [],
    trainingState:        null,
    ...partial,
  };
}

// ── Test lifecycle ───────────────────────────────────────────────────────────

beforeEach(() => {
  __resetCache();
  vi.resetAllMocks();
  // Default: profile + catalog resolve immediately; snapshot needs per-test setup.
  mockFetchProfile.mockResolvedValue(MOCK_PROFILE);
  mockFetchCatalog.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Decrypt-merge: session paths ─────────────────────────────────────────────

describe('decrypt-merge: session', () => {
  it('uses plaintext startTime/endTime when encryptedPayload is absent', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-1',
            startTime: 1_709_280_000_000,
            endTime:   1_709_283_600_000,
            isManual: false, isCorrected: false, isQuickChallenge: false,
            createdAt: 1_709_280_000_000, updatedAt: 1_709_280_000_000,
            // no encryptedPayload → plaintext path
          },
        ],
      }),
    );

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].startTime).toBe(1_709_280_000_000);
    expect(snapshot.sessions[0].endTime).toBe(1_709_283_600_000);
    // decrypt must NOT have been called for a plaintext session
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('decrypts encryptedPayload and resolves startTime/endTime for encrypted sessions', async () => {
    const ENCRYPTED_SESSION_PAYLOAD = '{"iv":"mockIv","ct":"mockCt"}';
    const DECRYPTED_SESSION_JSON    = '{"st":1709280000000,"et":1709283600000}';

    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-enc-1',
            startTime: 0,          // zeroed — real value in encryptedPayload
            endTime:   undefined,  // zeroed
            encryptedPayload: ENCRYPTED_SESSION_PAYLOAD,
            isManual: false, isCorrected: false, isQuickChallenge: false,
            createdAt: 0, updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(DECRYPTED_SESSION_JSON);

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].startTime).toBe(1_709_280_000_000);
    expect(snapshot.sessions[0].endTime).toBe(1_709_283_600_000);
    expect(mockDecrypt).toHaveBeenCalledWith(ENCRYPTED_SESSION_PAYLOAD, KEY_B64);
  });

  it('sets endTime to undefined when encrypted et <= 0 (ongoing session)', async () => {
    const PAYLOAD = '{"iv":"i","ct":"c"}';
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-ongoing',
            startTime: 0, endTime: undefined,
            encryptedPayload: PAYLOAD,
            isManual: false, isCorrected: false, isQuickChallenge: false,
            createdAt: 0, updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce('{"st":1709280000000,"et":0}'); // et=0 → ongoing

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.sessions[0].startTime).toBe(1_709_280_000_000);
    expect(snapshot.sessions[0].endTime).toBeUndefined();
  });
});

// ── Decrypt-merge: set-log paths ──────────────────────────────────────────────

describe('decrypt-merge: set-log', () => {
  it('uses plaintext metric fields (converted to null) when encryptedPayload is absent', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        setLogs: [
          {
            id: 'sl-plain',
            sessionId: 'sess-1',
            completedReps: 10,
            weightUsed: 50.5,
            // completedTimeSeconds / startedAt / measuredTimeSeconds are absent → null
            createdAt: 1_709_280_000_000, updatedAt: 1_709_280_000_000,
            // no encryptedPayload → plaintext path
          },
        ],
      }),
    );

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.setLogs).toHaveLength(1);
    const sl = snapshot.setLogs[0];
    expect(sl.completedReps).toBe(10);
    expect(sl.weightUsed).toBe(50.5);
    expect(sl.completedTimeSeconds).toBeNull();
    expect(sl.startedAt).toBeNull();
    expect(sl.measuredTimeSeconds).toBeNull();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('decrypts encryptedPayload and resolves metric fields for encrypted set-logs', async () => {
    const ENCRYPTED_SL_PAYLOAD = '{"iv":"slIv","ct":"slCt"}';
    const DECRYPTED_SL_JSON    = '{"r":8,"w":10.0}'; // t, sa, mt absent → null

    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        setLogs: [
          {
            id: 'sl-enc-1',
            sessionId: 'sess-1',
            // all metric fields zeroed when encrypted
            completedReps:        undefined,
            completedTimeSeconds: undefined,
            weightUsed:           undefined,
            startedAt:            undefined,
            measuredTimeSeconds:  undefined,
            encryptedPayload: ENCRYPTED_SL_PAYLOAD,
            createdAt: 0, updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(DECRYPTED_SL_JSON);

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.setLogs).toHaveLength(1);
    const sl = snapshot.setLogs[0];
    expect(sl.completedReps).toBe(8);
    expect(sl.weightUsed).toBe(10.0);
    expect(sl.completedTimeSeconds).toBeNull();
    expect(sl.startedAt).toBeNull();
    expect(sl.measuredTimeSeconds).toBeNull();
    expect(mockDecrypt).toHaveBeenCalledWith(ENCRYPTED_SL_PAYLOAD, KEY_B64);
  });
});

// ── Concurrent-call coalescing (T-120-15) ────────────────────────────────────

describe('concurrent-call coalescing', () => {
  it('coalesces two simultaneous first-calls into a single fetchSnapshot call', async () => {
    let resolveFetch!: (v: SyncPullResponse) => void;
    const deferred = new Promise<SyncPullResponse>(r => { resolveFetch = r; });
    mockFetchSnapshot.mockReturnValue(deferred);

    // Start two calls before the fetch resolves
    const p1 = getSnapshot(PAT, KEY_B64, URL);
    const p2 = getSnapshot(PAT, KEY_B64, URL);

    // Now let the deferred fetch complete
    resolveFetch(makePull({ syncedAt: 999 }));

    const [r1, r2] = await Promise.all([p1, p2]);

    // fetchSnapshot must have been called only once
    expect(mockFetchSnapshot).toHaveBeenCalledTimes(1);
    // Both callers received the same data
    expect(r1.snapshot.syncedAt).toBe(999);
    expect(r2.snapshot.syncedAt).toBe(999);
  });
});

// ── Decrypt-merge: planned workouts (Phase 135, D-14) ────────────────────────

describe('decrypt-merge: planned workouts', () => {
  it('a wire response whose plannedWorkouts key is absent yields an empty array and does not throw', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(makePull({}));

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.plannedWorkouts).toEqual([]);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('decrypts a single row into a DecryptedPlannedWorkout carrying completedSessionId and no calendarEventId/createdAt key', async () => {
    const ENCRYPTED_PW_PAYLOAD = '{"iv":"pwIv","ct":"pwCt"}';
    const DECRYPTED_PW_JSON = JSON.stringify({
      v: 1,
      id: 'root-1',
      templateId: 'tpl-1',
      scheduledDate: 1_749_600_000_000,
      scheduledTime: null,
      note: null,
      recurrenceRule: null,
      recurrenceGroupId: null,
      deletedOccurrences: null,
      completedSessionId: 'session-1',
      calendarEventId: 123,
      createdAt: 1_700_000_000_000,
    });

    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        plannedWorkouts: [
          {
            id: 'row-1',
            kind: 'planned_workout',
            clientLocalId: 'root-1',
            encryptedPayload: ENCRYPTED_PW_PAYLOAD,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(DECRYPTED_PW_JSON);

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.plannedWorkouts).toHaveLength(1);
    const pw = snapshot.plannedWorkouts[0];
    expect(pw.id).toBe('root-1');
    expect(pw.completedSessionId).toBe('session-1');
    expect(pw).not.toHaveProperty('calendarEventId');
    expect(pw).not.toHaveProperty('createdAt');
    expect(mockDecrypt).toHaveBeenCalledWith(ENCRYPTED_PW_PAYLOAD, KEY_B64);
  });

  it('a payload whose v is 2 makes getSnapshot reject, naming the row id and not the PAT or key', async () => {
    const ENCRYPTED_PW_PAYLOAD = '{"iv":"pwIv","ct":"pwCt"}';
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        plannedWorkouts: [
          {
            id: 'row-future-schema',
            kind: 'planned_workout',
            clientLocalId: 'root-future',
            encryptedPayload: ENCRYPTED_PW_PAYLOAD,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(JSON.stringify({ v: 2, id: 'root-future', templateId: 'tpl-1', scheduledDate: 0 }));

    await expect(getSnapshot(PAT, KEY_B64, URL)).rejects.toThrow(/row-future-schema/);
    // Reset the cache + mocks for a second call asserting the negative (no secret leaked).
    __resetCache();
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        plannedWorkouts: [
          {
            id: 'row-future-schema',
            kind: 'planned_workout',
            clientLocalId: 'root-future',
            encryptedPayload: ENCRYPTED_PW_PAYLOAD,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(JSON.stringify({ v: 2, id: 'root-future', templateId: 'tpl-1', scheduledDate: 0 }));
    let message = '';
    try {
      await getSnapshot(PAT, KEY_B64, URL);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(PAT);
    expect(message).not.toContain(KEY_B64);
  });

  it('a row whose encryptedPayload is the empty string makes getSnapshot reject, naming the row id (133 D-03 tombstone contract)', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        plannedWorkouts: [
          {
            id: 'row-tombstone',
            kind: 'planned_workout',
            clientLocalId: 'root-gone',
            encryptedPayload: '',
            createdAt: 0,
            updatedAt: 0,
            deletedAt: 1_700_000_000_000,
          },
        ],
      }),
    );

    await expect(getSnapshot(PAT, KEY_B64, URL)).rejects.toThrow(/row-tombstone/);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('a decrypt that throws makes getSnapshot reject rather than returning a shorter plannedWorkouts list', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        plannedWorkouts: [
          {
            id: 'row-corrupt',
            kind: 'planned_workout',
            clientLocalId: 'root-corrupt',
            encryptedPayload: '{"iv":"bad","ct":"bad"}',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error('auth tag mismatch');
    });

    await expect(getSnapshot(PAT, KEY_B64, URL)).rejects.toThrow(/auth tag mismatch/);
  });
});

// ── Decrypt-merge: settings (Phase 137, D-03) ────────────────────────────────

describe('decrypt-merge: settings', () => {
  it('decrypts a training_timezone_id row into a DecryptedSetting on snapshot.settings', async () => {
    const ENCRYPTED_SETTING_PAYLOAD = '{"iv":"tzIv","ct":"tzCt"}';
    const DECRYPTED_SETTING_JSON = JSON.stringify({ v: 1, t: 's', value: 'Europe/Berlin' });

    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        settings: [
          {
            id: 'row-tz-1',
            kind: 'settings',
            clientLocalId: 'training_timezone_id',
            encryptedPayload: ENCRYPTED_SETTING_PAYLOAD,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(DECRYPTED_SETTING_JSON);

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.settings).toHaveLength(1);
    expect(snapshot.settings[0]).toEqual({ key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' });
    expect(mockDecrypt).toHaveBeenCalledWith(ENCRYPTED_SETTING_PAYLOAD, KEY_B64);
  });

  it('a settings row with an empty encryptedPayload makes getSnapshot reject with a named error, not a half-filled list', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        settings: [
          {
            id: 'row-tombstone',
            kind: 'settings',
            clientLocalId: 'training_timezone_id',
            encryptedPayload: '',
            createdAt: 0,
            updatedAt: 0,
            deletedAt: 1_700_000_000_000,
          },
        ],
      }),
    );

    await expect(getSnapshot(PAT, KEY_B64, URL)).rejects.toThrow(/row-tombstone/);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('a wire response whose settings key is entirely absent yields an empty array (server predates Plan 137-03)', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(makePull({}));

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot.settings).toEqual([]);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});

// ── TTL expiry re-fetch ───────────────────────────────────────────────────────

describe('TTL re-fetch', () => {
  it('returns cached data within the 60-second TTL window', async () => {
    vi.useFakeTimers();
    mockFetchSnapshot.mockResolvedValue(makePull({ syncedAt: 1 }));

    await getSnapshot(PAT, KEY_B64, URL);
    // Still within TTL
    vi.advanceTimersByTime(30_000);
    await getSnapshot(PAT, KEY_B64, URL);

    expect(mockFetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the 60-second TTL has expired', async () => {
    vi.useFakeTimers();
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ syncedAt: 1 }));

    await getSnapshot(PAT, KEY_B64, URL);

    // Advance past TTL (60 000 ms)
    vi.advanceTimersByTime(61_000);

    mockFetchSnapshot.mockResolvedValueOnce(makePull({ syncedAt: 2 }));
    const r2 = await getSnapshot(PAT, KEY_B64, URL);

    expect(mockFetchSnapshot).toHaveBeenCalledTimes(2);
    expect(r2.snapshot.syncedAt).toBe(2);
  });
});

// ── Catalog normalization (CAP-05 gap-closure, 2026-09-06) ───────────────────
//
// The real server OMITS `capabilities`/`equipment`/`isSkill` ENTIRELY for any catalog
// exercise at its Kotlin-side default (`Dtos.kt`'s `= emptyList()`/`= false` combined with
// kotlinx.serialization's `encodeDefaults = false`) — measured directly against production,
// 75/189 exercises omit `capabilities` and 164/189 omit `isSkill`. `fetchCatalog()` (mocked
// here, exactly like every other test in this file) returns that raw `CatalogExerciseWire[]`
// shape unchanged; `getSnapshot()`'s `catalog` field must never hand a consumer a
// `CatalogExercise` whose `capabilities`/`equipment` is `undefined` instead of `[]`, or
// `isSkill` is `undefined` instead of `false` — that is the exact TypeError the phase
// verifier reproduced against the live catalog (`get_stats.ts`'s `ex.capabilities.length`).

describe('catalog normalization (CAP-05 gap-closure)', () => {
  it('a wire catalog entry that OMITS capabilities/equipment/isSkill entirely normalizes to [] / [] / false on snapshot.catalog, not undefined', async () => {
    const wireCatalogEntry: CatalogExerciseWire = {
      id: 'ex-omitted-fields',
      key: 'omitted_fields_exercise',
      nameEn: 'Omitted Fields Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      // capabilities, equipment, isSkill deliberately absent — not `[]`/`false` — this is
      // res.json() on a real GET /api/exercises response for a default-valued exercise.
    };
    mockFetchSnapshot.mockResolvedValueOnce(makePull({}));
    mockFetchCatalog.mockResolvedValueOnce([wireCatalogEntry]);

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toHaveLength(1);
    expect(catalog[0].capabilities).toEqual([]);
    expect(catalog[0].equipment).toEqual([]);
    expect(catalog[0].isSkill).toBe(false);
  });

  it('a wire catalog entry that DOES carry capabilities/equipment/isSkill passes them through unchanged', async () => {
    const wireCatalogEntry: CatalogExerciseWire = {
      id: 'ex-full-fields',
      key: 'full_fields_exercise',
      nameEn: 'Full Fields Exercise',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      equipment: [{ equipmentId: 'eq-1', key: 'pullup_bar', nameEn: 'Pull-Up Bar', isOptional: false }],
      isSkill: true,
      capabilities: [
        {
          id: 'cap-1',
          key: 'balance',
          translations: [{ languageCode: 'en', name: 'Balance' }],
          capabilityLevel: 'HAUPTREIZ',
        },
      ],
    };
    mockFetchSnapshot.mockResolvedValueOnce(makePull({}));
    mockFetchCatalog.mockResolvedValueOnce([wireCatalogEntry]);

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toHaveLength(1);
    expect(catalog[0].isSkill).toBe(true);
    expect(catalog[0].equipment).toHaveLength(1);
    expect(catalog[0].capabilities).toHaveLength(1);
    expect(catalog[0].capabilities[0].key).toBe('balance');
  });
});

// ── User-exercise merge into the catalog (141-18, G-141-2-SCOPE) ────────────
//
// snapshot.exercises has been typed and transported since Phase 120 (cache.ts's
// decryptMerge passes it through unchanged) but no tool ever read it — the closed test
// circle cannot write to the curated catalog at all, so their own exercises fell silently
// out of every coach evaluation. These seven cases are the seven <behavior> bullets from
// 141-18-PLAN.md Task 1, one test per bullet, in the same order. The last one is the most
// important: a snapshot with no user exercises must yield the exact catalog normalizeCatalog
// alone would have produced, or this change touched more than it should have.

describe('user-exercise merge into catalog (G-141-2-SCOPE)', () => {
  const CURATED_ID = 'cccccccc-1000-4000-c000-000000000001';
  const curatedWireEntry: CatalogExerciseWire = {
    id: CURATED_ID,
    key: 'dip',
    nameEn: 'Dip',
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 1_700_000_000_000,
    translations: [{ languageCode: 'de', name: 'Dip' }],
    muscleGroups: [],
  };

  function userExercise(overrides: Partial<SyncExerciseDto> & { id: string }): SyncExerciseDto {
    return {
      name: 'Klimmzug am Ring',
      mode: 'REPS',
      usesWeight: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_050_000,
      ...overrides,
    };
  }

  it('1. a user exercise from the snapshot appears in the merged catalog with id, name, mode and usesWeight', async () => {
    mockFetchCatalog.mockResolvedValueOnce([]);
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({ exercises: [userExercise({ id: 'user-ex-1', name: 'Ring Rows', mode: 'REPS', usesWeight: true })] }),
    );

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ id: 'user-ex-1', nameEn: 'Ring Rows', mode: 'REPS', usesWeight: true });
  });

  it('2. a user exercise carries the CUSTOM origin; a curated entry carries the CATALOG origin', async () => {
    mockFetchCatalog.mockResolvedValueOnce([curatedWireEntry]);
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({ exercises: [userExercise({ id: 'user-ex-2' })] }),
    );

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toHaveLength(2);
    const curated = catalog.find((ex) => ex.id === CURATED_ID);
    const user = catalog.find((ex) => ex.id === 'user-ex-2');
    expect(curated?.origin).toBe('CATALOG');
    expect(user?.origin).toBe('CUSTOM');
  });

  it('3. a user exercise with a set deletedAt does not appear', async () => {
    mockFetchCatalog.mockResolvedValueOnce([]);
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        exercises: [userExercise({ id: 'user-ex-deleted', deletedAt: 1_700_000_100_000 })],
      }),
    );

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toHaveLength(0);
  });

  it('4. a user exercise sharing an id with a catalog entry is dropped — the catalog entry wins', async () => {
    mockFetchCatalog.mockResolvedValueOnce([curatedWireEntry]);
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({ exercises: [userExercise({ id: CURATED_ID, name: 'Should never win' })] }),
    );

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe(CURATED_ID);
    expect(catalog[0].nameEn).toBe('Dip');
    expect(catalog[0].origin).toBe('CATALOG');
  });

  it('5. translations from the snapshot land on the matching user exercise, by language code', () => {
    const translations: SyncExerciseTranslationDto[] = [
      { exerciseId: 'user-ex-5', languageCode: 'de', name: 'Ring-Klimmzug' },
      { exerciseId: 'other-exercise', languageCode: 'de', name: 'Irrelevant' },
    ];

    const projected = projectUserExerciseToCatalog(userExercise({ id: 'user-ex-5' }), translations);

    expect(projected.translations).toEqual([{ languageCode: 'de', name: 'Ring-Klimmzug', description: undefined }]);
  });

  it('6. muscle groups, equipment and capability axes of a user exercise are empty — never invented', () => {
    const projected = projectUserExerciseToCatalog(userExercise({ id: 'user-ex-6' }), []);

    expect(projected.muscleGroups).toEqual([]);
    expect(projected.equipment).toEqual([]);
    expect(projected.capabilities).toEqual([]);
    expect(projected.isSkill).toBe(false);
  });

  it('7. a snapshot without user exercises yields exactly the catalog normalizeCatalog alone would produce', async () => {
    mockFetchCatalog.mockResolvedValueOnce([curatedWireEntry]);
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ exercises: [] }));

    const { catalog } = await getSnapshot(PAT, KEY_B64, URL);

    expect(catalog).toEqual([{ ...curatedWireEntry, capabilities: [], equipment: [], isSkill: false, origin: 'CATALOG' }]);
  });
});
