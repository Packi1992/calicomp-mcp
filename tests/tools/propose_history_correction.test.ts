/**
 * Tests for the `propose_history_correction` WRITE tool (Phase 168, plan 168-05, PERM-05, D-02, D-27, D-28,
 * protocol 1.56 §2.8 "History Correction Proposals").
 *
 * The args go through the real ProposeHistoryCorrectionSchema first (the SDK does the same before it calls the
 * handler), then through the registered handler with a mocked snapshot and a mocked `postSuggest`. The snapshot
 * holds the session and sets of the corpus vector `historyCorrection.cipher[0]` plus a deleted set, a session of
 * another workout and a running session, so every refusal of §2.8 "Scope" has a target. Covered:
 *   - a correction is sent as type `history_correction`; outside the ciphertext stand only `v`, `sessionId` and
 *     `encryptedPayload` (plan threat T-168-19);
 *   - the inner payload names every live set of the session in `seenSets` (the stale guard);
 *   - foreign, deleted, unknown and running targets are refused before any request (T-168-22);
 *   - the payload of the corpus vectors is built byte for byte with their IV (crypto parity, T-168-20);
 *   - the corpus parse vectors: what the tool can see, it refuses like the app.
 * Nothing here applies anything: the only network write is the mocked POST /api/mcp/suggest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../../src/cache.js');
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return { ...actual, postSuggest: vi.fn() };
});

import * as cacheModule from '../../src/cache.js';
import * as httpModule from '../../src/http.js';
import { HttpError } from '../../src/http.js';
import { decrypt } from '../../src/crypto.js';
import { computeChangeHash } from '../../src/hash.js';
import { ProposeHistoryCorrectionSchema } from '../../src/schemas.js';
import {
  buildHistoryCorrectionPayload,
  registerToolProposeHistoryCorrection,
  validateHistoryCorrection,
  type ProposeHistoryCorrectionArgs,
} from '../../src/tools/propose_history_correction.js';
import { mockSnapshot, mockCatalog } from '../fixture.js';
import { historyCorrectionSection } from '../shared-vectors.js';
import type { DecryptedSession, DecryptedSetLog, DecryptedSnapshot, SuggestionDtoResponse } from '../../src/types.js';

const CORPUS = historyCorrectionSection();
const KEY_B64 = CORPUS.cipher[0].keyB64;
const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: KEY_B64, serverUrl: 'https://example.test' };

const SESSION_ID = '16801000-0000-4000-8000-000000000001';
const SET_A = '16801000-0000-4000-8000-000000000011';
const SET_B = '16801000-0000-4000-8000-000000000012';
const SET_C = '16801000-0000-4000-8000-000000000013';
const SET_DELETED = '16801000-0000-4000-8000-000000000014';
const OTHER_SESSION_ID = '16801000-0000-4000-8000-000000000002';
const SET_OTHER = '16801000-0000-4000-8000-000000000021';
const RUNNING_SESSION_ID = '16801000-0000-4000-8000-000000000003';
const SET_RUNNING = '16801000-0000-4000-8000-000000000031';
const UNKNOWN_SET = '16801000-0000-4000-8000-000000000099';

function session(id: string, ended: boolean): DecryptedSession {
  return {
    id,
    startTime: 1_779_999_000_000,
    ...(ended ? { endTime: 1_780_000_200_000 } : {}),
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: 1_779_999_000_000,
    updatedAt: 1_780_000_200_000,
  };
}

function setLog(id: string, sessionId: string, updatedAt: number, deleted = false): DecryptedSetLog {
  return {
    id,
    sessionId,
    exerciseId: mockCatalog[0].id,
    exerciseSource: 'CATALOG',
    completedReps: 10,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: updatedAt,
    measuredTimeSeconds: null,
    createdAt: updatedAt,
    updatedAt,
    ...(deleted ? { deletedAt: updatedAt + 1 } : {}),
  };
}

/** The corpus session (sets A, B, C with the corpus `updatedAt`) plus a deleted set, another and a running session. */
const SNAPSHOT: DecryptedSnapshot = {
  ...mockSnapshot,
  sessions: [session(SESSION_ID, true), session(OTHER_SESSION_ID, true), session(RUNNING_SESSION_ID, false)],
  setLogs: [
    setLog(SET_A, SESSION_ID, 1_780_000_000_000),
    setLog(SET_B, SESSION_ID, 1_780_000_060_000),
    setLog(SET_DELETED, SESSION_ID, 1_780_000_090_000, true),
    setLog(SET_C, SESSION_ID, 1_780_000_120_000),
    setLog(SET_OTHER, OTHER_SESSION_ID, 1_780_000_000_000),
    setLog(SET_RUNNING, RUNNING_SESSION_ID, 1_780_000_000_000),
  ],
};

