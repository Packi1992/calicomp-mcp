/**
 * Tests for the `propose_plan_update` WRITE tool (op-list diff against a CLASSIC
 * template OR a `formatParams` whole-parameter replacement against a format
 * template — Phase 134, G-134-12, Protocol v1.7 §2.5 — with a planHash stale-guard
 * — D-02; inline-newExercises dedupe — A2; client-side templateId pre-check —
 * A4/SC5).
 *
 * Coverage mirrors the <behavior> block from 121-04-PLAN.md:
 *   - unknown-templateId: isError, postSuggest NOT called (no network — A4/SC5 fast-fail).
 *   - happy-path: postSuggest called with objectContaining { type:'plan_update', planHash, changeHash, sourceLlm }.
 *   - inline-dedupe: a newExercises entry matching the fixture catalog is dropped
 *     and its addExercise op ref rewritten to source:'catalog' (asserted on the payload argument).
 *   - changeHash determinism: two calls with identical logical input produce the
 *     identical changeHash argument to postSuggest.
 *   - server-error: postSuggest throws HttpError(404) -> isError text contains 'HTTP 404'.
 *
 * Plus the <behavior> block from 134-21-PLAN.md Task 1 (a CIRCUIT proposal
 * end-to-end through the MCP, plus the five locally-decidable refusals):
 *   - formatParams (no ops) against a CIRCUIT template: postSuggest called with an
 *     empty ops[] and the formatParams payload.
 *   - ops AND formatParams both present: OPS_AND_FORMAT_PARAMS_EXCLUSIVE, no network call.
 *   - ops (no formatParams) against a CIRCUIT template: FORMAT_PARAMS_REQUIRED, no
 *     network call — the UAT round-4 proof row (2c0b2537) in tool form.
 *   - formatParams against a CLASSIC template: FORMAT_PARAMS_NOT_ALLOWED, no network call.
 *   - formatParams.workoutType disagreeing with the target template: FORMAT_TYPE_MISMATCH,
 *     no network call.
 *   - ops against a CLASSIC template: unchanged, postSuggest called.
 *   - formatParams.workoutType outside the eight recognized values: UNKNOWN_FORMAT_TYPE
 *     at the Zod boundary (ProposePlanUpdateSchema.safeParse), never reaches the handler.
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
import { computePlanHash } from '../../src/hash.js';
import { ProposePlanUpdateSchema } from '../../src/schemas.js';
import {
  registerToolProposePlanUpdate,
  buildPlanUpdatePayload,
  type ProposePlanUpdateArgs,
} from '../../src/tools/propose_plan_update.js';
import {
  mockSnapshot,
  mockCatalog,
  CATALOG_EXERCISE_ID_PUSHUP,
  TEMPLATE_ID_PUSH,
  BLOCK_ID_PUSH_A,
  TE_ID_PUSH_PUSHUP,
} from '../fixture.js';
import type { DecryptedSnapshot } from '../../src/types.js';
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
  type:       'plan_update',
  payload:    '{}',
  rationale:  'because',
  sourceLlm:  'unknown',
  status:     'pending',
  createdAt:  1_700_000_000_000,
  expiresAt:  1_700_100_000_000,
  planHash:   'deadbeef',
};

const UNKNOWN_TEMPLATE_ID = 'ffffffff-ffff-4fff-afff-ffffffffffff';

// ---------------------------------------------------------------------------
// Format-template fixture (Phase 134, G-134-12) — a CIRCUIT template alongside
// the fixture's existing CLASSIC templates. Built inline (not in tests/fixture.ts)
// the same way the "soft-deleted templateId" test above builds its own snapshot
// variant — this plan's own files_modified list does not touch fixture.ts.
// ---------------------------------------------------------------------------

const TEMPLATE_ID_CIRCUIT = '99999999-0009-4999-9000-000000000001';

/**
 * A synced-post-134-18 snapshot: every template row carries an explicit `workoutType`
 * (the app's `WorkoutTemplateEntity.workoutType` column defaults to `WorkoutType.CLASSIC`
 * and always pushes `.name` — `BackupSyncService.kt:985` — so a live CLASSIC template's
 * wire row carries `"CLASSIC"` literally; `workoutType` is absent only on a pre-Phase-134
 * row nobody has re-pushed since). Fixture's existing CLASSIC templates get `"CLASSIC"`
 * explicitly here; a new CIRCUIT template is added alongside them.
 */
