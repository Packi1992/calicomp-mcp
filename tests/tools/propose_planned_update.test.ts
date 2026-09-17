/**
 * Tests for the `propose_planned_update` WRITE tool — all four intents
 * (`move_occurrence`: 136-01 TRACER SLICE; `cancel_occurrence`, `schedule_workout`,
 * `change_series_rule`: 136-02).
 *
 * `move_occurrence` coverage mirrors the <behavior> block from 136-01-PLAN.md Task 1:
 *   - recurring root: exactly two root entries — a `replace` of the original root
 *     with the moved date added to `deletedOccurrences`, and a `create` of a new
 *     standalone root on `newDate` inheriting `templateId`/`scheduledTime`.
 *   - non-recurring root: exactly one `replace` whose `scheduledDate` is `newDate`.
 *   - the emitted envelope carries `kind: "occurrence"` and `scope: "this_occurrence"`.
 *   - an out-of-expansion `occurrenceDate`: isError, postSuggest NOT called.
 *   - an unknown `rootId`: isError, postSuggest NOT called.
 *   - the `seriesHash` passed to postSuggest equals `computeSeriesHash` over the
 *     STORED before-state root(s) (protocol §4 "Which State Is Fingerprinted",
 *     136-11) — never the after-state the envelope proposes — and matches
 *     `/^[0-9a-f]{64}$/`.
 *   - moving a date when the root already carries a different cancelled date leaves
 *     that pre-existing date in the emitted list exactly once, sorted with the new one.
 * Plus: a stored `recurrenceRule` the allowlist would reject is itself rejected
 * before any hashing/network call (T-136-01, the key_link this plan pins between
 * propose_planned_update.ts and rrule-allowlist.ts).
 *
 * `cancel_occurrence`/`schedule_workout`/`change_series_rule` coverage mirrors the
 * <behavior> block from 136-02-PLAN.md Task 1 — see the per-intent describe blocks
 * below for the specific assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mocks — hoisted before static imports by Vitest.
vi.mock('../../src/cache.js');
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return {
    ...actual,
    postSuggest: vi.fn(),
    // Phase 136-08 (D-04): `fetchSuggestion` is the real network call the chain
    // path uses to resolve `chainSuggestionId` — mocked here for the same reason
    // `postSuggest` is, so no test in this file ever reaches an actual `fetch`.
    fetchSuggestion: vi.fn(),
  };
});

import * as cacheModule from '../../src/cache.js';
import * as httpModule from '../../src/http.js';
import { computeSeriesHash, type SeriesHashRoot } from '../../src/series-hash.js';
import {
  registerToolProposePlannedUpdate,
  proposePlannedUpdate,
  buildMoveOccurrenceEnvelope,
  buildChangeSeriesRuleEnvelope,
  splitMemberAtCutoff,
  PlannedUpdateRejection,
  type ProposePlannedUpdateArgs,
  type ChangeSeriesRuleArgs,
} from '../../src/tools/propose_planned_update.js';
import { mockSnapshot, TEMPLATE_ID_PUSH } from '../fixture.js';
import type { DecryptedSnapshot, DecryptedPlannedWorkout, UserProfileResponse, SuggestionDtoResponse } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function epochMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function root(overrides: Partial<DecryptedPlannedWorkout> & { id: string }): DecryptedPlannedWorkout {
  return {
    templateId: TEMPLATE_ID_PUSH,
    scheduledDate: epochMs(2026, 6, 2), // Tuesday
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    recurrenceGroupId: null,
    deletedOccurrencesRaw: null,
    completedSessionId: null,
    ...overrides,
  };
}

function snapshotWith(plannedWorkouts: DecryptedPlannedWorkout[]): DecryptedSnapshot {
  return { ...mockSnapshot, plannedWorkouts };
}

const mockProfile: UserProfileResponse = {
  userId: 'user-test-1',
  email: 'test@example.com',
  displayName: 'Test User',
  avatarUrl: 'https://example.com/avatar.svg',
  isPremium: false,
  createdAt: 1_700_000_000_000,
};

function mockCache(plannedWorkouts: DecryptedPlannedWorkout[]) {
  return {
    snapshot: snapshotWith(plannedWorkouts),
    catalog: [],
    profile: mockProfile,
    fetchedAt: Date.now(),
  };
}

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };

const MOCK_SUGGESTION: SuggestionDtoResponse = {
  id: 'suggestion-1',
  type: 'planned_update',
  payload: '{}',
  rationale: 'because',
  sourceLlm: 'unknown',
  status: 'pending',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_100_000_000,
  planHash: null,
};

const ROOT_ID_RECURRING = 'aaaaaaaa-1111-4111-8111-111111111111';
const ROOT_ID_STANDALONE = 'bbbbbbbb-2222-4222-8222-222222222222';
const UNKNOWN_ROOT_ID = 'ffffffff-ffff-4fff-afff-ffffffffffff';

// --- schedule_workout chain fixtures (Phase 136-08, D-04) -----------------

const CHAIN_SUGGESTION_ID = 'cccccccc-3333-4333-8333-333333333333';

function chainSuggestion(overrides: Partial<SuggestionDtoResponse> = {}): SuggestionDtoResponse {
  return {
    id: CHAIN_SUGGESTION_ID,
    type: 'new_plan',
    payload: '{}',
    rationale: 'a brand-new plan the coach also just proposed',
    sourceLlm: 'unknown',
    status: 'pending',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_100_000_000,
    planHash: null,
    ...overrides,
  };
}

const RECURRING_ROOT = root({
  id: ROOT_ID_RECURRING,
  scheduledDate: epochMs(2026, 6, 2), // DTSTART Tuesday 2026-06-02
  scheduledTime: '18:00',
  recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
});

const STANDALONE_ROOT = root({
  id: ROOT_ID_STANDALONE,
  scheduledDate: epochMs(2026, 6, 10),
  scheduledTime: null,
  recurrenceRule: null,
});

// --- change_series_rule fixtures (136-02) ---------------------------------

const ROOT_ID_SPLIT = 'eeeeeeee-5555-4555-8555-555555555555';

/** Protocol §2 "Splitting a series at a date" worked example, verbatim: cutoff
 * 2026-07-07, deletedOccurrences ["2026-06-16" (before), "2026-07-14" (on/after)]. */
