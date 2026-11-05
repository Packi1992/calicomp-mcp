/**
 * Tests for the `propose_catalog_exercise_links` WRITE tool (Phase 168.1, plan 168.1-03, D-01, D-03, D-04, protocol 1.57
 * §2.9 "Personal Link Proposals").
 *
 * The args go through the real ProposeCatalogExerciseLinksSchema first (the SDK does the same before it calls the
 * handler), then through the registered handler with a mocked snapshot and a mocked `postSuggest`. Nothing here applies
 * anything: the only network write is the mocked POST /api/mcp/suggest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../../src/cache.js');
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return { ...actual, postSuggest: vi.fn(), fetchSuggestion: vi.fn() };
});

import * as cacheModule from '../../src/cache.js';
import * as httpModule from '../../src/http.js';
import { HttpError } from '../../src/http.js';
import { computeChangeHash } from '../../src/hash.js';
import { ProposeCatalogExerciseLinksSchema } from '../../src/schemas.js';
import { registerToolProposeCatalogExerciseLinks } from '../../src/tools/propose_catalog_exercise_links.js';
import { registerToolGetSuggestion } from '../../src/tools/get_suggestion.js';
import { mockSnapshot, mockCatalog, CATALOG_EXERCISE_ID_PULLUP } from '../fixture.js';
import { loadCoachPlanningVectors } from '../shared-vectors.js';
import type { CatalogExercise, SuggestionDtoResponse } from '../../src/types.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };
const CORPUS = loadCoachPlanningVectors().catalogExerciseLinks.parse;

const OWN_EXERCISE_ID = '16811000-0000-4000-8000-000000000201';
const UNKNOWN_EXERCISE_ID = '16811000-0000-4000-8000-000000000299';

const OWN_EXERCISE: CatalogExercise = {
  id: OWN_EXERCISE_ID,
  key: `user_exercise:${OWN_EXERCISE_ID}`,
  nameEn: 'Own Drill',
  mode: 'TIME',
  usesWeight: false,
  lastModifiedAt: 1_700_000_000_000,
  translations: [],
  muscleGroups: [],
  equipment: [],
  capabilities: [],
  origin: 'CUSTOM',
};

/** The catalog before the overlay: the pull-up carries the axis `power`. */
const VOCABULARY: CatalogExercise[] = [
  ...mockCatalog.map((ex) =>
    ex.id === CATALOG_EXERCISE_ID_PULLUP
      ? { ...ex, capabilities: [{ id: 'cap-power', key: 'power', translations: [], capabilityLevel: 'HAUPTREIZ' as const }] }
      : ex,
  ),
  OWN_EXERCISE,
];

const MOCK_CACHE = {
  snapshot: mockSnapshot,
  catalog: VOCABULARY,
  linkVocabularyCatalog: VOCABULARY,
  profile: {
    userId: 'user-test-1',
    email: 'athlete',
    displayName: 'Athlete',
    avatarUrl: '',
    isPremium: false,
    createdAt: 1_700_000_000_000,
  },
  fetchedAt: Date.now(),
};

const MOCK_SUGGESTION: SuggestionDtoResponse = {
  id: 'suggestion-cl-1',
  type: 'catalog_exercise_links',
  payload: '{}',
  rationale: 'because',
  sourceLlm: 'unknown',
  status: 'pending',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_100_000_000,
  planHash: null,
};

type Handler = (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

function handlerOf(server: McpServer, name: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools[name].handler;
}

async function propose(input: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.1.0' });
  registerToolProposeCatalogExerciseLinks(server, DUMMY_CFG);
  return handlerOf(server, 'propose_catalog_exercise_links')(
    ProposeCatalogExerciseLinksSchema.parse({ rationale: 'this athlete feels it elsewhere', ...input }),
  );
}

beforeEach(() => {
  vi.mocked(cacheModule.getSnapshot).mockReset();
  vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
  vi.mocked(httpModule.postSuggest).mockReset();
  vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);
  vi.mocked(httpModule.fetchSuggestion).mockReset();
});

describe('propose_catalog_exercise_links', () => {
  it.each(CORPUS.map((v) => [v.name, v] as const))('the schema decides the corpus vector %s', (_name, vector) => {
    const result = ProposeCatalogExerciseLinksSchema.safeParse({ rationale: 'corpus', ...vector.payload });

    expect(result.success).toBe(vector.expect === 'ok');
  });

  it('an id outside the catalog is refused with EXERCISE_NOT_FOUND', async () => {
    const result = await propose({ exerciseId: UNKNOWN_EXERCISE_ID, muscleGroups: [{ key: 'lats', level: 'PRIMARY' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EXERCISE_NOT_FOUND');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('an own exercise is refused and names propose_exercise_update', async () => {
    const result = await propose({ exerciseId: OWN_EXERCISE_ID, muscleGroups: [{ key: 'lats', level: 'PRIMARY' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('propose_exercise_update');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('an unknown capability key is refused with its name', async () => {
    const result = await propose({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, capabilities: [{ key: 'juggling', level: 'GERING' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('juggling');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('sends type catalog_exercise_links with the payload of the contract', async () => {
    const lists = {
      muscleGroups: [{ key: 'lats', level: 'PRIMARY' }, { key: 'back' }],
      capabilities: [{ key: 'power', level: 'MITTRAINIERT' }],
    };

    const result = await propose({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, ...lists });

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const payload = { exerciseId: CATALOG_EXERCISE_ID_PULLUP, ...lists };
    expect(body.type).toBe('catalog_exercise_links');
    expect(JSON.parse(body.payload)).toStrictEqual(payload);
    expect(body.rationale).toBe('this athlete feels it elsewhere');
    expect(body.changeHash).toBe(computeChangeHash('catalog_exercise_links', payload));
    expect(body.planHash).toBeUndefined();
  });

  it('a list that is absent stays out of the payload', async () => {
    await propose({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, capabilities: [{ key: 'power', level: 'GERING' }] });

    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(Object.keys(JSON.parse(body.payload) as object)).toStrictEqual(['exerciseId', 'capabilities']);
  });

  it('a server without the type shows HTTP 400', async () => {
    vi.mocked(httpModule.postSuggest).mockRejectedValue(new HttpError(400, '/api/mcp/suggest'));

    const result = await propose({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, muscleGroups: [{ key: 'lats' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Server rejected proposal: HTTP 400');
  });

  it('a read that fails sends no proposal', async () => {
    vi.mocked(cacheModule.getSnapshot).mockRejectedValue(new Error('offline'));

    const result = await propose({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, muscleGroups: [{ key: 'lats' }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('offline');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  // Phase 168.1 (Pitfall 6): the vocabulary is the catalog before the personal lists were laid over it.
  it('a key that stood only on an overridden exercise stays known', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({ ...MOCK_CACHE, catalog: [...mockCatalog, OWN_EXERCISE] });

    const result = await propose({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, capabilities: [{ key: 'power', level: 'GERING' }] });

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
  });

  it('get_suggestion names the exercise of the proposal next to its top-level exerciseId', async () => {
    const payload = JSON.stringify({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, muscleGroups: [{ key: 'lats' }] });
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue({ ...MOCK_SUGGESTION, payload });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetSuggestion(server, DUMMY_CFG);

    const one = await handlerOf(server, 'get_suggestion')({ id: 'suggestion-cl-1' });

    expect(one.isError).toBeFalsy();
    const output = JSON.parse(one.content[0].text) as { payload: string; payloadResolved: Record<string, unknown> };
    expect(output.payload).toBe(payload);
    expect(output.payloadResolved.exerciseName).toBe('Pull-Up');
  });
});
