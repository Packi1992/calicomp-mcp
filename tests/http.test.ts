/**
 * Tests for the three Phase 136 coach-suggestion HTTP helpers in src/http.ts
 * (`fetchSuggestions`, `fetchSuggestion`, `postWithdraw` — PROP-10/PROP-11).
 *
 * Coverage mirrors the <behavior> block from 136-05-PLAN.md Task 1:
 *   - fetchSuggestions builds the query string from an optional status and an
 *     optional limit, omitting an absent parameter entirely.
 *   - fetchSuggestions returns an empty array unchanged for a 200 `[]`.
 *   - fetchSuggestion returns null for a 404 rather than throwing.
 *   - postWithdraw sends no request body and treats 200 as success.
 *   - postWithdraw maps a 404 to a distinguishable not-withdrawable outcome.
 *   - every helper attaches the PAT via the Authorization header, and no helper
 *     places the token or the encryption key into a thrown message.
 *   - every helper targets a path beginning `/api/mcp/coach/suggestions` — never
 *     the unprefixed, JWT-only `/api/mcp/suggestions` (D-17).
 *
 * global.fetch is stubbed per test — this repo has no existing fetch-mocking
 * helper (all other tool tests mock the whole http.js module instead), so this
 * file establishes the stub inline rather than inventing shared test infra this
 * plan's files_modified list does not include.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchSuggestions,
  fetchSuggestion,
  postWithdraw,
  fetchCoachParameters,
  putCoachParameters,
  HttpError,
} from '../src/http.js';

const CFG = { pat: 'calicomp_pat_test_secret', serverUrl: 'https://example.test' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe('fetchSuggestions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits both query params entirely when status and limit are both absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await fetchSuggestions(CFG);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/suggestions');
  });

  it('includes only status when limit is absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await fetchSuggestions(CFG, 'pending');
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/suggestions?status=pending');
  });

  it('includes only limit when status is absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await fetchSuggestions(CFG, undefined, 50);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/suggestions?limit=50');
  });

  it('includes both status and limit when both are present', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await fetchSuggestions(CFG, 'withdrawn', 10);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('status=withdrawn');
    expect(calledUrl).toContain('limit=10');
  });

  it('returns an empty array unchanged for a 200 []', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    const result = await fetchSuggestions(CFG);
    expect(result).toEqual([]);
  });

  it('returns the rows verbatim for a 200 with data', async () => {
    const rows = [
      { id: 's1', type: 'planned_update', status: 'pending', createdAt: 1, targetLabel: 'Push A', rationale: 'r' },
    ];
    fetchMock.mockResolvedValue(jsonResponse(200, rows));
    const result = await fetchSuggestions(CFG);
    expect(result).toEqual(rows);
  });

  it('targets a path beginning /api/mcp/coach/suggestions, never the unprefixed JWT path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await fetchSuggestions(CFG, 'pending', 10);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl.startsWith('https://example.test/api/mcp/coach/suggestions')).toBe(true);
    expect(calledUrl).not.toBe('https://example.test/api/mcp/suggestions');
  });

  it('attaches the PAT as a Bearer Authorization header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await fetchSuggestions(CFG);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CFG.pat}`);
  });

  it('throws HttpError on non-2xx without leaking the PAT in the message', async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    await expect(fetchSuggestions(CFG)).rejects.toThrow(HttpError);
    try {
      await fetchSuggestions(CFG);
    } catch (err) {
      expect((err as Error).message).not.toContain(CFG.pat);
    }
  });
});

describe('fetchSuggestion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the full row for a 200', async () => {
    const row = {
      id: 's1',
      type: 'planned_update',
      payload: '{}',
      rationale: 'r',
      sourceLlm: 'unknown',
      status: 'accepted_modified',
      createdAt: 1,
      expiresAt: 2,
      planHash: null,
      appliedPayload: '{"applied":true}',
      seriesHash: 'a'.repeat(64),
    };
    fetchMock.mockResolvedValue(jsonResponse(200, row));
    const result = await fetchSuggestion(CFG, 's1');
    expect(result).toEqual(row);
  });

  it('returns null for a 404 rather than throwing', async () => {
    fetchMock.mockResolvedValue(emptyResponse(404));
    const result = await fetchSuggestion(CFG, 'unknown-id');
    expect(result).toBeNull();
  });

  it('targets /api/mcp/coach/suggestions/{id}', async () => {
    fetchMock.mockResolvedValue(emptyResponse(404));
    await fetchSuggestion(CFG, 'abc-123');
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/suggestions/abc-123');
  });

  it('throws HttpError on a non-404 non-2xx without leaking the PAT', async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    await expect(fetchSuggestion(CFG, 's1')).rejects.toThrow(HttpError);
    try {
      await fetchSuggestion(CFG, 's1');
    } catch (err) {
      expect((err as Error).message).not.toContain(CFG.pat);
    }
  });
});

describe('postWithdraw', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a POST with no request body', async () => {
    fetchMock.mockResolvedValue(emptyResponse(200));
    await postWithdraw(CFG, 's1');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('treats 200 as success ("withdrawn")', async () => {
    fetchMock.mockResolvedValue(emptyResponse(200));
    const result = await postWithdraw(CFG, 's1');
    expect(result).toBe('withdrawn');
  });

  it('maps a 404 to the distinguishable not-withdrawable outcome, not a throw', async () => {
    fetchMock.mockResolvedValue(emptyResponse(404));
    const result = await postWithdraw(CFG, 's1');
    expect(result).toBe('not-withdrawable');
  });

  it('targets /api/mcp/coach/suggestions/{id}/withdraw', async () => {
    fetchMock.mockResolvedValue(emptyResponse(200));
    await postWithdraw(CFG, 'abc-123');
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/suggestions/abc-123/withdraw');
  });

  it('attaches the PAT as a Bearer Authorization header', async () => {
    fetchMock.mockResolvedValue(emptyResponse(200));
    await postWithdraw(CFG, 's1');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CFG.pat}`);
  });

  it('throws HttpError on a non-404 non-2xx without leaking the PAT', async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    await expect(postWithdraw(CFG, 's1')).rejects.toThrow(HttpError);
    try {
      await postWithdraw(CFG, 's1');
    } catch (err) {
      expect((err as Error).message).not.toContain(CFG.pat);
    }
  });
});

describe('fetchCoachParameters', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a GET with a Bearer Authorization header and an AbortSignal', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { params: {}, updatedAt: null }));
    await fetchCoachParameters(CFG);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/parameters');
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CFG.pat}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes a 200 response through as { params, updatedAt }', async () => {
    const body = { params: { toleranceDays: 3 }, updatedAt: 42 };
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const result = await fetchCoachParameters(CFG);
    expect(result).toEqual(body);
  });

  it('returns null for a 404 rather than throwing', async () => {
    fetchMock.mockResolvedValue(emptyResponse(404));
    const result = await fetchCoachParameters(CFG);
    expect(result).toBeNull();
  });

  it('throws HttpError on a 500 without leaking the PAT or key in the message', async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    await expect(fetchCoachParameters(CFG)).rejects.toThrow(HttpError);
    try {
      await fetchCoachParameters(CFG);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(CFG.pat);
      expect(message).toContain('500');
      expect(message).toContain('/api/mcp/coach/parameters');
    }
  });
});

describe('putCoachParameters', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a PUT with Content-Type: application/json and a body carrying only `params`', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { params: { toleranceDays: 3 }, updatedAt: 1 }));
    await putCoachParameters(CFG, { toleranceDays: 3 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const parsedBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(parsedBody)).toEqual(['params']);
    expect(parsedBody.params).toEqual({ toleranceDays: 3 });
  });

  it('targets /api/mcp/coach/parameters', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { params: {}, updatedAt: null }));
    await putCoachParameters(CFG, {});
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://example.test/api/mcp/coach/parameters');
  });

  it('returns "rejected" for a 400 instead of throwing', async () => {
    fetchMock.mockResolvedValue(emptyResponse(400));
    const result = await putCoachParameters(CFG, { toleranceDays: 99 });
    expect(result).toBe('rejected');
  });

  it('throws HttpError with status 401 for an unauthorized request', async () => {
    fetchMock.mockResolvedValue(emptyResponse(401));
    await expect(putCoachParameters(CFG, { toleranceDays: 3 })).rejects.toThrow(HttpError);
    try {
      await putCoachParameters(CFG, { toleranceDays: 3 });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
    }
  });

  it('never leaks the PAT in a thrown error message', async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    try {
      await putCoachParameters(CFG, { toleranceDays: 3 });
    } catch (err) {
      expect((err as Error).message).not.toContain(CFG.pat);
    }
  });
});
