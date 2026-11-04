/**
 * The coach is told that the app may apply a proposal directly, never how the athlete set it (Phase 168, plan
 * 168-05, D-10, protocol 1.56 §5 "Direct application by the app", plan threat T-168-21).
 *
 * Covered:
 *   - `AUTO_APPLY_NOTICE` equals the verbatim block of the protocol character for character;
 *   - every `propose_*` tool ends its description with it, exactly once; the tools are found by their module files
 *     under `src/tools/`, so a new proposal tool without the sentence turns this test red;
 *   - no description names a setting of the athlete, and none keeps a claim of the time before 168 that the
 *     notice contradicts ("never directly", "only the athlete applies it");
 *   - `get_suggestions` and `get_suggestion` pass `decidedBy` and `undoneAt` through and show no field of the app
 *     list, above all not the id of the witnessing PAT (protocol §5 "Witnessing PAT").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../src/cache.js');
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return { ...actual, fetchSuggestions: vi.fn(), fetchSuggestion: vi.fn() };
});

import * as cacheModule from '../src/cache.js';
import * as httpModule from '../src/http.js';
import { AUTO_APPLY_NOTICE } from '../src/auto-apply-notice.js';
import { registerToolGetSuggestions } from '../src/tools/get_suggestions.js';
import { registerToolGetSuggestion } from '../src/tools/get_suggestion.js';
import { protocolExplanation } from './protocol-text.js';
import type { SuggestionDtoResponse, SuggestionSummaryDtoResponse } from '../src/types.js';

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };
const TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/tools');

/** Words that would tell the coach about the athlete's settings or contradict the notice (D-10). */
const SETTING_WORDS = /\b(direct|directly|review|reviews|reviewed|permission|permissions|setting|settings)\b/i;

/** The claims of the five proposal tools before phase 168, which the notice contradicts. */
const OLD_CLAIMS = [
  'Never changes it directly',
  'Never creates it directly',
  'Never mutates directly',
  'only the athlete applies it',
  'for accept/reject',
] as const;

type ToolMap = Record<string, { description?: string; handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }>;

/** Every `propose_*` module under `src/tools/`, registered through its own `registerTool…` export. */
async function registeredProposeTools(): Promise<Record<string, string>> {
  const server = new McpServer({ name: 'test', version: '0.1.0' });
  const files = readdirSync(TOOLS_DIR).filter((f) => /^propose_[a-z_]+\.ts$/.test(f));
  for (const file of files) {
    const module = (await import(pathToFileURL(join(TOOLS_DIR, file)).href)) as Record<string, unknown>;
    const register = Object.entries(module).find(([name, value]) => name.startsWith('registerTool') && typeof value === 'function');
    if (register === undefined) throw new Error(`NICHT GEMESSEN: ${file} exports no registerTool function`);
    (register[1] as (s: McpServer, c: typeof DUMMY_CFG) => void)(server, DUMMY_CFG);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as ToolMap;
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([name]) => name.startsWith('propose_'))
      .map(([name, tool]) => [name, tool.description ?? '']),
  );
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('AUTO_APPLY_NOTICE', () => {
  it('the notice equals the verbatim block of the protocol', () => {
    expect(AUTO_APPLY_NOTICE).toBe(protocolExplanation('AUTO_APPLY_NOTICE'));
  });

  it('every propose tool description ends with the notice', async () => {
    const tools = await registeredProposeTools();
    expect(Object.keys(tools).length, 'NICHT GEMESSEN: fewer than six propose tools found').toBeGreaterThanOrEqual(6);
    for (const [name, description] of Object.entries(tools)) {
      expect(description.endsWith(` ${AUTO_APPLY_NOTICE}`), `${name} ends with the notice`).toBe(true);
      expect(occurrences(description, AUTO_APPLY_NOTICE), `${name} carries the notice once`).toBe(1);
    }
  });

  it('no description names a permission setting', async () => {
    const tools = await registeredProposeTools();
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(6);
    for (const [name, description] of Object.entries(tools)) {
      const rest = description.slice(0, description.length - AUTO_APPLY_NOTICE.length);
      expect(rest, `${name} names no setting`).not.toMatch(SETTING_WORDS);
    }
  });

  it('no propose description contradicts the notice', async () => {
    const tools = await registeredProposeTools();
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(6);
    for (const [name, description] of Object.entries(tools)) {
      for (const claim of OLD_CLAIMS) {
        expect(description, `${name} must not claim "${claim}"`).not.toContain(claim);
      }
    }
  });
});

