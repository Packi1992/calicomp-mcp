/**
 * Replays every `plannedUpdate` corpus vector (docs/coach-planning-vectors.json,
 * Phase 136-01/136-02) through the real PRODUCER — `proposePlannedUpdate` — not
 * merely through the loader. Feeds the vector's `beforeRoots` as the decrypted
 * snapshot, calls `proposePlannedUpdate` with the vector's `intent` arguments, and
 * asserts the emitted envelope deep-equals `expectedEnvelope` and that the emitted
 * `body.seriesHash` — `computeSeriesHash` over the STORED before-state roots the
 * producer resolves via `resolveBeforeStateRoots` (protocol §4 "Which State Is
 * Fingerprinted"), never the after-state the envelope proposes — equals
 * `expectedSeriesHash`. This is the assertion worth having: it pins the MIRROR the app
 * will later compare its own recomputation against, not merely that two functions agree
 * when fed identical input.
 * `postSuggest` is driven through the same stub `tests/tools/propose_planned_update.test.ts`
 * already uses, so no network call is ever made. `fetchSuggestion` is stubbed the same
 * way (Phase 136-08, D-04) — a chained `schedule_workout` vector's `chainSuggestionId`
 * resolves against a generic pending-`new_plan` stub response for whatever id it names,
 * so every chained vector replays end-to-end without ever reaching a real fetch; the
 * chain-resolution rejection paths themselves (foreign/wrong-type/not-pending) are
 * covered by `tests/tools/propose_planned_update.test.ts`, not here.
 *
 * A vector's `create`-operation root(s) carry a coach-generated UUID
 * (`crypto.randomUUID()` inside the after-state builders) — genuinely random at
 * runtime, so the corpus pins fixed ids instead for vector stability (see
 * `_provenance.regeneration.plannedUpdate`). `node:crypto`'s `randomUUID` is mocked
 * with one queued return value PER `create` operation the vector's `expectedEnvelope`
 * carries, IN ARRAY ORDER — a `this_and_following` group split can emit more than one
 * `create` (one per split group member), so a single fixed return value is not enough
 * once 136-02's split/group vectors land. The full emitted envelope — every id
 * included — can therefore be compared byte-for-byte against `expectedEnvelope`, and
 * the emitted `seriesHash` against the corpus's own pinned `expectedSeriesHash`, not
 * merely against an independent recomputation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module mocks — hoisted before static imports by Vitest.
vi.mock('../src/cache.js');
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    postSuggest: vi.fn(),
    fetchSuggestion: vi.fn(),
  };
});
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

import { randomUUID } from 'node:crypto';
import * as cacheModule from '../src/cache.js';
import * as httpModule from '../src/http.js';
import { proposePlannedUpdate, type ProposePlannedUpdateArgs } from '../src/tools/propose_planned_update.js';
import { loadCoachPlanningVectors } from './shared-vectors.js';
import { mockSnapshot } from './fixture.js';
import type { DecryptedPlannedWorkout, SuggestionDtoResponse, UserProfileResponse } from '../src/types.js';

const mockProfile: UserProfileResponse = {
  userId: 'user-test-1',
  email: 'test@example.com',
  displayName: 'Test User',
  avatarUrl: 'https://example.com/avatar.svg',
  isPremium: false,
  createdAt: 1_700_000_000_000,
};

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

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test', sourceLlm: 'test/1' };

/**
 * `schedule_workout` validates `templateId` against `data.snapshot.templates`
 * (proposePlannedUpdate's TEMPLATE_NOT_FOUND check) — every corpus `plannedUpdate`
 * vector's `beforeRoots` convention uses `22222222-2222-4222-8222-222222222222` as
 * its `templateId`, so that id must resolve here too, alongside `mockSnapshot`'s own
 * templates (which existing move_occurrence/cancel_occurrence vectors never consult).
 */
const CORPUS_TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';

describe('shared plannedUpdate corpus — MCP producer replay (Phase 136-01/136-02)', () => {
  const corpus = loadCoachPlanningVectors();

  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);
    vi.mocked(randomUUID).mockReset();
    // Phase 136-08 (D-04): a chained `schedule_workout` vector's `chainSuggestionId`
    // resolves to a generic pending `new_plan`, for whatever id it names — the shape
    // this arm proves is "does the chain reference reach the envelope end to end",
    // not the chain-resolution rejection paths (covered elsewhere, see file header).
    vi.mocked(httpModule.fetchSuggestion).mockReset();
    vi.mocked(httpModule.fetchSuggestion).mockImplementation(async (_cfg, id) => ({
      id,
      type: 'new_plan',
      payload: '{}',
      rationale: 'a brand-new plan the coach also just proposed',
      sourceLlm: 'unknown',
      status: 'pending',
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_100_000_000,
      planHash: null,
    }));
  });

  it('the plannedUpdate section is not empty', () => {
    expect(corpus.plannedUpdate.length).toBeGreaterThanOrEqual(3);
  });

  it('every vector replays through proposePlannedUpdate to the pinned envelope and seriesHash', async () => {
    for (const vector of corpus.plannedUpdate) {
      vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
        snapshot: {
          ...mockSnapshot,
          templates: [
            ...mockSnapshot.templates,
            {
              id: CORPUS_TEMPLATE_ID,
              name: 'Corpus Template',
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
              isFavoriteForWatch: false,
            },
          ],
          plannedWorkouts: vector.beforeRoots as DecryptedPlannedWorkout[],
        },
        catalog: [],
        profile: mockProfile,
        fetchedAt: Date.now(),
      });
      vi.mocked(httpModule.postSuggest).mockClear();
      vi.mocked(randomUUID).mockReset();

      // Named-arm dispatch (not `as ProposePlannedUpdateArgs`): a vector carrying an
      // `intent` this test has no arm for MUST fail by name, not be silently skipped —
      // so a later plan's corpus vector for a not-yet-implemented intent cannot pass
      // this replay by accident. `intentKind` is hoisted into a local binding — TS
      // does not narrow a chained member expression (`vector.intent.intent`) to
      // `never` in a switch's default arm, only a plain identifier.
      const intentKind = vector.intent.intent;
      switch (intentKind) {
        case 'move_occurrence':
        case 'cancel_occurrence':
        case 'schedule_workout':
        case 'change_series_rule':
          break;
        default: {
          const unhandled: never = intentKind;
          throw new Error(`plannedUpdate vector '${vector.name}' carries unhandled intent: ${String(unhandled)}`);
        }
      }

      // Feed the pinned create-root id(s), in array order, to the mocked randomUUID —
      // one queued return value per `create` operation the vector's expected envelope
      // carries (a this_and_following group split can create more than one root).
      const pinnedCreateIds = vector.expectedEnvelope.roots
        .filter((op) => op.operation === 'create')
        .map((op) => op.root.id);
      for (const id of pinnedCreateIds) {
        vi.mocked(randomUUID).mockImplementationOnce(() => id as ReturnType<typeof randomUUID>);
      }

      await proposePlannedUpdate(vector.intent as ProposePlannedUpdateArgs, DUMMY_CFG);

      expect(httpModule.postSuggest, `vector '${vector.name}'`).toHaveBeenCalledTimes(1);
      const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
      const emittedEnvelope = JSON.parse(body.payload) as typeof vector.expectedEnvelope;

      expect(emittedEnvelope, `vector '${vector.name}' envelope`).toStrictEqual(vector.expectedEnvelope);
      expect(body.seriesHash, `vector '${vector.name}' seriesHash`).toBe(vector.expectedSeriesHash);
    }
  });
});