function snapshotWithCircuitTemplate(): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    templates: [
      ...mockSnapshot.templates.map((t) => ({ ...t, workoutType: 'CLASSIC' })),
      {
        id: TEMPLATE_ID_CIRCUIT,
        name: 'Circuit Day',
        createdAt: 1_700_000_002_000,
        updatedAt: 1_700_000_002_000,
        isFavoriteForWatch: false,
        workoutType: 'CIRCUIT',
      },
    ],
  };
}

const VALID_CIRCUIT_FORMAT_PARAMS = {
  workoutType: 'CIRCUIT' as const,
  rounds: 3,
  restSeconds: 60,
  exercises: [
    {
      exercise: { source: 'catalog' as const, exerciseId: CATALOG_EXERCISE_ID_PUSHUP },
      mode: 'REPS' as const,
      targetReps: 15,
      orderIndex: 0,
    },
  ],
};

const VALID_UPDATE_ARGS: ProposePlanUpdateArgs = {
  templateId: TEMPLATE_ID_PUSH,
  rationale:  'testing plan update',
  ops: [
    { op: 'updateSetsReps', workoutExerciseId: TE_ID_PUSH_PUSHUP, sets: 4 },
  ],
};

function getHandler(server: McpServer): (args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools['propose_plan_update'].handler;
}

// ---------------------------------------------------------------------------
// buildPlanUpdatePayload — pure helper
// ---------------------------------------------------------------------------

describe('buildPlanUpdatePayload — pure helper', () => {
  it('inline-dedupe: a newExercises entry matching the catalog is dropped and its ref rewritten', () => {
    const args: ProposePlanUpdateArgs = {
      templateId: TEMPLATE_ID_PUSH,
      rationale:  'testing inline dedupe',
      newExercises: [
        { tempId: 'temp-pushup', name: '  PUSH-UP  ', mode: 'REPS', usesWeight: false },
        { tempId: 'temp-novel',  name: 'Dragon Flag', mode: 'TIME', usesWeight: false },
      ],
      ops: [
        {
          op:               'addExercise',
          blockId:          BLOCK_ID_PUSH_A,
          exercise:         { source: 'new', tempId: 'temp-pushup' },
          mode:             'REPS',
          restTimeSeconds:  60,
          sets:             3,
          orderIndex:       2,
        },
        {
          op:               'addExercise',
          blockId:          BLOCK_ID_PUSH_A,
          exercise:         { source: 'new', tempId: 'temp-novel' },
          mode:             'TIME',
          restTimeSeconds:  60,
          sets:             3,
          orderIndex:       3,
        },
      ],
    };

    const payload = buildPlanUpdatePayload(args, mockCatalog);

    // Matched entry dropped from newExercises[]; novel one remains.
    expect(payload.newExercises).toHaveLength(1);
    expect(payload.newExercises[0].tempId).toBe('temp-novel');

    // Matched ref rewritten to source:'catalog' with the existing UUID.
    const rewrittenOp = payload.ops[0] as { exercise: { source: string; exerciseId?: string } };
    expect(rewrittenOp.exercise).toStrictEqual({ source: 'catalog', exerciseId: CATALOG_EXERCISE_ID_PUSHUP });

    // Unmatched ref passes through unchanged.
    const passthroughOp = payload.ops[1] as { exercise: { source: string; tempId?: string } };
    expect(passthroughOp.exercise).toStrictEqual({ source: 'new', tempId: 'temp-novel' });
  });

  it('non-addExercise ops pass through unchanged (no ExerciseRef to rewrite)', () => {
    const payload = buildPlanUpdatePayload(VALID_UPDATE_ARGS, mockCatalog);
    expect(payload.ops).toStrictEqual(VALID_UPDATE_ARGS.ops);
    expect(payload.newExercises).toStrictEqual([]);
    expect(payload.templateId).toBe(TEMPLATE_ID_PUSH);
  });
});