describe('decidedBy and undoneAt in the read surface', () => {
  /** Fields only the app list carries (protocol §5); the PAT surface must never show them. */
  const APP_LIST_ONLY = { actorPatId: 'pat-of-the-witness', decidedByDeviceId: 'device-1', dismissedAt: 1_780_000_500_000 };

  function server(): ToolMap {
    const s = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetSuggestions(s, DUMMY_CFG);
    registerToolGetSuggestion(s, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (s as any)._registeredTools as ToolMap;
  }

  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockReset();
    vi.mocked(cacheModule.getSnapshot).mockRejectedValue(new Error('no snapshot in this test'));
    vi.mocked(httpModule.fetchSuggestions).mockReset();
    vi.mocked(httpModule.fetchSuggestion).mockReset();
  });

  it('get_suggestions passes decidedBy and undoneAt through', async () => {
    const auto: SuggestionSummaryDtoResponse = {
      id: 'suggestion-auto',
      type: 'history_correction',
      status: 'accepted',
      createdAt: 1_780_000_000_000,
      targetLabel: 'Workout correction',
      rationale: 'counted twelve',
      decidedBy: 'auto',
      undoneAt: 1_780_000_400_000,
    };
    const unknown: SuggestionSummaryDtoResponse = {
      id: 'suggestion-old',
      type: 'new_plan',
      status: 'accepted',
      createdAt: 1_770_000_000_000,
      targetLabel: 'Plan',
      rationale: 'older app',
    };
    vi.mocked(httpModule.fetchSuggestions).mockResolvedValue([{ ...auto, ...APP_LIST_ONLY } as SuggestionSummaryDtoResponse, unknown]);

    const result = await server().get_suggestions.handler({});

    expect(result.isError).toBeUndefined();
    const rows = JSON.parse(result.content[0].text) as Record<string, unknown>[];
    expect(rows).toStrictEqual([auto, unknown]);
    expect(rows[0].decidedBy).toBe('auto');
    expect(rows[0].undoneAt).toBe(1_780_000_400_000);
    for (const field of Object.keys(APP_LIST_ONLY)) {
      expect(rows[0], `${field} never leaves the MCP`).not.toHaveProperty(field);
    }
  });

  it('get_suggestion never shows actorPatId', async () => {
    const row: SuggestionDtoResponse = {
      id: 'suggestion-auto',
      type: 'new_exercise',
      payload: '{"name":"Vector exercise"}',
      rationale: 'because',
      sourceLlm: 'unknown',
      status: 'accepted',
      createdAt: 1_780_000_000_000,
      expiresAt: 1_782_592_000_000,
      planHash: null,
      decidedBy: 'auto',
      undoneAt: null,
    };
    vi.mocked(httpModule.fetchSuggestion).mockResolvedValue({ ...row, ...APP_LIST_ONLY } as SuggestionDtoResponse);

    const result = await server().get_suggestion.handler({ id: 'suggestion-auto' });

    expect(result.isError).toBeUndefined();
    const output = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(output).not.toHaveProperty('actorPatId');
    expect(output).not.toHaveProperty('decidedByDeviceId');
    expect(output).not.toHaveProperty('dismissedAt');
    expect(output.decidedBy).toBe('auto');
    expect(output.undoneAt).toBeNull();
    expect(output.payload).toBe(row.payload);
    expect(output.payloadResolvedSkipped).toBe('catalog_unavailable');
  });

  it('both suggestion read tools name decidedBy and undoneAt in their description', () => {
    const tools = server();
    for (const name of ['get_suggestions', 'get_suggestion']) {
      expect(tools[name].description, name).toContain('decidedBy');
      expect(tools[name].description, name).toContain('undoneAt');
    }
  });
});