const MOCK_CACHE = {
  snapshot: SNAPSHOT,
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

const MOCK_SUGGESTION: SuggestionDtoResponse = {
  id: 'suggestion-hc-1',
  type: 'history_correction',
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
  registerToolProposeHistoryCorrection(server, DUMMY_CFG);
  return handlerOf(server, 'propose_history_correction')(
    ProposeHistoryCorrectionSchema.parse({ rationale: 'the athlete counted twelve', sessionId: SESSION_ID, ...input }),
  );
}

/** The single request the tool sent: its body and the outer payload parsed. */
function sentRequest() {
  expect(vi.mocked(httpModule.postSuggest)).toHaveBeenCalledTimes(1);
  const body = vi.mocked(httpModule.postSuggest).mock.calls[0][0];
  return { body, outer: JSON.parse(body.payload) as Record<string, unknown> };
}

function innerOf(outer: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(decrypt(outer.encryptedPayload as string, KEY_B64)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(cacheModule.getSnapshot).mockReset();
  vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
  vi.mocked(httpModule.postSuggest).mockReset();
  vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);
});

describe('propose_history_correction', () => {
  it('a value change is sent as history_correction with only sessionId in plaintext', async () => {
    const result = await propose({ changes: [{ op: 'update', setId: SET_A, reps: 12, weight: 7.5 }] });

    expect(result.isError).toBeUndefined();
    const { body, outer } = sentRequest();
    expect(body.type).toBe('history_correction');
    expect(body.rationale).toBe('the athlete counted twelve');
    expect(Object.keys(outer)).toStrictEqual(['v', 'sessionId', 'encryptedPayload']);
    expect(outer.v).toBe(1);
    expect(outer.sessionId).toBe(SESSION_ID);
    for (const plain of [SET_A, SET_B, SET_C, 'reps', 'weight', 'seenSets', 'changes', '7.5', '"12"']) {
      expect(body.payload, `"${plain}" must not stand outside the ciphertext`).not.toContain(plain);
    }
    expect(body.changeHash).toBe(computeChangeHash('history_correction', outer));
    expect(body.planHash).toBeUndefined();
  });

  it('the inner payload lists every live set of the session in seenSets', async () => {
    await propose({ changes: [{ op: 'remove', setId: SET_C }] });

    const inner = innerOf(sentRequest().outer);
    expect(inner).toStrictEqual({
      v: 1,
      sessionId: SESSION_ID,
      seenSets: [
        { id: SET_A, updatedAt: 1_780_000_000_000 },
        { id: SET_B, updatedAt: 1_780_000_060_000 },
        { id: SET_C, updatedAt: 1_780_000_120_000 },
      ],
      changes: [{ op: 'remove', setId: SET_C }],
    });
  });

  it('an added set needs a live afterSetId of the same session', async () => {
    const added = await propose({ changes: [{ op: 'add', afterSetId: SET_B, reps: 8, timeSec: 30 }] });
    expect(added.isError).toBeUndefined();
    expect(innerOf(sentRequest().outer).changes).toStrictEqual([{ op: 'add', afterSetId: SET_B, reps: 8, timeSec: 30 }]);

    vi.mocked(httpModule.postSuggest).mockClear();
    for (const afterSetId of [SET_DELETED, SET_OTHER, UNKNOWN_SET]) {
      const refused = await propose({ changes: [{ op: 'add', afterSetId, reps: 8 }] });
      expect(refused.isError, `afterSetId ${afterSetId}`).toBe(true);
      expect(refused.content[0].text).toContain('changes[0].afterSetId');
    }
    expect(vi.mocked(httpModule.postSuggest)).not.toHaveBeenCalled();
  });

  it('a set id of another session is rejected without a request', async () => {
    const result = await propose({ changes: [{ op: 'update', setId: SET_OTHER, reps: 3 }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SET_NOT_IN_SESSION');
    expect(result.content[0].text).toContain('changes[0].setId');
    expect(vi.mocked(httpModule.postSuggest)).not.toHaveBeenCalled();
  });

  it('a session that has not ended is rejected without a request', async () => {
    const result = await propose({
      sessionId: RUNNING_SESSION_ID,
      changes: [{ op: 'update', setId: SET_RUNNING, reps: 3 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SESSION_NOT_FINISHED');
    expect(vi.mocked(httpModule.postSuggest)).not.toHaveBeenCalled();
  });

  it('a deleted set is rejected without a request', async () => {
    const result = await propose({ changes: [{ op: 'remove', setId: SET_DELETED }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SET_NOT_IN_SESSION');
    expect(vi.mocked(httpModule.postSuggest)).not.toHaveBeenCalled();
  });

  it('a deleted or unknown session is rejected without a request', async () => {
    const deletedSession = { ...session(SESSION_ID, true), deletedAt: 1_780_000_300_000 };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...MOCK_CACHE,
      snapshot: { ...SNAPSHOT, sessions: [deletedSession] },
    });
    const deleted = await propose({ changes: [{ op: 'update', setId: SET_A, reps: 3 }] });
    const unknown = await propose({
      sessionId: '16801000-0000-4000-8000-000000000098',
      changes: [{ op: 'update', setId: SET_A, reps: 3 }],
    });

    for (const result of [deleted, unknown]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('SESSION_NOT_FOUND');
    }
    expect(vi.mocked(httpModule.postSuggest)).not.toHaveBeenCalled();
  });

  it('the same set twice is rejected without a request', async () => {
    const result = await propose({
      changes: [
        { op: 'update', setId: SET_B, reps: 3 },
        { op: 'add', afterSetId: SET_B, reps: 4 },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DUPLICATE_SET');
    expect(result.content[0].text).toContain('changes[1].afterSetId');
    expect(vi.mocked(httpModule.postSuggest)).not.toHaveBeenCalled();
  });

  it('an empty change list is rejected by the schema', () => {
    const parsed = ProposeHistoryCorrectionSchema.safeParse({ sessionId: SESSION_ID, rationale: 'x', changes: [] });
    expect(parsed.success).toBe(false);
  });

  it('a server error answers HTTP status only', async () => {
    vi.mocked(httpModule.postSuggest).mockRejectedValue(new HttpError(500, 'internal detail that must not leak'));

    const result = await propose({ changes: [{ op: 'update', setId: SET_A, reps: 12 }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Server rejected proposal: HTTP 500');
  });

  it('the payload of the corpus vectors is built byte for byte with their iv', () => {
    for (const vector of CORPUS.cipher) {
      const inner = JSON.parse(vector.innerPlaintext) as { sessionId: string; changes: ProposeHistoryCorrectionArgs['changes'] };
      const iv = Buffer.from(
        (JSON.parse((JSON.parse(vector.outerPayload) as { encryptedPayload: string }).encryptedPayload) as { iv: string }).iv,
        'base64',
      );
      const args: ProposeHistoryCorrectionArgs = { sessionId: inner.sessionId, changes: inner.changes, rationale: 'x' };
      expect(validateHistoryCorrection(args, SNAPSHOT), vector.name).toBeUndefined();
      expect(JSON.stringify(buildHistoryCorrectionPayload(args, SNAPSHOT, vector.keyB64, iv)), vector.name).toBe(
        vector.outerPayload,
      );
    }
  });

  it('the corpus parse vectors are refused or accepted like the app as far as the tool can see them', () => {
    /** Reasons the tool cannot produce: it writes `v` and both session ids itself. */
    const NOT_THE_TOOLS = new Set(['bad_version', 'session_mismatch']);
    /** Reasons the tool decides against the snapshot, after the schema. */
    const AGAINST_SNAPSHOT = new Set(['duplicate_set', 'unknown_set']);
    let measured = 0;
    for (const vector of CORPUS.parse) {
      if (vector.reason !== undefined && NOT_THE_TOOLS.has(vector.reason)) continue;
      const { v: _v, seenSets, sessionId, changes, ...extra } = vector.inner as Record<string, unknown>;
      const seen = seenSets as { id: string; updatedAt: number }[];
      const snapshot: DecryptedSnapshot = {
        ...mockSnapshot,
        sessions: [session(sessionId as string, true)],
        setLogs: seen.map((s) => setLog(s.id, sessionId as string, s.updatedAt)),
      };
      const parsed = ProposeHistoryCorrectionSchema.safeParse({ sessionId, changes, rationale: 'x', ...extra });
      measured += 1;
      if (vector.expect === 'ok') {
        expect(parsed.success, vector.name).toBe(true);
        expect(validateHistoryCorrection(parsed.data as ProposeHistoryCorrectionArgs, snapshot), vector.name).toBeUndefined();
      } else if (vector.reason !== undefined && AGAINST_SNAPSHOT.has(vector.reason)) {
        expect(parsed.success, vector.name).toBe(true);
        expect(validateHistoryCorrection(parsed.data as ProposeHistoryCorrectionArgs, snapshot), vector.name).toBeDefined();
      } else {
        expect(parsed.success, vector.name).toBe(false);
      }
    }
    expect(measured).toBeGreaterThanOrEqual(10);
  });
});
