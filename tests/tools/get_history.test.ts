/**
 * Tests for src/tools/get_history.ts
 *
 * Coverage:
 *   - Schema: to < from rejected; non-UUID exercise filter rejected; limit boundary
 *     values (D-17: the plan's own randomized-edge probe for STATE-04 — 1 and 500
 *     accepted, 0 and 501 rejected, absent defaults to 200)
 *   - Transform: newest-first ordering; limit cap; exercise-UUID filter (regression
 *     anchors — unchanged by this plan)
 *   - Registered handler: `outputFile` (D-15) writes via `writeExportFile` and
 *     returns only path/bytes/itemCount, never the session/setLog payload; without
 *     the switch, behavior is byte-identical to before this plan
 *   - Registered description names `get_training_state` (D-17 role re-framing)
 *
 * All tests operate on the pre-decrypted mockSnapshot from fixture.ts —
 * no network, no decryption required.
 *
 * Fixture key values:
 *   SESSION_A — 2024-03-01T08:00:00Z — has PUSHUP + PULLUP setLogs
 *   SESSION_B — 2024-03-08T08:00:00Z — has SQUAT setLogs only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mocks — hoisted before static imports by Vitest.
vi.mock('../../src/cache.js');
vi.mock('../../src/file-channel.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/file-channel.js')>('../../src/file-channel.js');
  return {
    ...actual,
    writeExportFile: vi.fn(),
  };
});

import * as cacheModule from '../../src/cache.js';
import * as fileChannelModule from '../../src/file-channel.js';
import { GetHistorySchema } from '../../src/schemas.js';
import { getHistory, registerToolGetHistory } from '../../src/tools/get_history.js';
import {
  mockSnapshot,
  mockCatalog,
  CATALOG_EXERCISE_ID_PUSHUP,
  CATALOG_EXERCISE_ID_SQUAT,
  SESSION_ID_A,
  SESSION_ID_B,
  TEMPLATE_ID_PUSH,
  TEMPLATE_ID_LEGS,
} from '../fixture.js';
import type { DecryptedSnapshot, DecryptedSession } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Phase 150 (D-04/D-05/D-10) test helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schema validation (these tests exercise Zod without calling getHistory)
// ---------------------------------------------------------------------------

describe('get_history — schema validation', () => {
  it('rejects to < from (inverted date range)', () => {
    const result = GetHistorySchema.safeParse({
      from: '2024-03-08',
      to:   '2024-03-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID exercise filter', () => {
    const result = GetHistorySchema.safeParse({
      from:     '2024-01-01',
      to:       '2024-12-31',
      exercise: 'not-a-valid-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts equal from and to dates (from === to is valid)', () => {
    const result = GetHistorySchema.safeParse({
      from: '2024-03-01',
      to:   '2024-03-01',
    });
    expect(result.success).toBe(true);
  });

  // D-17: STATE-04's boundary-value edge probe, answered with real assertions
  // rather than a backstop. `get_history`'s capability is untouched by this plan.
  it('accepts limit: 1 (lower bound)', () => {
    const result = GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31', limit: 1 });
    expect(result.success).toBe(true);
  });

  it('accepts limit: 500 (upper bound)', () => {
    const result = GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31', limit: 500 });
    expect(result.success).toBe(true);
  });

  it('rejects limit: 0 (below lower bound)', () => {
    const result = GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31', limit: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects limit: 501 (above upper bound)', () => {
    const result = GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31', limit: 501 });
    expect(result.success).toBe(false);
  });

  it('defaults limit to 200 when omitted', () => {
    const result = GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(200);
    }
  });

  it('rejects a string value for outputFile (must be a boolean switch, never a path)', () => {
    const result = GetHistorySchema.safeParse({
      from:       '2024-01-01',
      to:         '2024-12-31',
      outputFile: '/etc/passwd',
    });
    expect(result.success).toBe(false);
  });

  it('accepts outputFile: true and outputFile: false', () => {
    expect(
      GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31', outputFile: true }).success,
    ).toBe(true);
    expect(
      GetHistorySchema.safeParse({ from: '2024-01-01', to: '2024-12-31', outputFile: false }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transform logic (pure getHistory over fixture snapshot)
// ---------------------------------------------------------------------------

describe('get_history — transform', () => {
  it('returns sessions newest-first and respects the limit cap', () => {
    const result = getHistory(
      { from: '2024-01-01', to: '2024-12-31', limit: 1 },
      mockSnapshot,
    );
    expect(result.sessions).toHaveLength(1);
    // SESSION_B (2024-03-08) is newer than SESSION_A (2024-03-01)
    expect(result.sessions[0].id).toBe(SESSION_ID_B);
    // setLogs must belong only to the returned sessions
    const returnedSessionIds = new Set(result.sessions.map(s => s.id));
    result.setLogs.forEach(sl => {
      expect(returnedSessionIds.has(sl.sessionId)).toBe(true);
    });
  });

  it('returns both sessions when limit is larger than session count', () => {
    const result = getHistory(
      { from: '2024-01-01', to: '2024-12-31', limit: 200 },
      mockSnapshot,
    );
    expect(result.sessions).toHaveLength(2);
    // Newest-first: B before A
    expect(result.sessions[0].id).toBe(SESSION_ID_B);
    expect(result.sessions[1].id).toBe(SESSION_ID_A);
  });

  it('filters sessions to those containing a matching setLog by exercise UUID', () => {
    const result = getHistory(
      { from: '2024-01-01', to: '2024-12-31', exercise: CATALOG_EXERCISE_ID_PUSHUP, limit: 200 },
      mockSnapshot,
    );
    // Only SESSION_A contains a PUSHUP setLog
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(SESSION_ID_A);
    // All setLogs of SESSION_A are returned (not only the pushup one)
    result.setLogs.forEach(sl => {
      expect(sl.sessionId).toBe(SESSION_ID_A);
    });
    // The PUSHUP setLog itself must be in the result
    const hasMatchingLog = result.setLogs.some(sl => sl.exerciseId === CATALOG_EXERCISE_ID_PUSHUP);
    expect(hasMatchingLog).toBe(true);
  });

  it('returns empty results when no sessions fall in the range', () => {
    const result = getHistory(
      { from: '2020-01-01', to: '2020-12-31', limit: 200 },
      mockSnapshot,
    );
    expect(result.sessions).toHaveLength(0);
    expect(result.setLogs).toHaveLength(0);
  });

  it('excludes sessions outside the date range', () => {
    // Range covers only SESSION_A (2024-03-01) — SESSION_B (2024-03-08) is outside
    const result = getHistory(
      { from: '2024-03-01', to: '2024-03-07', limit: 200 },
      mockSnapshot,
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(SESSION_ID_A);
  });
});

// ---------------------------------------------------------------------------
// Registered MCP handler — the outputFile switch (D-15) and the description
// re-framing (D-17)
// ---------------------------------------------------------------------------

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };

/** Full SnapshotCache shape returned by mocked getSnapshot. */
const MOCK_CACHE = {
  snapshot:  mockSnapshot,
  catalog:   mockCatalog,
  profile: {
    userId:      'user-test-1',
    email:       'test@example.com',
    displayName: 'Test User',
    avatarUrl:   'https://example.com/avatar.svg',
    isPremium:   false,
    createdAt:   1_700_000_000_000,
  },
  fetchedAt: Date.now(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['get_history'].handler;
}

describe('get_history — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
    vi.mocked(fileChannelModule.writeExportFile).mockReset();
  });

  it('without outputFile, returns the full JSON payload inline — unchanged from before this plan', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200 });

    const expected = getHistory(
      { from: '2024-01-01', to: '2024-12-31', limit: 200 },
      mockSnapshot,
    );
    expect(result.content[0].text).toBe(JSON.stringify({ ...expected, unreadable: [] }));
    expect(fileChannelModule.writeExportFile).not.toHaveBeenCalled();
  });

  it('outputFile: false behaves exactly like an omitted switch', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200, outputFile: false });

    const expected = getHistory(
      { from: '2024-01-01', to: '2024-12-31', limit: 200 },
      mockSnapshot,
    );
    expect(result.content[0].text).toBe(JSON.stringify({ ...expected, unreadable: [] }));
    expect(fileChannelModule.writeExportFile).not.toHaveBeenCalled();
  });

  it('outputFile: true writes via writeExportFile and returns only path/bytes/itemCount — never the payload', async () => {
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path:      '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes:     1234,
      itemCount: 3,
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200, outputFile: true });

    expect(fileChannelModule.writeExportFile).toHaveBeenCalledTimes(1);
    const [writtenPayload] = vi.mocked(fileChannelModule.writeExportFile).mock.calls[0];
    const expected = getHistory(
      { from: '2024-01-01', to: '2024-12-31', limit: 200 },
      mockSnapshot,
    );
    expect(writtenPayload).toEqual({ ...expected, unreadable: [] });

    const responseBody = JSON.parse(result.content[0].text) as {
      outputFile: { path: string; bytes: number; itemCount: number };
      unreadable: unknown[];
    };
    expect(responseBody.outputFile).toEqual({
      path:      '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes:     1234,
      itemCount: 3,
    });
    expect(responseBody.unreadable).toEqual([]);
    expect(result.content[0].text).not.toContain('sessions');
    expect(result.content[0].text).not.toContain('setLogs');
  });

  it('registered description names get_training_state and keeps the limit defaults', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const description = (server as any)._registeredTools['get_history'].description as string;

    expect(description).toContain('get_training_state');
    expect(description).toMatch(/targeted|TARGETED/);
    expect(description).toContain('default 200');
    expect(description).toContain('max 500');
  });
});

