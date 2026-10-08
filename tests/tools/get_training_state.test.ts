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
import { computeForeignAdherence } from '../../src/training-state/foreign-adherence.js';
import { FOREIGN_LOAD_EXPLANATION } from '../../src/training-state/foreign-load.js';
import { protocolExplanation } from '../protocol-text.js';
import type {
  DecryptedSnapshot,
  DecodeReport,
  DecryptedForeignActivity,
  DecryptedPlannedForeignActivity,
  DecryptedSession,
} from '../../src/types.js';

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
  'foreignSport',
].sort();

describe('getTrainingState', () => {
  it('returns exactly the twelve fields of the final result shape (Phase 151 adds templateFeedbackSeries, Phase 155 foreignSport)', () => {
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
// Phase 155 (FA-08, D-16) — the foreign sport block
// ---------------------------------------------------------------------------

const FT_RUNNING = 'b85b2339-ddf1-385d-acb2-b0d3d498eeca';
const FT_BOULDERING = 'bfb3bdb2-6bcc-37b6-92cc-11dec4db64c7';

function foreignActivity(overrides: Partial<DecryptedForeignActivity> & { id: string }): DecryptedForeignActivity {
  return {
    typeId: FT_RUNNING,
    performedOn: '2026-03-16',
    performedTime: null,
    durationMinutes: 30,
    intensity: 3,
    dayForm: null,
    distanceMeters: null,
    note: null,
    createdAt: Date.UTC(2026, 2, 1),
    updatedAt: Date.UTC(2026, 2, 1),
    ...overrides,
  };
}

/** Foreign activities around asOfDate 2026-03-16, also on days of the mock sessions. */
const FOREIGN_ACTIVITIES: DecryptedForeignActivity[] = [
  foreignActivity({ id: 'fa-today', performedOn: '2026-03-16', durationMinutes: 45, intensity: 4 }),
  foreignActivity({ id: 'fa-day-6', performedOn: '2026-03-10', durationMinutes: 60, intensity: 2 }),
  foreignActivity({ id: 'fa-day-7', typeId: FT_BOULDERING, performedOn: '2026-03-09', durationMinutes: 90, intensity: 5 }),
  foreignActivity({ id: 'fa-day-27', performedOn: '2026-02-17', durationMinutes: 20, intensity: null }),
  foreignActivity({ id: 'fa-day-28', performedOn: '2026-02-16', durationMinutes: 500, intensity: 5 }),
  ...mockSnapshot.sessions.map((s, i) =>
    foreignActivity({ id: `fa-session-day-${i}`, performedOn: new Date(s.startTime).toISOString().slice(0, 10) }),
  ),
];

function foreignRoot(
  overrides: Partial<DecryptedPlannedForeignActivity> & { id: string },
): DecryptedPlannedForeignActivity {
  return {
    typeId: FT_RUNNING,
    scheduledDate: Date.UTC(2026, 2, 10),
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    deletedOccurrencesRaw: null,
    createdAt: Date.UTC(2026, 1, 1),
    updatedAt: Date.UTC(2026, 1, 1),
    ...overrides,
  };
}

function withForeign(snapshot: DecryptedSnapshot, activities = FOREIGN_ACTIVITIES): DecryptedSnapshot {
  return { ...snapshot, foreignActivityTypes: [], foreignActivities: activities, plannedForeignActivities: [] };
}

describe('getTrainingState — Phase 155 foreign sport (D-16)', () => {
  const baseData = {
    catalog: mockCatalog,
    coachParameters: COACH_PARAMETER_DEFAULTS,
    parametersSource: 'server' as const,
  };

  it('P155 D-16 foreignSport is the last key and narrative is byte-identical', () => {
    const plain = snapshotWithZone(TZ);
    const without = getTrainingState({}, { ...baseData, snapshot: plain }, NOW_MS);
    const withData = getTrainingState({}, { ...baseData, snapshot: withForeign(plain) }, NOW_MS);

    const keys = Object.keys(withData);
    expect(keys.slice(-2)).toEqual(['templateFeedbackSeries', 'foreignSport']);
    expect(withData.narrative).toBe(without.narrative);
    const { foreignSport: _a, ...oldWith } = withData;
    const { foreignSport: _b, ...oldWithout } = without;
    expect(JSON.stringify(oldWith)).toBe(JSON.stringify(oldWithout));
    expect(oldWith.consistency).toEqual(oldWithout.consistency);

    expect(withData.foreignSport.available).toBe(true);
    expect(withData.foreignSport.asOfDate).toBe('2026-03-16');
  });

  it('P155 D-16 the windows end on asOfDate and span 7 and 28 days inclusive', () => {
    const result = getTrainingState(
      {},
      { ...baseData, snapshot: withForeign(snapshotWithZone(TZ), FOREIGN_ACTIVITIES.slice(0, 5)) },
      NOW_MS,
    );
    const sport = result.foreignSport;
    if (!sport.available) throw new Error('expected an available foreign block');
    const { last7Days, last28Days } = sport.windows;
    expect([last7Days.from, last7Days.to]).toEqual(['2026-03-10', '2026-03-16']);
    expect([last28Days.from, last28Days.to]).toEqual(['2026-02-17', '2026-03-16']);
    // 7 days: fa-today + fa-day-6 (fa-day-7 is outside).
    expect(last7Days.activityCount).toBe(2);
    expect(last7Days.totalMinutes).toBe(105);
    expect(last7Days.intensityMinutes).toBe(4 * 45 + 2 * 60);
    // 28 days: plus fa-day-7 and fa-day-27 (no intensity); fa-day-28 is outside.
    expect(last28Days.activityCount).toBe(4);
    expect(last28Days.totalMinutes).toBe(45 + 60 + 90 + 20);
    expect(last28Days.intensityMinutes).toBe(4 * 45 + 2 * 60 + 5 * 90);
    expect(last28Days.activitiesWithoutIntensity).toBe(1);
    expect(sport.loadApproximation).toMatchObject({ metric: 'intensity_x_minutes', isApproximation: true });
  });

  it('P155 D-12 the training state carries the foreign adherence short form in the template adherence window', () => {
    // Template short form window with adherenceWindowWeeks 2: 2026-03-02 … 2026-03-16.
    const params = { ...COACH_PARAMETER_DEFAULTS, adherenceWindowWeeks: 2 };
    const roots: DecryptedPlannedForeignActivity[] = [
      foreignRoot({ id: 'pfa-done', scheduledDate: Date.UTC(2026, 2, 10) }), // fulfilled by fa-day-6
      foreignRoot({ id: 'pfa-missed', typeId: FT_BOULDERING, scheduledDate: Date.UTC(2026, 2, 12) }), // missed
      foreignRoot({ id: 'pfa-today', scheduledDate: Date.UTC(2026, 2, 16), scheduledTime: '19:00' }), // fulfilled by fa-today
      foreignRoot({ id: 'pfa-tonight', typeId: FT_BOULDERING, scheduledDate: Date.UTC(2026, 2, 16) }), // upcoming (today)
      foreignRoot({ id: 'pfa-before', scheduledDate: Date.UTC(2026, 2, 1) }), // outside the window
      // Weekly on Wednesday from 2026-03-04; 2026-03-11 cancelled → 03-04 missed, 03-11 removed.
      foreignRoot({
        id: 'pfa-series',
        typeId: FT_BOULDERING,
        scheduledDate: Date.UTC(2026, 2, 4),
        recurrenceRule: 'FREQ=WEEKLY;BYDAY=WE',
        deletedOccurrencesRaw: '["2026-03-11"]',
      }),
    ];
    const snapshot: DecryptedSnapshot = {
      ...withForeign(snapshotWithZone(TZ), FOREIGN_ACTIVITIES.slice(0, 5)),
      plannedForeignActivities: roots,
    };
    const result = getTrainingState({}, { ...baseData, coachParameters: params, snapshot }, NOW_MS);
    const sport = result.foreignSport;
    if (!sport.available) throw new Error('expected an available foreign block');
    expect(Object.keys(sport.adherence)).toEqual([
      'window',
      'plannedCount',
      'fulfilledCount',
      'missedCount',
      'upcomingCount',
      'removedOccurrenceCount',
      'fulfilmentRatio',
    ]);
    expect(sport.adherence).toEqual({
      window: { from: '2026-03-02', to: '2026-03-16' },
      plannedCount: 5,
      fulfilledCount: 2,
      missedCount: 2,
      upcomingCount: 1,
      removedOccurrenceCount: 1,
      fulfilmentRatio: 0.5,
    });
    if (result.adherence === null) throw new Error('expected a readable-calendar adherence object');
    expect(sport.adherence.window).toEqual(result.adherence.window);
    // Same numbers as the get_adherence pass over the same window.
    const full = computeForeignAdherence(
      { from: '2026-03-02', to: '2026-03-16', asOfDate: '2026-03-16' },
      { snapshot, availability: { available: true } },
    );
    if (!full.available) throw new Error('expected an available foreign adherence');
    expect(sport.adherence.plannedCount).toBe(full.plannedCount);
    expect(sport.adherence.fulfilmentRatio).toBe(full.fulfilmentRatio);
  });

  it('P155 D-16 loadApproximation is marked as an approximation in every result, also when foreign sport is unavailable', () => {
    const expected = { metric: 'intensity_x_minutes', isApproximation: true, explanation: FOREIGN_LOAD_EXPLANATION };
    const available = getTrainingState({}, { ...baseData, snapshot: withForeign(snapshotWithZone(TZ)) }, NOW_MS);
    const noServerFields = getTrainingState({}, { ...baseData, snapshot: snapshotWithZone(TZ) }, NOW_MS);
    const unreadable = getTrainingState(
      {},
      {
        ...baseData,
        snapshot: withForeign(snapshotWithZone(TZ)),
        foreignAvailability: { available: false, reason: 'foreign_rows_unreadable' },
      },
      NOW_MS,
    );
    for (const result of [available, noServerFields, unreadable]) {
      expect(result.foreignSport.loadApproximation).toEqual(expected);
    }
    expect(Object.keys(noServerFields.foreignSport)).toEqual(['available', 'reason', 'asOfDate', 'loadApproximation']);
    expect(Object.keys(unreadable.foreignSport)).toEqual(['available', 'reason', 'asOfDate', 'loadApproximation']);
    expect(Object.keys(available.foreignSport)).toEqual(['available', 'asOfDate', 'windows', 'adherence', 'loadApproximation']);
  });

  it('P155 E-9 get_training_state reports server_without_foreign_sport', () => {
    const plain = snapshotWithZone(TZ);
    const result = getTrainingState({}, { ...baseData, snapshot: plain }, NOW_MS);
    expect(result.foreignSport).toEqual({
      available: false,
      reason: 'server_without_foreign_sport',
      asOfDate: '2026-03-16',
      loadApproximation: { metric: 'intensity_x_minutes', isApproximation: true, explanation: FOREIGN_LOAD_EXPLANATION },
    });
  });

  it('P155 E-8 a foreign root whose rule the expander refuses degrades only the foreign block', () => {
    const plain = snapshotWithZone(TZ);
    const broken: DecryptedSnapshot = {
      ...withForeign(plain),
      plannedForeignActivities: [
        foreignRoot({ id: 'pfa-broken', scheduledDate: Date.UTC(2026, 2, 3), recurrenceRule: 'FREQ=WEEKLY;INTERVAL=0;BYDAY=TU' }),
      ],
    };
    const result = getTrainingState({}, { ...baseData, snapshot: broken }, NOW_MS);
    expect(result.foreignSport).toMatchObject({ available: false, reason: 'foreign_rows_unreadable' });
    const without = getTrainingState({}, { ...baseData, snapshot: plain }, NOW_MS);
    const { foreignSport: _a, ...oldBroken } = result;
    const { foreignSport: _b, ...oldPlain } = without;
    expect(JSON.stringify(oldBroken)).toBe(JSON.stringify(oldPlain));
  });

  it('P155 SC3 consistency counts no foreign activity', () => {
    // Sessions on the Mondays of the last three weeks; foreign activities only on
    // training-free days, including a whole week without a session (2026-02-23 … 03-01)
    // that would lengthen the streak, and this week's Sunday.
    const session = (id: string, y: number, m: number, d: number): DecryptedSession => ({
      id,
      templateId: mockSnapshot.templates[0].id,
      startTime: Date.UTC(y, m - 1, d, 8),
      endTime: Date.UTC(y, m - 1, d, 9),
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: Date.UTC(y, m - 1, d, 8),
      updatedAt: Date.UTC(y, m - 1, d, 9),
    });
    const trained = snapshotWithZone(TZ, {
      sessions: [session('s-1', 2026, 3, 2), session('s-2', 2026, 3, 9), session('s-3', 2026, 3, 16)],
    });
    const freeDayActivities = ['2026-02-24', '2026-02-26', '2026-03-04', '2026-03-12', '2026-03-15'].map((day, i) =>
      foreignActivity({ id: `fa-free-${i}`, performedOn: day }),
    );
    const without = getTrainingState({}, { ...baseData, snapshot: trained }, NOW_MS);
    const withData = getTrainingState({}, { ...baseData, snapshot: withForeign(trained, freeDayActivities) }, NOW_MS);
    expect(without.consistency.currentStreakWeeks).toBeGreaterThan(0);
    expect(withData.consistency).toEqual(without.consistency);
    expect(withData.consistency.currentStreakWeeks).toBe(without.consistency.currentStreakWeeks);
    expect(withData.consistency.sessionsLast4Weeks).toBe(without.consistency.sessionsLast4Weeks);
    expect(withData.consistency.totalCompletedSessions).toBe(3);
    expect(withData.narrative).toBe(without.narrative);
    // ...while the foreign block does see them.
    if (!withData.foreignSport.available) throw new Error('expected an available foreign block');
    expect(withData.foreignSport.windows.last28Days.activityCount).toBe(5);
  });

  it('P155 D-16 the load explanation is verbatim in the protocol', () => {
    const protocolText = protocolExplanation('FOREIGN_LOAD_EXPLANATION');
    expect(FOREIGN_LOAD_EXPLANATION).toBe(protocolText);
    const result = getTrainingState({}, { ...baseData, snapshot: snapshotWithZone(TZ) }, NOW_MS);
    expect(result.foreignSport.loadApproximation.explanation).toBe(protocolText);
  });

  it('P155 D-16 the description explains the foreign sport block', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTrainingState(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description: string = (server as any)._registeredTools['get_training_state'].description;
    for (const fragment of [
      'foreignSport',
      'last7Days',
      'last28Days',
      'intensityMinutes',
      'activitiesWithoutIntensity',
      'loadApproximation',
      'isApproximation',
      'fulfilmentRatio',
      'server_without_foreign_sport',
      'foreign_rows_unreadable',
      '60 seconds',
    ]) {
      expect(description).toContain(fragment);
    }
    expect(description).toMatch(/consistency and narrative (?:contain|count) no foreign sport/);
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

describe('getTrainingState — Phase 155 D-07', () => {
  it('P155 D-07 the get_training_state adherence short form does not carry the new fields', () => {
    const snapshot = snapshotWithZone(TZ, {
      plannedWorkouts: [
        {
          id: 'r-series',
          templateId: mockSnapshot.templates[0].id,
          scheduledDate: Date.UTC(2026, 2, 3),
          scheduledTime: null,
          note: null,
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
          recurrenceGroupId: null,
          deletedOccurrencesRaw: '["2026-03-10"]',
          completedSessionId: null,
        },
      ],
      sessions: [
        {
          id: 's-done',
          templateId: mockSnapshot.templates[0].id,
          startTime: Date.UTC(2026, 2, 10, 12),
          endTime: Date.UTC(2026, 2, 10, 13),
          isManual: false,
          isCorrected: false,
          isQuickChallenge: false,
          createdAt: Date.UTC(2026, 2, 10, 12),
          updatedAt: Date.UTC(2026, 2, 10, 13),
        },
      ],
    });
    const result = getTrainingState(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS, parametersSource: 'server' },
      NOW_MS,
    );
    if (result.adherence === null) throw new Error('expected a readable-calendar adherence object');
    expect(result.adherence.removedOccurrenceCount).toBe(1);
    expect(result.adherence).not.toHaveProperty('removedWithCompletedSessionCount');
    expect(result.adherence).not.toHaveProperty('removedWithCompletedSessionDates');
    expect(result.adherence).not.toHaveProperty('removedWithCompletedSessionExplanation');
    expect(Object.keys(result.adherence)).toEqual([
      'window',
      'toleranceDays',
      'plannedCount',
      'matchedCount',
      'uncertainCount',
      'missedCount',
      'removedOccurrenceCount',
      'adherenceRatio',
      'explanation',
    ]);
  });
});

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

  it('P155 E-8 get_training_state reports foreign_rows_unreadable and keeps every other field', async () => {
    const snapshot = withForeign(snapshotWithZone(TZ));
    const report: DecodeReport = {
      unreadable: [{ entity: 'foreignActivity', id: 'fa-broken', reason: 'decrypt_failed' }],
      encryptedCount: { ...EMPTY_COUNTS, foreignActivity: 3 },
      failedCount: { ...EMPTY_COUNTS, foreignActivity: 1 },
    };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({ ...mockCacheFor(snapshot), decodeReport: report });
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
    expect(body.foreignSport).toEqual({
      available: false,
      reason: 'foreign_rows_unreadable',
      asOfDate: body.asOfDate,
      loadApproximation: { metric: 'intensity_x_minutes', isApproximation: true, explanation: FOREIGN_LOAD_EXPLANATION },
    });
    expect(body.unreadable).toEqual(report.unreadable);
    // Every other field is the one the same snapshot yields with readable foreign rows.
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    const readableResult = await handler({});
    const readable = JSON.parse(readableResult.content[0].text) as Record<string, unknown>;
    expect((readable.foreignSport as { available: boolean }).available).toBe(true);
    const { foreignSport: _f, unreadable: _u, ...bodyRest } = body;
    const { foreignSport: _g, unreadable: _v, ...readableRest } = readable;
    expect(JSON.stringify(bodyRest)).toBe(JSON.stringify(readableRest));
    expect(body.adherence).not.toBeNull();
    expect(typeof body.narrative).toBe('string');
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
