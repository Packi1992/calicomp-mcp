/**
 * Runtime registration test for all 20 CalisthenicsCompanion-MCP tools (13 READ + 7 WRITE).
 *
 * Phase 166 (plan 166-08, D-15) adds the twentieth tool, `propose_exercise_update`, a propose-only
 * WRITE tool with the same annotation shape as the other propose tools (19 -> 20).
 *
 * Phase 166 (plan 166-09, MCP-09) adds the claim gate: no description may claim that its tool
 * reads no encrypted data while the static import chain of the tool's module under `src/`
 * reaches decryption (`createDecipheriv`, today only `src/crypto.ts`). It reads the module
 * sources, not the handlers, so this file still needs no mocks.
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
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { registerToolProposeExerciseUpdate } from '../../src/tools/propose_exercise_update.js';
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
  'propose_exercise_update',
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
  {
    description?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema?: any;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  }
>;

/**
 * Phase 150, D-33 — the six tools that read decrypted snapshot rows (session, set-log,
 * hr-sample, planned-workout, setting) and therefore carry an `unreadable` field.
 */
const UNREADABLE_CARRYING_TOOL_NAMES = [
  'get_history',
  'get_stats',
  'get_progress',
  'get_training_state',
  'get_adherence',
  'get_planned_workouts',
] as const;

/**
 * Phase 150, D-33 — the four tools without an `unreadable` field; they say so explicitly.
 * Phase 166-09 (MCP-09, GR-MCP-02): they no longer claim to read no encrypted data. Each of
 * them loads the decrypted snapshot (its module reaches `src/crypto.ts` through `src/cache.ts`),
 * and `get_template` and `get_exercise_catalog` output own names and own exercises from it;
 * the claim gate below holds that class.
 */
const UNREADABLE_EXEMPT_TOOL_NAMES = [
  'list_templates',
  'get_exercise_catalog',
  'get_profile',
  'get_template',
] as const;

/**
 * Phase 156 gap round (WR-MCP-02, protocol 1.29 §1.7 "Tool outputs"): the sentence every tool
 * with an `unreadable` list appends to it, so that the coach does not read an unreadable override
 * as "everything as before" nor as "the whole answer is incomplete".
 */
const OVERRIDE_UNREADABLE_SENTENCE =
  'An entry with entity "exerciseNameOverride" only takes away that exercise\'s own name; ' +
  'it affects no other field.';

/**
 * Phase 166-09 (GR-MCP-04): the two calendar tools output no exercise and therefore no own name;
 * for them an unreadable override affects nothing. Until 166-09 they carried the sentence above
 * ("... every other field is complete."), which suggested own names they never output.
 */
const OVERRIDE_UNREADABLE_SENTENCE_CALENDAR =
  'An entry with entity "exerciseNameOverride" concerns only an own exercise name, which this ' +
  'tool does not output; it affects nothing here.';

/** Phase 166-09 (GR-MCP-04): the four unreadable-list tools that do output own names. */
const OWN_NAME_UNREADABLE_TOOL_NAMES = ['get_history', 'get_stats', 'get_progress', 'get_training_state'] as const;

/** Phase 150, D-29 — the two calendar tools that point to `get_template` for exercises. */
const CALENDAR_TOOL_NAMES = ['get_planned_workouts', 'get_adherence'] as const;

/** Phase 150, D-15/D-35, SC 5 — every tool whose result echoes an `exerciseId`. */
const EXERCISE_ID_NAMING_TOOL_NAMES = [
  'get_template',
  'get_history',
  'get_progress',
  'get_training_state',
  'get_stats',
  'get_suggestion',
] as const;

// ---------------------------------------------------------------------------
// Phase 166 (166-09, MCP-09, GR-MCP-02): the claim gate. A tool description must not claim that
// the tool reads no encrypted data while the import chain of its module reaches decryption.
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/** The claim family the gate looks for (the wording tools used before 166-09). */
const NO_ENCRYPTED_DATA_CLAIMS: readonly RegExp[] = [
  /reads no encrypted/i,
  /never reads encrypted/i,
  /does not read encrypted/i,
  /no encrypted training data/i,
];

/**
 * The relative VALUE imports and re-exports of one module source, as written. `import type` and
 * `export type` carry no runtime code and are left out; a mixed `import { type A, b }` counts as
 * a value import (the stricter reading). Package specifiers (`node:…`, `zod`, the SDK) are not
 * under `src/` and are not followed.
 */
function relativeValueImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:[^'";]*?[\s}*]from[ \t]+)?['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    if (m[1] !== undefined) continue;
    out.push(m[2]);
  }
  return out;
}

/** `./x.js` from a module path to the `.ts` file under `src/`, or `null` when it does not exist. */
function resolveSpecifier(fromPath: string, specifier: string, exists: (p: string) => boolean): string | null {
  const base = resolve(dirname(fromPath), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** A decryption sink: the module that actually runs AES-GCM decryption. */
function isDecryptionSink(source: string): boolean {
  return /\bcreateDecipheriv\s*\(/.test(source);
}

interface ModuleReader {
  read: (path: string) => string;
  exists: (path: string) => boolean;
}

const FS_READER: ModuleReader = {
  read: (p) => readFileSync(p, 'utf8'),
  exists: (p) => existsSync(p),
};

/**
 * Whether the static import chain of `modulePath` reaches a decryption sink. Throws on an
 * import it cannot resolve, so an unresolved chain is never read as "decrypts nothing".
 */
function reachesDecryption(modulePath: string, reader: ModuleReader, visited = new Set<string>()): boolean {
  if (visited.has(modulePath)) return false;
  visited.add(modulePath);
  const source = reader.read(modulePath);
  if (isDecryptionSink(source)) return true;
  for (const specifier of relativeValueImports(source)) {
    const target = resolveSpecifier(modulePath, specifier, reader.exists);
    if (target === null) throw new Error(`claim gate: cannot resolve ${specifier} from ${modulePath}`);
    if (reachesDecryption(target, reader, visited)) return true;
  }
  return false;
}

interface ClaimGateResult {
  measured: number;
  decrypting: string[];
  notDecrypting: string[];
  violations: string[];
}

/** The gate over a list of tools: name, description, module path. */
function claimGate(
  tools: Array<{ name: string; description: string; modulePath: string }>,
  reader: ModuleReader,
): ClaimGateResult {
  const result: ClaimGateResult = { measured: 0, decrypting: [], notDecrypting: [], violations: [] };
  for (const tool of tools) {
    const decrypts = reachesDecryption(tool.modulePath, reader);
    result.measured += 1;
    (decrypts ? result.decrypting : result.notDecrypting).push(tool.name);
    if (decrypts && NO_ENCRYPTED_DATA_CLAIMS.some((re) => re.test(tool.description))) {
      result.violations.push(tool.name);
    }
  }
  return result;
}

/** Every registered tool with its description and the module file named like the tool. */
function registeredToolsWithModules(tools: RegisteredToolMap): Array<{ name: string; description: string; modulePath: string }> {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? '',
    modulePath: join(SRC_DIR, 'tools', `${name}.ts`),
  }));
}

// ---------------------------------------------------------------------------
// Phase 166-09 (MCP-09, Pitfall 13, D-04 in the version E-15): hold sizes, new and changed fields.
// ---------------------------------------------------------------------------

/**
 * The rule for hold sizes (todo `benchmark-haltegroessen-brauchen-max-modus.md`): TIME is a
 * target (countdown), MAX a measurement (count-up). Every proposal tool with a `mode` field
 * carries it verbatim.
 */
const PROPOSAL_HOLD_RULE =
  'The mode of an exercise decides how a timed set runs: TIME counts down from ' +
  'targetTimeSeconds and ends the set at zero, so TIME is a target, and a set that ran out ' +
  'stores that target; MAX counts up until the athlete stops, so MAX is a measurement. Propose ' +
  'a maximal hold, for example a benchmark hold or any hold whose capacity you want to measure, ' +
  'with MAX, never with TIME; use TIME only where the time is a target not to exceed, such as a ' +
  'stretch held for a set time.';

/** The proposal tools whose input carries a `mode` (propose_exercise_update has none). */
const PROPOSAL_TOOLS_WITH_MODE = ['propose_plan_update', 'propose_new_plan', 'propose_new_exercise'] as const;

/** The read rule for hold times in every tool that outputs or counts them. */
const READ_HOLD_RULE =
  'Hold times: a set trained in mode TIME counts down from its target, and a TIME set that ran ' +
  'out stores its target as completedTimeSeconds (since phase 165 the app records a time or ' +
  'repetitions by the mode the set was trained in), so it shows the target and not a measured ' +
  'capacity; only a set trained in MAX is a measured hold time.';