// ---------------------------------------------------------------------------
// registered MCP handler
// ---------------------------------------------------------------------------

describe('propose_plan_update — registered MCP handler', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('unknown-templateId: isError, no network call (A4/SC5 fast-fail)', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({ ...VALID_UPDATE_ARGS, templateId: UNKNOWN_TEMPLATE_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(UNKNOWN_TEMPLATE_ID);
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('soft-deleted templateId: isError, no network call (WR-03 — deleted plans reject proposals)', async () => {
    const snapshotWithDeletedPush = {
      ...mockSnapshot,
      templates: mockSnapshot.templates.map((t) =>
        t.id === TEMPLATE_ID_PUSH ? { ...t, deletedAt: 1_700_000_005_000 } : t,
      ),
    };
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...MOCK_CACHE,
      snapshot: snapshotWithDeletedPush,
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(VALID_UPDATE_ARGS);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(TEMPLATE_ID_PUSH);
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('happy-path: POSTs plan_update with planHash + changeHash + sourceLlm', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(VALID_UPDATE_ARGS);

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(body).toMatchObject({
      type:      'plan_update',
      rationale: 'testing plan update',
    });
    expect(typeof body.changeHash).toBe('string');
    expect(body.changeHash).toHaveLength(64);
    expect(typeof body.planHash).toBe('string');
    expect(body.planHash).toHaveLength(64);
    expect(body.planHash).toBe(computePlanHash(TEMPLATE_ID_PUSH, mockSnapshot));
    expect(typeof body.sourceLlm).toBe('string');

    const payload = JSON.parse(body.payload) as { templateId: string; ops: unknown[]; newExercises: unknown[] };
    expect(payload.templateId).toBe(TEMPLATE_ID_PUSH);
    expect(payload.newExercises).toStrictEqual([]);
  });

  it('inline-dedupe via handler: matched newExercises entry rewritten in the POSTed payload', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    await handler({
      templateId: TEMPLATE_ID_PUSH,
      rationale:  'testing inline dedupe via handler',
      newExercises: [
        { tempId: 'temp-pushup', name: '  PUSH-UP  ', mode: 'REPS', usesWeight: false },
      ],
      ops: [
        {
          op:              'addExercise',
          blockId:         BLOCK_ID_PUSH_A,
          exercise:        { source: 'new', tempId: 'temp-pushup' },
          mode:            'REPS',
          restTimeSeconds: 60,
          sets:            3,
          orderIndex:      2,
        },
      ],
    });

    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const payload = JSON.parse(body.payload) as {
      newExercises: unknown[];
      ops: { exercise: { source: string; exerciseId?: string } }[];
    };
    expect(payload.newExercises).toStrictEqual([]);
    expect(payload.ops[0].exercise).toStrictEqual({
      source:     'catalog',
      exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
    });
  });

  it('changeHash determinism: two calls with identical logical input produce the identical changeHash', async () => {
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    await handler(VALID_UPDATE_ARGS);
    await handler(VALID_UPDATE_ARGS);

    expect(httpModule.postSuggest).toHaveBeenCalledTimes(2);
    const firstHash  = vi.mocked(httpModule.postSuggest).mock.calls[0][0].changeHash;
    const secondHash = vi.mocked(httpModule.postSuggest).mock.calls[1][0].changeHash;
    expect(firstHash).toBe(secondHash);
  });

  it('server-error: HttpError(404) from postSuggest returns isError text containing HTTP 404', async () => {
    vi.mocked(httpModule.postSuggest).mockRejectedValue(new HttpError(404, '/api/mcp/suggest'));

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(VALID_UPDATE_ARGS);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 404');
  });
});

// ---------------------------------------------------------------------------
// Format-template plan_update (Phase 134, G-134-12, Protocol v1.7 §2.5,
// 134-21-PLAN.md Task 1 <behavior>) — enforcement point #1 (the MCP), mirroring
// FormatProposalApplier.validate (Kotlin, enforcement point #2, the app).
// ---------------------------------------------------------------------------

describe('propose_plan_update — format-template plan_update (G-134-12)', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...MOCK_CACHE,
      snapshot: snapshotWithCircuitTemplate(),
    });
    vi.mocked(httpModule.postSuggest).mockReset();
    vi.mocked(httpModule.postSuggest).mockResolvedValue(MOCK_SUGGESTION);
  });

  it('formatParams (no ops) against a CIRCUIT template: postSuggest called with an empty ops[] and the formatParams payload', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_CIRCUIT,
      rationale: 'propose a new circuit',
      formatParams: VALID_CIRCUIT_FORMAT_PARAMS,
    });

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    expect(body.type).toBe('plan_update');
    const payload = JSON.parse(body.payload) as { ops: unknown[]; formatParams?: unknown };
    expect(payload.ops).toStrictEqual([]);
    expect(payload.formatParams).toStrictEqual(VALID_CIRCUIT_FORMAT_PARAMS);
  });

  it('ops AND formatParams both present: OPS_AND_FORMAT_PARAMS_EXCLUSIVE, no network call', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_CIRCUIT,
      rationale: 'both set',
      ops: [{ op: 'removeExercise', workoutExerciseId: TE_ID_PUSH_PUSHUP }],
      formatParams: VALID_CIRCUIT_FORMAT_PARAMS,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('OPS_AND_FORMAT_PARAMS_EXCLUSIVE');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('ops (no formatParams) against a CIRCUIT template: FORMAT_PARAMS_REQUIRED, no network call (UAT round-4 proof row 2c0b2537)', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_CIRCUIT,
      rationale: 'op-list against a format template',
      ops: [{ op: 'removeExercise', workoutExerciseId: TE_ID_PUSH_PUSHUP }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FORMAT_PARAMS_REQUIRED');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('formatParams against a CLASSIC template: FORMAT_PARAMS_NOT_ALLOWED, no network call', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_PUSH,
      rationale: 'formatParams against classic',
      formatParams: VALID_CIRCUIT_FORMAT_PARAMS,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FORMAT_PARAMS_NOT_ALLOWED');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it("formatParams.workoutType disagreeing with the target template: FORMAT_TYPE_MISMATCH, no network call", async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_CIRCUIT,
      rationale: 'mismatched discriminator',
      formatParams: { ...VALID_CIRCUIT_FORMAT_PARAMS, workoutType: 'EMOM' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FORMAT_TYPE_MISMATCH');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('ops against a CLASSIC template: unchanged, postSuggest called', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(VALID_UPDATE_ARGS);

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const payload = JSON.parse(body.payload) as { ops: unknown[]; formatParams?: unknown };
    expect(payload.ops).toStrictEqual(VALID_UPDATE_ARGS.ops);
    expect(payload.formatParams).toBeUndefined();
  });

  // CR-01 (134-REVIEW.md): once the format-params server migration deploys, a CLASSIC
  // template the user has not re-synced since then keeps its `workoutType` column at a
  // genuine wire `null` — NOT the same runtime shape as the key being absent (which the
  // 'ops against a CLASSIC template: unchanged' test above already covers). Before the
  // fix, `get_template.ts`'s `!== undefined` projection let that `null` through
  // verbatim, and `format_proposal.ts`'s `=== undefined` check then missed it too, so an
  // ordinary ops[] plan_update against this exact template shape was wrongly refused
  // with FORMAT_PARAMS_REQUIRED. This test exercises the full handler path end-to-end —
  // getTemplate's projection AND validateFormatProposal's decision together — the same
  // path a real post-migration, not-yet-resynced row will hit.
  it('ops against a template whose workoutType is a genuine null (not merely absent): treated as classicOps, postSuggest called', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...MOCK_CACHE,
      snapshot: {
        ...mockSnapshot,
        templates: mockSnapshot.templates.map((t) =>
          t.id === TEMPLATE_ID_PUSH ? { ...t, workoutType: null } : t,
        ),
      },
    });
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler(VALID_UPDATE_ARGS);

    expect(result.isError).toBeFalsy();
    expect(httpModule.postSuggest).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(httpModule.postSuggest).mock.calls[0];
    const payload = JSON.parse(body.payload) as { ops: unknown[]; formatParams?: unknown };
    expect(payload.ops).toStrictEqual(VALID_UPDATE_ARGS.ops);
    expect(payload.formatParams).toBeUndefined();
  });

  it('formatParams.workoutType outside the eight recognized values: UNKNOWN_FORMAT_TYPE at the Zod boundary, never reaches the handler', () => {
    const result = ProposePlanUpdateSchema.safeParse({
      templateId: TEMPLATE_ID_CIRCUIT,
      rationale: 'invented discriminator',
      formatParams: { workoutType: 'PILATES', exercises: [] },
    });

    expect(result.success).toBe(false);
  });

  it('a payload carrying formatParams and no ops key parses successfully (ops is optional)', () => {
    const result = ProposePlanUpdateSchema.safeParse({
      templateId: TEMPLATE_ID_CIRCUIT,
      rationale: 'formatParams only, no ops key at all',
      formatParams: VALID_CIRCUIT_FORMAT_PARAMS,
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G-136-R2-7a (Plan 136-24) — a formatParams proposal against a template whose
// own workoutType the MCP cannot read (absent, or a genuine wire null) is refused
// locally instead of silently dropping formatParams and posting an empty,
// unapplicable plan_update (UAT round-2 setup, suggestion `a5801708` against
// "tabatest", `ff66017b`). The regression this fix must not break — an ops-only
// proposal against the SAME absent/null-workoutType template still posts — is
// already covered elsewhere and intentionally not duplicated here: the
// absent-workoutType case by the 'happy-path' test above (plain MOCK_CACHE, no
// workoutType override on any template), the null-workoutType case by 'ops
// against a template whose workoutType is a genuine null (not merely absent)'
// in the describe block above.
// ---------------------------------------------------------------------------

describe('propose_plan_update — G-136-R2-7a: formatParams against an untyped template', () => {
  beforeEach(() => {
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('formatParams against a template with workoutType absent from the snapshot: isError, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_PUSH,
      rationale: 'formatParams against a template with no workoutType at all',
      formatParams: VALID_CIRCUIT_FORMAT_PARAMS,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FORMAT_PARAMS_ON_UNTYPED_TEMPLATE');
    expect(result.content[0].text).not.toContain('CLASSIC');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });

  it('formatParams against a template whose workoutType is a genuine null: isError, no network call', async () => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue({
      ...MOCK_CACHE,
      snapshot: {
        ...mockSnapshot,
        templates: mockSnapshot.templates.map((t) =>
          t.id === TEMPLATE_ID_PUSH ? { ...t, workoutType: null } : t,
        ),
      },
    });

    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_PUSH,
      rationale: 'formatParams against a template whose workoutType is a literal null',
      formatParams: VALID_CIRCUIT_FORMAT_PARAMS,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FORMAT_PARAMS_ON_UNTYPED_TEMPLATE');
    expect(result.content[0].text).not.toContain('CLASSIC');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G-136-R2-7a (Plan 136-24, Task 2) — a fail-closed invariant guard immediately
// before postSuggest. ProposePlanUpdateSchema's "exactly one of ops/formatParams"
// rule and Task 1's refusal above both make an empty built payload (no ops[], no
// formatParams) unreachable through any schema-validated tool call — but the
// registered handler is invoked directly here, bypassing Zod, which is exactly
// the seam that keeps this guard from rotting into dead code.
// ---------------------------------------------------------------------------

describe('propose_plan_update — G-136-R2-7a Task 2: fail-closed invariant guard', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
    vi.mocked(httpModule.postSuggest).mockReset();
  });

  it('a direct handler call with an empty ops[] and no formatParams (a shape Zod would reject) is refused, not posted', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    const handler = getHandler(server);

    const result = await handler({
      templateId: TEMPLATE_ID_PUSH,
      rationale: 'nothing to propose',
      ops: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EMPTY_PLAN_UPDATE');
    expect(httpModule.postSuggest).not.toHaveBeenCalled();
  });
});
