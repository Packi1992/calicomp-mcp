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
 * HTTP module is fully mocked so tests run offline with no real server. `crypto.js`'s
 * `decrypt` defaults to the REAL implementation (Phase 151) — every existing test
 * below still overrides it per-call via `mockReturnValueOnce`/`mockImplementationOnce`
 * exactly as before, so this is backward-compatible; it additionally lets the Phase
 * 151 session-feedback tolerance tests (`decryptSession` fault-tolerance, further
 * below) build a REAL AES-256-GCM envelope with `node:crypto`'s `createCipheriv` and
 * a fixed test-only key, and let it decrypt for real — no mock JSON string standing
 * in for a payload the test itself claims to encrypt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCipheriv } from 'node:crypto';
import type {
  SyncPullResponse,
  UserProfileResponse,
  CatalogExerciseWire,
  SyncExerciseDto,
  SyncExerciseTranslationDto,
  SyncSessionDto,
  MiscSyncRow,
  CatalogExercise,
} from '../src/types.js';

// ── Module mocks (hoisted by vitest before static imports) ──────────────────
vi.mock('../src/http.js');
vi.mock('../src/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../src/crypto.js')>('../src/crypto.js');
  return { decrypt: vi.fn(actual.decrypt) };
});

// ── Imports after mocks ──────────────────────────────────────────────────────
import {
  getSnapshot,
  __resetCache,
  projectUserExerciseToCatalog,
  decryptSession,
  isBlankOverrideText,
} from '../src/cache.js';
import { assertEntitiesReadable, foreignSportAvailability } from '../src/read-guard.js';
import { createExerciseNameResolver } from '../src/exercise-names.js';
import { getTemplate } from '../src/tools/get_template.js';
import { listTemplates } from '../src/tools/list_templates.js';
import { getExerciseCatalog } from '../src/tools/get_exercise_catalog.js';
import { OWN_TEST_KEY_B64, ownExercisePair, ownTranslationPair } from './own-exercise-fixture.js';
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

// ── Decrypt-merge: session fault tolerance (Phase 150, D-08/D-12/D-13) ──────────

describe('decrypt-merge: session fault tolerance', () => {
  it('P150 D-13 SC4 one corrupt session of three is reported, the other two are read', async () => {
    const PAYLOAD = '{"iv":"i","ct":"c"}';
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-ok-1', startTime: 0, endTime: undefined, encryptedPayload: PAYLOAD,
            isManual: false, isCorrected: false, isQuickChallenge: false, templateId: 'tpl-1',
            createdAt: 1_709_000_000_000, updatedAt: 1_709_000_000_000,
          },
          {
            id: 'sess-corrupt', startTime: 0, endTime: undefined, encryptedPayload: PAYLOAD,
            isManual: false, isCorrected: false, isQuickChallenge: true,
            createdAt: 1_709_100_000_000, updatedAt: 1_709_100_000_000,
          },
          {
            id: 'sess-ok-2', startTime: 0, endTime: undefined, encryptedPayload: PAYLOAD,
            isManual: false, isCorrected: false, isQuickChallenge: false, templateId: 'tpl-2',
            createdAt: 1_709_200_000_000, updatedAt: 1_709_200_000_000,
          },
        ],
      }),
    );
    mockDecrypt
      .mockReturnValueOnce('{"st":1709000000000,"et":1709003600000}')
      .mockImplementationOnce(() => { throw new Error('auth tag mismatch'); })
      .mockReturnValueOnce('{"st":1709200000000,"et":1709203600000}');

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.sessions).toHaveLength(2);
    expect(cache.snapshot.sessions.map((s) => s.id)).toEqual(['sess-ok-1', 'sess-ok-2']);
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0]).toEqual({
      entity: 'session',
      id: 'sess-corrupt',
      reason: 'decrypt_failed',
      createdAt: 1_709_100_000_000,
      updatedAt: 1_709_100_000_000,
      templateId: undefined,
      isQuickChallenge: true,
      // Phase 150, D-10/D-37: classifySession(row) without a template index.
      // isQuickChallenge:true takes precedence over the (absent) templateId (D-01).
      sessionKind: 'quick_challenge',
    });
    expect(decodeReport.encryptedCount.session).toBe(3);
    expect(decodeReport.failedCount.session).toBe(1);
  });

  it('P150 D-12 a session payload without numeric st is malformed_payload', async () => {
    const PAYLOAD = '{"iv":"i","ct":"c"}';
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-malformed', startTime: 0, endTime: undefined, encryptedPayload: PAYLOAD,
            isManual: false, isCorrected: false, isQuickChallenge: false,
            createdAt: 0, updatedAt: 0,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(JSON.stringify({ et: 0 }));

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.sessions).toHaveLength(0);
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0].entity).toBe('session');
    expect(decodeReport.unreadable[0].id).toBe('sess-malformed');
    expect(decodeReport.unreadable[0].reason).toBe('malformed_payload');
    expect(decodeReport.encryptedCount.session).toBe(1);
    expect(decodeReport.failedCount.session).toBe(1);
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

// ── Decrypt-merge: set-log and hr-sample fault tolerance (Phase 150, D-10/D-12) ──

