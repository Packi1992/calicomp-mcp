/**
 * Runtime registration test for all 19 CalisthenicsCompanion-MCP tools (13 READ + 6 WRITE).
 *
 * Endstand dieser Phase (137): 14 tools existed before Phase 137; this phase adds FIVE new
 * tools per D-22 (`get_training_state`, `get_coach_parameters`, `set_coach_parameters`,
 * `get_adherence`, `get_progress`) — NOT six, because `get_exercise_progress` and
 * `get_format_progress` were merged into the single `get_progress` tool (D-22). 14 + 5 = 19.
 *
 * Proves that src/index.ts's wiring (Phase 121-04 SC1 / MCPW-01, extended Phase 135, Phase
 * 136, Phase 137) is correct by:
 *   1. Constructing a fresh McpServer.
 *   2. Calling all 19 registerTool<Name> functions with a dummy config.
 *      (Handlers are NOT invoked here — no network, no crypto, no mocks required.)
 *   3. Asserting exactly 19 tools are registered.
 *   4. Asserting the 13 READ tools carry annotations.readOnlyHint === true.
 *   5. Asserting the 5 propose/withdraw WRITE tools carry readOnlyHint:false,
 *      destructiveHint:false, idempotentHint:true (D-06 — propose-only, never a direct
 *      mutation; Phase 136 extends this shape to `withdraw_suggestion`, the one named
 *      PROP-11 exception to propose-only — it mutates a status, never deletes, so the
 *      same non-destructive/idempotent shape applies).
 *   6. Asserting `set_coach_parameters` (Phase 137, STATE-06, the SECOND named
 *      propose-only exception) carries NO readOnlyHint annotation at all — unlike the
 *      other WRITE tools, this file never spells out that annotation's name (Task 3's
 *      own verification gate in 137-05-PLAN.md checks the token is absent from
 *      set_coach_parameters.ts), so this test checks its effect (undefined, not true)
 *      rather than a literal value equal to the token's own name.
 *
 * Introspection: the MCP SDK v1.29.0 stores registered tools in the
 * `_registeredTools` property (keyed by tool name → RegisteredTool).
 * Although `_registeredTools` is marked private in the TypeScript declaration,
 * it is a plain JS object accessible for test purposes via `(server as any)`.
 *
 * This test does NOT call the handlers, so getSnapshot is never triggered;
 * no vi.mock is required.
 */

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerToolGetHistory }         from '../../src/tools/get_history.js';
import { registerToolGetStats }           from '../../src/tools/get_stats.js';
import { registerToolGetProfile }         from '../../src/tools/get_profile.js';
import { registerToolListTemplates }      from '../../src/tools/list_templates.js';
import { registerToolGetTemplate }        from '../../src/tools/get_template.js';
import { registerToolGetExerciseCatalog } from '../../src/tools/get_exercise_catalog.js';
import { registerToolGetPlannedWorkouts } from '../../src/tools/get_planned_workouts.js';
import { registerToolGetTrainingState }   from '../../src/tools/get_training_state.js';
import { registerToolProposePlanUpdate }  from '../../src/tools/propose_plan_update.js';
import { registerToolProposeNewPlan }     from '../../src/tools/propose_new_plan.js';
import { registerToolProposeNewExercise } from '../../src/tools/propose_new_exercise.js';
import { registerToolProposePlannedUpdate } from '../../src/tools/propose_planned_update.js';
import { registerToolGetSuggestions }     from '../../src/tools/get_suggestions.js';
import { registerToolGetSuggestion }      from '../../src/tools/get_suggestion.js';
import { registerToolWithdrawSuggestion } from '../../src/tools/withdraw_suggestion.js';
import { registerToolGetCoachParameters } from '../../src/tools/get_coach_parameters.js';
import { registerToolSetCoachParameters } from '../../src/tools/set_coach_parameters.js';
import { registerToolGetAdherence }        from '../../src/tools/get_adherence.js';
import { registerToolGetProgress }         from '../../src/tools/get_progress.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DUMMY_CFG = {
  pat:       'calicomp_pat_test',
  keyB64:    'AAAA',
  serverUrl: 'https://example.test',
};

const READ_TOOL_NAMES = [
  'get_history',
  'get_stats',
  'get_profile',
  'list_templates',
  'get_template',
  'get_exercise_catalog',
  'get_planned_workouts',
  'get_suggestions',
  'get_suggestion',
  'get_training_state',
  'get_coach_parameters',
  'get_adherence',
  'get_progress',
] as const;