const SPLIT_ROOT = root({
  id: ROOT_ID_SPLIT,
  scheduledDate: epochMs(2026, 6, 2), // DTSTART Tuesday 2026-06-02
  scheduledTime: '18:00',
  recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
  deletedOccurrencesRaw: '["2026-06-16","2026-07-14"]',
});

const GROUP_ID = '11112222-3333-4444-8555-666677778888';

const GROUP_ROOT_A = root({
  id: 'aaaa1111-0000-4000-8000-000000000001',
  scheduledDate: epochMs(2026, 6, 2), // Tuesday, Week 1
  scheduledTime: '18:00',
  recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
  recurrenceGroupId: GROUP_ID,
});

const GROUP_ROOT_B = root({
  id: 'aaaa1111-0000-4000-8000-000000000002',
  scheduledDate: epochMs(2026, 6, 6), // Saturday, Week 1
  scheduledTime: '09:00',
  recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
  recurrenceGroupId: GROUP_ID,
});

/** Same recurrenceGroupId as GROUP_ROOT_A/B but detached from the pattern (no
 * recurrenceRule of its own) — e.g. by an earlier move_occurrence. */
const GROUP_ROOT_DETACHED = root({
  id: 'aaaa1111-0000-4000-8000-000000000003',
  scheduledDate: epochMs(2026, 6, 20),
  scheduledTime: null,
  recurrenceRule: null,
  recurrenceGroupId: GROUP_ID,
});

function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['propose_planned_update'].handler;
}

// ---------------------------------------------------------------------------
// buildMoveOccurrenceEnvelope — pure helper
// ---------------------------------------------------------------------------