describe('decrypt-merge: set-log and hr-sample fault tolerance', () => {
  it('P150 D-10 a corrupt set-log inside a readable session is reported with its sessionId', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-readable', startTime: 1_709_000_000_000, endTime: 1_709_003_600_000,
            isManual: false, isCorrected: false, isQuickChallenge: false,
            createdAt: 1_709_000_000_000, updatedAt: 1_709_000_000_000,
          },
        ],
        setLogs: [
          {
            id: 'sl-corrupt', sessionId: 'sess-readable', encryptedPayload: '{"iv":"i","ct":"c"}',
            createdAt: 1_709_000_100_000, updatedAt: 1_709_000_100_000,
          },
        ],
      }),
    );
    mockDecrypt.mockImplementationOnce(() => { throw new Error('auth tag mismatch'); });

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.sessions).toHaveLength(1);
    expect(cache.snapshot.setLogs).toHaveLength(0);
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0]).toEqual({
      entity: 'setLog',
      id: 'sl-corrupt',
      reason: 'decrypt_failed',
      sessionId: 'sess-readable',
      createdAt: 1_709_000_100_000,
      updatedAt: 1_709_000_100_000,
    });
  });

  it('P150 D-10 set-logs of an unreadable session are removed and counted on the session row', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [
          {
            id: 'sess-corrupt', startTime: 0, endTime: undefined, encryptedPayload: '{"iv":"i","ct":"c"}',
            isManual: false, isCorrected: false, isQuickChallenge: false,
            createdAt: 0, updatedAt: 0,
          },
        ],
        setLogs: [
          { id: 'sl-1', sessionId: 'sess-corrupt', completedReps: 5, createdAt: 0, updatedAt: 0 },
          { id: 'sl-2', sessionId: 'sess-corrupt', completedReps: 6, createdAt: 0, updatedAt: 0 },
          { id: 'sl-orphan', sessionId: 'sess-unknown', completedReps: 7, createdAt: 0, updatedAt: 0 },
        ],
      }),
    );
    mockDecrypt.mockImplementationOnce(() => { throw new Error('auth tag mismatch'); });

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    // The two set-logs of the unreadable session are removed; the orphan (unrelated to any
    // session, readable or not) is left completely untouched.
    expect(cache.snapshot.setLogs).toHaveLength(1);
    expect(cache.snapshot.setLogs[0].id).toBe('sl-orphan');
    const sessionRow = decodeReport.unreadable.find((r) => r.entity === 'session' && r.id === 'sess-corrupt');
    expect(sessionRow?.affectedSetLogCount).toBe(2);
    expect(sessionRow?.affectedHrSampleCount).toBeUndefined();
  });

  it('P150 D-12 a corrupt hr sample is reported as malformed_payload', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        hrSamples: [
          {
            id: 'hr-corrupt', sessionId: 'sess-hr', timestampMs: 0, bpm: 0,
            encryptedPayload: '{"iv":"i","ct":"c"}',
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(JSON.stringify({ ts: 'not-a-number', bpm: 70 }));

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.hrSamples).toHaveLength(0);
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0]).toEqual({
      entity: 'hrSample',
      id: 'hr-corrupt',
      reason: 'malformed_payload',
      sessionId: 'sess-hr',
    });
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

  it('P150 D-37 planned v=2 is reported as unknown_version instead of failing getSnapshot', async () => {
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

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.plannedWorkouts).toHaveLength(0);
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0].entity).toBe('plannedWorkout');
    expect(decodeReport.unreadable[0].id).toBe('row-future-schema');
    expect(decodeReport.unreadable[0].reason).toBe('unknown_version');
    // No secret leaked into the report (T-120-17).
    expect(JSON.stringify(decodeReport)).not.toContain(PAT);
    expect(JSON.stringify(decodeReport)).not.toContain(KEY_B64);
  });

  it('P150 D-37 an empty planned payload is reported as malformed_payload', async () => {
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

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.plannedWorkouts).toHaveLength(0);
    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0].entity).toBe('plannedWorkout');
    expect(decodeReport.unreadable[0].id).toBe('row-tombstone');
    expect(decodeReport.unreadable[0].reason).toBe('malformed_payload');
    expect(JSON.stringify(decodeReport)).not.toContain(PAT);
    expect(JSON.stringify(decodeReport)).not.toContain(KEY_B64);
  });

  it('P150 D-37 a planned decrypt failure is reported as decrypt_failed and the row is left out', async () => {
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

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.plannedWorkouts).toHaveLength(0);
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0].entity).toBe('plannedWorkout');
    expect(decodeReport.unreadable[0].id).toBe('row-corrupt');
    expect(decodeReport.unreadable[0].reason).toBe('decrypt_failed');
    expect(JSON.stringify(decodeReport)).not.toContain(PAT);
    expect(JSON.stringify(decodeReport)).not.toContain(KEY_B64);
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

  it('P150 D-37 an empty settings payload is reported as malformed_payload with its key', async () => {
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

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.settings).toHaveLength(0);
    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(decodeReport.unreadable).toHaveLength(1);
    expect(decodeReport.unreadable[0].entity).toBe('setting');
    expect(decodeReport.unreadable[0].id).toBe('row-tombstone');
    expect(decodeReport.unreadable[0].reason).toBe('malformed_payload');
    expect(decodeReport.unreadable[0].key).toBe('training_timezone_id');
    expect(JSON.stringify(decodeReport)).not.toContain(PAT);
    expect(JSON.stringify(decodeReport)).not.toContain(KEY_B64);
  });

  // Phase 150 review WR-01 — the D-11 guard run over the REAL decode counters, not a
  // hand-built report: proves `decodeSettings` and `assertEntitiesReadable` agree on
  // which rows form the denominator.
  it('P150 WR-01 a readable tz setting plus an empty-payload setting does not trip the key guard', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        settings: [
          {
            id: 'row-tz-1', kind: 'settings', clientLocalId: 'training_timezone_id',
            encryptedPayload: '{"iv":"tzIv","ct":"tzCt"}', createdAt: 0, updatedAt: 0,
          },
          {
            id: 'row-tombstone', kind: 'settings', clientLocalId: 'some_other_key',
            encryptedPayload: '', createdAt: 0, updatedAt: 0, deletedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    mockDecrypt.mockReturnValueOnce(JSON.stringify({ v: 1, t: 's', value: 'Europe/Berlin' }));

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(cache.snapshot.settings).toEqual([{ key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' }]);
    expect(decodeReport.encryptedCount.setting).toBe(1);
    expect(decodeReport.failedCount.setting).toBe(1);
    expect(() => assertEntitiesReadable(decodeReport, ['session', 'setLog', 'setting'], 'Training state error')).not.toThrow();
  });

  it('P150 WR-01 a wrong key is detected even when an empty-payload setting is present', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        settings: [
          {
            id: 'row-tz-1', kind: 'settings', clientLocalId: 'training_timezone_id',
            encryptedPayload: '{"iv":"tzIv","ct":"tzCt"}', createdAt: 0, updatedAt: 0,
          },
          {
            id: 'row-tombstone', kind: 'settings', clientLocalId: 'some_other_key',
            encryptedPayload: '', createdAt: 0, updatedAt: 0, deletedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    mockDecrypt.mockImplementation(() => {
      throw new Error('auth tag mismatch');
    });

    const cache = await getSnapshot(PAT, KEY_B64, URL);
    const decodeReport = cache.decodeReport!;

    expect(decodeReport.encryptedCount.setting).toBe(1);
    expect(decodeReport.failedCount.setting).toBe(2);
    expect(() => assertEntitiesReadable(decodeReport, ['setting'], 'Progress error')).toThrow(
      /every encrypted setting row \(1 of 1\) failed to decrypt — CALICOMP_KEY most likely does not match/,
    );
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

// ── Regression: omitted-empty-list wire keys (Phase 146) ─────────────────────
//
// `McpDataPullResponse` (SyncDtos.kt) declares EVERY list `= emptyList()` and the server
// serializes with `encodeDefaults = false` — so any of them vanishes from the wire the
// moment it is empty. `makePull` above always supplies all of them, which is precisely why
// this defect survived: the fixture was more generous than the wire ever is.
//
// Measured against production 2026-09-22 for a user with no self-created exercises:
// `exercises` and `exerciseTranslations` were both absent. Typed as required, they reached
// the snapshot as `undefined` and the first `.filter` on them threw `Cannot read properties
// of undefined (reading 'filter')` — taking down three of four read tools and all ten
// `propose_new_plan` calls of Plan 146-07, while `plannedWorkouts`, absent in the SAME
// response, passed through silently because its `?? []` was already there.
describe('decrypt-merge: every optional list key may be absent from the wire (Phase 146)', () => {
  const LIST_KEYS = [
    'exercises',
    'exerciseTranslations',
    'templates',
    'blocks',
    'templateExercises',
    'sessions',
    'setLogs',
    'hrSamples',
    'plannedWorkouts',
    'settings',
  ] as const;

  it.each(LIST_KEYS)('a wire response without `%s` yields [] and does not throw', async (key) => {
    const pull = makePull({}) as unknown as Record<string, unknown>;
    delete pull[key];
    mockFetchSnapshot.mockResolvedValueOnce(pull as unknown as SyncPullResponse);

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    expect(snapshot[key as keyof typeof snapshot]).toEqual([]);
  });

  it('the real production shape — no exercises, no exerciseTranslations, no plannedWorkouts — survives a .filter on every list', async () => {
    const pull = makePull({}) as unknown as Record<string, unknown>;
    delete pull.exercises;
    delete pull.exerciseTranslations;
    delete pull.plannedWorkouts;
    mockFetchSnapshot.mockResolvedValueOnce(pull as unknown as SyncPullResponse);

    const { snapshot } = await getSnapshot(PAT, KEY_B64, URL);

    // The throw site was never decryptMerge itself — it was whatever touched the snapshot
    // first. Exercise that seam directly rather than trusting the assignment.
    for (const key of LIST_KEYS) {
      const value = snapshot[key as keyof typeof snapshot] as unknown[];
      expect(Array.isArray(value), `snapshot.${key} must be an array, not ${typeof value}`).toBe(true);
      expect(() => value.filter(Boolean)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Session feedback decode tolerance (Phase 151, FB-03/D-28) — direct against the
// exported `decryptSession`, not through `getSnapshot()`. `crypto.js`'s `decrypt`
// defaults to the REAL implementation in this file (see the `vi.mock` factory above),
// so every payload here is a REAL AES-256-GCM envelope built with `node:crypto`'s
// `createCipheriv` and the same fixed, non-production test key `docs/coach-planning-
// vectors.json`'s `sessionCipher` vectors use (bytes 0x00..0x1F) — never a real key.
// ---------------------------------------------------------------------------

describe('decryptSession: session-feedback decode tolerance', () => {
  const FEEDBACK_TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

  /** Build a real `{"iv":...,"ct":...}` envelope decryptable by the real `decrypt()`. */
  function encryptTestPayload(payload: Record<string, unknown>, keyB64 = FEEDBACK_TEST_KEY_B64): string {
    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.alloc(12); // fixed zero IV — test-only encryption, never a real session
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ctBuf = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ iv: iv.toString('base64'), ct: ctBuf.toString('base64') });
  }

  function makeEncryptedSessionRow(payload: Record<string, unknown>): SyncSessionDto {
    return {
      id: 'sess-fb03-test',
      startTime: 0,
      endTime: undefined,
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      encryptedPayload: encryptTestPayload(payload),
      createdAt: 0,
      updatedAt: 0,
    };
  }

  it('P151 FB-03 a legacy payload yields never_asked on both scales', () => {
    const row = makeEncryptedSessionRow({ st: 1_709_000_000_000, et: 1_709_003_600_000 });
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.feedback).toEqual({
      execution: { value: null, state: 'never_asked', setLaterAt: null },
      feel: { value: null, state: 'never_asked', setLaterAt: null },
      comment: null,
    });
    expect(decoded.goalSnapshot).toBeNull();
  });

  it('P151 FB-03 an unrecognized state is treated as absent', () => {
    const row = makeEncryptedSessionRow({
      st: 1_709_000_000_000, et: 1_709_003_600_000,
      fe: 5, fes: 'bogus_eighth_state', fel: 1_709_100_000_000,
    });
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.feedback?.execution).toEqual({ value: null, state: 'never_asked', setLaterAt: null });
  });

  it('P151 FB-03 a value outside one to five is dropped', () => {
    const row = makeEncryptedSessionRow({
      st: 1_709_000_000_000, et: 1_709_003_600_000,
      fe: 9, fes: 'confirmed',
    });
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.feedback?.execution).toEqual({ value: null, state: 'confirmed', setLaterAt: null });
  });

  it('P151 FB-03 a value with a non-answer state is dropped', () => {
    const row = makeEncryptedSessionRow({
      st: 1_709_000_000_000, et: 1_709_003_600_000,
      fe: 3, fes: 'skipped',
    });
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.feedback?.execution).toEqual({ value: null, state: 'skipped', setLaterAt: null });
  });

  it('P151 FB-03 a malformed feedback field never makes the row unreadable', () => {
    const row = makeEncryptedSessionRow({
      st: 1_709_000_000_000, et: 1_709_003_600_000,
      fes: 12345,               // wrong type — should read as absent, never throw
      fe: 'not-a-number',       // wrong type
      ff: {},                   // wrong type
      ffs: ['confirmed'],       // wrong type
      fc: 42,                   // wrong type — never a comment
      tg: 'not-an-array',       // wrong type — never a goal snapshot
    });
    expect(() => decryptSession(row, FEEDBACK_TEST_KEY_B64)).not.toThrow();
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.feedback).toEqual({
      execution: { value: null, state: 'never_asked', setLaterAt: null },
      feel: { value: null, state: 'never_asked', setLaterAt: null },
      comment: null,
    });
    expect(decoded.goalSnapshot).toBeNull();
  });

  it('P151 FB-03 a plaintext pre-encryption row yields never_asked', () => {
    const row: SyncSessionDto = {
      id: 'sess-plaintext',
      startTime: 1_709_000_000_000,
      endTime: 1_709_003_600_000,
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      // no encryptedPayload — pre-encryption plaintext row
      createdAt: 1_709_000_000_000,
      updatedAt: 1_709_003_600_000,
    };
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.feedback).toEqual({
      execution: { value: null, state: 'never_asked', setLaterAt: null },
      feel: { value: null, state: 'never_asked', setLaterAt: null },
      comment: null,
    });
    expect(decoded.goalSnapshot).toBeNull();
  });

  it('P151 D-28 a malformed goal entry is dropped and valid entries are kept', () => {
    const row = makeEncryptedSessionRow({
      st: 1_709_000_000_000, et: 1_709_003_600_000,
      tg: [
        { workoutExerciseId: 'we-1', exerciseId: 'ex-1', mode: 'REPS', sets: 2, targetReps: 10 },
        { bogus: 'entry-missing-required-fields' },
        { workoutExerciseId: 'we-2', exerciseId: 'ex-2', mode: 'TIME', sets: 1, targetTimeSeconds: 30 },
      ],
    });
    const decoded = decryptSession(row, FEEDBACK_TEST_KEY_B64);
    expect(decoded.goalSnapshot).toEqual([
      { workoutExerciseId: 'we-1', exerciseId: 'ex-1', mode: 'REPS', sets: 2, targetReps: 10 },
      { workoutExerciseId: 'we-2', exerciseId: 'ex-2', mode: 'TIME', sets: 1, targetTimeSeconds: 30 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Foreign sport decode (Phase 155, FA-08, E-8/E-9) — through `getSnapshot()`, so the
// real `decryptMerge` runs. Every payload is a REAL AES-256-GCM envelope under the same
// fixed, non-production test key the corpus uses (bytes 0x00..0x1F); `crypto.js`'s
// `decrypt` defaults to the real implementation in this file (see the `vi.mock` above).
// ---------------------------------------------------------------------------

describe('decrypt-merge: foreign sport (Phase 155)', () => {
  const FOREIGN_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
  let ivCounter = 0;

  /** A real `{"iv":...,"ct":...}` envelope; a fresh IV per call (test-only key). */
  function encryptForeign(payload: Record<string, unknown>): string {
    ivCounter += 1;
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(ivCounter, 8);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(FOREIGN_KEY_B64, 'base64'), iv);
    const ctBuf = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ iv: iv.toString('base64'), ct: ctBuf.toString('base64') });
  }

  function foreignRow(id: string, kind: string, encryptedPayload: string): MiscSyncRow {
    return { id, kind, clientLocalId: id, encryptedPayload, createdAt: 1_791_000_000_000, updatedAt: 1_791_000_000_000 };
  }

  const SECRET_NOTE = 'P155 private note text that must never reach a report';

  function activityPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      v: 1,
      id: 'fa-1',
      typeId: 'b85b2339-ddf1-385d-acb2-b0d3d498eeca',
      performedOn: '2026-10-06',
      performedTime: null,
      durationMinutes: 35,
      intensity: 2,
      dayForm: null,
      distanceMeters: null,
      note: SECRET_NOTE,
      createdAt: 1_791_306_000_000,
      updatedAt: 1_791_306_000_000,
      ...overrides,
    };
  }

  const PLAINTEXT_SESSION: SyncSessionDto = {
    id: 'sess-p155',
    startTime: 1_791_200_000_000,
    endTime: 1_791_203_600_000,
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: 1_791_200_000_000,
    updatedAt: 1_791_200_000_000,
  };

  const TEMPLATE = {
    id: 'tpl-p155',
    name: 'Push',
    createdAt: 1_791_000_000_000,
    updatedAt: 1_791_000_000_000,
    isFavoriteForWatch: false,
  };

  it('P155 E-9 decryptMerge leaves foreign fields absent when the server sends none', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ sessions: [PLAINTEXT_SESSION], templates: [TEMPLATE] }));

    const cache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    const { snapshot } = cache;

    expect(snapshot).not.toHaveProperty('foreignActivityTypes');
    expect(snapshot).not.toHaveProperty('foreignActivities');
    expect(snapshot).not.toHaveProperty('plannedForeignActivities');
    expect(foreignSportAvailability(snapshot, cache.decodeReport!)).toEqual({
      available: false,
      reason: 'server_without_foreign_sport',
    });
    // Everything else is delivered as before.
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.templates).toHaveLength(1);
    expect(cache.decodeReport!.unreadable).toEqual([]);
  });

  it('P155 E-8 one unreadable foreign activity makes foreign sport unavailable but leaves sessions readable', async () => {
    const readable = encryptForeign(activityPayload());
    // A real envelope with one flipped ciphertext byte: GCM authentication fails.
    const broken = JSON.parse(encryptForeign(activityPayload({ id: 'fa-2' }))) as { iv: string; ct: string };
    const ctBuf = Buffer.from(broken.ct, 'base64');
    ctBuf[0] ^= 0xff;
    const tampered = JSON.stringify({ iv: broken.iv, ct: ctBuf.toString('base64') });

    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [PLAINTEXT_SESSION],
        templates: [TEMPLATE],
        foreignActivityTypes: [],
        foreignActivities: [
          foreignRow('row-fa-1', 'foreign_activity', readable),
          foreignRow('row-fa-2', 'foreign_activity', tampered),
        ],
        plannedForeignActivities: [],
      }),
    );

    const cache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    const { snapshot } = cache;
    const report = cache.decodeReport!;

    expect(snapshot.foreignActivities?.map((a) => a.id)).toEqual(['fa-1']);
    expect(report.unreadable).toEqual([
      {
        entity: 'foreignActivity',
        id: 'row-fa-2',
        reason: 'decrypt_failed',
        createdAt: 1_791_000_000_000,
        updatedAt: 1_791_000_000_000,
      },
    ]);
    expect(report.encryptedCount.foreignActivity).toBe(2);
    expect(report.failedCount.foreignActivity).toBe(1);
    expect(foreignSportAvailability(snapshot, report)).toEqual({ available: false, reason: 'foreign_rows_unreadable' });

    // Sessions and templates stay readable; the session guard of every session tool passes.
    expect(snapshot.sessions.map((s) => s.id)).toEqual(['sess-p155']);
    expect(snapshot.templates.map((t) => t.id)).toEqual(['tpl-p155']);
    expect(() => assertEntitiesReadable(report, ['session', 'setLog', 'hrSample'], 'History error')).not.toThrow();

    // No content, ciphertext, key or PAT in the report (T-120-17, T-155-24).
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain(SECRET_NOTE);
    expect(reportJson).not.toContain(broken.ct);
    expect(reportJson).not.toContain(FOREIGN_KEY_B64);
    expect(reportJson).not.toContain(PAT);
  });

  it('P155 D-16 an activity with an unreadable intensity decodes with intensity null', async () => {
    const odd: Array<[string, Record<string, unknown>]> = [
      ['fa-i0', { intensity: 0 }],
      ['fa-i6', { intensity: 6 }],
      ['fa-ifrac', { intensity: 2.5 }],
      ['fa-istr', { intensity: '3' }],
      ['fa-inull', { intensity: null }],
      ['fa-dayform', { intensity: 4, dayForm: 9, distanceMeters: 0 }],
      ['fa-distneg', { intensity: 5, dayForm: 0, distanceMeters: -5 }],
      ['fa-distfrac', { intensity: 1, dayForm: 5, distanceMeters: 10.5 }],
    ];
    const missing = activityPayload({ id: 'fa-imissing' });
    delete missing.intensity;
    const rows = [
      ...odd.map(([id, o]) => foreignRow(`row-${id}`, 'foreign_activity', encryptForeign(activityPayload({ id, ...o })))),
      foreignRow('row-fa-imissing', 'foreign_activity', encryptForeign(missing)),
    ];
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({ foreignActivityTypes: [], foreignActivities: rows, plannedForeignActivities: [] }),
    );

    const cache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    const byId = new Map((cache.snapshot.foreignActivities ?? []).map((a) => [a.id, a]));

    // Every row stays readable — an unreadable optional value never costs the row.
    expect(cache.decodeReport!.failedCount.foreignActivity).toBe(0);
    expect(byId.size).toBe(9);
    for (const id of ['fa-i0', 'fa-i6', 'fa-ifrac', 'fa-istr', 'fa-inull', 'fa-imissing']) {
      expect(byId.get(id)?.intensity, id).toBeNull();
      expect(byId.get(id)?.durationMinutes, id).toBe(35);
    }
    expect(byId.get('fa-dayform')).toMatchObject({ intensity: 4, dayForm: null, distanceMeters: null });
    expect(byId.get('fa-distneg')).toMatchObject({ intensity: 5, dayForm: null, distanceMeters: null });
    expect(byId.get('fa-distfrac')).toMatchObject({ intensity: 1, dayForm: 5, distanceMeters: null });
    expect(foreignSportAvailability(cache.snapshot, cache.decodeReport!)).toEqual({ available: true });
  });

  it('P155 E-8 a foreign activity without a readable required field is unreadable', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['fa-v2', { v: 2 }],
      ['fa-nodate', { performedOn: '7.10.2026' }],
      ['fa-zero', { durationMinutes: 0 }],
      ['fa-fracdur', { durationMinutes: 12.5 }],
      ['fa-notype', { typeId: '' }],
    ];
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        foreignActivityTypes: [],
        foreignActivities: [
          ...bad.map(([id, o]) => foreignRow(`row-${id}`, 'foreign_activity', encryptForeign(activityPayload({ id, ...o })))),
          foreignRow('row-fa-empty', 'foreign_activity', ''),
        ],
        plannedForeignActivities: [],
      }),
    );

    const cache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    const report = cache.decodeReport!;

    expect(cache.snapshot.foreignActivities).toEqual([]);
    expect(report.unreadable.map((r) => [r.id, r.reason])).toEqual([
      ['row-fa-v2', 'unknown_version'],
      ['row-fa-nodate', 'malformed_payload'],
      ['row-fa-zero', 'malformed_payload'],
      ['row-fa-fracdur', 'malformed_payload'],
      ['row-fa-notype', 'malformed_payload'],
      ['row-fa-empty', 'malformed_payload'],
    ]);
    expect(report.encryptedCount.foreignActivity).toBe(5);
    expect(report.failedCount.foreignActivity).toBe(6);
    expect(JSON.stringify(report)).not.toContain(SECRET_NOTE);
  });

  it('P155 E-8 an unreadable foreign type or planned row makes foreign sport unavailable', async () => {
    const goodType = encryptForeign({
      v: 1, id: 'ft-1', name: 'Klettersteig', createdAt: 1, updatedAt: 2, deletedAt: null,
    });
    const goodPlanned = encryptForeign({
      v: 1, id: 'pfa-1', typeId: 'ft-1', scheduledDate: 1_791_244_800_000, scheduledTime: null,
      note: SECRET_NOTE, recurrenceRule: null, deletedOccurrences: null, createdAt: 3, updatedAt: 4,
    });

    // (a) An own type with a future schema version.
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [PLAINTEXT_SESSION],
        templates: [TEMPLATE],
        foreignActivityTypes: [
          foreignRow('row-ft-1', 'foreign_activity_type', goodType),
          foreignRow('row-ft-2', 'foreign_activity_type', encryptForeign({ v: 2, id: 'ft-2', name: SECRET_NOTE })),
        ],
        foreignActivities: [foreignRow('row-fa-1', 'foreign_activity', encryptForeign(activityPayload()))],
        plannedForeignActivities: [foreignRow('row-pfa-1', 'planned_foreign_activity', goodPlanned)],
      }),
    );
    const typeCache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    expect(typeCache.snapshot.foreignActivityTypes?.map((t) => t.id)).toEqual(['ft-1']);
    expect(typeCache.snapshot.foreignActivities?.map((a) => a.id)).toEqual(['fa-1']);
    expect(typeCache.snapshot.plannedForeignActivities?.map((p) => p.id)).toEqual(['pfa-1']);
    expect(typeCache.decodeReport!.unreadable).toEqual([
      { entity: 'foreignActivityType', id: 'row-ft-2', reason: 'unknown_version', createdAt: 1_791_000_000_000, updatedAt: 1_791_000_000_000 },
    ]);
    expect(foreignSportAvailability(typeCache.snapshot, typeCache.decodeReport!)).toEqual({
      available: false,
      reason: 'foreign_rows_unreadable',
    });
    expect(typeCache.snapshot.sessions).toHaveLength(1);
    expect(typeCache.snapshot.templates).toHaveLength(1);

    // (b) An appointment without a scheduledDate.
    __resetCache();
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        sessions: [PLAINTEXT_SESSION],
        templates: [TEMPLATE],
        foreignActivityTypes: [foreignRow('row-ft-1', 'foreign_activity_type', goodType)],
        foreignActivities: [],
        plannedForeignActivities: [
          foreignRow('row-pfa-1', 'planned_foreign_activity', goodPlanned),
          foreignRow(
            'row-pfa-2',
            'planned_foreign_activity',
            encryptForeign({ v: 1, id: 'pfa-2', typeId: 'ft-1', note: SECRET_NOTE }),
          ),
        ],
      }),
    );
    const plannedCache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    expect(plannedCache.snapshot.plannedForeignActivities?.map((p) => p.id)).toEqual(['pfa-1']);
    expect(plannedCache.decodeReport!.unreadable).toEqual([
      { entity: 'plannedForeignActivity', id: 'row-pfa-2', reason: 'malformed_payload', createdAt: 1_791_000_000_000, updatedAt: 1_791_000_000_000 },
    ]);
    expect(foreignSportAvailability(plannedCache.snapshot, plannedCache.decodeReport!)).toEqual({
      available: false,
      reason: 'foreign_rows_unreadable',
    });
    expect(plannedCache.snapshot.sessions).toHaveLength(1);
    expect(plannedCache.snapshot.templates).toHaveLength(1);
    expect(JSON.stringify(plannedCache.decodeReport)).not.toContain(SECRET_NOTE);
    expect(JSON.stringify(typeCache.decodeReport)).not.toContain(SECRET_NOTE);
  });

  it('P155 E-9 a server that sends only some foreign fields counts as a server without foreign sport', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ foreignActivities: [], plannedForeignActivities: [] }));
    const cache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    expect(cache.snapshot).not.toHaveProperty('foreignActivityTypes');
    expect(cache.snapshot.foreignActivities).toEqual([]);
    expect(foreignSportAvailability(cache.snapshot, cache.decodeReport!)).toEqual({
      available: false,
      reason: 'server_without_foreign_sport',
    });
  });

  it('P155 E-9 an empty but present foreign block is available', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({ foreignActivityTypes: [], foreignActivities: [], plannedForeignActivities: [] }),
    );
    const cache = await getSnapshot(PAT, FOREIGN_KEY_B64, URL);
    expect(cache.snapshot.foreignActivityTypes).toEqual([]);
    expect(cache.snapshot.foreignActivities).toEqual([]);
    expect(cache.snapshot.plannedForeignActivities).toEqual([]);
    expect(foreignSportAvailability(cache.snapshot, cache.decodeReport!)).toEqual({ available: true });
  });
});

