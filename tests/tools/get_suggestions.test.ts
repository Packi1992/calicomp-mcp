/**
 * Tests for the `get_suggestions` and `get_suggestion` READ tools (Phase 136,
 * D-08/D-09, PROP-10) — the coach's cheap-list-plus-full-single read-back pair.
 *
 * Coverage mirrors the <behavior> block from 136-05-PLAN.md Task 2:
 *   - get_suggestions with no arguments: newest-first rows, capped at the default.
 *   - get_suggestions with a status filter: only rows in that status (pass-through
 *     to the server — the filter itself is server-side, this asserts the arg flows).
 *   - limit clamp: 900 -> 500 sent to fetchSuggestions; 0 -> 1.
 *   - no proposals: an empty, successful result — never an error.
 *   - summary rows carry no `payload`/`appliedPayload` member.
 *   - get_suggestion with a known own id: the full row, including `payload`, and
 *     `appliedPayload` for an `accepted_modified` row.
 *   - get_suggestion with an unknown/foreign id: a structured `isError` result,
 *     never an uncaught throw.
 *   - both tools carry `readOnlyHint`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mock — hoisted before static imports by Vitest.
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return {
    ...actual,
    fetchSuggestions: vi.fn(),
    fetchSuggestion: vi.fn(),
  };
});

// Phase 150, D-35: get_suggestion's registered handler additionally fetches the
// decrypted snapshot to resolve catalog exercise names — only `getSnapshot` is replaced.
vi.mock('../../src/cache.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/cache.js')>('../../src/cache.js');
  return { ...actual, getSnapshot: vi.fn() };
});

import * as httpModule from '../../src/http.js';
import * as cacheModule from '../../src/cache.js';
import {
  getSuggestions,
  clampSuggestionsLimit,
  registerToolGetSuggestions,
} from '../../src/tools/get_suggestions.js';
import { getSuggestion, registerToolGetSuggestion } from '../../src/tools/get_suggestion.js';
import type { SuggestionDtoResponse, SuggestionSummaryDtoResponse } from '../../src/types.js';
import {
  mockSnapshot,
  mockCatalog,
  CATALOG_EXERCISE_ID_PULLUP,
} from '../fixture.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };

/** Minimal `SnapshotCache`-shaped mock for `getSnapshot` (Phase 150, D-35 tests). */
function mockSnapshotCache(snapshot = mockSnapshot, catalog = mockCatalog) {
  return {
    snapshot,
    catalog,
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

const SUMMARY_ROW: SuggestionSummaryDtoResponse = {
  id: 'suggestion-1',
  type: 'planned_update',
  status: 'pending',
  createdAt: 1_700_000_000_000,
  targetLabel: 'Push A — 2026-06-04',
  rationale: 'because progressive overload',
};

const FULL_ROW: SuggestionDtoResponse = {
  id: 'suggestion-1',
  type: 'planned_update',
  payload: '{"kind":"occurrence"}',
  rationale: 'because progressive overload',
  sourceLlm: 'unknown',
  status: 'accepted_modified',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_100_000_000,
  planHash: null,
  appliedPayload: '{"kind":"occurrence","applied":true}',
  seriesHash: 'a'.repeat(64),
};

beforeEach(() => {
  vi.mocked(httpModule.fetchSuggestions).mockReset();
  vi.mocked(httpModule.fetchSuggestion).mockReset();
  vi.mocked(cacheModule.getSnapshot).mockReset();
});

// ---------------------------------------------------------------------------
// clampSuggestionsLimit
// ---------------------------------------------------------------------------

describe('clampSuggestionsLimit', () => {
  it('defaults to 200 when absent', () => {
    expect(clampSuggestionsLimit(undefined)).toBe(200);
  });

  it('clamps an excessive value down to 500', () => {
    expect(clampSuggestionsLimit(900)).toBe(500);
  });

  it('raises a value below 1 up to 1', () => {
    expect(clampSuggestionsLimit(0)).toBe(1);
  });

  it('passes through an in-range value unchanged', () => {
    expect(clampSuggestionsLimit(50)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// getSuggestions
// ---------------------------------------------------------------------------

describe('getSuggestions', () => {
  it('with no arguments, fetches with the default limit and no status', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([SUMMARY_ROW]);
    const result = await getSuggestions({}, DUMMY_CFG);
    expect(httpModule.fetchSuggestions).toHaveBeenCalledWith(DUMMY_CFG, undefined, 200);
    expect(result).toEqual([SUMMARY_ROW]);
  });

  it('passes a status filter through unchanged', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([SUMMARY_ROW]);
    await getSuggestions({ status: 'pending' }, DUMMY_CFG);
    expect(httpModule.fetchSuggestions).toHaveBeenCalledWith(DUMMY_CFG, 'pending', 200);
  });

  it('clamps an excessive limit to 500 before calling fetchSuggestions', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([]);
    await getSuggestions({ limit: 900 }, DUMMY_CFG);
    expect(httpModule.fetchSuggestions).toHaveBeenCalledWith(DUMMY_CFG, undefined, 500);
  });

  it('raises a limit of 0 to 1 before calling fetchSuggestions', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([]);
    await getSuggestions({ limit: 0 }, DUMMY_CFG);
    expect(httpModule.fetchSuggestions).toHaveBeenCalledWith(DUMMY_CFG, undefined, 1);
  });

  it('returns a successful empty result when the coach has no proposals', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([]);
    const result = await getSuggestions({}, DUMMY_CFG);
    expect(result).toEqual([]);
  });

  it('summary rows carry no payload or appliedPayload member', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([SUMMARY_ROW]);
    const result = await getSuggestions({}, DUMMY_CFG);
    for (const row of result) {
      expect(Object.prototype.hasOwnProperty.call(row, 'payload')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(row, 'appliedPayload')).toBe(false);
    }
  });

  it('every summary row names its target by label, never a raw id field', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([SUMMARY_ROW]);
    const result = await getSuggestions({}, DUMMY_CFG);
    for (const row of result) {
      expect(typeof row.targetLabel).toBe('string');
      // The target label itself must not just be the row's own raw UUID.
      expect(row.targetLabel).not.toBe(row.id);
      expect(row.targetLabel).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });
});

// ---------------------------------------------------------------------------
// getSuggestion
// ---------------------------------------------------------------------------

describe('getSuggestion', () => {
  it('returns the full row (including appliedPayload) for a known own id', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(FULL_ROW);
    const result = await getSuggestion({ id: 'suggestion-1' }, DUMMY_CFG);
    expect(result).toEqual(FULL_ROW);
    expect(result?.appliedPayload).toBe(FULL_ROW.appliedPayload);
  });

  it('returns null for an unknown or foreign id (fetchSuggestion 404 contract)', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(null);
    const result = await getSuggestion({ id: 'not-mine' }, DUMMY_CFG);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tool registration — readOnlyHint + isError contract
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RegisteredToolMap = Record<string, { annotations?: { readOnlyHint?: boolean } }>;

describe('registerToolGetSuggestions / registerToolGetSuggestion', () => {
  it('both tools carry readOnlyHint: true', () => {
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestions(server, DUMMY_CFG);
    registerToolGetSuggestion(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as RegisteredToolMap;
    expect(tools['get_suggestions'].annotations?.readOnlyHint).toBe(true);
    expect(tools['get_suggestion'].annotations?.readOnlyHint).toBe(true);
  });

  it('get_suggestion returns a structured isError for an unknown id, never throws', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(null);
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> }>;
    await expect(tools['get_suggestion'].handler({ id: 'unknown-id' })).resolves.toMatchObject({
      isError: true,
    });
  });

  it('get_suggestions surfaces a network error as isError, never throws', async () => {
    vi.mocked(httpModule.fetchSuggestions).mockRejectedValue(new Error('boom'));
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestions(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> }>;
    await expect(tools['get_suggestions'].handler({})).resolves.toMatchObject({ isError: true });
  });
});

// ---------------------------------------------------------------------------
// get_suggestion — payloadResolved/appliedPayloadResolved (Phase 150, D-35)
// ---------------------------------------------------------------------------

type ResolvedSuggestionBody = SuggestionDtoResponse & {
  payloadResolved?: unknown;
  payloadResolvedSkipped?: string;
  appliedPayloadResolved?: unknown;
  appliedPayloadResolvedSkipped?: string;
};

function getSuggestionHandler(
  server: McpServer,
): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['get_suggestion'].handler;
}

describe('get_suggestion — payloadResolved/appliedPayloadResolved (Phase 150, D-35)', () => {
  const PLAN_UPDATE_PAYLOAD = JSON.stringify({
    ops: [
      {
        op: 'addExercise',
        blockId: null,
        exercise: { source: 'catalog', exerciseId: CATALOG_EXERCISE_ID_PULLUP },
        mode: 'REPS',
        restTimeSeconds: 60,
        sets: 3,
        orderIndex: 0,
      },
    ],
  });

  const APPLIED_PLAN_STATE_PAYLOAD = JSON.stringify({
    templateId: 'template-1',
    name: 'Push A',
    blocks: [
      {
        tempBlockId: 'block-1',
        rounds: 1,
        orderIndex: 0,
        exercises: [
          {
            exercise: { source: 'catalog', exerciseId: CATALOG_EXERCISE_ID_PULLUP },
            mode: 'REPS',
            targetReps: 8,
            targetTimeSeconds: null,
            restTimeSeconds: 60,
            sets: 3,
            targetWeight: null,
            orderIndex: 0,
            roundTargets: null,
          },
        ],
      },
    ],
  });

  const ROW_WITH_APPLIED: SuggestionDtoResponse = {
    ...FULL_ROW,
    payload: PLAN_UPDATE_PAYLOAD,
    appliedPayload: APPLIED_PLAN_STATE_PAYLOAD,
  };

  it('P150 D-35 get_suggestion adds payloadResolved with names next to every catalog exerciseId', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(ROW_WITH_APPLIED);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockSnapshotCache());
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);
    const handler = getSuggestionHandler(server);

    const result = await handler({ id: 'suggestion-1' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as ResolvedSuggestionBody;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvedOps = (body.payloadResolved as any).ops as Array<{ exercise: Record<string, unknown> }>;
    expect(resolvedOps[0].exercise).toMatchObject({
      source: 'catalog',
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      exerciseName: 'Pull-Up',
      exerciseKey: 'pull_up',
    });
  });

  it('P150 D-16 get_suggestion leaves payload and appliedPayload byte-identical', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(ROW_WITH_APPLIED);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockSnapshotCache());
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);
    const handler = getSuggestionHandler(server);

    const result = await handler({ id: 'suggestion-1' });
    const body = JSON.parse(result.content[0].text) as ResolvedSuggestionBody;
    expect(body.payload).toBe(ROW_WITH_APPLIED.payload);
    expect(body.appliedPayload).toBe(ROW_WITH_APPLIED.appliedPayload);
  });

  it('P150 D-35 an unparsable payload yields payloadResolvedSkipped unparsable_payload', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue({ ...FULL_ROW, payload: '{not json', appliedPayload: undefined });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockSnapshotCache());
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);
    const handler = getSuggestionHandler(server);

    const result = await handler({ id: 'suggestion-1' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as ResolvedSuggestionBody;
    expect(body.payloadResolvedSkipped).toBe('unparsable_payload');
    expect(body.payloadResolved).toBeUndefined();
  });

  it('P150 D-35 a failing snapshot yields payloadResolvedSkipped catalog_unavailable and still returns the row', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(ROW_WITH_APPLIED);
    vi.mocked(cacheModule.getSnapshot).mockRejectedValue(new Error('snapshot fetch failed'));
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);
    const handler = getSuggestionHandler(server);

    const result = await handler({ id: 'suggestion-1' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as ResolvedSuggestionBody;
    expect(body.payloadResolvedSkipped).toBe('catalog_unavailable');
    expect(body.appliedPayloadResolvedSkipped).toBe('catalog_unavailable');
    expect(body.id).toBe(ROW_WITH_APPLIED.id);
  });

  it('P150 D-35 appliedPayloadResolved resolves a plan after-state', async () => {
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(ROW_WITH_APPLIED);
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockSnapshotCache());
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);
    const handler = getSuggestionHandler(server);

    const result = await handler({ id: 'suggestion-1' });
    const body = JSON.parse(result.content[0].text) as ResolvedSuggestionBody;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvedBlocks = (body.appliedPayloadResolved as any).blocks as Array<{
      exercises: Array<{ exercise: Record<string, unknown> }>;
    }>;
    expect(resolvedBlocks[0].exercises[0].exercise).toMatchObject({
      source: 'catalog',
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      exerciseName: 'Pull-Up',
      exerciseKey: 'pull_up',
    });
  });
});