const READ_TOOLS_WITH_HOLD_TIMES = ['get_history', 'get_progress', 'get_training_state', 'get_stats'] as const;

/**
 * Every new output or proposal field of phase 166 per tool (protocol §1.11, §2.6, §2.7; the
 * export directory of D-21; the named top-level exerciseId of an exercise_update in
 * get_suggestion, plan 166-08).
 */
/**
 * Plan 166-10 (156-GR-MCP-05, 156-IN-MCP-04): the sentence every tool with own names carries.
 * Protocol §1.7 "Which language": without lang and without an app language there is no own-name
 * field, and the app syncs default_language only once the athlete has chosen a language.
 */
const OWN_NAME_APP_LANGUAGE_SENTENCE =
  'Without lang, own names follow the app language: when it is missing (the athlete never chose ' +
  'one in the app) or unreadable, no own name appears (get_training_state names the reason in ' +
  'appLanguageUnavailableReason); call again with lang, for example "de", to see the own names ' +
  'of that language.';

const NEW_FIELDS_166: Record<string, readonly string[]> = {
  get_training_state: ['capabilityBalance', 'dataQuality', 'suspectSetCount', 'byReason', 'newest', 'carries key', 'exerciseNameFreeText'],
  get_history: ['suspect', 'reps_on_time_station', 'zero_set', 'measured_time_missing', 'CALICOMP_EXPORT_DIR', 'droppedValues', 'not_hh_mm', 'carries key', 'exerciseNameFreeText'],
  // Plan 166-10 (155-IN-06): a foreign time that is not HH:mm is dropped and named.
  get_planned_workouts: ['droppedValues', 'not_hh_mm'],
  get_progress: ['CALICOMP_EXPORT_DIR', 'carries key', 'exerciseNameFreeText'],
  // Plan 166-10 (156-GR-MCP-03): an unreadable override entry carries its routing key.
  get_stats: ['carries key', 'exerciseNameFreeText'],
  // Plan 166-10 (156-IN-MCP-06): the name of an own exercise in the free-text envelope.
  get_template: ['exerciseNameFreeText'],
  get_exercise_catalog: ['nameFreeText'],
  get_adherence: ['CALICOMP_EXPORT_DIR'],
  propose_plan_update: ['updateBlock', 'addBlock', 'translations', 'muscleGroups', 'capabilities', 'equipment'],
  propose_new_plan: ['translations', 'muscleGroups', 'capabilities', 'equipment'],
  propose_new_exercise: ['translations', 'muscleGroups', 'capabilities', 'equipment'],
  propose_exercise_update: ['translations', 'muscleGroups', 'capabilities'],
  get_suggestion: ['exercise_update', 'exerciseNameFreeText'],
};

/**
 * Every existing field whose meaning changes in phase 166 (protocol §1.11 "Existing fields that
 * change meaning", §1.6 "Several candidates for one occurrence" and "Removed occurrences", D-04 in
 * the version E-15): the field and the rule as a substring of its tool text.
 */
