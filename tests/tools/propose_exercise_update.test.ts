/**
 * Tests for the `propose_exercise_update` WRITE tool (Phase 166, plan 166-08, MCP-06, D-15,
 * protocol §2.7 "exercise_update: changing an existing exercise").
 *
 * The args go through the real ProposeExerciseUpdateSchema first (the SDK does the same before it
 * calls the handler), then through the registered handler with a mocked snapshot and a mocked
 * `postSuggest`. Covered:
 *   - an own exercise (origin CUSTOM): every field is sent as type `exercise_update`, with a
 *     changeHash over the payload and no planHash;
 *   - a catalog exercise: translations only; muscleGroups or capabilities are a tool error;
 *   - an exerciseId neither in the catalog nor among the own exercises: EXERCISE_NOT_FOUND;
 *   - an unknown capability key: refused, the key named;
 *   - get_suggestions lists an exercise_update row, get_suggestion names its exercise.
 * Nothing here applies anything: the only network write is the mocked POST /api/mcp/suggest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../../src/cache.js');
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return {
    ...actual,
    postSuggest: vi.fn(),
    fetchSuggestions: vi.fn(),
    fetchSuggestion: vi.fn(),
  };
});

import * as cacheModule from '../../src/cache.js';
import * as httpModule from '../../src/http.js';
import { HttpError } from '../../src/http.js';
import { computeChangeHash } from '../../src/hash.js';
import { ProposeExerciseUpdateSchema } from '../../src/schemas.js';
import { registerToolProposeExerciseUpdate } from '../../src/tools/propose_exercise_update.js';
import { registerToolGetSuggestions } from '../../src/tools/get_suggestions.js';
import { registerToolGetSuggestion } from '../../src/tools/get_suggestion.js';
import { mockSnapshot, mockCatalog, CATALOG_EXERCISE_ID_PULLUP } from '../fixture.js';
import type { CatalogExercise, SuggestionDtoResponse, SuggestionSummaryDtoResponse } from '../../src/types.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };

const OWN_EXERCISE_ID = '16608000-0000-4000-8000-000000000201';
const UNKNOWN_EXERCISE_ID = '16608000-0000-4000-8000-000000000299';

/** The fixture catalog plus one own exercise (origin CUSTOM) and a capability vocabulary. */
const OWN_EXERCISE: CatalogExercise = {
  id: OWN_EXERCISE_ID,
  key: `user_exercise:${OWN_EXERCISE_ID}`,
  nameEn: 'Own Hip Flow',
  mode: 'TIME',
  usesWeight: false,
  lastModifiedAt: 1_700_000_000_000,
  translations: [],
  muscleGroups: [],
  equipment: [],
  capabilities: [{ id: 'cap-mobility', key: 'mobility', translations: [], capabilityLevel: 'HAUPTREIZ' }],
  origin: 'CUSTOM',
};
const CATALOG: CatalogExercise[] = [...mockCatalog, OWN_EXERCISE];

const MOCK_CACHE = {
  snapshot: mockSnapshot,
  catalog: CATALOG,
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

const MOCK_SUGGESTION: SuggestionDtoResponse = {
  id: 'suggestion-eu-1',
  type: 'exercise_update',
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
  registerToolProposeExerciseUpdate(server, DUMMY_CFG);
  return handlerOf(server, 'propose_exercise_update')(
    ProposeExerciseUpdateSchema.parse({ rationale: 'adjust the exercise', ...input }),
  );
}

beforeEach(() => {
  vi.mocked(cacheModule.getSnapshot).mockReset();
  vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
  vi.mocked(httpModule.postSuggest).mockReset();
  vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);
  vi.mocked(httpModule.fetchSuggestions).mockReset();
  vi.mocked(httpModule.fetchSuggestion).mockReset();
});