// ---------------------------------------------------------------------------
// unreadable (Phase 150, D-08/D-10/D-11/D-13)
// ---------------------------------------------------------------------------

describe('get_history — unreadable rows', () => {
  beforeEach(() => {
    vi.mocked(fileChannelModule.writeExportFile).mockReset();
  });

  it('P150 D-13 SC4 get_history returns the readable sessions plus unreadable', async () => {
    const decodeReport = {
      unreadable: [
        { entity: 'session' as const, id: 'sess-corrupt', reason: 'decrypt_failed' as const, createdAt: 1, updatedAt: 1 },
      ],
      encryptedCount: { session: 3, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
      failedCount: { session: 1, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
    };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({ ...MOCK_CACHE, decodeReport });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200 });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as { unreadable: unknown[] };
    expect(body.unreadable).toEqual(decodeReport.unreadable);
  });

  it('P150 D-33 get_history carries unreadable as an empty list when nothing is broken', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE); // no decodeReport key at all

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200 });

    const body = JSON.parse(result.content[0].text) as { unreadable: unknown[] };
    expect(body.unreadable).toEqual([]);
  });

  it('P150 D-11 get_history refuses when every encrypted session failed', async () => {
    const decodeReport = {
      unreadable: [{ entity: 'session' as const, id: 'sess-1', reason: 'decrypt_failed' as const }],
      encryptedCount: { session: 1, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
      failedCount: { session: 1, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
    };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({ ...MOCK_CACHE, decodeReport });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CALICOMP_KEY most likely does not match');
    expect(result.content[0].text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0].text).not.toContain(DUMMY_CFG.keyB64);
  });

  it('P150 D-13 D-09 a corrupt planned row does not stop get_history', async () => {
    const decodeReport = {
      unreadable: [{ entity: 'plannedWorkout' as const, id: 'row-broken', reason: 'decrypt_failed' as const }],
      encryptedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 1, setting: 0 },
      failedCount: { session: 0, setLog: 0, hrSample: 0, plannedWorkout: 1, setting: 0 },
    };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({ ...MOCK_CACHE, decodeReport });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200 });

    expect(result.isError).toBeUndefined();
    const expected = getHistory({ from: '2024-01-01', to: '2024-12-31', limit: 200 }, mockSnapshot);
    const body = JSON.parse(result.content[0].text) as { sessions: unknown[]; unreadable: unknown[] };
    expect(body.sessions).toEqual(expected.sessions);
    expect(body.unreadable).toEqual(decodeReport.unreadable);
  });
});

