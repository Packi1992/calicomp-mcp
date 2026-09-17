/**
 * Tests for the `propose_new_plan` WRITE tool (full new-plan structure, no
 * stale-guard hash sent — A3; inline-newExercises dedupe — A2).
 *
 * Coverage mirrors the <behavior> block from 121-03-PLAN.md:
 *   - novel-plan: postSuggest called with type 'new_plan', no planHash key.
 *   - inline-dedupe: a newExercises entry matching the fixture catalog is dropped
 *     and its ref rewritten to source:'catalog' with the existing UUID (asserted
 *     on the payload argument).
 *   - changeHash determinism: two calls with identical logical input produce the
 *     identical changeHash argument to postSuggest.
 *   - server-error: postSuggest throws HttpError(400) -> isError text contains 'HTTP 400'.
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
  };
});

import * as cacheModule from '../../src/cache.js';
import * as httpModule from '../../src/http.js';
import { HttpError } from '../../src/http.js';
import {
  registerToolProposeNewPlan,
  buildNewPlanPayload,
  type ProposeNewPlanArgs,
} from '../../src/tools/propose_new_plan.js';
import { mockSnapshot, mockCatalog, CATALOG_EXERCISE_ID_PUSHUP } from '../fixture.js';
import type { UserProfileResponse, SuggestionDtoResponse } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const mockProfile: UserProfileResponse = {
  userId:      'user-test-1',
  email:       'test@example.com',
  displayName: 'Test User',
  avatarUrl:   'https://example.com/avatar.svg',
  isPremium:   false,
  createdAt:   1_700_000_000_000,
};

/** Full SnapshotCache shape returned by mocked getSnapshot. */
const MOCK_CACHE = {
  snapshot:  mockSnapshot,
  catalog:   mockCatalog,
  profile:   mockProfile,
  fetchedAt: Date.now(),
};

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };

const MOCK_SUGGESTION: SuggestionDtoResponse = {
  id:         'suggestion-1',
  type:       'new_plan',
  payload:    '{}',
  rationale:  'because',
  sourceLlm:  'unknown',
  status:     'pending',
  createdAt:  1_700_000_000_000,
  expiresAt:  1_700_100_000_000,
  planHash:   null,
};

const NOVEL_PLAN_ARGS: ProposeNewPlanArgs = {
  name:      'Novel Push Plan',
  rationale: 'testing new plan',
  blocks: [
    {
      tempBlockId: 'block-1',
      rounds:      3,
      orderIndex:  0,
      exercises: [
        {
          exercise:        { source: 'catalog', exerciseId: CATALOG_EXERCISE_ID_PUSHUP },
          mode:            'REPS',
          targetReps:      12,
          restTimeSeconds: 60,
          sets:            3,
          orderIndex:      0,
        },
      ],
    },
  ],
};

function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['propose_new_plan'].handler;
}

// ---------------------------------------------------------------------------
// buildNewPlanPayload — pure helper
// ---------------------------------------------------------------------------

