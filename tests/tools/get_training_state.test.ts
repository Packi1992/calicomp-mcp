/**
 * get_training_state.ts unit tests (Phase 137, D-14 — completed by Plan 137-12).
 *
 * Covers the pure getTrainingState() function's final, additive-only result shape:
 *   - all ten fields of the interface contract are present
 *   - consistency/muscleBalance match the standalone calculators for the same inputs
 *   - the adherence block is the SHORT FORM (never matches/missed)
 *   - the adherence window derives from adherenceWindowWeeks, ending on asOfDate
 *   - recentExercises is capped by recentExerciseCount and carries no points field
 *   - parametersSource/parameters passthrough
 *   - resolveTimeZoneId propagation (TimeZoneUnavailableError uncaught from the pure fn)
 *   - determinism: two calls, same snapshot + nowMs, deep-equal result incl. narrative
 * ...and the registered MCP handler's coach-parameter fallback and isError path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../../src/cache.js');
vi.mock('../../src/coach-parameters.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/coach-parameters.js')>(
    '../../src/coach-parameters.js',
  );
  return { ...actual, loadCoachParameters: vi.fn() };
});

import * as cacheModule from '../../src/cache.js';
import * as coachParametersModule from '../../src/coach-parameters.js';
import { COACH_PARAMETER_DEFAULTS } from '../../src/coach-parameters.js';
import { getTrainingState, registerToolGetTrainingState } from '../../src/tools/get_training_state.js';
import { computeConsistency } from '../../src/training-state/consistency.js';
import { computeMuscleBalance } from '../../src/training-state/muscle-balance.js';
import { computeTemplateFeedbackSeries } from '../../src/training-state/template-feedback-series.js';
import { TRAINING_TIMEZONE_SETTING_KEY, TimeZoneUnavailableError } from '../../src/training-state/time-zone.js';
import { mockSnapshot, mockCatalog } from '../fixture.js';
import type { DecryptedSnapshot, DecodeReport } from '../../src/types.js';

const TZ = 'Europe/Berlin';
const NOW_MS = Date.UTC(2026, 2, 16, 12, 0); // 2026-03-16, a Monday

function snapshotWithZone(zone: string | null, extra: Partial<DecryptedSnapshot> = {}): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    settings: zone === null ? [] : [{ key: TRAINING_TIMEZONE_SETTING_KEY, type: 's', value: zone }],
    ...extra,
  };
}

const EXPECTED_KEYS = [
  'timeZoneId',
  'asOfDate',
  'parametersSource',
  'parameters',
  'consistency',
  'muscleBalance',
  'adherence',
  'recentExercises',
  'personalRecords',
  'narrative',
  'templateFeedbackSeries',
].sort();

describe('getTrainingState', () => {
  it('returns exactly the eleven fields of the final result shape (Phase 151, FB-12 adds templateFeedbackSeries)', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
  });

  it('consistency and muscleBalance match the standalone calculators for the same inputs', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    expect(result.timeZoneId).toBe(TZ);
    expect(result.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.consistency).toEqual(computeConsistency(snapshot, mockCatalog, TZ, NOW_MS));
    expect(result.muscleBalance).toEqual(computeMuscleBalance(snapshot, mockCatalog, NOW_MS));
  });

  it('adherence carries the short form (window, tolerance, counts, ratio, explanation) but never matches or missed', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    if (result.adherence === null) throw new Error('expected a readable-calendar adherence object');
    expect(result.adherence).not.toHaveProperty('matches');
    expect(result.adherence).not.toHaveProperty('missed');
    expect(result.adherence).toHaveProperty('window');
    expect(result.adherence).toHaveProperty('toleranceDays');
    expect(result.adherence).toHaveProperty('plannedCount');
    expect(result.adherence).toHaveProperty('matchedCount');
    expect(result.adherence).toHaveProperty('uncertainCount');
    expect(result.adherence).toHaveProperty('missedCount');
    expect(result.adherence).toHaveProperty('removedOccurrenceCount');
    expect(result.adherence).toHaveProperty('adherenceRatio');
    expect(typeof result.adherence.explanation).toBe('string');
  });

  it('the adherence window ends at asOfDate and spans back adherenceWindowWeeks', () => {
    const snapshot = snapshotWithZone(TZ);
    const params = { ...COACH_PARAMETER_DEFAULTS, adherenceWindowWeeks: 2 };
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: params, parametersSource: 'server' },
      NOW_MS,
    );
    if (result.adherence === null) throw new Error('expected a readable-calendar adherence object');
    expect(result.adherence.window.to).toBe(result.asOfDate);
    // asOfDate is 2026-03-16 in Europe/Berlin; 2 weeks (14 days) back is 2026-03-02.
    expect(result.adherence.window.from).toBe('2026-03-02');
  });

  it('recentExercises is capped by recentExerciseCount and carries no points field', () => {
    const snapshot = snapshotWithZone(TZ);
    const params = { ...COACH_PARAMETER_DEFAULTS, recentExerciseCount: 1 };
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: params, parametersSource: 'server' },
      NOW_MS,
    );
    expect(result.recentExercises.length).toBeLessThanOrEqual(1);
    for (const entry of result.recentExercises) {
      expect(entry).not.toHaveProperty('points');
      expect(entry).toHaveProperty('exerciseId');
      expect(entry).toHaveProperty('exerciseName');
      expect(entry).toHaveProperty('metric');
      expect(entry).toHaveProperty('lastTrainedOn');
      expect(entry).toHaveProperty('bestSetDirection');
      expect(entry).toHaveProperty('sessionTotalDirection');
      expect(entry).toHaveProperty('rule');
    }
  });

  it('personalRecords carries maxReps and maxHoldSeconds', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    expect(result.personalRecords).toHaveProperty('maxReps');
    expect(result.personalRecords).toHaveProperty('maxHoldSeconds');
  });

  it('carries parametersSource and parameters exactly as supplied by the caller', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'defaults' },
      NOW_MS,
    );
    expect(result.parametersSource).toBe('defaults');
    expect(result.parameters).toEqual(COACH_PARAMETER_DEFAULTS);
  });

  it('returns a non-empty narrative string', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    expect(typeof result.narrative).toBe('string');
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  it('propagates TimeZoneUnavailableError from the pure function when no time-zone row is synced', () => {
    const snapshot = snapshotWithZone(null);
    expect(() =>
      getTrainingState(
        {},
        { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
        NOW_MS,
      ),
    ).toThrow(TimeZoneUnavailableError);
  });

  it('two calls with the same snapshot and nowMs produce a deeply equal result, including narrative', () => {
    const snapshot = snapshotWithZone(TZ);
    const data = {
      snapshot,
      catalog: mockCatalog,
      coachParameters: COACH_PARAMETER_DEFAULTS,
      parametersSource: 'server' as const,
    };
    const first = getTrainingState({}, data, NOW_MS);
    const second = getTrainingState({}, data, NOW_MS);
    expect(first).toEqual(second);
    expect(first.narrative).toBe(second.narrative);
  });

  it('P150 D-32 a readable calendar keeps adherence and narrative unchanged', () => {
    const snapshot = snapshotWithZone(TZ);
    const data = {
      snapshot,
      catalog: mockCatalog,
      coachParameters: COACH_PARAMETER_DEFAULTS,
      parametersSource: 'server' as const,
    };
    const withoutFlag = getTrainingState({}, data, NOW_MS);
    const withTrueFlag = getTrainingState({}, { ...data, calendarReadable: true }, NOW_MS);
    expect(withoutFlag).toEqual(withTrueFlag);
    expect(withoutFlag).not.toHaveProperty('adherenceUnavailableReason');
    expect(withoutFlag.adherence).not.toBeNull();
  });

  it('P151 FB-12 get_training_state carries templateFeedbackSeries after the narrative', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    expect(result.templateFeedbackSeries).toEqual(computeTemplateFeedbackSeries(snapshot, TZ));
    const keys = Object.keys(result);
    expect(keys.indexOf('templateFeedbackSeries')).toBeGreaterThan(keys.indexOf('narrative'));
  });
});

// ---------------------------------------------------------------------------
// Registered MCP handler
// ---------------------------------------------------------------------------

const DUMMY_CFG = { pat: 'calicomp_pat_test_secret', keyB64: 'AAAA', serverUrl: 'https://example.test' };

function mockCacheFor(snapshot: DecryptedSnapshot) {
  return {
    snapshot,
    catalog: mockCatalog,
    profile: {
      userId: 'user-test-1',
      email: 'test@example.com',
      displayName: 'Test User',
      avatarUrl: 'https://example.com/avatar.svg',
      isPremium: false,
      createdAt: 1_700_000_000_000,
    },
    fetchedAt: Date.now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['get_training_state'].handler;
}

describe('get_training_state — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockReset();
    vi.mocked(coachParametersModule.loadCoachParameters).mockReset();
  });

  it('falls back to defaults and still succeeds when the coach-parameters route reports a fallback', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.parametersSource).toBe('defaults');
    expect(body.parameters).toEqual(COACH_PARAMETER_DEFAULTS);
    expect(body).toHaveProperty('narrative');
  });

  it('responds with a structured isError, naming neither PAT nor key, when no time-zone row is synced', async () => {
    const snapshot = snapshotWithZone(null);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.keyB64);
  });

  // -------------------------------------------------------------------------
  // Phase 150 (D-32/D-11/D-09-ermessen) — per-row decode fault tolerance
  // -------------------------------------------------------------------------

  const EMPTY_COUNTS = { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0 };

  const REPORT_ONE_BROKEN_PLANNED: DecodeReport = {
    unreadable: [{ entity: 'plannedWorkout', id: 'pw-broken', reason: 'decrypt_failed' }],
    encryptedCount: { ...EMPTY_COUNTS, plannedWorkout: 1 },
    failedCount: { ...EMPTY_COUNTS, plannedWorkout: 1 },
  };

  const REPORT_ALL_SESSIONS_FAILED: DecodeReport = {
    unreadable: [{ entity: 'session', id: 'sess-broken', reason: 'decrypt_failed' }],
    encryptedCount: { ...EMPTY_COUNTS, session: 1 },
    failedCount: { ...EMPTY_COUNTS, session: 1 },
  };

  // Two encrypted settings, only the tz one fails — so the D-11 100%-failure guard on
  // 'setting' never trips before assertTimeZoneReadable gets a chance to run.
  const REPORT_TZ_UNREADABLE: DecodeReport = {
    unreadable: [{ entity: 'setting', id: 'set-tz', reason: 'malformed_payload', key: TRAINING_TIMEZONE_SETTING_KEY }],
    encryptedCount: { ...EMPTY_COUNTS, setting: 2 },
    failedCount: { ...EMPTY_COUNTS, setting: 1 },
  };

  it('P150 D-32 an unreadable planned row degrades adherence to null with a reason', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(snapshot),
      decodeReport: REPORT_ONE_BROKEN_PLANNED,
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.adherence).toBeNull();
    expect(body.adherenceUnavailableReason).toBe('calendar_unreadable');
    expect(body.narrative as string).toContain('The training calendar could not be read');
    expect(body.unreadable).toEqual(REPORT_ONE_BROKEN_PLANNED.unreadable);
  });

  it('P150 D-11 get_training_state refuses when every encrypted session failed', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(snapshot),
      decodeReport: REPORT_ALL_SESSIONS_FAILED,
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('every encrypted session');
    expect(result.content[0].text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.keyB64);
  });

  it('P150 get_training_state names the unreadable tz setting', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(snapshot),
      decodeReport: REPORT_TZ_UNREADABLE,
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('Missing synchronized settings key');
    expect(result.content[0].text).toContain(TRAINING_TIMEZONE_SETTING_KEY);
  });
});

// ---------------------------------------------------------------------------
// Exercise names (Phase 150, D-03/D-16/D-17)
// ---------------------------------------------------------------------------

describe('get_training_state — exercise names (D-03/D-16/D-17)', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockReset();
    vi.mocked(coachParametersModule.loadCoachParameters).mockReset();
  });

  it('P150 D-16 recentExercises and personalRecords carry exerciseKey', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    const body = JSON.parse(result.content[0].text) as {
      recentExercises: Array<{ exerciseKey?: string | null }>;
      personalRecords: { maxReps: Array<{ exerciseKey?: string | null }> };
    };
    expect(body.recentExercises.length).toBeGreaterThan(0);
    for (const entry of body.recentExercises) {
      expect(entry.exerciseKey).toBeTruthy();
    }
    expect(body.personalRecords.maxReps.length).toBeGreaterThan(0);
    for (const record of body.personalRecords.maxReps) {
      expect(record.exerciseKey).toBeTruthy();
    }
  });

  it('P150 D-03 the narrative is unchanged even with lang set', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const withoutLang = await handler({});
    const withLang = await handler({ lang: 'de' });
    const bodyWithoutLang = JSON.parse(withoutLang.content[0].text) as { narrative: string };
    const bodyWithLang = JSON.parse(withLang.content[0].text) as { narrative: string };
    expect(bodyWithLang.narrative).toBe(bodyWithoutLang.narrative);
  });

  it('P150 D-17 a deleted user exercise in personalRecords keeps its name', async () => {
    const deletedUserExerciseId = 'eeeeeeee-0010-4000-e000-000000000001';
    const snapshot = snapshotWithZone(TZ, {
      exercises: [
        {
          id: deletedUserExerciseId,
          name: 'Alte Übung',
          mode: 'REPS',
          usesWeight: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          deletedAt: 1_700_000_100_000,
        },
      ],
      setLogs: [
        ...mockSnapshot.setLogs,
        {
          id: 'sl-deleted-exercise',
          sessionId: mockSnapshot.sessions[0].id,
          exerciseId: deletedUserExerciseId,
          completedReps: 12,
          completedTimeSeconds: null,
          weightUsed: null,
          startedAt: null,
          measuredTimeSeconds: null,
          createdAt: mockSnapshot.sessions[0].startTime,
          updatedAt: mockSnapshot.sessions[0].startTime,
        },
      ],
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    const body = JSON.parse(result.content[0].text) as {
      personalRecords: { maxReps: Array<{ exerciseId: string; exerciseName: string | null; exerciseDeleted?: boolean }> };
    };
    const record = body.personalRecords.maxReps.find((r) => r.exerciseId === deletedUserExerciseId);
    expect(record).toBeDefined();
    expect(record!.exerciseName).toBe('Alte Übung');
    expect(record!.exerciseDeleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// templateFeedbackSeries description (Phase 151, FB-12, D-27/D-29)
// ---------------------------------------------------------------------------

describe('get_training_state — templateFeedbackSeries description', () => {
  it('P151 D-27 the description names the attainment rule, the approximation and hasComment', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server as any)._registeredTools['get_training_state'].description as string;

    expect(description).toContain('templateFeedbackSeries');
    expect(description).toContain('achievedSets');
    expect(description).toContain('totalSets');
    expect(description).toContain('MAX');
    expect(description).toContain('weight is never checked');
    expect(description).toContain('approximation_current_template');
    expect(description).toContain('stored_goals');
    expect(description).toContain('hasComment');
  });
});
