/**
 * propose_new_exercise — catalog-dedupe then propose a brand-new exercise (D-04).
 *
 * Never mutates the catalog directly. First checks the cached catalog for a
 * name-normalized match (Pattern 6 `findCatalogMatch`, operating on the same
 * `getSnapshot().catalog` source `get_exercise_catalog` reads — functionally
 * equivalent to calling that handler, no redundant round-trip). On a match,
 * returns `{ dedupedTo: <existingUuid> }` without POSTing. On no match, builds
 * an allowlisted payload (name/mode/usesWeight/description, since Phase 166 plus the
 * optional translations/muscleGroups/capabilities/equipment of protocol §2.7, each only when
 * set — never a spread CatalogExercise), computes `changeHash`, stamps `sourceLlm`, and POSTs
 * a `new_exercise` proposal (no stale-guard hash is sent — a brand-new exercise
 * has nothing to stale-guard against).
 *
 * Exports:
 *   registerToolProposeNewExercise(server, cfg)   — registers the tool with the MCP server
 *   buildNewExercisePayload(args)                 — pure payload builder (corpus replay)
 *   catalogLinkVocabulary(catalog), findUnknownLinkKey(def, vocabulary)
 *                                                 — the key check of protocol §2.7, also used by
 *                                                   propose_plan_update, propose_new_plan and
 *                                                   propose_exercise_update
 *
 * Security (threat model):
 *   T-121-02: payload carries only allowlisted fields; matches referenced by `.id` only.
 *   T-121-01: on HttpError, console.error logs only the status; isError text carries
 *             only `HTTP <status>` — never the PAT or request body.
 *   T-121-07: handler body wrapped in try/catch — never an uncaught throw, never a
 *             byte on stdout (D-05).
 *   T-121-04: only console.error permitted (ESLint no-console allow:['error']).
 *
 * Patterns: RESEARCH.md Pattern 1 (registerTool convention), Pattern 6 (catalog dedupe).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeNewExerciseSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { findCatalogMatch } from '../dedupe.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';
import type {
  CapabilityLinkInput,
  CatalogExercise,
  EquipmentLinkInput,
  ExerciseTranslationInput,
  MuscleLinkInput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Pure helpers (Phase 166, plan 166-08) — importable for the corpus replay
// ---------------------------------------------------------------------------

export interface ProposeNewExerciseArgs {
  name: string;
  mode: 'REPS' | 'TIME' | 'MAX';
  usesWeight: boolean;
  rationale?: string;
  description?: string;
  translations?: ExerciseTranslationInput[];
  muscleGroups?: MuscleLinkInput[];
  capabilities?: CapabilityLinkInput[];
  equipment?: EquipmentLinkInput[];
}

/** The capability and equipment keys of the loaded catalog (protocol §2.7 "Keys, never ids"). */
export interface LinkVocabulary {
  capabilityKeys: ReadonlySet<string>;
  equipmentKeys: ReadonlySet<string>;
}

/**
 * The capability and equipment vocabulary of the catalog the MCP loaded: every key that a
 * catalog entry (curated or own) carries, the same keys `get_exercise_catalog` shows the coach.
 */
export function catalogLinkVocabulary(catalog: CatalogExercise[]): LinkVocabulary {
  const capabilityKeys = new Set<string>();
  const equipmentKeys = new Set<string>();
  for (const ex of catalog) {
    for (const c of ex.capabilities) capabilityKeys.add(c.key);
    for (const e of ex.equipment) equipmentKeys.add(e.key);
  }
  return { capabilityKeys, equipmentKeys };
}

/**
 * The first capability or equipment key of `def` the vocabulary does not know, as a tool error
 * text that names only the key (T-166-25: never the payload); `undefined` when every key is known.
 * Muscle keys are not checked here: the schema checks them against `MUSCLE_KEY`.
 */