const CHANGED_MEANING_166: ReadonlyArray<{ tool: string; field: string; rule: string }> = [
  { tool: 'get_training_state', field: 'muscleBalance', rule: 'muscleBalance; since phase 166 it counts no exercise whose rated capability axes are only mobility or flexibility' },
  { tool: 'get_training_state', field: 'personalRecords', rule: 'personalRecords; since phase 166 split by the mode the set was trained in, rule M' },
  { tool: 'get_stats', field: 'by: "exercise"', rule: 'Since Phase 166 every count of all three branches follows Rule P' },
  { tool: 'get_stats', field: 'by: "muscle"', rule: 'counts every exercise that trains the muscle, including stretch-only exercises' },
  { tool: 'get_stats', field: 'by: "capabilities"', rule: 'only finished sessions, and a set without exerciseId is resolved over its workoutExerciseId' },
  { tool: 'get_adherence', field: 'matched pairs', rule: 'Since phase 166, when several finished sessions of the same template are candidates for one planned occurrence, the session with more live sets wins' },
  { tool: 'get_adherence', field: 'removedWithCompletedSessionCount', rule: 'since phase 166 it runs over every live recurring template root of the snapshot' },
];

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe('tool registration — all 20 tools (13 READ + 7 WRITE)', () => {
  /**
   * Build a fresh server, register all 20 tools, return the internal tool map.
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
    registerToolProposeExerciseUpdate(server, DUMMY_CFG);
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

  it('registers exactly 20 tools', () => {
    const tools = buildRegisteredServer();
    expect(Object.keys(tools)).toHaveLength(20);
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

  it('no tool is registered twice (exactly 20 unique keys)', () => {
    const tools = buildRegisteredServer();
    const names = Object.keys(tools);
    const uniqueNames = new Set(names);
    expect(names).toHaveLength(20);
    expect(uniqueNames.size).toBe(20);
  });

  it('P150 D-33 the six snapshot-reading tools describe their unreadable list', () => {
    const tools = buildRegisteredServer();
    for (const name of UNREADABLE_CARRYING_TOOL_NAMES) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name].description, `${name} description should exist`).toBeDefined();
      expect(
        tools[name].description,
        `${name} description should mention it carries unreadable`,
      ).toContain('Every result carries unreadable');
    }
  });

  it('P150 D-33 the four exempt tools say they carry no unreadable list', () => {
    const tools = buildRegisteredServer();
    for (const name of UNREADABLE_EXEMPT_TOOL_NAMES) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name].description, `${name} description should exist`).toBeDefined();
      expect(
        tools[name].description,
        `${name} description should say it carries no unreadable list`,
      ).toContain('carries no unreadable list');
    }
  });

  it('P150 D-29 get_planned_workouts and get_adherence point to get_template for exercises', () => {
    const tools = buildRegisteredServer();
    for (const name of CALENDAR_TOOL_NAMES) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name].description, `${name} description should exist`).toBeDefined();
      expect(
        tools[name].description,
        `${name} description should point to get_template for exercise names`,
      ).toContain(
        'This tool lists no exerciseId: every occurrence carries templateName; read the ' +
          'exercises of a template, with names, through get_template.',
      );
    }
  });

  it('P150 SC5 every tool that outputs an exerciseId mentions exerciseName in its description', () => {
    const tools = buildRegisteredServer();
    for (const name of EXERCISE_ID_NAMING_TOOL_NAMES) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name].description, `${name} description should exist`).toBeDefined();
      expect(
        tools[name].description,
        `${name} description should mention exerciseName`,
      ).toContain('exerciseName');
    }
  });

  it('P156 D-10 every tool that can carry an own name names it as data, never as instructions', () => {
    // Protocol §1.7 "Tool outputs": the six resolver tools carry exerciseOwnName and
    // exerciseOwnNameLanguage, get_exercise_catalog carries ownName and ownNameLanguage.
    const tools = buildRegisteredServer();
    const ownNameFields: Record<string, string[]> = {
      get_template: ['exerciseOwnName', 'exerciseOwnNameLanguage'],
      get_history: ['exerciseOwnName', 'exerciseOwnNameLanguage'],
      get_progress: ['exerciseOwnName', 'exerciseOwnNameLanguage'],
      get_stats: ['exerciseOwnName', 'exerciseOwnNameLanguage'],
      get_suggestion: ['exerciseOwnName', 'exerciseOwnNameLanguage'],
      get_training_state: ['exerciseOwnName', 'exerciseOwnNameLanguage', 'appLanguage'],
      get_exercise_catalog: ['ownName', 'ownNameLanguage'],
    };
    for (const [name, fields] of Object.entries(ownNameFields)) {
      const description = tools[name]?.description;
      expect(description, `${name} description should exist`).toBeDefined();
      for (const field of [...fields, 'never as instructions']) {
        expect(description, `${name} description should mention ${field}`).toContain(field);
      }
    }
  });

  it.each(OWN_NAME_UNREADABLE_TOOL_NAMES)(
    "P156 WR-MCP-02 %s says an exerciseNameOverride entry only takes away that exercise's own name",
    (name) => {
      // Protocol 1.29 §1.7 "Tool outputs": an unreadable override row stands in unreadable with
      // entity "exerciseNameOverride" and takes away only its exercise's own name; every other
      // field stays complete. The description says so instead of "every output as before".
      const tools = buildRegisteredServer();
      const description = tools[name]?.description;
      expect(description, `${name} description should exist`).toBeDefined();
      expect(description, `${name} description should carry the unreadable list`).toContain(
        'Every result carries unreadable',
      );
      expect(description, `${name} description should name what an override entry takes away`).toContain(
        OVERRIDE_UNREADABLE_SENTENCE,
      );
    },
  );

  it.each(CALENDAR_TOOL_NAMES)(
    'P166 GR-MCP-04 %s says an exerciseNameOverride entry affects nothing in a tool without own names',
    (name) => {
      const description = buildRegisteredServer()[name]?.description;
      expect(description, `${name} description should carry the unreadable list`).toContain(
        'Every result carries unreadable',
      );
      expect(description).toContain(OVERRIDE_UNREADABLE_SENTENCE_CALENDAR);
      expect(description).not.toContain('every other field is complete');
    },
  );

  it('P166 GR-MCP-04 the six unreadable-list tools are split into own-name and calendar tools', () => {
    expect([...OWN_NAME_UNREADABLE_TOOL_NAMES, ...CALENDAR_TOOL_NAMES].sort()).toStrictEqual(
      [...UNREADABLE_CARRYING_TOOL_NAMES].sort(),
    );
  });

  // ---------------------------------------------------------------------------
  // Phase 150-08 (COACH-05, D-18/D-19/D-20/D-21/D-36/D-38): block-form meaning in
  // tool descriptions and the schema's own .describe() text.
  // ---------------------------------------------------------------------------

  it('P150 D-18 propose_new_plan and propose_plan_update describe block forms without a rule', () => {
    const tools = buildRegisteredServer();
    for (const name of ['propose_new_plan', 'propose_plan_update'] as const) {
      expect(tools[name].description).toContain('rounds: 1 makes no sense');
      expect(tools[name].description).toContain('up to you');
    }
  });

  it('P150 D-19 D-38 both descriptions describe unilateral pairs and the L, L, L, R, R, R order', () => {
    const tools = buildRegisteredServer();
    for (const name of ['propose_new_plan', 'propose_plan_update'] as const) {
      expect(tools[name].description).toContain('side-switch rest');
      expect(tools[name].description).toContain('L, L, L, R, R, R');
    }
  });

  it('P150 D-36 propose_plan_update describes insert semantics and the unchecked reorder', () => {
    const tools = buildRegisteredServer();
    expect(tools.propose_plan_update.description).toContain(
      'addExercise inserts at orderIndex within its level',
    );
    expect(tools.propose_plan_update.description).toContain(
      'reorder renumbers the listed workoutExerciseIds 0..n-1 without checking which block they belong to',
    );
  });

  it('P150 D-21 the inputSchema of propose_new_plan carries the block meaning in its descriptions', () => {
    const tools = buildRegisteredServer();
    const jsonSchema = z.toJSONSchema(tools.propose_new_plan.inputSchema) as {
      properties: Record<string, { description?: string }>;
    };
    expect(jsonSchema.properties.standalone?.description).toBeDefined();
    expect(jsonSchema.properties.standalone?.description).toContain('rounds: 1');
    const blocksItemsProps = (
      jsonSchema.properties.blocks as unknown as {
        items?: { properties?: Record<string, { description?: string }> };
      }
    ).items?.properties;
    expect(blocksItemsProps?.rounds?.description).toBeDefined();
    expect(blocksItemsProps?.rounds?.description).toContain('rounds: 1 makes no sense');
  });
  it('P166 propose_exercise_update is registered with its description', () => {
    const tools = buildRegisteredServer();
    const tool = tools.propose_exercise_update;
    expect(tool, 'propose_exercise_update should be registered').toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(false);
    for (const part of [
      'Never changes it directly',
      'only the athlete applies it by accepting in the app',
      'translations, muscleGroups and capabilities',
      'replaces that list completely',
      'personal name and description per language',
      'the shared catalog never changes for anyone',
      'refused until phase 168.1',
      'EXERCISE_NOT_FOUND',
      'Equipment is not part of this proposal',
      'once the server has been deployed with it',
    ]) {
      expect(tool.description, `description should contain "${part}"`).toContain(part);
    }
    // Werkzeugtexte ohne Gedankenstriche (166 notes, rule 5).
    expect(tool.description).not.toMatch(/[\u2013\u2014]/);
    const jsonSchema = z.toJSONSchema(tool.inputSchema) as { properties: Record<string, { description?: string }> };
    expect(Object.keys(jsonSchema.properties).sort()).toStrictEqual(
      ['capabilities', 'exerciseId', 'muscleGroups', 'rationale', 'translations'],
    );
  });

  // ---------------------------------------------------------------------------
  // Phase 166-09 (MCP-09, GR-MCP-02, GR-MCP-06): tool texts against behaviour.
  // ---------------------------------------------------------------------------

  it('P166 no tool claims to read no encrypted data while its resolver decrypts', () => {
    const tools = registeredToolsWithModules(buildRegisteredServer());
    for (const tool of tools) {
      expect(existsSync(tool.modulePath), `module of ${tool.name} should exist at ${tool.modulePath}`).toBe(true);
    }
    const result = claimGate(tools, FS_READER);
    // NICHT GEMESSEN: the gate measured nothing, or could not tell decrypting from plain tools.
    expect(result.measured, 'NICHT GEMESSEN: not every registered tool was measured').toBe(20);
    expect(result.decrypting.length, 'NICHT GEMESSEN: no tool reaches decryption').toBeGreaterThanOrEqual(10);
    expect(result.notDecrypting.length, 'NICHT GEMESSEN: every tool reaches decryption').toBeGreaterThanOrEqual(1);
    // The resolvers of the snapshot tools reach src/crypto.ts through src/cache.ts.
    for (const name of ['get_template', 'get_suggestion', 'get_exercise_catalog', 'get_history', 'get_profile']) {
      expect(result.decrypting, `${name} reaches decryption`).toContain(name);
    }
    expect(result.violations, 'tools that claim to read no encrypted data while they decrypt').toStrictEqual([]);
  });

  it('P166 the claim gate reports a planted tool that decrypts and makes the claim', () => {
    const planted: Record<string, string> = {
      [join(SRC_DIR, 'tools', 'planted_decrypting.ts')]:
        "import { getSnapshot } from '../cache.js';\nexport const x = getSnapshot;\n",
      [join(SRC_DIR, 'tools', 'planted_type_only.ts')]:
        "import type { SnapshotCache } from '../cache.js';\nexport type X = SnapshotCache;\n",
      [join(SRC_DIR, 'tools', 'planted_plain.ts')]:
        "import { fetchSuggestions } from '../http.js';\nexport const y = fetchSuggestions;\n",
    };
    const reader: ModuleReader = {
      read: (p) => planted[p] ?? readFileSync(p, 'utf8'),
      exists: (p) => p in planted || existsSync(p),
    };
    const claim = 'Return something. This tool reads no encrypted training data and therefore carries no unreadable list.';
    const result = claimGate(
      [
        { name: 'planted_decrypting', description: claim, modulePath: join(SRC_DIR, 'tools', 'planted_decrypting.ts') },
        { name: 'planted_type_only', description: claim, modulePath: join(SRC_DIR, 'tools', 'planted_type_only.ts') },
        { name: 'planted_plain', description: claim, modulePath: join(SRC_DIR, 'tools', 'planted_plain.ts') },
      ],
      reader,
    );
    expect(result.measured).toBe(3);
    expect(result.decrypting).toStrictEqual(['planted_decrypting']);
    expect(result.violations).toStrictEqual(['planted_decrypting']);
    // An unresolvable import is never read as "decrypts nothing".
    const broken: ModuleReader = {
      read: () => "import { gone } from './does_not_exist.js';\n",
      exists: (p) => p === join(SRC_DIR, 'tools', 'planted_broken.ts'),
    };
    expect(() =>
      claimGate([{ name: 'planted_broken', description: claim, modulePath: join(SRC_DIR, 'tools', 'planted_broken.ts') }], broken),
    ).toThrow(/cannot resolve/);
  });

  it('P166 get_exercise_catalog describes own exercises with links origin CUSTOM and key user_exercise', () => {
    const description = buildRegisteredServer().get_exercise_catalog?.description ?? '';
    for (const part of [
      'origin',
      '"CUSTOM"',
      'user_exercise:<id>',
      'since phase 164',
      'muscle groups, equipment and capability ratings the athlete set',
      'not rated',
      'an own exercise that cannot be read is left out',
      'carries no unreadable list',
    ]) {
      expect(description, `get_exercise_catalog description should contain "${part}"`).toContain(part);
    }
    // The pre-164 sentence is gone (GR-MCP-06 class: stale texts).
    expect(description).not.toContain('carries no muscle-group, equipment or capability-axis rating');
    expect(description).not.toContain('never contributes to a weighted evaluation');
  });

  it('P166 proposal tools describe TIME as a target and MAX as a measurement for holds', () => {
    const tools = buildRegisteredServer();
    expect(PROPOSAL_HOLD_RULE).not.toMatch(/[–—]/);
    for (const name of PROPOSAL_TOOLS_WITH_MODE) {
      expect(tools[name]?.description, `${name} should carry the hold rule`).toContain(PROPOSAL_HOLD_RULE);
    }
    // A format entry has no MAX (FormatExerciseEntry: REPS or TIME), so the plan_update text says
    // where a hold to measure belongs.
    expect(tools.propose_plan_update.description).toContain(
      'formatParams entries know only REPS and TIME, so a hold to measure belongs in a CLASSIC template',
    );
  });

  it('P166 reading tools say a TIME set that ran out stores its target', () => {
    const tools = buildRegisteredServer();
    expect(READ_HOLD_RULE).toContain('a TIME set that ran out stores its target');
    expect(READ_HOLD_RULE).not.toMatch(/[–—]/);
    for (const name of READ_TOOLS_WITH_HOLD_TIMES) {
      expect(tools[name]?.description, `${name} should carry the read rule for hold times`).toContain(READ_HOLD_RULE);
    }
  });

  it('P166 every new output field of phase 166 is named in its tool description', () => {
    const tools = buildRegisteredServer();
    let checked = 0;
    for (const [name, fields] of Object.entries(NEW_FIELDS_166)) {
      const description = tools[name]?.description;
      expect(description, `${name} should be registered with a description`).toBeDefined();
      for (const field of fields) {
        expect(description, `${name} description should name the new field ${field}`).toContain(field);
        checked += 1;
      }
    }
    expect(checked, 'NICHT GEMESSEN: the list of new fields is shorter than the phase delivered').toBeGreaterThanOrEqual(30);
  });

  it('P166 every field whose meaning changed in phase 166 names its rule in its tool description', () => {
    const tools = buildRegisteredServer();
    for (const { tool, field, rule } of CHANGED_MEANING_166) {
      const description = tools[tool]?.description ?? '';
      expect(description, `${tool} description should name the field ${field}`).toContain(field);
      expect(description, `${tool} description should name the rule of ${field} since phase 166`).toContain(rule);
    }
    expect(CHANGED_MEANING_166.length, 'NICHT GEMESSEN: fewer changed fields than protocol §1.11 and §1.6 name').toBeGreaterThanOrEqual(6);
    // Every tool of the table "Existing fields that change meaning" (§1.11) and of §1.6 is covered.
    expect([...new Set(CHANGED_MEANING_166.map((c) => c.tool))].sort()).toStrictEqual(
      ['get_adherence', 'get_stats', 'get_training_state'],
    );
  });

  // Plan 166-10 (D-19, 156-GR-MCP-05 and 156-IN-MCP-04): without lang the own name follows the
  // app language (protocol §1.7 "Which language"); when that setting is missing (never chosen) or
  // unreadable, every tool with own names says so and how to get them, instead of leaving the
  // own names out without a word.
  it.each([
    'get_template', 'get_history', 'get_progress', 'get_training_state', 'get_stats', 'get_suggestion', 'get_exercise_catalog',
  ] as const)('P166 GR-MCP-05 %s explains that without lang a missing or unreadable app language leaves own names out', (name) => {
    const description = buildRegisteredServer()[name]?.description ?? '';
    expect(description).toContain(OWN_NAME_APP_LANGUAGE_SENTENCE);
  });

  it.each(['get_template', 'get_suggestion', 'get_exercise_catalog'] as const)(
    'P166 GR-MCP-02 %s says when an own name is missing although it carries no unreadable list',
    (name) => {
      const description = buildRegisteredServer()[name]?.description ?? '';
      for (const part of [
        'encrypted data',
        'up to 60 seconds',
        'cannot be read',
        'carries no unreadable list',
        'get_training_state',
      ]) {
        expect(description, `${name} description should contain "${part}"`).toContain(part);
      }
    },
  );
});
