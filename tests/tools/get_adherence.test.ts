/**
 * Tests for src/tools/get_adherence.ts (Phase 137, STATE-03) and its
 * `GetAdherenceSchema` (src/schemas.ts).
 *
 * Coverage mirrors the <behavior> block from 137-08-PLAN.md Task 3:
 *   - Schema: from/to optional, toleranceDays 0..7, windowWeeks 1..52, `to` < `from`
 *     rejected, span > 366 days rejected, windowWeeks + complete from/to rejected.
 *   - Pure function: default window from adherenceWindowWeeks ending on the
 *     athlete's calendar day; explicit from/to wins; toleranceDays/windowWeeks
 *     override without persisting; TimeZoneUnavailableError propagates uncaught.
 *   - Registered handler: parametersSource passthrough, outputFile summary
 *     (counts + explanation, never the full matches/missed lists), the isError
 *     path for a missing time-zone row with no credential material in the text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mocks — hoisted before static imports by Vitest.
vi.mock('../../src/cache.js');
vi.mock('../../src/coach-parameters.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/coach-parameters.js')>(
    '../../src/coach-parameters.js',
  );
  return { ...actual, loadCoachParameters: vi.fn() };
});
vi.mock('../../src/file-channel.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/file-channel.js')>('../../src/file-channel.js');
  return { ...actual, writeExportFile: vi.fn() };
});

import * as cacheModule from '../../src/cache.js';
import * as coachParametersModule from '../../src/coach-parameters.js';
import * as fileChannelModule from '../../src/file-channel.js';
import { COACH_PARAMETER_DEFAULTS } from '../../src/coach-parameters.js';
import { GetAdherenceSchema } from '../../src/schemas.js';
import { getAdherence, registerToolGetAdherence } from '../../src/tools/get_adherence.js';
import { FOREIGN_ADHERENCE_EXPLANATION } from '../../src/training-state/foreign-adherence.js';
import { REMOVED_WITH_COMPLETED_SESSION_EXPLANATION } from '../../src/training-state/adherence.js';
import { TRAINING_TIMEZONE_SETTING_KEY, TimeZoneUnavailableError } from '../../src/training-state/time-zone.js';
import { mockSnapshot, mockCatalog, TEMPLATE_ID_PUSH } from '../fixture.js';
import type {
  DecryptedSnapshot,
  DecryptedPlannedWorkout,
  DecryptedPlannedForeignActivity,
  DecryptedForeignActivity,
} from '../../src/types.js';

const TZ = 'Europe/Berlin';

function epochMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function root(overrides: Partial<DecryptedPlannedWorkout> & { id: string }): DecryptedPlannedWorkout {
  return {
    templateId: TEMPLATE_ID_PUSH,
    scheduledDate: epochMs(2026, 6, 4),
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    recurrenceGroupId: null,
    deletedOccurrencesRaw: null,
    completedSessionId: null,
    ...overrides,
  };
}

function snapshotWithZone(zone: string | null, extra: Partial<DecryptedSnapshot> = {}): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    plannedWorkouts: [],
    sessions: [],
    setLogs: [],
    settings: zone === null ? [] : [{ key: TRAINING_TIMEZONE_SETTING_KEY, type: 's', value: zone }],
    ...extra,
  };
}

// Phase 155 (FA-06): foreign sport fixtures. RUNNING is the predefined type id.
const FT_RUNNING = 'b85b2339-ddf1-385d-acb2-b0d3d498eeca';

function foreignRoot(
  overrides: Partial<DecryptedPlannedForeignActivity> & { id: string },
): DecryptedPlannedForeignActivity {
  return {
    typeId: FT_RUNNING,
    scheduledDate: epochMs(2026, 6, 3),
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    deletedOccurrencesRaw: null,
    createdAt: epochMs(2026, 5, 1),
    updatedAt: epochMs(2026, 5, 1),
    ...overrides,
  };
}

function foreignActivity(
  overrides: Partial<DecryptedForeignActivity> & { id: string },
): DecryptedForeignActivity {
  return {
    typeId: FT_RUNNING,
    performedOn: '2026-06-03',
    performedTime: null,
    durationMinutes: 30,
    intensity: 3,
    dayForm: null,
    distanceMeters: null,
    note: null,
    createdAt: epochMs(2026, 6, 3),
    updatedAt: epochMs(2026, 6, 3),
    ...overrides,
  };
}

/** Strip the foreign block — what is left are the template keys of `get_adherence`. */
function templateKeys(result: object): Record<string, unknown> {
  const { foreignSport: _foreignSport, ...rest } = result as Record<string, unknown>;
  void _foreignSport;
  return rest;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('GetAdherenceSchema', () => {
  it('accepts an empty object — every field is optional', () => {
    expect(GetAdherenceSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a complete from/to pair', () => {
    expect(GetAdherenceSchema.safeParse({ from: '2026-06-01', to: '2026-06-30' }).success).toBe(true);
  });

  it('rejects `to` before `from`', () => {
    expect(GetAdherenceSchema.safeParse({ from: '2026-06-30', to: '2026-06-01' }).success).toBe(false);
  });

  it('rejects a span over 366 days', () => {
    expect(GetAdherenceSchema.safeParse({ from: '2024-01-01', to: '2026-01-05' }).success).toBe(false);
  });

  it('accepts toleranceDays 0 and 7; rejects -1 and 8', () => {
    expect(GetAdherenceSchema.safeParse({ toleranceDays: 0 }).success).toBe(true);
    expect(GetAdherenceSchema.safeParse({ toleranceDays: 7 }).success).toBe(true);
    expect(GetAdherenceSchema.safeParse({ toleranceDays: -1 }).success).toBe(false);
    expect(GetAdherenceSchema.safeParse({ toleranceDays: 8 }).success).toBe(false);
  });

  it('accepts windowWeeks 1 and 52; rejects 0 and 53', () => {
    expect(GetAdherenceSchema.safeParse({ windowWeeks: 1 }).success).toBe(true);
    expect(GetAdherenceSchema.safeParse({ windowWeeks: 52 }).success).toBe(true);
    expect(GetAdherenceSchema.safeParse({ windowWeeks: 0 }).success).toBe(false);
    expect(GetAdherenceSchema.safeParse({ windowWeeks: 53 }).success).toBe(false);
  });

  it('rejects windowWeeks combined with a COMPLETE from/to pair', () => {
    const result = GetAdherenceSchema.safeParse({ windowWeeks: 4, from: '2026-06-01', to: '2026-06-30' });
    expect(result.success).toBe(false);
  });

  it('accepts windowWeeks alone (no from/to)', () => {
    expect(GetAdherenceSchema.safeParse({ windowWeeks: 4 }).success).toBe(true);
  });

  it('accepts windowWeeks with only one of from/to set (not a complete pair)', () => {
    expect(GetAdherenceSchema.safeParse({ windowWeeks: 4, from: '2026-06-01' }).success).toBe(true);
  });

  it('accepts outputFile true/false, rejects a string', () => {
    expect(GetAdherenceSchema.safeParse({ outputFile: true }).success).toBe(true);
    expect(GetAdherenceSchema.safeParse({ outputFile: false }).success).toBe(true);
    expect(GetAdherenceSchema.safeParse({ outputFile: '/etc/passwd' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAdherence — pure function
// ---------------------------------------------------------------------------

describe('getAdherence', () => {
  it('without from/to, builds the window from adherenceWindowWeeks ending on the athlete calendar day', () => {
    const snapshot = snapshotWithZone(TZ, {
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 5, 20) })],
    });
    const nowMs = epochMs(2026, 6, 4) + 12 * 3_600_000; // 2026-06-04 noon UTC → same day in Europe/Berlin
    const result = getAdherence(
      {},
      { snapshot, catalog: mockCatalog, coachParameters: { ...COACH_PARAMETER_DEFAULTS, adherenceWindowWeeks: 2 } },
      nowMs,
    );
    expect(result.window.to).toBe('2026-06-04');
    expect(result.window.from).toBe('2026-05-21'); // 2 weeks = 14 days back from 2026-06-04
  });

  it('an explicit from/to pair wins over the default window', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getAdherence(
      { from: '2026-01-01', to: '2026-01-10' },
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS },
      epochMs(2026, 6, 4),
    );
    expect(result.window).toEqual({ from: '2026-01-01', to: '2026-01-10' });
  });

  it('args.toleranceDays overrides the coach parameter for this call', () => {
    const snapshot = snapshotWithZone(TZ);
    const result = getAdherence(
      { from: '2026-01-01', to: '2026-01-10', toleranceDays: 5 },
      { snapshot, catalog: mockCatalog, coachParameters: { ...COACH_PARAMETER_DEFAULTS, toleranceDays: 1 } },
      epochMs(2026, 6, 4),
    );
    expect(result.toleranceDays).toBe(5);
  });

  it('args.windowWeeks overrides adherenceWindowWeeks for this call (no from/to given)', () => {
    const snapshot = snapshotWithZone(TZ);
    const nowMs = epochMs(2026, 6, 4) + 12 * 3_600_000;
    const result = getAdherence(
      { windowWeeks: 1 },
      { snapshot, catalog: mockCatalog, coachParameters: { ...COACH_PARAMETER_DEFAULTS, adherenceWindowWeeks: 10 } },
      nowMs,
    );
    expect(result.window.to).toBe('2026-06-04');
    expect(result.window.from).toBe('2026-05-28'); // 1 week = 7 days, not the parameter's 10
  });

  it('P155 FA-06 get_adherence counts a same-day same-type activity as fulfilled', () => {
    const templateOnly = snapshotWithZone(TZ, {
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 2) })],
    });
    const withForeign: DecryptedSnapshot = {
      ...templateOnly,
      foreignActivityTypes: [],
      foreignActivities: [foreignActivity({ id: 'fa1', performedOn: '2026-06-03', performedTime: '18:10' })],
      plannedForeignActivities: [foreignRoot({ id: 'fr1', scheduledDate: epochMs(2026, 6, 3), scheduledTime: '18:00' })],
    };
    const call = (snapshot: DecryptedSnapshot) =>
      getAdherence(
        { from: '2026-06-01', to: '2026-06-07' },
        { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS },
        epochMs(2026, 6, 4) + 12 * 3_600_000,
      );
    const result = call(withForeign);
    expect(result.foreignSport).toMatchObject({
      available: true,
      window: { from: '2026-06-01', to: '2026-06-07' },
      asOfDate: '2026-06-04',
      plannedCount: 1,
      fulfilledCount: 1,
      missedCount: 0,
      upcomingCount: 0,
      removedOccurrenceCount: 0,
      fulfilmentRatio: 1,
      fulfilled: [{ date: '2026-06-03', rootId: 'fr1', typeId: FT_RUNNING, activityId: 'fa1' }],
      unplannedActivityIds: [],
      rule: 'same_calendar_day_same_type_one_to_one',
    });
    // The foreign pass moves no template key: deep equal to the run without foreign data.
    expect(templateKeys(result)).toEqual(templateKeys(call(templateOnly)));
    expect(call(templateOnly).foreignSport).toMatchObject({
      available: false,
      reason: 'server_without_foreign_sport',
    });
  });

  it('propagates TimeZoneUnavailableError uncaught when no time-zone row is synced', () => {
    const snapshot = snapshotWithZone(null);
    expect(() =>
      getAdherence({}, { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS }, Date.now()),
    ).toThrow(TimeZoneUnavailableError);
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
  return (server as any)._registeredTools['get_adherence'].handler;
}

describe('get_adherence — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockReset();
    vi.mocked(coachParametersModule.loadCoachParameters).mockReset();
    vi.mocked(fileChannelModule.writeExportFile).mockReset();
  });

  it('carries parametersSource through from loadCoachParameters, plus explanation/removedOccurrenceCount/adherenceRatio', async () => {
    const snapshot = snapshotWithZone(TZ, {
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4) })],
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'server',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2026-06-01', to: '2026-06-10' });
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(body.parametersSource).toBe('server');
    expect(typeof body.explanation).toBe('string');
    expect(body.removedOccurrenceCount).toBe(0);
    expect(body.plannedCount).toBe(1);
    expect(body.adherenceRatio).toBe(0);
    expect(body).toHaveProperty('matches');
    expect(body).toHaveProperty('missed');
  });

  it('outputFile: true writes the full result via writeExportFile and returns only counts/explanation/pointer — never the matches/missed lists', async () => {
    const snapshot = snapshotWithZone(TZ, {
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4) })],
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path: '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes: 999,
      itemCount: 1,
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2026-06-01', to: '2026-06-10', outputFile: true });
    expect(fileChannelModule.writeExportFile).toHaveBeenCalledTimes(1);
    const [writtenPayload] = vi.mocked(fileChannelModule.writeExportFile).mock.calls[0];
    expect(writtenPayload).toHaveProperty('matches');
    expect(writtenPayload).toHaveProperty('missed');

    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body).not.toHaveProperty('matches');
    expect(body).not.toHaveProperty('missed');
    expect(body.outputFile).toEqual({ path: '/tmp/calicomp-mcp-exports/fake-uuid.json', bytes: 999, itemCount: 1 });
    expect(body.plannedCount).toBe(1);
    expect(body.explanation).toEqual(expect.any(String));
    expect(body.parametersSource).toBe('defaults');
  });

  it('responds with a structured isError, naming neither PAT nor key, when no time-zone row is synced', async () => {
    const snapshot = snapshotWithZone(null);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.keyB64);
  });

  // -------------------------------------------------------------------------
  // unreadable / decode-fault-tolerance guards (Phase 150, D-09/D-11)
  // -------------------------------------------------------------------------

  it('P150 D-09 get_adherence fails on an unreadable planned row', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(snapshot),
      decodeReport: {
        unreadable: [{ entity: 'plannedWorkout', id: 'row-1', reason: 'unknown_version' }],
        encryptedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 1, setting: 0, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0, exerciseNameOverride: 0 },
        failedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 1, setting: 0, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0, exerciseNameOverride: 0 },
      },
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2026-06-01', to: '2026-06-10' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('row-1');
    expect(result.content[0].text).toContain('partial calendar');
  });

  it('P150 D-11 get_adherence refuses when every encrypted session failed', async () => {
    const snapshot = snapshotWithZone(TZ);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(snapshot),
      decodeReport: {
        unreadable: [{ entity: 'session', id: 'sess-1', reason: 'decrypt_failed' }],
        encryptedCount: { session: 1, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0, exerciseNameOverride: 0 },
        failedCount: { session: 1, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0, exerciseNameOverride: 0 },
      },
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2026-06-01', to: '2026-06-10' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CALICOMP_KEY most likely does not match');
    expect(result.content[0].text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.keyB64);
  });

  it('P150 get_adherence names the unreadable tz setting instead of a missing key', async () => {
    const snapshot = snapshotWithZone(null);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(snapshot),
      decodeReport: {
        // setting.encryptedCount > failedCount so assertEntitiesReadable (D-11) does not
        // fire first — this test isolates assertTimeZoneReadable's own message.
        unreadable: [{ entity: 'setting', id: 'row-tz', reason: 'malformed_payload', key: TRAINING_TIMEZONE_SETTING_KEY }],
        encryptedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 2, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0, exerciseNameOverride: 0 },
        failedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 1, foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0, exerciseNameOverride: 0 },
      },
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(TRAINING_TIMEZONE_SETTING_KEY);
    expect(result.content[0].text).not.toContain('Missing synchronized settings key');
  });

  // -------------------------------------------------------------------------
  // Phase 155 (FA-06, E-8, E-9): the foreign sport block of the handler
  // -------------------------------------------------------------------------

  function foreignSnapshot(): DecryptedSnapshot {
    return snapshotWithZone(TZ, {
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4) })],
      foreignActivityTypes: [],
      foreignActivities: [foreignActivity({ id: 'fa1', performedOn: '2026-06-03' })],
      plannedForeignActivities: [
        foreignRoot({ id: 'fr1', scheduledDate: epochMs(2026, 6, 3) }),
        foreignRoot({ id: 'fr2', scheduledDate: epochMs(2026, 6, 2) }),
      ],
    });
  }

  it('P155 E-9 get_adherence reports server_without_foreign_sport and still returns template numbers', async () => {
    const snapshot = snapshotWithZone(TZ, {
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4) })],
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);

    const result = await getHandler(server)({ from: '2026-06-01', to: '2026-06-10' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.plannedCount).toBe(1);
    expect(body.adherenceRatio).toBe(0);
    expect(body.foreignSport).toEqual({
      available: false,
      reason: 'server_without_foreign_sport',
      explanation: FOREIGN_ADHERENCE_EXPLANATION,
    });
    expect(Object.keys(body).at(-1)).toBe('unreadable');
    expect(Object.keys(body).indexOf('foreignSport')).toBeGreaterThan(Object.keys(body).indexOf('explanation'));
  });

  it('P155 E-8 get_adherence reports foreign_rows_unreadable for an unreadable foreign row and still returns template numbers', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...mockCacheFor(foreignSnapshot()),
      decodeReport: {
        unreadable: [{ entity: 'foreignActivity', id: 'fa-broken', reason: 'malformed_payload' }],
        encryptedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0, foreignActivityType: 0, foreignActivity: 2, plannedForeignActivity: 2, exerciseNameOverride: 0 },
        failedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0, foreignActivityType: 0, foreignActivity: 1, plannedForeignActivity: 0, exerciseNameOverride: 0 },
      },
    });
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);

    const result = await getHandler(server)({ from: '2026-06-01', to: '2026-06-10' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.plannedCount).toBe(1);
    expect(body.foreignSport).toEqual({
      available: false,
      reason: 'foreign_rows_unreadable',
      explanation: FOREIGN_ADHERENCE_EXPLANATION,
    });
    expect(body.unreadable).toEqual([{ entity: 'foreignActivity', id: 'fa-broken', reason: 'malformed_payload' }]);
  });

  it('P155 FA-06 the outputFile summary carries the foreign counts', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(foreignSnapshot()));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path: '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes: 999,
      itemCount: 1,
    });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);

    // Window ends 2026-06-10, so "today" (Date.now()) lies after every appointment.
    const result = await getHandler(server)({ from: '2026-06-01', to: '2026-06-10', outputFile: true });
    const [writtenPayload] = vi.mocked(fileChannelModule.writeExportFile).mock.calls[0];
    expect((writtenPayload as Record<string, unknown>).foreignSport).toMatchObject({
      available: true,
      fulfilled: [{ date: '2026-06-03', rootId: 'fr1', typeId: FT_RUNNING, activityId: 'fa1' }],
    });

    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.foreignSport).toEqual({
      available: true,
      plannedCount: 2,
      fulfilledCount: 1,
      missedCount: 1,
      upcomingCount: 0,
      removedOccurrenceCount: 0,
      fulfilmentRatio: 0.5,
    });
  });

  it('P155 FA-06 the outputFile summary carries the reason when foreign sport is unavailable', async () => {
    const snapshot = snapshotWithZone(TZ, { plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4) })] });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path: '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes: 10,
      itemCount: 1,
    });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);

    const result = await getHandler(server)({ from: '2026-06-01', to: '2026-06-10', outputFile: true });
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.foreignSport).toEqual({ available: false, reason: 'server_without_foreign_sport' });
  });

  it('P155 FA-06 the description says template counts exclude foreign sport', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server as any)._registeredTools['get_adherence'].description as string;
    expect(description).toContain('plannedCount, matchedCount, uncertainCount, missedCount and removedOccurrenceCount count template trainings only');
    expect(description).toContain('foreignSport');
    expect(description).toContain('toleranceDays applies to template trainings only');
    expect(description).toContain(FOREIGN_ADHERENCE_EXPLANATION);
    expect(description).toContain('60 seconds');
    expect(description).not.toMatch(/propose[^.]*foreign/i);
  });

  it('P155 D-07 the outputFile summary and the description carry removedWithCompletedSessionCount', async () => {
    const snapshot = snapshotWithZone(TZ, {
      plannedWorkouts: [
        root({
          id: 'r-series',
          scheduledDate: epochMs(2026, 6, 2),
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
          deletedOccurrencesRaw: '["2026-06-09"]',
        }),
      ],
      sessions: [
        {
          id: 's-done',
          templateId: TEMPLATE_ID_PUSH,
          startTime: epochMs(2026, 6, 9) + 12 * 3_600_000,
          endTime: epochMs(2026, 6, 9) + 13 * 3_600_000,
          isManual: false,
          isCorrected: false,
          isQuickChallenge: false,
          createdAt: epochMs(2026, 6, 9),
          updatedAt: epochMs(2026, 6, 9),
        },
      ],
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path: '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes: 10,
      itemCount: 1,
    });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetAdherence(server, DUMMY_CFG);

    const inline = JSON.parse((await getHandler(server)({ from: '2026-06-01', to: '2026-06-14' })).content[0].text);
    expect(inline.removedOccurrenceCount).toBe(1);
    expect(inline.removedWithCompletedSessionCount).toBe(1);
    expect(inline.removedWithCompletedSessionDates).toEqual([
      { date: '2026-06-09', rootId: 'r-series', templateId: TEMPLATE_ID_PUSH },
    ]);
    expect(inline.removedWithCompletedSessionExplanation).toBe(REMOVED_WITH_COMPLETED_SESSION_EXPLANATION);

    const summary = JSON.parse(
      (await getHandler(server)({ from: '2026-06-01', to: '2026-06-14', outputFile: true })).content[0].text,
    );
    expect(summary.removedWithCompletedSessionCount).toBe(1);
    expect(summary).not.toHaveProperty('removedWithCompletedSessionDates');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server as any)._registeredTools['get_adherence'].description as string;
    expect(description).toContain('removedWithCompletedSessionCount');
  });
});
