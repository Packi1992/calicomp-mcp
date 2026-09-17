/**
 * Tests for src/tools/get_progress.ts (Phase 137, STATE-05) and its `GetProgressSchema`
 * (src/schemas.ts).
 *
 * Coverage mirrors the <behavior> block from 137-10-PLAN.md Task 2:
 *   - Schema: `kind: 'exercise' | 'format'` discriminator, each branch rejects the OTHER
 *     branch's own argument (`.strict()`), `points` bounded 3..30, unknown `kind` rejected.
 *   - Pure function: `kind: 'exercise'` delegates to computeExerciseProgress (with and
 *     without `exerciseId`), `kind: 'format'` delegates to computeFormatProgress (with and
 *     without `templateId`), `points` overrides `exerciseTrendPoints`.
 *   - Registered handler: D-27 c (no-match is a structurally empty series, not an error),
 *     outputFile summary (labels/rule kept, point series moved to the file),
 *     parametersSource passthrough, the isError path for a missing time-zone row.
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
import { GetProgressSchema } from '../../src/schemas.js';
import { getProgress, registerToolGetProgress } from '../../src/tools/get_progress.js';
import { TRAINING_TIMEZONE_SETTING_KEY } from '../../src/training-state/time-zone.js';
import { mockSnapshot, mockCatalog, CATALOG_EXERCISE_ID_PUSHUP } from '../fixture.js';
import type { DecryptedSnapshot, DecryptedSession, DecryptedSetLog, SyncTemplateDto } from '../../src/types.js';

const TZ = 'Europe/Berlin';

function buildSession(overrides: Partial<DecryptedSession> & { id: string; startTime: number }): DecryptedSession {
  return {
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: overrides.startTime,
    updatedAt: overrides.startTime,
    endTime: overrides.startTime + 3_600_000,
    ...overrides,
  };
}

function buildSetLog(
  overrides: Partial<DecryptedSetLog> & { id: string; sessionId: string; createdAt: number },
): DecryptedSetLog {
  return {
    exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
    completedReps: 10,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function buildTemplate(overrides: Partial<SyncTemplateDto> & { id: string }): SyncTemplateDto {
  return {
    name: overrides.id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isFavoriteForWatch: false,
    ...overrides,
  };
}

function snapshotWithZone(zone: string | null, extra: Partial<DecryptedSnapshot> = {}): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    plannedWorkouts: [],
    sessions: [],
    setLogs: [],
    templates: [],
    settings: zone === null ? [] : [{ key: TRAINING_TIMEZONE_SETTING_KEY, type: 's', value: zone }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('GetProgressSchema', () => {
  it('accepts { kind: "exercise" } with no further fields', () => {
    expect(GetProgressSchema.safeParse({ kind: 'exercise' }).success).toBe(true);
  });

  it('accepts { kind: "exercise", exerciseId }', () => {
    expect(
      GetProgressSchema.safeParse({ kind: 'exercise', exerciseId: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(true);
  });

  it('accepts { kind: "format" } and { kind: "format", templateId }', () => {
    expect(GetProgressSchema.safeParse({ kind: 'format' }).success).toBe(true);
    expect(
      GetProgressSchema.safeParse({ kind: 'format', templateId: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(true);
  });

  it('rejects a kind outside the two known values', () => {
    expect(GetProgressSchema.safeParse({ kind: 'muscle' }).success).toBe(false);
  });

  it('rejects an exerciseId under kind: "format", and a templateId under kind: "exercise"', () => {
    expect(
      GetProgressSchema.safeParse({ kind: 'format', exerciseId: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(false);
    expect(
      GetProgressSchema.safeParse({ kind: 'exercise', templateId: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(false);
  });

  it('accepts points 3 and 30; rejects 2 and 31', () => {
    expect(GetProgressSchema.safeParse({ kind: 'exercise', points: 3 }).success).toBe(true);
    expect(GetProgressSchema.safeParse({ kind: 'exercise', points: 30 }).success).toBe(true);
    expect(GetProgressSchema.safeParse({ kind: 'exercise', points: 2 }).success).toBe(false);
    expect(GetProgressSchema.safeParse({ kind: 'exercise', points: 31 }).success).toBe(false);
  });

  it('accepts outputFile: true and outputFile: false', () => {
    expect(GetProgressSchema.safeParse({ kind: 'exercise', outputFile: true }).success).toBe(true);
    expect(GetProgressSchema.safeParse({ kind: 'exercise', outputFile: false }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

describe('getProgress — pure function', () => {
  it('kind: "exercise" with exerciseId delegates to computeExerciseProgress for that exercise only', () => {
    const s1 = buildSession({ id: 's1', startTime: 1_700_000_000_000 });
    const snapshot = snapshotWithZone(TZ, {
      sessions: [s1],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime })],
    });

    const result = getProgress(
      { kind: 'exercise', exerciseId: CATALOG_EXERCISE_ID_PUSHUP },
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS },
    );

    expect(result.kind).toBe('exercise');
    if (result.kind !== 'exercise') throw new Error('expected exercise result');
    expect(result.series).toHaveLength(1);
    expect(result.series[0].exerciseId).toBe(CATALOG_EXERCISE_ID_PUSHUP);
  });

  it('kind: "exercise" without exerciseId returns recentExerciseCount recent exercises', () => {
    const s1 = buildSession({ id: 's1', startTime: 1_700_000_000_000 });
    const snapshot = snapshotWithZone(TZ, {
      sessions: [s1],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime })],
    });

    const result = getProgress(
      { kind: 'exercise' },
      {
        snapshot,
        catalog: mockCatalog,
        coachParameters: { ...COACH_PARAMETER_DEFAULTS, recentExerciseCount: 2 },
      },
    );

    if (result.kind !== 'exercise') throw new Error('expected exercise result');
    expect(result.series.length).toBeLessThanOrEqual(2);
  });

  it('kind: "format" with templateId delegates to computeFormatProgress for that template only', () => {
    const template = buildTemplate({ id: 'tpl-amrap', workoutType: 'AMRAP', formatParams: null });
    const s1 = buildSession({ id: 's1', startTime: 1_700_000_000_000, templateId: 'tpl-amrap' });
    const snapshot = snapshotWithZone(TZ, {
      templates: [template],
      sessions: [s1],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime })],
    });

    const result = getProgress(
      { kind: 'format', templateId: 'tpl-amrap' },
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS },
    );

    expect(result.kind).toBe('format');
    if (result.kind !== 'format') throw new Error('expected format result');
    expect(result.series).toHaveLength(1);
    expect(result.series[0].templateId).toBe('tpl-amrap');
  });

  it('kind: "format" without templateId returns all format series', () => {
    const templateA = buildTemplate({ id: 'tpl-amrap', workoutType: 'AMRAP', formatParams: null });
    const templateB = buildTemplate({ id: 'tpl-emom', workoutType: 'EMOM', formatParams: null });
    const s1 = buildSession({ id: 's1', startTime: 1_700_000_000_000, templateId: 'tpl-amrap' });
    const s2 = buildSession({ id: 's2', startTime: 1_700_100_000_000, templateId: 'tpl-emom' });
    const snapshot = snapshotWithZone(TZ, {
      templates: [templateA, templateB],
      sessions: [s1, s2],
      setLogs: [
        buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime }),
        buildSetLog({ id: 'sl2', sessionId: 's2', createdAt: s2.startTime }),
      ],
    });

    const result = getProgress(
      { kind: 'format' },
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS },
    );

    if (result.kind !== 'format') throw new Error('expected format result');
    expect(result.series.map((s) => s.templateId).sort()).toEqual(['tpl-amrap', 'tpl-emom']);
  });

  it('points overrides exerciseTrendPoints for this call', () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      buildSession({ id: `s${i}`, startTime: 1_700_000_000_000 + i * 86_400_000 }),
    );
    const snapshot = snapshotWithZone(TZ, {
      sessions,
      setLogs: sessions.map((s, i) => buildSetLog({ id: `sl${i}`, sessionId: s.id, createdAt: s.startTime })),
    });

    const result = getProgress(
      { kind: 'exercise', exerciseId: CATALOG_EXERCISE_ID_PUSHUP, points: 2 },
      { snapshot, catalog: mockCatalog, coachParameters: { ...COACH_PARAMETER_DEFAULTS, exerciseTrendPoints: 10 } },
    );

    if (result.kind !== 'exercise') throw new Error('expected exercise result');
    expect(result.series[0].points).toHaveLength(2);
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

function getHandler(
  server: McpServer,
): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['get_progress'].handler;
}

describe('get_progress — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockReset();
    vi.mocked(coachParametersModule.loadCoachParameters).mockReset();
    vi.mocked(fileChannelModule.writeExportFile).mockReset();
  });

  it('D-27 c: an unknown exerciseId returns a structurally empty series, isError unset', async () => {
    const snapshot = snapshotWithZone(TZ, {});
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetProgress(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ kind: 'exercise', exerciseId: '99999999-9999-4999-8999-999999999999' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as { series: Array<{ points: unknown[] }> };
    expect(body.series).toHaveLength(1);
    expect(body.series[0].points).toEqual([]);
  });

  it('D-27 c: a templateId with no format sessions returns an empty series, isError unset', async () => {
    const snapshot = snapshotWithZone(TZ, {});
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetProgress(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ kind: 'format', templateId: 'no-such-template' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as { series: unknown[] };
    expect(body.series).toEqual([]);
  });

  it('carries parametersSource through from loadCoachParameters', async () => {
    const snapshot = snapshotWithZone(TZ, {});
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'server',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetProgress(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ kind: 'exercise' });
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body.parametersSource).toBe('server');
  });

  it('outputFile: true writes the full series to a file and returns labels/rule but no point series', async () => {
    const s1 = buildSession({ id: 's1', startTime: 1_700_000_000_000 });
    const snapshot = snapshotWithZone(TZ, {
      sessions: [s1],
      setLogs: [buildSetLog({ id: 'sl1', sessionId: 's1', createdAt: s1.startTime })],
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path: '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes: 555,
      itemCount: 1,
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetProgress(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      kind: 'exercise',
      exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
      outputFile: true,
    });

    expect(fileChannelModule.writeExportFile).toHaveBeenCalledTimes(1);
    const [writtenPayload] = vi.mocked(fileChannelModule.writeExportFile).mock.calls[0];
    const typedPayload = writtenPayload as { series: Array<{ points: unknown[] }> };
    expect(typedPayload.series[0].points.length).toBeGreaterThan(0);

    const body = JSON.parse(result.content[0].text) as {
      outputFile: { path: string; bytes: number; itemCount: number };
      series: Array<{ points?: unknown; bestSetDirection?: unknown; rule?: unknown }>;
    };
    expect(body.outputFile).toEqual({ path: '/tmp/calicomp-mcp-exports/fake-uuid.json', bytes: 555, itemCount: 1 });
    expect(body.series[0]).not.toHaveProperty('points');
    expect(body.series[0].bestSetDirection).toBeDefined();
    expect(body.series[0].rule).toBeDefined();
  });

  it('responds with a structured isError, naming neither PAT nor key, when no time-zone row is synced', async () => {
    const snapshot = snapshotWithZone(null);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCacheFor(snapshot));
    vi.mocked(coachParametersModule.loadCoachParameters).mockResolvedValue({
      params: COACH_PARAMETER_DEFAULTS,
      source: 'defaults',
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetProgress(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ kind: 'exercise' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.keyB64);
  });
});
