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
import { TRAINING_TIMEZONE_SETTING_KEY, TimeZoneUnavailableError } from '../../src/training-state/time-zone.js';
import { mockSnapshot, mockCatalog } from '../fixture.js';
import type { DecryptedSnapshot } from '../../src/types.js';

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
].sort();

describe('getTrainingState', () => {
  it('returns exactly the ten fields of the final result shape', () => {
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
});