export function findUnknownLinkKey(
  def: { capabilities?: { key: string }[]; equipment?: { key: string }[] },
  vocabulary: LinkVocabulary,
): string | undefined {
  for (const c of def.capabilities ?? []) {
    if (!vocabulary.capabilityKeys.has(c.key)) {
      return `UNKNOWN_CAPABILITY_KEY: "${c.key}" is not a capability key of the catalog (see get_exercise_catalog).`;
    }
  }
  for (const e of def.equipment ?? []) {
    if (!vocabulary.equipmentKeys.has(e.key)) {
      return `UNKNOWN_EQUIPMENT_KEY: "${e.key}" is not an equipment key of the catalog (see get_exercise_catalog).`;
    }
  }
  return undefined;
}

/**
 * The allowlisted `new_exercise` payload (T-121-02): name, mode, usesWeight, description, and
 * since Phase 166 the four optional fields of protocol §2.7, each only when set. A payload without
 * them is the 1.48 payload key for key, so its bytes and its `changeHash` stay the same.
 */
export function buildNewExercisePayload(args: ProposeNewExerciseArgs): Record<string, unknown> {
  return {
    name:       args.name,
    mode:       args.mode,
    usesWeight: args.usesWeight,
    ...(args.description ? { description: args.description } : {}),
    ...(args.translations !== undefined ? { translations: args.translations } : {}),
    ...(args.muscleGroups !== undefined ? { muscleGroups: args.muscleGroups } : {}),
    ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
    ...(args.equipment !== undefined ? { equipment: args.equipment } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_new_exercise` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposeNewExercise(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_new_exercise',
    {
      title:       'Propose New Exercise',
      description:
        'Propose a brand-new custom exercise for human review. Never creates it directly — ' +
        'the proposal is transported to the coach inbox for accept/reject. If the name matches ' +
        'an existing catalog exercise, returns the existing UUID instead of proposing a duplicate. ' +
        'Optional fields, none of them required: translations (name and description in languages ' +
        'other than en; name and description themselves are the base language en), muscleGroups ' +
        '(muscle keys, each with an optional level PRIMARY, SECONDARY or STABILIZER), capabilities ' +
        '(capability keys, each with a required level HAUPTREIZ, MITTRAINIERT or GERING) and ' +
        'equipment (equipment keys, each with an optional flag optional). Use the keys ' +
        'get_exercise_catalog shows; an unknown capability or equipment key is refused with an error ' +
        'that names it. Leave out a field you do not want to set; never send an empty list. The ' +
        'duplicate check compares the name and every translation name with the catalog names of ' +
        'every language. The athlete can change every field when accepting in the app. ' +
        'The mode of an exercise decides how a timed set runs: TIME counts down from ' +
        'targetTimeSeconds and ends the set at zero, so TIME is a target, and a set that ran out ' +
        'stores that target; MAX counts up until the athlete stops, so MAX is a measurement. Propose ' +
        'a maximal hold, for example a benchmark hold or any hold whose capacity you want to measure, ' +
        'with MAX, never with TIME; use TIME only where the time is a target not to exceed, such as a ' +
        'stretch held for a set time.',
      inputSchema: ProposeNewExerciseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposeNewExerciseArgs & { rationale: string };

        const data  = await getSnapshot(pat, keyB64, serverUrl);
        // Phase 166 (D-11, T-166-25): capability and equipment keys against the loaded catalog.
        const unknownKey = findUnknownLinkKey(typedArgs, catalogLinkVocabulary(data.catalog));
        if (unknownKey !== undefined) {
          return { isError: true, content: [{ type: 'text' as const, text: unknownKey }] };
        }
        const match = findCatalogMatch(
          typedArgs.name,
          data.catalog,
          (typedArgs.translations ?? []).map((t) => t.name),
        );
        if (match) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ dedupedTo: match.id }) }],
          };
        }

        const payload = buildNewExercisePayload(typedArgs);
        const changeHash = computeChangeHash('new_exercise', payload);
        const sourceLlm  = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'new_exercise',
            payload:   JSON.stringify(payload),
            rationale: typedArgs.rationale,
            sourceLlm,
            changeHash,
          },
          pat,
          serverUrl,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof HttpError) {
          console.error(`propose_new_exercise: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose new exercise error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
