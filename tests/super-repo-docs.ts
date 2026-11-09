/**
 * Find a file of `docs/` in the CaliCompanion super-repo above this submodule checkout.
 *
 * Tests that read the protocol or the shared vector corpus used fixed relative paths from their own directory
 * (`tests/../../docs/...`). Those paths break as soon as the test files run from another place, which is exactly what
 * Stryker does with `inPlace: false`: it copies the project to `.stryker-tmp/sandbox-<id>/` and runs the tests there
 * (166.1 review IN-14). Walking up from the start directory until `<dir>/docs/<name>` exists reaches the same file
 * from the checkout (`tests/`, `tests/tools/`) and from the sandbox. Resolution stays cwd-independent: callers pass
 * the directory of their own module URL.
 *
 * Returns `undefined` when no directory up to the file-system root has the file; the callers then build the path the
 * plain checkout layout would give, so their loud "not found" error names a concrete path (never a silent skip).
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findSuperRepoDoc(name: string, fromDir: string): string | undefined {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, 'docs', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
