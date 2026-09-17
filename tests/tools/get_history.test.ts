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
  SESSION_ID_A,
  SESSION_ID_B,
} from '../fixture.js';

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
    expect(result.content[0].text).toBe(JSON.stringify(expected));
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
    expect(result.content[0].text).toBe(JSON.stringify(expected));
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
    expect(writtenPayload).toEqual(expected);

    const responseBody = JSON.parse(result.content[0].text) as {
      outputFile: { path: string; bytes: number; itemCount: number };
    };
    expect(responseBody.outputFile).toEqual({
      path:      '/tmp/calicomp-mcp-exports/fake-uuid.json',
      bytes:     1234,
      itemCount: 3,
    });
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
