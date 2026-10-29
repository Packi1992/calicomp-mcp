/**
 * propose_exercise_update — STUB (red commit of plan 166-08). The real tool follows in the
 * green commit; this file only exists so the tests can import its exports.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeExerciseUpdateSchema } from '../schemas.js';
import type { LinkVocabulary } from './propose_new_exercise.js';

export interface ProposeExerciseUpdateArgs {
  exerciseId: string;
  rationale?: string;
}

/** STUB: refuses nothing yet. */
export function validateExerciseUpdate(
  _args: ProposeExerciseUpdateArgs,
  _target: { origin: 'CATALOG' | 'CUSTOM' } | undefined,
  _vocabulary: LinkVocabulary,
): string | undefined {
  return undefined;
}

/** STUB: carries only the id. */
export function buildExerciseUpdatePayload(args: ProposeExerciseUpdateArgs): Record<string, unknown> {
  return { exerciseId: args.exerciseId };
}

export function registerToolProposeExerciseUpdate(
  server: McpServer,
  _cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  server.registerTool(
    'propose_exercise_update',
    {
      title: 'Propose Exercise Update',
      description: 'STUB',
      inputSchema: ProposeExerciseUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => ({ isError: true, content: [{ type: 'text' as const, text: 'not implemented' }] }),
  );
}