// ── Decrypt-merge: own names of catalog exercises (Phase 156) ───────────────

describe('decrypt-merge: exercise name overrides (Phase 156)', () => {
  const OVERRIDE_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
  let ivCounter = 0;

  /** A real `{"iv":...,"ct":...}` envelope; a fresh IV per call (test-only key). */
  function encryptOverride(payload: Record<string, unknown>): string {
    ivCounter += 1;
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(ivCounter, 4);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(OVERRIDE_KEY_B64, 'base64'), iv);
    const ctBuf = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ iv: iv.toString('base64'), ct: ctBuf.toString('base64') });
  }

  function overrideRow(id: string, clientLocalId: string, encryptedPayload: string): MiscSyncRow {
    return {
      id,
      kind: 'exercise_name_override',
      clientLocalId,
      encryptedPayload,
      createdAt: 1_791_400_000_000,
      updatedAt: 1_791_400_000_000,
    };
  }

  const SECRET_NAME = 'P156 private own name that must never reach a report';
  const SECRET_DESCRIPTION = 'P156 private own description that must never reach a report';

  /** The §1.7 plaintext form v1, key order binding. */
  function overridePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      v: 1,
      exerciseId: '15600000-0000-4000-8000-0000000000a1',
      languageCode: 'de',
      name: SECRET_NAME,
      description: null,
      updatedAt: 1_791_450_000_000,
      ...overrides,
    };
  }

  const PLAINTEXT_SESSION: SyncSessionDto = {
    id: 'sess-p156',
    startTime: 1_791_200_000_000,
    endTime: 1_791_203_600_000,
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: 1_791_200_000_000,
    updatedAt: 1_791_200_000_000,
  };

  const TEMPLATE = {
    id: 'tpl-p156',
    name: 'Pull',
    createdAt: 1_791_000_000_000,
    updatedAt: 1_791_000_000_000,
    isFavoriteForWatch: false,
  };

  it('P156 D-11 decryptMerge leaves exerciseNameOverrides absent when the server sends none', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ sessions: [PLAINTEXT_SESSION], templates: [TEMPLATE] }));

    const cache = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);

    // A server older than Phase 156: the key is left OUT, never an invented empty list.
    expect(cache.snapshot).not.toHaveProperty('exerciseNameOverrides');
    expect(cache.snapshot.sessions).toHaveLength(1);
    expect(cache.snapshot.templates).toHaveLength(1);
    expect(cache.decodeReport!.unreadable).toEqual([]);
    expect(cache.decodeReport!.encryptedCount.exerciseNameOverride).toBe(0);
    expect(cache.decodeReport!.failedCount.exerciseNameOverride).toBe(0);

    // A Phase 156 server with no overrides sends an empty list, and the snapshot carries it.
    __resetCache();
    mockFetchSnapshot.mockResolvedValueOnce(makePull({ exerciseNameOverrides: [] }));
    const fresh = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);
    expect(fresh.snapshot.exerciseNameOverrides).toEqual([]);
  });

  it('P156 D-10 one unreadable override row lands in the decode report and leaves sessions, templates and other overrides readable', async () => {
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      const readable = encryptOverride(overridePayload({ description: SECRET_DESCRIPTION }));
      // A real envelope with one flipped ciphertext byte: GCM authentication fails.
      const broken = JSON.parse(
        encryptOverride(overridePayload({ exerciseId: '15600000-0000-4000-8000-0000000000a2' })),
      ) as { iv: string; ct: string };
      const ctBuf = Buffer.from(broken.ct, 'base64');
      ctBuf[0] ^= 0xff;
      const tampered = JSON.stringify({ iv: broken.iv, ct: ctBuf.toString('base64') });
      // Version 3 is unknown (§1.7 reads 1 and 2 since the gap round, D-22; this fixture was
      // v: 2 before 156-29, when version 2 did not exist yet).
      const unknownVersion = encryptOverride(overridePayload({ v: 3, exerciseId: '15600000-0000-4000-8000-0000000000a3' }));
      const emptyName = encryptOverride(overridePayload({ name: '', exerciseId: '15600000-0000-4000-8000-0000000000a4' }));

      mockFetchSnapshot.mockResolvedValueOnce(
        makePull({
          sessions: [PLAINTEXT_SESSION],
          templates: [TEMPLATE],
          exerciseNameOverrides: [
            overrideRow('row-eno-1', '15600000-0000-4000-8000-0000000000a1:de', readable),
            overrideRow('row-eno-2', '15600000-0000-4000-8000-0000000000a2:de', tampered),
            overrideRow('row-eno-3', '15600000-0000-4000-8000-0000000000a3:de', unknownVersion),
            overrideRow('row-eno-4', '15600000-0000-4000-8000-0000000000a4:de', emptyName),
          ],
        }),
      );

      const cache = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);
      const { snapshot } = cache;
      const report = cache.decodeReport!;

      // The readable override is in the snapshot, in the §1.7 normal form.
      expect(snapshot.exerciseNameOverrides).toEqual([
        {
          exerciseId: '15600000-0000-4000-8000-0000000000a1',
          languageCode: 'de',
          name: SECRET_NAME,
          description: SECRET_DESCRIPTION,
          updatedAt: 1_791_450_000_000,
        },
      ]);
      // Each unreadable row is reported by entity, id, reason and routing timestamps only.
      const routing = { createdAt: 1_791_400_000_000, updatedAt: 1_791_400_000_000 };
      expect(report.unreadable).toEqual([
        { entity: 'exerciseNameOverride', id: 'row-eno-2', reason: 'decrypt_failed', ...routing },
        { entity: 'exerciseNameOverride', id: 'row-eno-3', reason: 'unknown_version', ...routing },
        { entity: 'exerciseNameOverride', id: 'row-eno-4', reason: 'malformed_payload', ...routing },
      ]);
      expect(report.encryptedCount.exerciseNameOverride).toBe(4);
      expect(report.failedCount.exerciseNameOverride).toBe(3);

      // Sessions and templates stay readable; no readability guard trips (D-10).
      expect(snapshot.sessions.map((s) => s.id)).toEqual(['sess-p156']);
      expect(snapshot.templates.map((t) => t.id)).toEqual(['tpl-p156']);
      expect(() =>
        assertEntitiesReadable(
          report,
          ['session', 'setLog', 'hrSample', 'plannedWorkout', 'setting'],
          'History error',
        ),
      ).not.toThrow();
      expect(foreignSportAvailability(snapshot, report)).toEqual({
        available: false,
        reason: 'server_without_foreign_sport',
      });

      // No content, ciphertext, key or PAT in the report (T-156-25).
      const reportJson = JSON.stringify(report);
      expect(reportJson).not.toContain(SECRET_NAME);
      expect(reportJson).not.toContain(SECRET_DESCRIPTION);
      expect(reportJson).not.toContain(broken.ct);
      expect(reportJson).not.toContain(OVERRIDE_KEY_B64);
      expect(reportJson).not.toContain(PAT);
      // Nothing was printed while decoding (MUST NOT log a decrypted own name).
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it('P156 D-01 an empty description decodes as null', async () => {
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        exerciseNameOverrides: [
          overrideRow(
            'row-eno-empty-desc',
            '15600000-0000-4000-8000-0000000000a5:en',
            encryptOverride(
              overridePayload({
                exerciseId: '15600000-0000-4000-8000-0000000000a5',
                languageCode: 'en',
                name: 'Close-grip chin-up',
                description: '',
              }),
            ),
          ),
        ],
      }),
    );

    const cache = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);

    expect(cache.snapshot.exerciseNameOverrides).toEqual([
      {
        exerciseId: '15600000-0000-4000-8000-0000000000a5',
        languageCode: 'en',
        name: 'Close-grip chin-up',
        description: null,
        updatedAt: 1_791_450_000_000,
      },
    ]);
    expect(cache.decodeReport!.unreadable).toEqual([]);
  });
  // ── Phase 156 gap round: decoding rules as in the app (WR-MCP-03, IN-TC-07, D-04) ──

  const ID_A = '15600000-0000-4000-8000-0000000000b1';
  const ID_B = '15600000-0000-4000-8000-0000000000b2';
  const ID_C = '15600000-0000-4000-8000-0000000000b3';
  const ID_D = '15600000-0000-4000-8000-0000000000b4';
  const ID_E = '15600000-0000-4000-8000-0000000000b5';

  /** A curated catalog exercise for the resolver (German catalog name `Katalog <key>`). */
  function catalogExercise(id: string, key: string): CatalogExercise {
    return {
      id,
      key,
      nameEn: `Catalog ${key}`,
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [{ languageCode: 'de', name: `Katalog ${key}` }],
      muscleGroups: [],
      equipment: [],
      capabilities: [],
      origin: 'CATALOG',
    };
  }

  /** A wire row with its own server `updatedAt` (the tie-break after the payload's). */
  function rowAt(id: string, clientLocalId: string, encryptedPayload: string, rowUpdatedAt: number): MiscSyncRow {
    return { ...overrideRow(id, clientLocalId, encryptedPayload), updatedAt: rowUpdatedAt };
  }

  it('P156 WR-MCP-03 two rows on the same key keep the one with the newer payload updatedAt', async () => {
    const payloadA = (name: string, updatedAt: number) =>
      encryptOverride(overridePayload({ exerciseId: ID_A, name, updatedAt }));
    const other = encryptOverride(overridePayload({ exerciseId: ID_B, name: 'P156 B bleibt', updatedAt: 5 }));
    const keyA = `${ID_A}:de`;
    const keyB = `${ID_B}:de`;

    const scenarios: Array<{ label: string; rows: MiscSyncRow[]; winner: string }> = [
      {
        // The newer payload stands FIRST, so "the later one in the array wins" would fail.
        label: 'newer payload updatedAt',
        rows: [
          rowAt('row-a-new', keyA, payloadA('P156 neuer Stand', 2_000), 1_000),
          rowAt('row-b', keyB, other, 1_000),
          rowAt('row-a-old', keyA, payloadA('P156 alter Stand', 1_000), 9_000),
        ],
        winner: 'P156 neuer Stand',
      },
      {
        label: 'payload tie, larger server updatedAt of the row',
        rows: [
          rowAt('row-a-1', keyA, payloadA('P156 Server neuer', 3_000), 8_000),
          rowAt('row-b', keyB, other, 1_000),
          rowAt('row-a-2', keyA, payloadA('P156 Server aelter', 3_000), 7_000),
        ],
        winner: 'P156 Server neuer',
      },
      {
        label: 'payload and row tie, lexicographically larger row id',
        rows: [
          rowAt('row-a-z', keyA, payloadA('P156 Id groesser', 3_000), 8_000),
          rowAt('row-b', keyB, other, 1_000),
          rowAt('row-a-a', keyA, payloadA('P156 Id kleiner', 3_000), 8_000),
        ],
        winner: 'P156 Id groesser',
      },
    ];

    const catalog = [catalogExercise(ID_A, 'p156_a'), catalogExercise(ID_B, 'p156_b')];
    for (const scenario of scenarios) {
      __resetCache();
      mockFetchSnapshot.mockResolvedValueOnce(makePull({ exerciseNameOverrides: scenario.rows }));
      const cache = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);
      const overrides = cache.snapshot.exerciseNameOverrides ?? [];

      // Exactly one entry per key; the other key is untouched and the order is kept.
      expect(overrides.map((o) => `${o.exerciseId}:${o.languageCode}`), scenario.label).toEqual([keyA, keyB]);
      expect(overrides[0].name, scenario.label).toBe(scenario.winner);
      expect(overrides[1].name, scenario.label).toBe('P156 B bleibt');
      // A superseded row is dropped silently: it is not unreadable.
      expect(cache.decodeReport!.unreadable, scenario.label).toEqual([]);
      expect(cache.decodeReport!.failedCount.exerciseNameOverride, scenario.label).toBe(0);

      // The resolver and the catalog tool see the same single winner.
      const resolver = createExerciseNameResolver({ catalog, snapshot: cache.snapshot, lang: 'de' });
      expect(resolver.forExerciseId(ID_A).exerciseOwnName?.text, scenario.label).toBe(scenario.winner);
    }
  });

  it('P156 WR-MCP-03 a row whose payload names another exercise than its key is unreadable and gives no own name', async () => {
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      // Key names exercise A, the payload names exercise B (T-156-97).
      const crossed = encryptOverride(overridePayload({ exerciseId: ID_B, name: SECRET_NAME }));
      mockFetchSnapshot.mockResolvedValueOnce(
        makePull({ exerciseNameOverrides: [overrideRow('row-crossed', `${ID_A}:de`, crossed)] }),
      );
      const cache = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);

      expect(cache.snapshot.exerciseNameOverrides).toEqual([]);
      expect(cache.decodeReport!.unreadable).toEqual([
        {
          entity: 'exerciseNameOverride',
          id: 'row-crossed',
          reason: 'malformed_payload',
          createdAt: 1_791_400_000_000,
          updatedAt: 1_791_400_000_000,
        },
      ]);
      expect(JSON.stringify(cache.decodeReport)).not.toContain(SECRET_NAME);

      const catalog = [catalogExercise(ID_A, 'p156_a'), catalogExercise(ID_B, 'p156_b')];
      const resolver = createExerciseNameResolver({ catalog, snapshot: cache.snapshot, lang: 'de' });
      for (const id of [ID_A, ID_B]) {
        expect(resolver.forExerciseId(id)).not.toHaveProperty('exerciseOwnName');
        expect(resolver.forExerciseId(id)).not.toHaveProperty('exerciseOwnNameLanguage');
      }
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it('P156 D-04 a pulled override with a blank name is unreadable and leaves no own name', async () => {
    const zeroWidth = encryptOverride(overridePayload({ exerciseId: ID_C, name: '\u200B\uFEFF' }));
    const spaces = encryptOverride(overridePayload({ exerciseId: ID_D, name: '   ' }));
    // A visible name with code units from W at its edges stays byte for byte as it is.
    const visibleWithEdges = encryptOverride(overridePayload({ exerciseId: ID_E, name: '\uFEFFDips ' }));
    mockFetchSnapshot.mockResolvedValueOnce(
      makePull({
        exerciseNameOverrides: [
          overrideRow('row-blank-zw', `${ID_C}:de`, zeroWidth),
          overrideRow('row-blank-sp', `${ID_D}:de`, spaces),
          overrideRow('row-visible', `${ID_E}:de`, visibleWithEdges),
        ],
      }),
    );
    const cache = await getSnapshot(PAT, OVERRIDE_KEY_B64, URL);

    expect(cache.snapshot.exerciseNameOverrides?.map((o) => o.exerciseId)).toEqual([ID_E]);
    expect(cache.snapshot.exerciseNameOverrides?.[0].name).toBe('\uFEFFDips ');
    const routing = { createdAt: 1_791_400_000_000, updatedAt: 1_791_400_000_000 };
    expect(cache.decodeReport!.unreadable).toEqual([
      { entity: 'exerciseNameOverride', id: 'row-blank-zw', reason: 'malformed_payload', ...routing },
      { entity: 'exerciseNameOverride', id: 'row-blank-sp', reason: 'malformed_payload', ...routing },
    ]);

    const catalog = [
      catalogExercise(ID_C, 'p156_c'),
      catalogExercise(ID_D, 'p156_d'),
      catalogExercise(ID_E, 'p156_e'),
    ];
    const resolver = createExerciseNameResolver({ catalog, snapshot: cache.snapshot, lang: 'de' });
    expect(resolver.forExerciseId(ID_C)).toEqual({ exerciseName: 'Katalog p156_c', exerciseKey: 'p156_c' });
    expect(resolver.forExerciseId(ID_D)).toEqual({ exerciseName: 'Katalog p156_d', exerciseKey: 'p156_d' });
    expect(resolver.forExerciseId(ID_E).exerciseOwnName?.text).toBe('\uFEFFDips ');
  });

  it('P156 D-04 isBlankOverrideText tests exactly the set W of §1.7, never trim()', () => {
    // The set W of protocol §1.7 "Blank text", written out as code unit ranges.
    const W: Array<[number, number]> = [
      [0x0009, 0x000d], [0x001c, 0x0020], [0x00a0, 0x00a0], [0x1680, 0x1680], [0x2000, 0x200d],
      [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x2060, 0x2060], [0x3000, 0x3000],
      [0xfeff, 0xfeff],
    ];
    const inW = (unit: number): boolean => W.some(([lo, hi]) => unit >= lo && unit <= hi);
    let blankUnits = 0;
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const text = String.fromCharCode(unit);
      expect(isBlankOverrideText(text), `U+${unit.toString(16).padStart(4, '0')}`).toBe(inW(unit));
      if (inW(unit)) blankUnits += 1;
    }
    expect(blankUnits).toBe(5 + 5 + 1 + 1 + 14 + 2 + 1 + 1 + 1 + 1 + 1);
    expect(isBlankOverrideText('')).toBe(true);
    expect(isBlankOverrideText(' \u001f\u3000\u200b\ufeff')).toBe(true);
    expect(isBlankOverrideText(' a ')).toBe(false);
    // Where JavaScript's own trim() differs from W (the reason not to use it).
    expect('\u001f'.trim()).toBe('\u001f');
    expect(isBlankOverrideText('\u001f')).toBe(true);
    expect('\u200b'.trim()).toBe('\u200b');
    expect(isBlankOverrideText('\u200b')).toBe(true);
    expect('\u180e'.trim()).toBe('\u180e');
    expect(isBlankOverrideText('\u180e')).toBe(false);
  });
});