describe('buildMoveOccurrenceEnvelope — pure helper', () => {
  it('recurring root: emits exactly two roots — replace(original, +deletedOccurrences) and create(new standalone root)', () => {
    const args: ProposePlannedUpdateArgs = {
      intent: 'move_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      newDate: '2026-06-10',
      rationale: 'moving one Tuesday session to Wednesday',
    };

    const envelope = buildMoveOccurrenceEnvelope(args, RECURRING_ROOT);

    expect(envelope.kind).toBe('occurrence');
    expect(envelope.scope).toBe('this_occurrence');
    expect(envelope.roots).toHaveLength(2);

    const [replaceOp, createOp] = envelope.roots;
    expect(replaceOp.operation).toBe('replace');
    expect(replaceOp.root.id).toBe(ROOT_ID_RECURRING);
    expect(replaceOp.root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU');
    expect(replaceOp.root.deletedOccurrences).toStrictEqual(['2026-06-09']);

    expect(createOp.operation).toBe('create');
    expect(createOp.root.id).not.toBe(ROOT_ID_RECURRING);
    expect(createOp.root.templateId).toBe(TEMPLATE_ID_PUSH);
    expect(createOp.root.scheduledDate).toBe('2026-06-10');
    expect(createOp.root.scheduledTime).toBe('18:00'); // inherited from the original root
    expect(createOp.root.recurrenceRule).toBeNull();
    expect(createOp.root.recurrenceGroupId).toBeNull();
  });

  it('newTime overrides the inherited scheduledTime on the created root', () => {
    const args: ProposePlannedUpdateArgs = {
      intent: 'move_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      newDate: '2026-06-10',
      newTime: '07:00',
      rationale: 'moving to an earlier slot',
    };
    const envelope = buildMoveOccurrenceEnvelope(args, RECURRING_ROOT);
    const createOp = envelope.roots.find((op) => op.operation === 'create');
    expect(createOp?.root.scheduledTime).toBe('07:00');
  });

  it('non-recurring root: emits exactly one replace whose scheduledDate is newDate', () => {
    const args: ProposePlannedUpdateArgs = {
      intent: 'move_occurrence',
      rootId: ROOT_ID_STANDALONE,
      occurrenceDate: '2026-06-10',
      newDate: '2026-06-20',
      rationale: 'moving a single session',
    };

    const envelope = buildMoveOccurrenceEnvelope(args, STANDALONE_ROOT);

    expect(envelope.kind).toBe('occurrence');
    expect(envelope.scope).toBe('this_occurrence');
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('replace');
    expect(envelope.roots[0].root.id).toBe(ROOT_ID_STANDALONE);
    expect(envelope.roots[0].root.scheduledDate).toBe('2026-06-20');
    expect(envelope.roots[0].root.recurrenceRule).toBeNull();
  });

  it('a pre-existing cancelled date stays in the emitted list exactly once, sorted with the newly moved date', () => {
    const rootWithCancellation = root({
      id: ROOT_ID_RECURRING,
      scheduledDate: epochMs(2026, 6, 2),
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
      deletedOccurrencesRaw: '["2026-06-16"]',
    });
    const args: ProposePlannedUpdateArgs = {
      intent: 'move_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      newDate: '2026-06-10',
      rationale: 'moving a different occurrence than the already-cancelled one',
    };

    const envelope = buildMoveOccurrenceEnvelope(args, rootWithCancellation);
    const replaceOp = envelope.roots.find((op) => op.operation === 'replace');
    expect(replaceOp?.root.deletedOccurrences).toStrictEqual(['2026-06-09', '2026-06-16']);
  });
});

// ---------------------------------------------------------------------------
// proposePlannedUpdate / registered MCP handler
// ---------------------------------------------------------------------------

describe('propose_planned_update — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('unknown rootId: isError naming ROOT_NOT_FOUND, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([RECURRING_ROOT]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'move_occurrence',
      rootId: UNKNOWN_ROOT_ID,
      occurrenceDate: '2026-06-09',
      newDate: '2026-06-10',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ROOT_NOT_FOUND');
    expect(result.content[0].text).toContain(UNKNOWN_ROOT_ID);
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('occurrenceDate outside the root expansion: isError naming OCCURRENCE_NOT_IN_EXPANSION, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([RECURRING_ROOT]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    // 2026-06-10 is a Wednesday — RECURRING_ROOT only expands on Tuesdays.
    const result = await handler({
      intent: 'move_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-10',
      newDate: '2026-06-17',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('OCCURRENCE_NOT_IN_EXPANSION');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('a stored recurrenceRule the allowlist rejects: isError naming the reason code, no network call (T-136-01)', async () => {
    const badRoot = root({
      id: ROOT_ID_RECURRING,
      scheduledDate: epochMs(2026, 6, 2),
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=0;BYDAY=TU', // INTERVAL=0 -> INTERVAL_MUST_BE_POSITIVE
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([badRoot]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'move_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      newDate: '2026-06-10',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INTERVAL_MUST_BE_POSITIVE');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('happy-path (recurring root): POSTs a planned_update whose seriesHash matches computeSeriesHash over the stored before-state root', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([RECURRING_ROOT]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'move_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      newDate: '2026-06-10',
      rationale: 'moving one Tuesday session to Wednesday',
    });

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(body.type).toBe('planned_update');
    expect(body.rationale).toBe('moving one Tuesday session to Wednesday');
    expect(typeof body.changeHash).toBe('string');
    expect(body.changeHash).toHaveLength(64);
    expect(typeof body.seriesHash).toBe('string');
    expect(body.seriesHash).toMatch(/^[0-9a-f]{64}$/);

    const envelope = JSON.parse(body.payload) as {
      kind: string;
      scope: string;
      roots: { operation: string; root: Record<string, unknown> }[];
    };
    expect(envelope.kind).toBe('occurrence');
    expect(envelope.scope).toBe('this_occurrence');
    expect(envelope.roots).toHaveLength(2);

    // Recompute the seriesHash independently from the STORED root as it existed
    // BEFORE this proposal (protocol §4) — RECURRING_ROOT itself, untouched by the
    // move — and assert it equals the value actually sent to postSuggest. The
    // envelope's `replace`/`create` roots (the after-state) must NOT be used here;
    // that was the exact bug this plan (136-11) fixes.
    const beforeStateRoots: SeriesHashRoot[] = [
      {
        id: RECURRING_ROOT.id,
        templateId: RECURRING_ROOT.templateId,
        scheduledDate: RECURRING_ROOT.scheduledDate,
        scheduledTime: RECURRING_ROOT.scheduledTime,
        recurrenceRule: RECURRING_ROOT.recurrenceRule,
        recurrenceGroupId: RECURRING_ROOT.recurrenceGroupId,
        deletedOccurrencesRaw: RECURRING_ROOT.deletedOccurrencesRaw,
      },
    ];
    expect(body.seriesHash).toBe(computeSeriesHash(beforeStateRoots));
  });

  it('happy-path (non-recurring root): POSTs a planned_update with exactly one replace root', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([STANDALONE_ROOT]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'move_occurrence',
      rootId: ROOT_ID_STANDALONE,
      occurrenceDate: '2026-06-10',
      newDate: '2026-06-20',
      rationale: 'moving a single session',
    });

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as { roots: { operation: string }[] };
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('replace');
  });
});

// ---------------------------------------------------------------------------
// proposePlannedUpdate — direct calls (no MCP server scaffolding)
// ---------------------------------------------------------------------------

describe('proposePlannedUpdate — direct calls', () => {
  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('throws PlannedUpdateRejection with cause ROOT_NOT_FOUND for an unknown rootId', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));

    let caught: unknown;
    try {
      await proposePlannedUpdate(
        {
          intent: 'move_occurrence',
          rootId: UNKNOWN_ROOT_ID,
          occurrenceDate: '2026-06-09',
          newDate: '2026-06-10',
          rationale: 'test',
        },
        { ...DUMMY_CFG, sourceLlm: 'test/1' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlannedUpdateRejection);
    expect((caught as PlannedUpdateRejection).cause).toBe('ROOT_NOT_FOUND');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancel_occurrence — registered MCP handler (136-02)
// ---------------------------------------------------------------------------

describe('cancel_occurrence — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('recurring root: emits exactly one replace with the cancelled date added to deletedOccurrences', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([RECURRING_ROOT]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'cancel_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      rationale: 'trainee is sick',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      kind: string;
      scope: string;
      roots: { operation: string; root: { id: string; recurrenceRule: string | null; deletedOccurrences: string[] } }[];
    };
    expect(envelope.kind).toBe('occurrence');
    expect(envelope.scope).toBe('this_occurrence');
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('replace');
    expect(envelope.roots[0].root.id).toBe(ROOT_ID_RECURRING);
    expect(envelope.roots[0].root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU');
    expect(envelope.roots[0].root.deletedOccurrences).toStrictEqual(['2026-06-09']);
  });

  it('cancelling a date already present in deletedOccurrences leaves it present exactly once, not twice', async () => {
    const alreadyCancelled = root({
      id: ROOT_ID_RECURRING,
      scheduledDate: epochMs(2026, 6, 2),
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
      deletedOccurrencesRaw: '["2026-06-09"]',
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([alreadyCancelled]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    await handler({
      intent: 'cancel_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-09',
      rationale: 'cancelling an already-cancelled date again',
    });

    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as { roots: { root: { deletedOccurrences: string[] } }[] };
    expect(envelope.roots[0].root.deletedOccurrences).toStrictEqual(['2026-06-09']);
  });

  it('standalone root (no recurrenceRule): emits a delete operation, never a replace carrying deletedOccurrences', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([STANDALONE_ROOT]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'cancel_occurrence',
      rootId: ROOT_ID_STANDALONE,
      occurrenceDate: '2026-06-10',
      rationale: 'one-off session no longer needed',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as { roots: { operation: string; root: { id: string } }[] };
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('delete');
    expect(envelope.roots[0].root.id).toBe(ROOT_ID_STANDALONE);
  });

  it('a date outside the expansion: isError naming OCCURRENCE_NOT_IN_EXPANSION, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([RECURRING_ROOT]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    // 2026-06-10 is a Wednesday — RECURRING_ROOT only expands on Tuesdays.
    const result = await handler({
      intent: 'cancel_occurrence',
      rootId: ROOT_ID_RECURRING,
      occurrenceDate: '2026-06-10',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('OCCURRENCE_NOT_IN_EXPANSION');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// schedule_workout — registered MCP handler (136-02, D-03)
// ---------------------------------------------------------------------------

describe('schedule_workout — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
    vi.mocked(httpModule.fetchSuggestion).mockReset();
  });

  it('templateId + no recurrenceRule: emits one create of a standalone root on date', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      templateId: TEMPLATE_ID_PUSH,
      date: '2026-07-01',
      rationale: 'one extra push session',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      kind: string;
      scope: string;
      roots: { operation: string; root: { templateId: string; scheduledDate: string; recurrenceRule: string | null } }[];
    };
    expect(envelope.kind).toBe('occurrence');
    expect(envelope.scope).toBe('this_occurrence');
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('create');
    expect(envelope.roots[0].root.templateId).toBe(TEMPLATE_ID_PUSH);
    expect(envelope.roots[0].root.scheduledDate).toBe('2026-07-01');
    expect(envelope.roots[0].root.recurrenceRule).toBeNull();
  });

  it('templateId + valid recurrenceRule: emits one create of a recurring root (D-03)', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      templateId: TEMPLATE_ID_PUSH,
      date: '2026-07-01',
      time: '19:00',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=WE',
      rationale: 'new weekly Wednesday session',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      roots: { root: { recurrenceRule: string | null; scheduledTime: string | null } }[];
    };
    expect(envelope.roots[0].root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE');
    expect(envelope.roots[0].root.scheduledTime).toBe('19:00');
  });

  it('a recurrenceRule outside the allowlist: isError naming the reason code + substitute, no network call (T-136-06)', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      templateId: TEMPLATE_ID_PUSH,
      date: '2026-07-01',
      recurrenceRule: 'FREQ=YEARLY',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('YEARLY_NOT_SUPPORTED');
    expect(result.content[0].text).toContain('FREQ=MONTHLY;INTERVAL=12');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('a templateId absent from the decrypted snapshot: isError naming TEMPLATE_NOT_FOUND, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      templateId: UNKNOWN_ROOT_ID, // a syntactically valid UUID, absent from mockSnapshot.templates
      date: '2026-07-01',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TEMPLATE_NOT_FOUND');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // chainSuggestionId — Phase 136-08 (D-04, protocol §2 "Proposal Chain
  // Reference"): a still-open new_plan proposal in place of a templateId.
  // -------------------------------------------------------------------

  it('chainSuggestionId + no templateId, referenced proposal is a pending new_plan: emits one create carrying chainSuggestionId, no templateId', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(chainSuggestion());
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      chainSuggestionId: CHAIN_SUGGESTION_ID,
      date: '2026-07-01',
      rationale: 'schedule the plan I just proposed',
    });

    expect(result.isError).toBeFalsy();
    expect(httpModule.fetchSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ pat: DUMMY_CFG.pat, serverUrl: DUMMY_CFG.serverUrl }),
      CHAIN_SUGGESTION_ID,
    );
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      roots: { operation: string; root: Record<string, unknown> }[];
    };
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('create');
    expect(envelope.roots[0].root.chainSuggestionId).toBe(CHAIN_SUGGESTION_ID);
    expect(envelope.roots[0].root.templateId).toBeUndefined();
    expect(typeof body.seriesHash).toBe('string');
    expect(body.seriesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('templateId AND chainSuggestionId both present: isError naming the exclusivity rule, no network call', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      templateId: TEMPLATE_ID_PUSH,
      chainSuggestionId: CHAIN_SUGGESTION_ID,
      date: '2026-07-01',
      rationale: 'both set',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CHAIN_EXCLUSIVITY');
    expect(httpModule.fetchSuggestion).not.toHaveBeenCalled();
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('neither templateId nor chainSuggestionId present: isError naming the exclusivity rule, no network call', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      date: '2026-07-01',
      rationale: 'neither set',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CHAIN_EXCLUSIVITY');
    expect(httpModule.fetchSuggestion).not.toHaveBeenCalled();
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('a chainSuggestionId that is foreign or unknown: isError naming CHAIN_SUGGESTION_NOT_FOUND, no write call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(null);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      chainSuggestionId: CHAIN_SUGGESTION_ID,
      date: '2026-07-01',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CHAIN_SUGGESTION_NOT_FOUND');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('a chainSuggestionId naming a proposal that is not a new_plan: isError naming CHAIN_SUGGESTION_WRONG_TYPE, no write call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(chainSuggestion({ type: 'planned_update' }));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      chainSuggestionId: CHAIN_SUGGESTION_ID,
      date: '2026-07-01',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CHAIN_SUGGESTION_WRONG_TYPE');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('a chainSuggestionId naming a new_plan proposal that is no longer pending: isError naming CHAIN_SUGGESTION_NOT_PENDING, no write call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([]));
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue(chainSuggestion({ status: 'accepted' }));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      chainSuggestionId: CHAIN_SUGGESTION_ID,
      date: '2026-07-01',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CHAIN_SUGGESTION_NOT_PENDING');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// change_series_rule — registered MCP handler (136-02, the series split)
// ---------------------------------------------------------------------------

describe('change_series_rule — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('whole_series: emits one replace carrying the new rule; scheduledDate is unchanged', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([RECURRING_ROOT]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'change_series_rule',
      rootId: ROOT_ID_RECURRING,
      scope: 'whole_series',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR',
      rationale: 'add a Friday session',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      kind: string;
      scope: string;
      roots: { operation: string; root: { id: string; scheduledDate: string; recurrenceRule: string | null } }[];
    };
    expect(envelope.kind).toBe('rule');
    expect(envelope.scope).toBe('whole_series');
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('replace');
    expect(envelope.roots[0].root.id).toBe(ROOT_ID_RECURRING);
    expect(envelope.roots[0].root.scheduledDate).toBe('2026-06-02');
    expect(envelope.roots[0].root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR');
  });

  it('a root with no recurrenceRule: isError naming NO_RECURRENCE_RULE, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([STANDALONE_ROOT]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'change_series_rule',
      rootId: ROOT_ID_STANDALONE,
      scope: 'whole_series',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NO_RECURRENCE_RULE');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('this_and_following: old root UNTIL is cutoff minus one day; deletedOccurrences partition at the cutoff (protocol §2 worked example)', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([SPLIT_ROOT]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'change_series_rule',
      rootId: ROOT_ID_SPLIT,
      scope: 'this_and_following',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR',
      cutoffDate: '2026-07-07',
      rationale: 'add Fridays starting in July',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      kind: string;
      scope: string;
      roots: {
        operation: string;
        root: { id: string; scheduledDate: string; recurrenceRule: string | null; deletedOccurrences: string[] };
      }[];
    };

    expect(envelope.kind).toBe('rule');
    expect(envelope.scope).toBe('this_and_following');
    expect(envelope.roots).toHaveLength(2);

    const [replaceOp, createOp] = envelope.roots;
    expect(replaceOp.operation).toBe('replace');
    expect(replaceOp.root.id).toBe(ROOT_ID_SPLIT);
    expect(replaceOp.root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20260706');
    expect(replaceOp.root.deletedOccurrences).toStrictEqual(['2026-06-16']);

    expect(createOp.operation).toBe('create');
    expect(createOp.root.id).not.toBe(ROOT_ID_SPLIT);
    expect(createOp.root.scheduledDate).toBe('2026-07-07');
    expect(createOp.root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR');
    expect(createOp.root.deletedOccurrences).toStrictEqual(['2026-07-14']);
  });

  it("a cutoff equal to the root's own scheduledDate: emits a single replace, never a clamped root whose UNTIL precedes its own start", async () => {
    const rootAtStart = root({
      id: ROOT_ID_SPLIT,
      scheduledDate: epochMs(2026, 6, 2),
      scheduledTime: '18:00',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
    });
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([rootAtStart]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'change_series_rule',
      rootId: ROOT_ID_SPLIT,
      scope: 'this_and_following',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR',
      cutoffDate: '2026-06-02',
      rationale: 'change the whole series from the very start',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      roots: { operation: string; root: { id: string; recurrenceRule: string | null } }[];
    };
    expect(envelope.roots).toHaveLength(1);
    expect(envelope.roots[0].operation).toBe('replace');
    expect(envelope.roots[0].root.id).toBe(ROOT_ID_SPLIT);
    expect(envelope.roots[0].root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR');
  });

  it('group split: every member of a recurrenceGroupId group splits at the same cutoff and appears in roots', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([GROUP_ROOT_A, GROUP_ROOT_B]));
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'change_series_rule',
      rootId: GROUP_ROOT_A.id,
      scope: 'this_and_following',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
      cutoffDate: '2026-07-14',
      rationale: 'shift the whole block to Wednesdays',
    });

    expect(result.isError).toBeFalsy();
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const envelope = JSON.parse(body.payload) as {
      roots: { operation: string; root: { id: string; recurrenceGroupId: string | null } }[];
    };

    // Both members split (cutoff differs from each member's own scheduledDate) ->
    // one replace + one create per member = 4 root operations total.
    expect(envelope.roots).toHaveLength(4);
    const replacedIds = new Set(envelope.roots.filter((op) => op.operation === 'replace').map((op) => op.root.id));
    expect(replacedIds).toStrictEqual(new Set([GROUP_ROOT_A.id, GROUP_ROOT_B.id]));
    for (const op of envelope.roots) {
      expect(op.root.recurrenceGroupId).toBe(GROUP_ID);
    }
  });

  it('a partial group (a member with no recurrenceRule of its own): isError naming the group rule, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(mockCache([GROUP_ROOT_A, GROUP_ROOT_DETACHED]));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      intent: 'change_series_rule',
      rootId: GROUP_ROOT_A.id,
      scope: 'whole_series',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
      rationale: 'test',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('PARTIAL_GROUP_REJECTED');
    expect(result.content[0].text.toLowerCase()).toContain('indivisible');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// splitMemberAtCutoff — pure helper, the three-case cutoff boundary (gap
// closure CR-01, protocol §2 Rule 6, plan 136-19). Tests A-C call the
// now-exported splitMemberAtCutoff DIRECTLY, one member at a time, because
// the three-case boundary is that function's own contract. Test D goes
// through buildChangeSeriesRuleEnvelope, because D-11 group completeness is
// the envelope's contract, not the member splitter's.
// ---------------------------------------------------------------------------

describe('splitMemberAtCutoff — pure helper, three-case cutoff boundary (CR-01)', () => {
  const SPLIT_MEMBER = root({
    id: ROOT_ID_SPLIT,
    scheduledDate: epochMs(2026, 6, 2), // DTSTART Tuesday 2026-06-02
    scheduledTime: '18:00',
    recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
  });
  const NEW_RULE = 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR';

  it('Test A — cutoff strictly AFTER the member\'s own scheduledDate: replace(UNTIL=cutoff-1) + create(cutoff) — unchanged behaviour', () => {
    const ops = splitMemberAtCutoff(SPLIT_MEMBER, '2026-07-07', NEW_RULE);

    expect(ops).toHaveLength(2);
    const [replaceOp, createOp] = ops;
    expect(replaceOp.operation).toBe('replace');
    expect(replaceOp.root.id).toBe(ROOT_ID_SPLIT);
    expect(replaceOp.root.scheduledDate).toBe('2026-06-02');
    expect(replaceOp.root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20260706');

    expect(createOp.operation).toBe('create');
    expect(createOp.root.id).not.toBe(ROOT_ID_SPLIT);
    expect(createOp.root.scheduledDate).toBe('2026-07-07');
    expect(createOp.root.recurrenceRule).toBe(NEW_RULE);
  });

  it('Test B — cutoff EQUAL to the member\'s own scheduledDate: exactly one replace, no UNTIL appended, no create — unchanged behaviour, previously untested by name', () => {
    const ops = splitMemberAtCutoff(SPLIT_MEMBER, '2026-06-02', NEW_RULE);

    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe('replace');
    expect(ops[0].root.id).toBe(ROOT_ID_SPLIT);
    expect(ops[0].root.scheduledDate).toBe('2026-06-02');
    expect(ops[0].root.recurrenceRule).toBe(NEW_RULE);
  });

  it("Test C — cutoff strictly BEFORE the member's own scheduledDate: exactly one replace at the member's OWN date (never the cutoff), no create, no UNTIL anywhere — this is the case that was broken (CR-01)", () => {
    const ops = splitMemberAtCutoff(SPLIT_MEMBER, '2026-05-01', NEW_RULE);

    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe('replace');
    expect(ops[0].root.id).toBe(ROOT_ID_SPLIT);
    expect(ops[0].root.scheduledDate).toBe('2026-06-02'); // the member's own DTSTART, never the cutoff
    expect(ops[0].root.recurrenceRule).toBe(NEW_RULE);
    expect(ops[0].root.recurrenceRule).not.toContain('UNTIL');
  });

  it('Test D — staggered two-member group split through buildChangeSeriesRuleEnvelope: earlier member yields the Test-A pair, later member yields the Test-C single, envelope carries both member ids (D-11 completeness), 3 operations total', () => {
    const GROUP_STAGGERED_ID = '99998888-7777-4666-8555-444433332222';
    const earlierMember = root({
      id: 'aaaa9999-0000-4000-8000-00000000a001',
      scheduledDate: epochMs(2026, 6, 2), // DTSTART Tuesday, before the cutoff
      scheduledTime: '18:00',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
      recurrenceGroupId: GROUP_STAGGERED_ID,
    });
    const laterMember = root({
      id: 'aaaa9999-0000-4000-8000-00000000a002',
      scheduledDate: epochMs(2026, 8, 4), // DTSTART Tuesday, after the cutoff
      scheduledTime: '09:00',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
      recurrenceGroupId: GROUP_STAGGERED_ID,
    });
    const args: ChangeSeriesRuleArgs = {
      intent: 'change_series_rule',
      rootId: earlierMember.id,
      scope: 'this_and_following',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=WE',
      cutoffDate: '2026-07-14',
      rationale: 'staggered two-week block shifts to Wednesdays starting mid-July',
    };

    const envelope = buildChangeSeriesRuleEnvelope(args, [earlierMember, laterMember]);

    expect(envelope.kind).toBe('rule');
    expect(envelope.scope).toBe('this_and_following');
    expect(envelope.roots).toHaveLength(3); // Test-A pair (2) + Test-C single (1)

    const idsPresent = new Set(envelope.roots.map((op) => op.root.id));
    expect(idsPresent.has(earlierMember.id)).toBe(true); // D-11: both member ids present
    expect(idsPresent.has(laterMember.id)).toBe(true);

    // Earlier member (DTSTART before the cutoff): the Test-A split pair.
    const earlierReplace = envelope.roots.find((op) => op.operation === 'replace' && op.root.id === earlierMember.id);
    expect(earlierReplace?.root.scheduledDate).toBe('2026-06-02');
    expect(earlierReplace?.root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20260713');

    const createOps = envelope.roots.filter((op) => op.operation === 'create');
    expect(createOps).toHaveLength(1); // only the earlier member's split creates a new root
    expect(createOps[0].root.scheduledDate).toBe('2026-07-14');
    expect(createOps[0].root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE');
    expect(createOps[0].root.recurrenceGroupId).toBe(GROUP_STAGGERED_ID);

    // Later member (DTSTART on/after the cutoff): the Test-C collapsed single, at its
    // own DTSTART, never the cutoff, and no UNTIL on the later member's root.
    const laterReplace = envelope.roots.find((op) => op.root.id === laterMember.id);
    expect(laterReplace?.operation).toBe('replace');
    expect(laterReplace?.root.scheduledDate).toBe('2026-08-04');
    expect(laterReplace?.root.recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE');
    expect(laterReplace?.root.recurrenceRule).not.toContain('UNTIL');
  });
});

// ---------------------------------------------------------------------------
// assertRuleEmittableOnRoot — the previously ✗ NOT WIRED Key Link
// (136-VERIFICATION.md: splitMemberAtCutoff/buildChangeSeriesRuleEnvelope ->
// validateRRule ...), now ✓ WIRED (Task 2, gap closure CR-01). Every case is
// driven through the already-exported buildChangeSeriesRuleEnvelope — never
// through a direct call on the guard itself, which stays module-private —
// because only the wired path is evidence the link is closed.
// ---------------------------------------------------------------------------

describe('assertRuleEmittableOnRoot — driven through buildChangeSeriesRuleEnvelope (Key Link, now wired)', () => {
  const GUARD_GROUP_ID = '88887777-6666-4555-8444-333322221111';
  const earlierMember = root({
    id: 'bbbb9999-0000-4000-8000-00000000b001',
    scheduledDate: epochMs(2026, 6, 2), // DTSTART Tuesday
    scheduledTime: '18:00',
    recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
    recurrenceGroupId: GUARD_GROUP_ID,
  });
  const laterMember = root({
    id: 'bbbb9999-0000-4000-8000-00000000b002',
    scheduledDate: epochMs(2026, 8, 4), // DTSTART Tuesday, well after earlierMember's
    scheduledTime: '09:00',
    recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
    recurrenceGroupId: GUARD_GROUP_ID,
  });

  it("whole_series: a coach-supplied newRecurrenceRule whose UNTIL is legal on the earliest member but precedes a LATER member's own scheduledDate throws RULE_NOT_EMITTABLE naming the offending root", () => {
    const args: ChangeSeriesRuleArgs = {
      intent: 'change_series_rule',
      rootId: earlierMember.id,
      scope: 'whole_series',
      // UNTIL 2026-07-01 is after earlierMember's DTSTART (2026-06-02, legal there)
      // but before laterMember's DTSTART (2026-08-04) — inert on that member alone.
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20260701',
      rationale: 'one rule proposed for the whole staggered block',
    };

    let caught: unknown;
    try {
      buildChangeSeriesRuleEnvelope(args, [earlierMember, laterMember]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlannedUpdateRejection);
    expect((caught as PlannedUpdateRejection).cause).toBe('RULE_NOT_EMITTABLE');
    expect((caught as PlannedUpdateRejection).message).toContain(laterMember.id);
    expect((caught as PlannedUpdateRejection).message).toContain('20260701');
    expect((caught as PlannedUpdateRejection).message).toContain('2026-08-04');
  });

  it("this_and_following: a coach-supplied newRecurrenceRule whose UNTIL precedes the cutoff (the new root's own scheduledDate) throws RULE_NOT_EMITTABLE — the derived clamped-old-root direction is covered by Test C passing instead, since there is no longer an input that reaches it", () => {
    const args: ChangeSeriesRuleArgs = {
      intent: 'change_series_rule',
      rootId: earlierMember.id,
      scope: 'this_and_following',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;UNTIL=20260701', // before the cutoff
      cutoffDate: '2026-07-14',
      rationale: 'this rule can never fire on the post-cutoff root',
    };

    let caught: unknown;
    try {
      buildChangeSeriesRuleEnvelope(args, [earlierMember]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlannedUpdateRejection);
    expect((caught as PlannedUpdateRejection).cause).toBe('RULE_NOT_EMITTABLE');
  });

  it('a rule rejected by the allowlist throws with validateRRule\'s own reasonCode, not RULE_NOT_EMITTABLE — the coach keeps the token-level diagnosis', () => {
    const args: ChangeSeriesRuleArgs = {
      intent: 'change_series_rule',
      rootId: earlierMember.id,
      scope: 'whole_series',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=0;BYDAY=TU', // INTERVAL=0 -> INTERVAL_MUST_BE_POSITIVE
      rationale: 'test',
    };

    let caught: unknown;
    try {
      buildChangeSeriesRuleEnvelope(args, [earlierMember]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlannedUpdateRejection);
    expect((caught as PlannedUpdateRejection).cause).toBe('INTERVAL_MUST_BE_POSITIVE');
  });

  it('a rule with no UNTIL at all is always emittable — the check is skipped, never treated as a violation', () => {
    const args: ChangeSeriesRuleArgs = {
      intent: 'change_series_rule',
      rootId: earlierMember.id,
      scope: 'whole_series',
      newRecurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR',
      rationale: 'no UNTIL on this rule',
    };

    expect(() => buildChangeSeriesRuleEnvelope(args, [earlierMember, laterMember])).not.toThrow();
  });
});
