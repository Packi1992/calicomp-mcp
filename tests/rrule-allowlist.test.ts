/**
 * Tests for src/rrule-allowlist.ts — the MCP-side RRULE allowlist enforcement point
 * (protocol §3, PROP-08). Corpus-driven over `docs/coach-planning-vectors.json`'s
 * `rruleAllowlist` section (13 vectors, shared with `RRuleAllowlist.kt`'s Kotlin
 * enforcement point via `RRuleAllowlistTest.kt`) plus a handful of hand-written
 * boundary/order-of-checks assertions the corpus vectors don't individually isolate.
 *
 * The last describe block (136-02, T-136-06) proves `validateRRule` guards BOTH create
 * paths propose_planned_update.ts owns — `change_series_rule`'s `newRecurrenceRule`
 * AND `schedule_workout`'s optional `recurrenceRule` — driven through the real
 * registered tool handler, not merely through `validateRRule` in isolation, so a
 * future refactor that forgets to call it on the newer create path fails here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { validateRRule } from '../src/rrule-allowlist.js';
import { loadCoachPlanningVectors } from './shared-vectors.js';

// Module mocks — hoisted before static imports by Vitest.
vi.mock('../src/cache.js');
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    postSuggest: vi.fn(),
  };
});

import * as cacheModule from '../src/cache.js';
import * as httpModule from '../src/http.js';
import { registerToolProposePlannedUpdate } from '../src/tools/propose_planned_update.js';
import { mockSnapshot, TEMPLATE_ID_PUSH } from './fixture.js';
import type { UserProfileResponse } from '../src/types.js';

describe('validateRRule — shared corpus (rruleAllowlist)', () => {
  const corpus = loadCoachPlanningVectors();

  it('the rruleAllowlist section is not empty', () => {
    expect(corpus.rruleAllowlist.length).toBeGreaterThan(0);
  });

  it('every corpus vector reproduces its own expected reasonCode', () => {
    // Mirrors RRuleAllowlistTest.kt's own assertion scope exactly: `reason` (the
    // reasonCode) is the shared contract both enforcement points key on (protocol
    // §3). `replacement` is per-vector descriptive text, not asserted for equality
    // by the Kotlin side either — some corpus vectors phrase it differently from
    // RRuleAllowlist.kt's own generic REPLACEMENTS map for the same reasonCode
    // (e.g. the WKST vector), so asserting it here would fail against the very
    // source of truth this test replays.
    for (const vector of corpus.rruleAllowlist) {
      const result = validateRRule(vector.rrule);
      if (vector.accepted) {
        expect(result, `vector '${vector.rrule}' expected valid:true`).toStrictEqual({ valid: true });
      } else {
        expect(result.valid, `vector '${vector.rrule}' expected valid:false`).toBe(false);
        if (!result.valid) {
          expect(result.reasonCode, `vector '${vector.rrule}' reasonCode mismatch`).toBe(vector.reason);
        }
      }
    }
  });
});

describe('validateRRule — boundary and check-order assertions', () => {
  it('null and blank rules are always valid (standalone root)', () => {
    expect(validateRRule(null)).toStrictEqual({ valid: true });
    expect(validateRRule(undefined)).toStrictEqual({ valid: true });
    expect(validateRRule('')).toStrictEqual({ valid: true });
    expect(validateRRule('   ')).toStrictEqual({ valid: true });
  });

  it('BYMONTHDAY=31 is accepted; BYMONTHDAY=32 and BYMONTHDAY=0 are both rejected BYMONTHDAY_OUT_OF_RANGE', () => {
    expect(validateRRule('FREQ=MONTHLY;BYMONTHDAY=31')).toStrictEqual({ valid: true });
    const above = validateRRule('FREQ=MONTHLY;BYMONTHDAY=32');
    expect(above.valid).toBe(false);
    if (!above.valid) expect(above.reasonCode).toBe('BYMONTHDAY_OUT_OF_RANGE');
    const below = validateRRule('FREQ=MONTHLY;BYMONTHDAY=0');
    expect(below.valid).toBe(false);
    if (!below.valid) expect(below.reasonCode).toBe('BYMONTHDAY_OUT_OF_RANGE');
  });

  it('INTERVAL=0 and a negative INTERVAL both reject INTERVAL_MUST_BE_POSITIVE', () => {
    const zero = validateRRule('FREQ=WEEKLY;INTERVAL=0;BYDAY=MO');
    expect(zero.valid).toBe(false);
    if (!zero.valid) expect(zero.reasonCode).toBe('INTERVAL_MUST_BE_POSITIVE');
    const negative = validateRRule('FREQ=DAILY;INTERVAL=-1');
    expect(negative.valid).toBe(false);
    if (!negative.valid) expect(negative.reasonCode).toBe('INTERVAL_MUST_BE_POSITIVE');
  });

  it('a rule carrying both COUNT and BYSETPOS reports COUNT_NOT_SUPPORTED, proving check order', () => {
    const result = validateRRule('FREQ=WEEKLY;COUNT=3;BYSETPOS=1;BYDAY=MO');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reasonCode).toBe('COUNT_NOT_SUPPORTED');
  });

  it('WKST=MO rejects UNKNOWN_TOKEN — the week start is fixed, not configurable', () => {
    const result = validateRRule('FREQ=WEEKLY;WKST=MO;BYDAY=MO');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reasonCode).toBe('UNKNOWN_TOKEN');
  });

  it('a valid UNTIL=YYYYMMDD is accepted; a non-existent calendar date rejects UNKNOWN_TOKEN', () => {
    expect(validateRRule('FREQ=DAILY;UNTIL=20261231')).toStrictEqual({ valid: true });
    const result = validateRRule('FREQ=DAILY;UNTIL=20260231'); // Feb 31 does not exist
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reasonCode).toBe('UNKNOWN_TOKEN');
  });
});

describe('validateRRule — schedule_workout create path is guarded too (136-02, T-136-06)', () => {
  const mockProfile: UserProfileResponse = {
    userId: 'user-test-1',
    email: 'test@example.com',
    displayName: 'Test User',
    avatarUrl: 'https://example.com/avatar.svg',
    isPremium: false,
    createdAt: 1_700_000_000_000,
  };

  function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (server as any)._registeredTools['propose_planned_update'].handler;
  }

  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('a schedule_workout carrying FREQ=YEARLY is rejected via the SAME allowlist change_series_rule uses, not only inspected by it', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      snapshot: { ...mockSnapshot, plannedWorkouts: [] },
      catalog: [],
      profile: mockProfile,
      fetchedAt: Date.now(),
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlannedUpdate(server, { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' });
    const handler = getHandler(server);

    const result = await handler({
      intent: 'schedule_workout',
      templateId: TEMPLATE_ID_PUSH,
      date: '2026-07-01',
      recurrenceRule: 'FREQ=YEARLY',
      rationale: 'test',
    });

    const direct = validateRRule('FREQ=YEARLY');
    expect(direct.valid).toBe(false);
    if (!direct.valid) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(direct.reasonCode);
      // The reason code the tool surfaces is the SAME allowlist result — not a
      // second, independently-worded rejection.
      expect(direct.reasonCode).toBe('YEARLY_NOT_SUPPORTED');
    }
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});