describe('buildNewPlanPayload — pure helper', () => {
  it('inline-dedupe: a newExercises entry matching the catalog is dropped and its ref rewritten', () => {
    const args: ProposeNewPlanArgs = {
      name:      'Dedupe Plan',
      rationale: 'testing inline dedupe',
      newExercises: [
        { tempId: 'temp-pushup', name: '  PUSH-UP  ', mode: 'REPS', usesWeight: false },
        { tempId: 'temp-novel',  name: 'Dragon Flag', mode: 'TIME', usesWeight: false },
      ],
      blocks: [
        {
          tempBlockId: 'block-1',
          rounds:      2,
          orderIndex:  0,
          exercises: [
            {
              exercise:        { source: 'new', tempId: 'temp-pushup' },
              mode:            'REPS',
              restTimeSeconds: 60,
              sets:            3,
              orderIndex:      0,
            },
            {
              exercise:        { source: 'new', tempId: 'temp-novel' },
              mode:            'TIME',
              restTimeSeconds: 60,
              sets:            3,
              orderIndex:      1,
            },
          ],
        },
      ],
    };

    const payload = buildNewPlanPayload(args, mockCatalog);

    // Matched entry dropped from newExercises[]; novel one remains.
    expect(payload.newExercises).toHaveLength(1);
    expect(payload.newExercises[0].tempId).toBe('temp-novel');

    // Matched ref rewritten to source:'catalog' with the existing UUID.
    const rewrittenRef = payload.blocks[0].exercises[0].exercise;
    expect(rewrittenRef).toStrictEqual({ source: 'catalog', exerciseId: CATALOG_EXERCISE_ID_PUSHUP });

    // Unmatched ref passes through unchanged.
    const passthroughRef = payload.blocks[0].exercises[1].exercise;
    expect(passthroughRef).toStrictEqual({ source: 'new', tempId: 'temp-novel' });
  });

  it('leaves already-catalog refs and no-newExercises plans unchanged', () => {
    const payload = buildNewPlanPayload(NOVEL_PLAN_ARGS, mockCatalog);
    expect(payload.newExercises).toStrictEqual([]);
    expect(payload.blocks[0].exercises[0].exercise).toStrictEqual({
      source:     'catalog',
      exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
    });
  });
});

// ---------------------------------------------------------------------------
// registered MCP handler
// ---------------------------------------------------------------------------

describe('propose_new_plan — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('novel-plan: POSTs new_plan with changeHash + sourceLlm and no planHash', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewPlan(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(NOVEL_PLAN_ARGS);

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(body.type).toBe('new_plan');
    expect(body.rationale).toBe('testing new plan');
    expect(typeof body.changeHash).toBe('string');
    expect(body.changeHash).toHaveLength(64);
    expect(typeof body.sourceLlm).toBe('string');
    expect('planHash' in body).toBe(false);

    const payload = JSON.parse(body.payload) as { name: string; blocks: unknown[]; newExercises: unknown[] };
    expect(payload.name).toBe('Novel Push Plan');
    expect(payload.newExercises).toStrictEqual([]);
  });

  it('inline-dedupe via handler: matched newExercises entry rewritten in the POSTed payload', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewPlan(server, DUMMY_CFG);
    const handler = getHandler(server);

    await handler({
      name:      'Dedupe Plan',
      rationale: 'testing inline dedupe via handler',
      newExercises: [
        { tempId: 'temp-pushup', name: '  PUSH-UP  ', mode: 'REPS', usesWeight: false },
      ],
      blocks: [
        {
          tempBlockId: 'block-1',
          rounds:      2,
          orderIndex:  0,
          exercises: [
            {
              exercise:        { source: 'new', tempId: 'temp-pushup' },
              mode:            'REPS',
              restTimeSeconds: 60,
              sets:            3,
              orderIndex:      0,
            },
          ],
        },
      ],
    });

    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const payload = JSON.parse(body.payload) as {
      newExercises: unknown[];
      blocks: { exercises: { exercise: { source: string; exerciseId?: string } }[] }[];
    };
    expect(payload.newExercises).toStrictEqual([]);
    expect(payload.blocks[0].exercises[0].exercise).toStrictEqual({
      source:     'catalog',
      exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
    });
  });

  it('changeHash determinism: two calls with identical logical input produce the identical changeHash', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewPlan(server, DUMMY_CFG);
    const handler = getHandler(server);

    await handler({ ...NOVEL_PLAN_ARGS, rationale: 'first call' });
    await handler({ ...NOVEL_PLAN_ARGS, rationale: 'second call' });

    expect(httpModule.postSuggest).toHaveBeenCalledTimes(2);
    const firstHash  = vi.mocked(httpModule.postSuggest).mock.calls[0][0].changeHash;
    const secondHash = vi.mocked(httpModule.postSuggest).mock.calls[1][0].changeHash;
    expect(firstHash).toBe(secondHash);
  });

  it('server-error: HttpError(400) from postSuggest returns isError text containing HTTP 400', async () => {
    vi.mocked(httpModule.postSuggest).mockRejectedValue(new HttpError(400, '/api/mcp/suggest'));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewPlan(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(NOVEL_PLAN_ARGS);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 400');
  });
});
