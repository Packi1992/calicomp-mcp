/**
 * Tests for the `get_coach_parameters` / `set_coach_parameters` tools (Phase 137,
 * D-09/D-23, STATE-06) — the coach's self-description entry point and the SECOND
 * named exception to the propose-only boundary.
 *
 * Coverage mirrors the <behavior> block from 137-05-PLAN.md Task 3.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mock — hoisted before static imports by Vitest. Both fetchCoachParameters
// (used internally by loadCoachParameters, coach-parameters.ts) and
// putCoachParameters (used directly by set_coach_parameters.ts) live in the same
// module, so a single vi.mock covers both call sites.
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return {
    ...actual,
    fetchCoachParameters: vi.fn(),
    putCoachParameters: vi.fn(),
  };
});

import * as httpModule from '../../src/http.js';
import { HttpError } from '../../src/http.js';
import { getCoachParameters, registerToolGetCoachParameters } from '../../src/tools/get_coach_parameters.js';
import {
  setCoachParameters,
  registerToolSetCoachParameters,
  CoachParametersRejectedError,
} from '../../src/tools/set_coach_parameters.js';
import { COACH_PARAMETER_DEFAULTS } from '../../src/coach-parameters.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test_secret', keyB64: 'AAAA', serverUrl: 'https://example.test' };

beforeEach(() => {
  vi.mocked(httpModule.fetchCoachParameters).mockReset();
  vi.mocked(httpModule.putCoachParameters).mockReset();
});

// ---------------------------------------------------------------------------
// getCoachParameters
// ---------------------------------------------------------------------------

describe('getCoachParameters', () => {
  it('reports source: server, the merged values, and per-key default/range/description when the server has values set', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({
      params: { toleranceDays: 3 },
      updatedAt: 100,
    });
    const result = await getCoachParameters(DUMMY_CFG);
    expect(result.source).toBe('server');
    expect(result.params.toleranceDays.value).toBe(3);
    expect(result.params.adherenceWindowWeeks.value).toBe(COACH_PARAMETER_DEFAULTS.adherenceWindowWeeks);
    for (const key of Object.keys(COACH_PARAMETER_DEFAULTS) as (keyof typeof COACH_PARAMETER_DEFAULTS)[]) {
      expect(result.params[key].default).toBe(COACH_PARAMETER_DEFAULTS[key]);
      expect(typeof result.params[key].min).toBe('number');
      expect(typeof result.params[key].max).toBe('number');
      expect(result.params[key].description.length).toBeGreaterThan(0);
    }
  });

  it('reports the defaults and source: defaults for a 404-shaped (null) response — not an error', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue(null);
    const result = await getCoachParameters(DUMMY_CFG);
    expect(result.source).toBe('defaults');
    expect(result.params.toleranceDays.value).toBe(COACH_PARAMETER_DEFAULTS.toleranceDays);
  });

  it('reports the defaults and source: defaults on a network error, and says so explicitly', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockRejectedValue(new Error('network down'));
    const result = await getCoachParameters(DUMMY_CFG);
    expect(result.source).toBe('defaults');
  });
});

// ---------------------------------------------------------------------------
// setCoachParameters
// ---------------------------------------------------------------------------

describe('setCoachParameters', () => {
  it('calls putCoachParameters exactly once with exactly the given partial object and returns the new overall state', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });
    vi.mocked(httpModule.putCoachParameters).mockResolvedValue({
      params: { ...COACH_PARAMETER_DEFAULTS, toleranceDays: 3 },
      updatedAt: 200,
    });

    const result = await setCoachParameters({ toleranceDays: 3 }, DUMMY_CFG);

    expect(httpModule.putCoachParameters).toHaveBeenCalledTimes(1);
    expect(httpModule.putCoachParameters).toHaveBeenCalledWith(DUMMY_CFG, { toleranceDays: 3 });
    expect(result.params.toleranceDays.value).toBe(3);
  });

  it('rejects an out-of-range value BEFORE calling putCoachParameters', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });

    await expect(setCoachParameters({ toleranceDays: 99 }, DUMMY_CFG)).rejects.toThrow();
    expect(httpModule.putCoachParameters).not.toHaveBeenCalled();
  });

  it('rejects uncertainThreshold against the real current matchThreshold, without calling putCoachParameters', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({
      params: { matchThreshold: 0.5 },
      updatedAt: null,
    });

    await expect(setCoachParameters({ uncertainThreshold: 0.9 }, DUMMY_CFG)).rejects.toThrow();
    expect(httpModule.putCoachParameters).not.toHaveBeenCalled();
  });

  it('throws CoachParametersRejectedError when the server answers 400 (rejected)', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });
    vi.mocked(httpModule.putCoachParameters).mockResolvedValue('rejected');

    await expect(setCoachParameters({ toleranceDays: 3 }, DUMMY_CFG)).rejects.toThrow(
      CoachParametersRejectedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

interface RegisteredToolEntry {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;
}

function buildServer(): Record<string, RegisteredToolEntry> {
  const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
  registerToolGetCoachParameters(server, DUMMY_CFG);
  registerToolSetCoachParameters(server, DUMMY_CFG);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools as Record<string, RegisteredToolEntry>;
}

describe('registerToolGetCoachParameters', () => {
  it('is registered as read-only', () => {
    const tools = buildServer();
    expect(tools['get_coach_parameters']).toBeDefined();
    expect(tools['get_coach_parameters'].annotations?.readOnlyHint).toBe(true);
  });

  it('handler returns a structured result, never throwing, on success', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue(null);
    const tools = buildServer();
    const result = await tools['get_coach_parameters'].handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { source: string };
    expect(parsed.source).toBe('defaults');
  });
});

describe('registerToolSetCoachParameters', () => {
  it('is registered and carries no readOnlyHint: true annotation (it writes)', () => {
    const tools = buildServer();
    expect(tools['set_coach_parameters']).toBeDefined();
    expect(tools['set_coach_parameters'].annotations?.readOnlyHint).not.toBe(true);
  });

  it('returns a structured isError result for a 400 (rejected), whose text names neither the PAT nor CALICOMP_KEY', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });
    vi.mocked(httpModule.putCoachParameters).mockResolvedValue('rejected');
    const tools = buildServer();
    const result = await tools['set_coach_parameters'].handler({ toleranceDays: 3 });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain(DUMMY_CFG.pat);
    expect(text).not.toContain(DUMMY_CFG.keyB64);
  });

  it('returns a structured isError result for an out-of-range value, without calling putCoachParameters', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });
    const tools = buildServer();
    const result = await tools['set_coach_parameters'].handler({ toleranceDays: 99 });
    expect(result.isError).toBe(true);
    expect(httpModule.putCoachParameters).not.toHaveBeenCalled();
  });

  it('never leaks the PAT or key in an isError message on a server HttpError', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });
    vi.mocked(httpModule.putCoachParameters).mockRejectedValue(new HttpError(500, '/api/mcp/coach/parameters'));
    const tools = buildServer();
    const result = await tools['set_coach_parameters'].handler({ toleranceDays: 3 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0]?.text).not.toContain(DUMMY_CFG.keyB64);
  });

  it('returns a successful result for a valid write', async () => {
    vi.mocked(httpModule.fetchCoachParameters).mockResolvedValue({ params: {}, updatedAt: null });
    vi.mocked(httpModule.putCoachParameters).mockResolvedValue({
      params: { ...COACH_PARAMETER_DEFAULTS, toleranceDays: 3 },
      updatedAt: 200,
    });
    const tools = buildServer();
    const result = await tools['set_coach_parameters'].handler({ toleranceDays: 3 });
    expect(result.isError).toBeUndefined();
  });
});
