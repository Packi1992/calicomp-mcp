/**
 * Tests for the `propose_new_exercise` WRITE tool (D-04 catalog dedupe → propose).
 *
 * Coverage mirrors the <behavior> block from 121-03-PLAN.md:
 *   - dedupe-hit: proposed name normalizes-equal to a catalog exercise → returns
 *     `{ dedupedTo: <existingUuid> }`, postSuggest NOT called.
 *   - novel-name: postSuggest called with type 'new_exercise', changeHash, sourceLlm,
 *     and NO planHash key.
 *   - changeHash determinism: two calls with identical logical input produce the
 *     identical changeHash argument to postSuggest.
 *   - server-error: postSuggest throws HttpError(400) → isError text contains 'HTTP 400'.
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
import { registerToolProposeNewExercise } from '../../src/tools/propose_new_exercise.js';
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
  type:       'new_exercise',
  payload:    '{}',
  rationale:  'because',
  sourceLlm:  'unknown',
  status:     'pending',
  createdAt:  1_700_000_000_000,
  expiresAt:  1_700_100_000_000,
  planHash:   null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['propose_new_exercise'].handler;
}

describe('propose_new_exercise — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('dedupe-hit: normalizes-equal name returns dedupedTo and does not call postSuggest', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewExercise(server, DUMMY_CFG);
    const handler = getHandler(server);

    // "  PUSH-UP  " (case + surrounding whitespace) normalizes-equal to catalog "Push-Up".
    const result = await handler({
      name:       '  PUSH-UP  ',
      mode:       'REPS',
      usesWeight: false,
      rationale:  'testing dedupe',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as { dedupedTo: string };
    expect(parsed.dedupedTo).toBe(CATALOG_EXERCISE_ID_PUSHUP);
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('novel-name: POSTs new_exercise with changeHash + sourceLlm and no planHash', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewExercise(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      name:       'Dragon Flag',
      mode:       'TIME',
      usesWeight: false,
      rationale:  'novel exercise',
    });

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(body.type).toBe('new_exercise');
    expect(body.rationale).toBe('novel exercise');
    expect(typeof body.changeHash).toBe('string');
    expect(body.changeHash).toHaveLength(64);
    expect(typeof body.sourceLlm).toBe('string');
    expect('planHash' in body).toBe(false);

    const payload = JSON.parse(body.payload) as Record<string, unknown>;
    expect(payload).toStrictEqual({ name: 'Dragon Flag', mode: 'TIME', usesWeight: false });
  });

  it('changeHash determinism: two calls with identical logical input produce the identical changeHash', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewExercise(server, DUMMY_CFG);
    const handler = getHandler(server);

    await handler({ name: 'Dragon Flag', mode: 'TIME', usesWeight: false, rationale: 'first call' });
    await handler({ name: 'Dragon Flag', mode: 'TIME', usesWeight: false, rationale: 'second call' });

    expect(httpModule.postSuggest).toHaveBeenCalledTimes(2);
    const firstHash  = vi.mocked(httpModule.postSuggest).mock.calls[0][0].changeHash;
    const secondHash = vi.mocked(httpModule.postSuggest).mock.calls[1][0].changeHash;
    expect(firstHash).toBe(secondHash);
  });

  it('server-error: HttpError(400) from postSuggest returns isError text containing HTTP 400', async () => {
    vi.mocked(httpModule.postSuggest).mockRejectedValue(new HttpError(400, '/api/mcp/suggest'));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposeNewExercise(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      name:       'Dragon Flag',
      mode:       'TIME',
      usesWeight: false,
      rationale:  'novel exercise',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 400');
  });
});