// ---------------------------------------------------------------------------
// Sessionarten und Vorlagenfilter (Phase 150, D-01/D-02/D-04/D-05)
// ---------------------------------------------------------------------------

describe('get_history — session classification and template filter', () => {
  it('P150 D-04 SC2 filters before the limit and reports truncation', () => {
    const snapshot: DecryptedSnapshot = {
      ...mockSnapshot,
      sessions: [
        buildSession({ id: 's1', startTime: 1_710_000_000_000, templateId: TEMPLATE_ID_PUSH }),
        buildSession({ id: 's2', startTime: 1_710_100_000_000, templateId: TEMPLATE_ID_PUSH }),
        buildSession({ id: 's3', startTime: 1_710_200_000_000, templateId: TEMPLATE_ID_PUSH }),
      ],
      setLogs: [],
    };

    const result = getHistory(
      { from: '2024-01-01', to: '2024-12-31', templateId: TEMPLATE_ID_PUSH, limit: 1 },
      snapshot,
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.matchingSessions).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('P150 D-04 an unknown templateId returns an empty result without an error', () => {
    expect(() =>
      getHistory(
        { from: '2024-01-01', to: '2024-12-31', templateId: 'tpl-does-not-exist', limit: 200 },
        mockSnapshot,
      ),
    ).not.toThrow();

    const result = getHistory(
      { from: '2024-01-01', to: '2024-12-31', templateId: 'tpl-does-not-exist', limit: 200 },
      mockSnapshot,
    );
    expect(result.sessions).toEqual([]);
    expect(result.matchingSessions).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('P150 D-04 templateId, sessionKind and exercise combine with AND', () => {
    const matching = buildSession({ id: 's-match', startTime: 1_710_000_000_000, templateId: TEMPLATE_ID_PUSH });
    const wrongExercise = buildSession({
      id: 's-wrong-exercise',
      startTime: 1_710_010_000_000,
      templateId: TEMPLATE_ID_PUSH,
    });
    const wrongTemplate = buildSession({
      id: 's-wrong-template',
      startTime: 1_710_020_000_000,
      templateId: TEMPLATE_ID_LEGS,
    });
    const quickChallenge = buildSession({
      id: 's-quick',
      startTime: 1_710_030_000_000,
      templateId: TEMPLATE_ID_PUSH,
      isQuickChallenge: true,
    });

    const snapshot: DecryptedSnapshot = {
      ...mockSnapshot,
      sessions: [matching, wrongExercise, wrongTemplate, quickChallenge],
      setLogs: [
        { id: 'sl-match', sessionId: matching.id, exerciseId: CATALOG_EXERCISE_ID_PUSHUP, completedReps: 10,
          completedTimeSeconds: null, weightUsed: null, startedAt: null, measuredTimeSeconds: null,
          createdAt: matching.startTime, updatedAt: matching.startTime },
        { id: 'sl-wrong-exercise', sessionId: wrongExercise.id, exerciseId: CATALOG_EXERCISE_ID_SQUAT,
          completedReps: 5, completedTimeSeconds: null, weightUsed: null, startedAt: null, measuredTimeSeconds: null,
          createdAt: wrongExercise.startTime, updatedAt: wrongExercise.startTime },
        { id: 'sl-wrong-template', sessionId: wrongTemplate.id, exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
          completedReps: 10, completedTimeSeconds: null, weightUsed: null, startedAt: null, measuredTimeSeconds: null,
          createdAt: wrongTemplate.startTime, updatedAt: wrongTemplate.startTime },
        { id: 'sl-quick', sessionId: quickChallenge.id, exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
          completedReps: 10, completedTimeSeconds: null, weightUsed: null, startedAt: null, measuredTimeSeconds: null,
          createdAt: quickChallenge.startTime, updatedAt: quickChallenge.startTime },
      ],
    };

    const result = getHistory(
      {
        from: '2024-01-01',
        to: '2024-12-31',
        templateId: TEMPLATE_ID_PUSH,
        sessionKind: 'template',
        exercise: CATALOG_EXERCISE_ID_PUSHUP,
        limit: 200,
      },
      snapshot,
    );

    expect(result.sessions.map((s) => s.id)).toEqual([matching.id]);
    expect(result.matchingSessions).toBe(1);
  });

  it('P150 D-05 the outputFile summary reports matchingSessions and truncated', async () => {
    vi.mocked(fileChannelModule.writeExportFile).mockReset();
    vi.mocked(fileChannelModule.writeExportFile).mockResolvedValue({
      path:      '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes:     42,
      itemCount: 1,
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 1, outputFile: true });

    const body = JSON.parse(result.content[0].text) as { matchingSessions: number; truncated: boolean };
    expect(body.matchingSessions).toBe(2); // mockSnapshot has 2 sessions in range
    expect(body.truncated).toBe(true); // limit 1 < 2 matching sessions
  });

  it('P150 D-10 an unreadable session row carries its sessionKind', async () => {
    const decodeReport = {
      unreadable: [
        {
          entity: 'session' as const,
          id: 'sess-corrupt',
          reason: 'decrypt_failed' as const,
          createdAt: 1,
          updatedAt: 1,
          templateId: TEMPLATE_ID_PUSH,
          isQuickChallenge: false,
          sessionKind: 'template' as const,
        },
      ],
      encryptedCount: { session: 3, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
      failedCount: { session: 1, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0 },
    };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({ ...MOCK_CACHE, decodeReport });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ from: '2024-01-01', to: '2024-12-31', limit: 200 });

    const body = JSON.parse(result.content[0].text) as { unreadable: { sessionKind?: string }[] };
    expect(body.unreadable[0].sessionKind).toBe('template');
  });
});
