/**
 * Tests for the `withdraw_suggestion` WRITE tool (Phase 136, D-08, PROP-11) — the
 * single named exception to propose-only.
 *
 * Coverage mirrors the <behavior> block from 136-05-PLAN.md Task 3:
 *   - withdraw of an own pending proposal succeeds and reports the new status.
 *   - withdraw of an already-withdrawn own proposal succeeds as an idempotent no-op.
 *   - withdraw of an unknown id, a foreign id, or an already-decided own row
 *     returns a structured error stating the proposal is not withdrawable, with
 *     wording that does not distinguish the three cases — asserted byte-identical.
 *   - no response and no error text implies a row was deleted.
 *   - no error text contains the PAT or the encryption key.
 *   - the tool is registered, is NOT annotated readOnlyHint, and its description
 *     does not use deletion vocabulary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mock — hoisted before static imports by Vitest.
vi.mock('../../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/http.js')>('../../src/http.js');
  return {
    ...actual,
    postWithdraw: vi.fn(),
  };
});

import * as httpModule from '../../src/http.js';
import { HttpError } from '../../src/http.js';
import {
  withdrawSuggestion,
  registerToolWithdrawSuggestion,
  SuggestionNotWithdrawableError,
} from '../../src/tools/withdraw_suggestion.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test_secret', keyB64: 'AAAA', serverUrl: 'https://example.test' };

beforeEach(() => {
  vi.mocked(httpModule.postWithdraw).mockReset();
});

// ---------------------------------------------------------------------------
// withdrawSuggestion — the producer
// ---------------------------------------------------------------------------

describe('withdrawSuggestion', () => {
  it('succeeds and reports the new status for an own pending proposal', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('withdrawn');
    const result = await withdrawSuggestion({ id: 'suggestion-1' }, DUMMY_CFG);
    expect(result).toEqual({ id: 'suggestion-1', status: 'withdrawn' });
  });

  it('succeeds as an idempotent no-op for an already-withdrawn own proposal', async () => {
    // postWithdraw's own contract folds a repeat call against an already-withdrawn
    // row into the same 'withdrawn' outcome as a fresh transition (server-side
    // idempotent 200) — nothing here distinguishes the two.
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('withdrawn');
    const result = await withdrawSuggestion({ id: 'suggestion-1' }, DUMMY_CFG);
    expect(result.status).toBe('withdrawn');
  });

  it('throws SuggestionNotWithdrawableError for an unknown id', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');
    await expect(withdrawSuggestion({ id: 'unknown-id' }, DUMMY_CFG)).rejects.toThrow(
      SuggestionNotWithdrawableError,
    );
  });

  it('throws the identical-message SuggestionNotWithdrawableError for a foreign id', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');
    await expect(withdrawSuggestion({ id: 'foreign-id' }, DUMMY_CFG)).rejects.toThrow(
      SuggestionNotWithdrawableError,
    );
  });

  it('throws the identical-message SuggestionNotWithdrawableError for an already-decided own row', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');
    await expect(withdrawSuggestion({ id: 'decided-id' }, DUMMY_CFG)).rejects.toThrow(
      SuggestionNotWithdrawableError,
    );
  });

  it('produces a byte-identical error message across unknown id, foreign id, and already-decided row', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');

    const messages: string[] = [];
    for (const id of ['unknown-id', 'foreign-id', 'decided-id']) {
      try {
        await withdrawSuggestion({ id }, DUMMY_CFG);
        throw new Error('expected withdrawSuggestion to throw');
      } catch (err) {
        messages.push((err as Error).message);
      }
    }

    expect(messages[0]).toBe(messages[1]);
    expect(messages[1]).toBe(messages[2]);
  });
});

// ---------------------------------------------------------------------------
// Tool registration — annotations, description, isError contract
// ---------------------------------------------------------------------------

interface RegisteredToolEntry {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  description?: string;
  handler: (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;
}

function buildServer(): Record<string, RegisteredToolEntry> {
  const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
  registerToolWithdrawSuggestion(server, DUMMY_CFG);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools as Record<string, RegisteredToolEntry>;
}

describe('registerToolWithdrawSuggestion', () => {
  it('is registered and is NOT annotated readOnlyHint (it mutates)', () => {
    const tools = buildServer();
    expect(tools['withdraw_suggestion']).toBeDefined();
    expect(tools['withdraw_suggestion'].annotations?.readOnlyHint).toBe(false);
    expect(tools['withdraw_suggestion'].annotations?.destructiveHint).toBe(false);
    expect(tools['withdraw_suggestion'].annotations?.idempotentHint).toBe(true);
  });

  it('description states the audit row survives and is readable, and never presents the action itself as deletion', () => {
    const tools = buildServer();
    const description = (tools['withdraw_suggestion'].description ?? '').toLowerCase();
    // The description is allowed — and expected — to affirmatively deny deletion
    // ("is NOT deleted"), but must never present the withdraw action ITSELF as a
    // delete/remove: no un-negated "deletes/removes the proposal" phrasing.
    expect(description).toContain('not deleted');
    expect(description).toContain('get_suggestion');
    for (const forbidden of ['deletes the', 'delete the', 'removes the', 'remove the', 'deleting the', 'removing the']) {
      expect(description).not.toContain(forbidden);
    }
  });

  it('returns a structured isError for a not-withdrawable outcome, never throws through the handler', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');
    const tools = buildServer();
    const result = await tools['withdraw_suggestion'].handler({ id: 'unknown-id' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not withdrawable');
  });

  it('the isError message does not imply the row was deleted', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');
    const tools = buildServer();
    const result = await tools['withdraw_suggestion'].handler({ id: 'unknown-id' });
    const text = (result.content[0]?.text ?? '').toLowerCase();
    for (const forbidden of ['delete', 'deleted', 'removed']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('returns a successful result for a withdrawn outcome', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('withdrawn');
    const tools = buildServer();
    const result = await tools['withdraw_suggestion'].handler({ id: 'suggestion-1' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('withdrawn');
  });

  it('never leaks the PAT in an isError message on a server HttpError', async () => {
    vi.mocked(httpModule.postWithdraw).mockRejectedValue(new HttpError(500, '/api/mcp/coach/suggestions/x/withdraw'));
    const tools = buildServer();
    const result = await tools['withdraw_suggestion'].handler({ id: 'suggestion-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0]?.text).not.toContain(DUMMY_CFG.keyB64);
  });

  it('never leaks the PAT or key in the not-withdrawable isError message', async () => {
    vi.mocked(httpModule.postWithdraw).mockResolvedValue('not-withdrawable');
    const tools = buildServer();
    const result = await tools['withdraw_suggestion'].handler({ id: 'suggestion-1' });
    expect(result.content[0]?.text).not.toContain(DUMMY_CFG.pat);
    expect(result.content[0]?.text).not.toContain(DUMMY_CFG.keyB64);
  });
});