describe('propose_exercise_update (166-08, D-15)', () => {
  it('P166 propose_exercise_update posts type exercise_update', async () => {
    const input = {
      exerciseId: OWN_EXERCISE_ID,
      translations: [
        { languageCode: 'en', name: 'Own Hip Flow Long', description: null },
        { languageCode: 'de', name: 'Eigener Hüftfluss', description: 'Langsam.' },
      ],
      muscleGroups: [{ key: 'glutes', level: 'PRIMARY' }, { key: 'hip_flexors' }],
      capabilities: [{ key: 'mobility', level: 'MITTRAINIERT' }],
    };
    const result = await propose(input);

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(body.type).toBe('exercise_update');
    expect(body.rationale).toBe('adjust the exercise');
    expect(typeof body.sourceLlm).toBe('string');
    expect('planHash' in body).toBe(false);
    expect('seriesHash' in body).toBe(false);
    const payload = JSON.parse(body.payload) as Record<string, unknown>;
    expect(payload).toStrictEqual({
      exerciseId: OWN_EXERCISE_ID,
      translations: input.translations,
      muscleGroups: input.muscleGroups,
      capabilities: input.capabilities,
    });
    expect(body.changeHash).toBe(computeChangeHash('exercise_update', payload));
    expect(body.changeHash).not.toBe(computeChangeHash('new_exercise', payload));
  });

  it('P166 muscle groups or capabilities on a catalog exercise are refused', async () => {
    const withMuscles = await propose({
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      translations: [{ languageCode: 'de', name: 'Mein Klimmzug' }],
      muscleGroups: [{ key: 'lats', level: 'PRIMARY' }],
    });
    expect(withMuscles.isError).toBe(true);
    expect(withMuscles.content[0].text).toContain('CATALOG_EXERCISE_LINKS_REFUSED');

    const withCapabilities = await propose({
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      capabilities: [{ key: 'mobility', level: 'GERING' }],
    });
    expect(withCapabilities.isError).toBe(true);
    expect(withCapabilities.content[0].text).toContain('CATALOG_EXERCISE_LINKS_REFUSED');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();

    // Control: translations alone on the same catalog exercise are sent (a personal name).
    const namesOnly = await propose({
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      translations: [{ languageCode: 'de', name: 'Mein Klimmzug', description: null }],
    });
    expect(namesOnly.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(JSON.parse(body.payload)).toStrictEqual({
      exerciseId: CATALOG_EXERCISE_ID_PULLUP,
      translations: [{ languageCode: 'de', name: 'Mein Klimmzug', description: null }],
    });
  });

  it('P166 an exerciseId missing from the catalog is refused', async () => {
    const result = await propose({
      exerciseId: UNKNOWN_EXERCISE_ID,
      translations: [{ languageCode: 'de', name: 'Irgendwas' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EXERCISE_NOT_FOUND');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('P166 an unknown capability key on an own exercise is refused with the key named', async () => {
    const result = await propose({ exerciseId: OWN_EXERCISE_ID, capabilities: [{ key: 'juggling', level: 'GERING' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('juggling');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('P166 an exercise_update without any field and one with equipment are refused by the schema', () => {
    expect(ProposeExerciseUpdateSchema.safeParse({ exerciseId: OWN_EXERCISE_ID, rationale: 'r' }).success).toBe(false);
    const withEquipment = ProposeExerciseUpdateSchema.safeParse({
      exerciseId: OWN_EXERCISE_ID,
      rationale: 'r',
      equipment: [{ key: 'kettlebell' }],
    });
    // Equipment is not part of exercise_update in 166 (§2.7 "No other key"): refused, never
    // silently dropped, also next to a valid field.
    expect(withEquipment.success).toBe(false);
    expect(
      ProposeExerciseUpdateSchema.safeParse({
        exerciseId: OWN_EXERCISE_ID,
        rationale: 'r',
        translations: [{ languageCode: 'de', name: 'Neu' }],
        equipment: [{ key: 'kettlebell' }],
      }).success,
    ).toBe(false);
    expect(
      ProposeExerciseUpdateSchema.safeParse({ exerciseId: OWN_EXERCISE_ID, rationale: 'r', muscleGroups: [] }).success,
    ).toBe(false);
  });

  it('P166 a server error surfaces only the status', async () => {
    vi.mocked(httpModule.postSuggest).mockRejectedValue(new HttpError(400, '/api/mcp/suggest'));
    const result = await propose({ exerciseId: OWN_EXERCISE_ID, translations: [{ languageCode: 'de', name: 'Neu' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Server rejected proposal: HTTP 400');
  });

  it('P166 get_suggestions lists an exercise_update proposal', async () => {
    const summary: SuggestionSummaryDtoResponse = {
      id: 'suggestion-eu-1',
      type: 'exercise_update',
      status: 'pending',
      createdAt: 1_700_000_000_000,
      targetLabel: 'exercise_update',
      rationale: 'adjust the exercise',
    };
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([summary]);
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetSuggestions(server, DUMMY_CFG);
    registerToolGetSuggestion(server, DUMMY_CFG);

    const list = await handlerOf(server, 'get_suggestions')({});
    expect(list.isError).toBeFalsy();
    expect(JSON.parse(list.content[0].text)).toStrictEqual([summary]);

    // get_suggestion names the exercise of an exercise_update next to its top-level exerciseId.
    const payload = JSON.stringify({ exerciseId: CATALOG_EXERCISE_ID_PULLUP, translations: [{ languageCode: 'de', name: 'Mein Klimmzug' }] });
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue({ ...MOCK_SUGGESTION, payload });
    const one = await handlerOf(server, 'get_suggestion')({ id: 'suggestion-eu-1' });
    expect(one.isError).toBeFalsy();
    const output = JSON.parse(one.content[0].text) as { type: string; payload: string; payloadResolved: Record<string, unknown> };
    expect(output.type).toBe('exercise_update');
    expect(output.payload).toBe(payload);
    expect(output.payloadResolved.exerciseId).toBe(CATALOG_EXERCISE_ID_PULLUP);
    expect(output.payloadResolved.exerciseName).toBe('Pull-Up');
  });
});