// ── Own exercises, encrypted (Phase 164, CRYPT-01, SC 2, O-6) ────────────────
//
// The template and catalog tools name an own exercise the server holds only as ciphertext
// byte for byte as they named the plaintext row: the same pull once in plaintext (reference)
// and once encrypted, both through the REAL getSnapshot() → decryptMerge → catalog projection.
describe('decrypt-merge: own exercises, encrypted (Phase 164)', () => {
  it('P164 template and catalog tools name an encrypted own exercise like before', async () => {
    const OWN = '16400000-0000-4000-8000-0000000000d1';
    const TEMPLATE = '16400000-0000-4000-8000-0000000000f1';
    const BLOCK = '16400000-0000-4000-8000-0000000000f2';
    const times = { createdAt: 1_792_000_000_000, updatedAt: 1_792_000_000_100 };
    const own = ownExercisePair({ id: OWN, name: 'Ringstütz tief', mode: 'TIME', usesWeight: true, description: 'Ellbogen eng.' }, times);
    const ownDe = ownTranslationPair(
      { id: '16400000-0000-4000-8000-0000000000e1', exerciseId: OWN, languageCode: 'de', name: 'Ringstütz, tief', description: 'Eng.' },
      times,
    );
    const curated: CatalogExerciseWire = {
      id: 'cccccccc-1640-4000-c000-000000000001', key: 'dip', nameEn: 'Dip', mode: 'REPS', usesWeight: false,
      lastModifiedAt: 1, translations: [{ languageCode: 'de', name: 'Dip' }], muscleGroups: [],
    };

    async function toolsOf(exercises: SyncExerciseDto[], translations: SyncExerciseTranslationDto[]): Promise<string[]> {
      __resetCache();
      mockFetchCatalog.mockResolvedValueOnce([curated]);
      mockFetchSnapshot.mockResolvedValueOnce(makePull({
        exercises,
        exerciseTranslations: translations,
        templates: [{ id: TEMPLATE, name: 'Ringe', createdAt: times.createdAt, updatedAt: times.updatedAt, isFavoriteForWatch: false }],
        blocks: [{ id: BLOCK, templateId: TEMPLATE, name: 'A', orderIndex: 0, createdAt: times.createdAt, updatedAt: times.updatedAt }],
        templateExercises: [{
          id: '16400000-0000-4000-8000-0000000000f3', templateId: TEMPLATE, blockId: BLOCK, exerciseId: OWN,
          exerciseSource: 'CUSTOM', mode: 'TIME', targetTimeSeconds: 30, restTimeSeconds: 60, orderIndex: 0,
          createdAt: times.createdAt, updatedAt: times.updatedAt,
        }],
      }));
      const { snapshot, catalog } = await getSnapshot(PAT, OWN_TEST_KEY_B64, URL);
      const out: string[] = [];
      for (const lang of [undefined, 'de']) {
        const resolver = createExerciseNameResolver({ catalog, snapshot, lang });
        out.push(JSON.stringify(getTemplate({ templateId: TEMPLATE }, snapshot, resolver)));
        out.push(JSON.stringify(getExerciseCatalog(lang === undefined ? {} : { lang }, catalog, snapshot)));
      }
      out.push(JSON.stringify(listTemplates(snapshot)));
      return out;
    }

    const plain = await toolsOf([own.plaintext], [ownDe.plaintext]);
    const cipher = await toolsOf([own.encrypted], [ownDe.encrypted]);

    expect(cipher).toHaveLength(5);
    for (let i = 0; i < plain.length; i += 1) expect(cipher[i], `output ${i}`).toBe(plain[i]);
    // The reference names the own exercise — the comparison is not empty against empty.
    expect(plain[0]).toContain('"exerciseName":"Ringstütz tief"');
    expect(plain[2]).toContain('"exerciseName":"Ringstütz, tief"');
    expect(plain[1]).toContain('"nameEn":"Ringstütz tief"');
    expect(cipher.join('')).not.toContain('encryptedPayload');
  });
});
