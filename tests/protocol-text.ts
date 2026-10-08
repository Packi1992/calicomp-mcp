/**
 * Read a verbatim explanation from docs/COACH-PLANNING-PROTOCOL.md (Phase 155, §1.6
 * "Verbatim explanations") so a test can compare a constant with the protocol character for
 * character. The protocol lives in the CaliCompanion super-repo above this submodule; the path
 * is resolved from this file's own URL (cwd-independent), like `tests/shared-vectors.ts`.
 * Fails LOUDLY when the protocol or the block is missing — never a silent skip.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Path to the protocol, relative to this file's own directory (tests/). */
export const PROTOCOL_RELATIVE_PATH = '../../docs/COACH-PLANNING-PROTOCOL.md';

/**
 * The single line of the ```text block that follows the line `` `NAME` `` in the protocol.
 *
 * @param name The constant name, e.g. `FOREIGN_ADHERENCE_EXPLANATION`.
 */
export function protocolExplanation(name: string): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), PROTOCOL_RELATIVE_PATH);
  const lines = readFileSync(path, 'utf-8').split('\n');
  const heading = lines.indexOf(`\`${name}\``);
  if (heading < 0) throw new Error(`protocol has no line \`${name}\` (${path})`);
  const open = lines.indexOf('```text', heading);
  if (open < 0 || lines[open + 2] !== '```') {
    throw new Error(`protocol block after \`${name}\` is not a one-line text block (${path})`);
  }
  return lines[open + 1];
}