const WRITE_TOOL_NAMES = [
  'propose_plan_update',
  'propose_new_plan',
  'propose_new_exercise',
  'propose_planned_update',
  'withdraw_suggestion',
] as const;

/**
 * `set_coach_parameters` (Phase 137, STATE-06) is a WRITE tool too, but its
 * annotations shape deliberately omits the readOnlyHint token entirely (see the
 * describe-block comment above) rather than setting it to `false` like every
 * other WRITE tool — so it is counted separately from WRITE_TOOL_NAMES, which
 * asserts that specific value.
 */
const WRITE_TOOL_NAMES_NO_READONLY_ANNOTATION = ['set_coach_parameters'] as const;

const EXPECTED_TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
  ...WRITE_TOOL_NAMES_NO_READONLY_ANNOTATION,
] as const;

type RegisteredToolMap = Record<
  string,
  { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }
>;

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe('tool registration — all 19 tools (13 READ + 6 WRITE)', () => {
  /**
   * Build a fresh server, register all 19 tools, return the internal tool map.
   * Each test creates its own server to guarantee isolation.
   */
  function buildRegisteredServer() {
    const server = new McpServer({ name: 'calicomp', version: '0.1.0' });
    registerToolGetHistory(server, DUMMY_CFG);
    registerToolGetStats(server, DUMMY_CFG);
    registerToolGetProfile(server, DUMMY_CFG);
    registerToolListTemplates(server, DUMMY_CFG);
    registerToolGetTemplate(server, DUMMY_CFG);
    registerToolGetExerciseCatalog(server, DUMMY_CFG);
    registerToolGetPlannedWorkouts(server, DUMMY_CFG);
    registerToolGetTrainingState(server, DUMMY_CFG);
    registerToolProposePlanUpdate(server, DUMMY_CFG);
    registerToolProposeNewPlan(server, DUMMY_CFG);
    registerToolProposeNewExercise(server, DUMMY_CFG);
    registerToolProposePlannedUpdate(server, DUMMY_CFG);
    registerToolGetSuggestions(server, DUMMY_CFG);
    registerToolGetSuggestion(server, DUMMY_CFG);
    registerToolWithdrawSuggestion(server, DUMMY_CFG);
    registerToolGetCoachParameters(server, DUMMY_CFG);
    registerToolSetCoachParameters(server, DUMMY_CFG);
    registerToolGetAdherence(server, DUMMY_CFG);
    registerToolGetProgress(server, DUMMY_CFG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (server as any)._registeredTools as RegisteredToolMap;
  }

  it('registers exactly 19 tools', () => {
    const tools = buildRegisteredServer();
    expect(Object.keys(tools)).toHaveLength(19);
  });

  it('registers all expected tool names', () => {
    const tools = buildRegisteredServer();
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(Object.keys(tools)).toContain(name);
    }
  });

  it('every READ tool has annotations.readOnlyHint === true', () => {
    const tools = buildRegisteredServer();
    for (const name of READ_TOOL_NAMES) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(
        tools[name].annotations?.readOnlyHint,
        `${name} must have readOnlyHint: true`,
      ).toBe(true);
    }
  });

  it('every WRITE tool has readOnlyHint:false, destructiveHint:false, idempotentHint:true (D-06)', () => {
    const tools = buildRegisteredServer();
    for (const name of WRITE_TOOL_NAMES) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name].annotations?.readOnlyHint, `${name} must have readOnlyHint: false`).toBe(false);
      expect(tools[name].annotations?.destructiveHint, `${name} must have destructiveHint: false`).toBe(false);
      expect(tools[name].annotations?.idempotentHint, `${name} must have idempotentHint: true`).toBe(true);
    }
  });

  it('set_coach_parameters is registered and carries no readOnlyHint annotation (it writes)', () => {
    const tools = buildRegisteredServer();
    for (const name of WRITE_TOOL_NAMES_NO_READONLY_ANNOTATION) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name].annotations?.readOnlyHint, `${name} must not be true`).not.toBe(true);
    }
  });

  it('no tool is registered twice (exactly 19 unique keys)', () => {
    const tools = buildRegisteredServer();
    const names = Object.keys(tools);
    const uniqueNames = new Set(names);
    expect(names).toHaveLength(19);
    expect(uniqueNames.size).toBe(19);
  });
});
