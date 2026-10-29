/**
 * file-channel.ts — the Local File Channel (protocol v1.15 §1.5, D-15).
 *
 * The MCP is a local stdio process. Everything a tool *returns* travels through
 * the model's context — there is no MCP content type that bypasses it for this
 * stdio chat setup (see protocol v1.15 §1.5's own rejection of `structuredContent`
 * for this purpose). A local process CAN, however, write a file to local disk and
 * hand back nothing but its path, byte size and scope — the numbers themselves
 * never have to pass through the model.
 *
 * This module is the ONLY place in this codebase that writes to the filesystem.
 * It is the first filesystem write operation in the entire MCP codebase and is
 * therefore this phase's one genuinely new attack surface.
 *
 * Exports:
 *   EXPORT_DIR      — the default export directory under os.tmpdir(); never a
 *                      caller-supplied value
 *   EXPORT_DIR_ENV  — `CALICOMP_EXPORT_DIR`, the one variable that configures the
 *                      export directory (Phase 166, D-09, D-21)
 *   EXPORT_TTL_MS   — 24 hours in milliseconds; files older than this are
 *                      deleted from EXPORT_DIR at process startup
 *   ExportHandle    — { path, bytes, itemCount } — what a tool result reports
 *   ExportDirError  — the start error for an unusable CALICOMP_EXPORT_DIR
 *   resolveExportDir — resolves the export directory once at start
 *   writeExportFile — writes a payload to a fresh file, returns its handle
 *   pruneExports    — deletes stale export files; never throws
 *
 * Security (threat model, Plan 137-06):
 *   T-137-05 (Information Disclosure): decrypted training data could survive the
 *     conversation on disk. Mitigated by mode 0600 (owner read/write only) and,
 *     without CALICOMP_EXPORT_DIR, placement under os.tmpdir() with TTL-based
 *     pruning at every process startup. The channel opens ONLY on the caller's
 *     explicit `outputFile: true` — there is no size threshold or other heuristic
 *     that opens it (protocol §1.5 rule 1).
 *     Carried forward in Phase 166 (protocol 1.49, D-09, D-21, T-166-20): the
 *     athlete MAY set CALICOMP_EXPORT_DIR to a directory of his own (for example
 *     `~/training/personal`). Then the plaintext export lands there on purpose and
 *     stays: the TTL prune never runs in the configured directory (rule 4,
 *     T-166-21), because it would delete the athlete's files after 24 hours. That
 *     the data survives the conversation is the point of the setting, and still
 *     happens only on an explicit `outputFile: true`, with mode 0600.
 *   T-137-06 (Tampering — path traversal): a caller could try to steer the write
 *     target. Mitigated structurally: the path is always built from the export
 *     directory plus `randomUUID()`. No caller-supplied string ever reaches path
 *     construction — no directory and no file name from a tool argument.
 *     Carried forward in Phase 166 (T-166-19): the export directory is either
 *     EXPORT_DIR or the value of CALICOMP_EXPORT_DIR, which only the athlete sets
 *     in the MCP configuration, resolved ONCE at start by `resolveExportDir`
 *     (a leading `~/` expands to the home directory, otherwise the value must be
 *     absolute; `realpath` resolves a symlinked directory once, and the result
 *     must be a directory). A later change of a symlink therefore cannot move the
 *     writes. The file itself is created with
 *     `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, so a file or a
 *     symlink planted at the target name is refused instead of followed or
 *     overwritten. The `dir` parameter of `writeExportFile` carries only that
 *     start-resolved directory (index.ts) or a test directory — it is never wired
 *     to any tool argument.
 *   T-137-07 (Information Disclosure — error text): `pruneExports` never throws,
 *     so a cleanup failure can never surface a path or credential fragment
 *     through an error message. `writeExportFile`'s own errors carry no
 *     credential material; callers apply their existing generic catch (T-120-17).
 *
 * stdout discipline (T-120-18): this module never writes to stdout or stderr.
 * stdout is the JSON-RPC channel exclusively; a cleanup failure here is
 * best-effort housekeeping, not a contract, so it stays silent rather than use
 * the one output channel that belongs to the protocol.
 *
 * Every rule enforced here traces back to protocol v1.15 §1.5 ("The Local File
 * Channel"), which is the single source of truth for the numbered rules.
 */

import { constants, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Fixed export directory. A module-level constant, not a parameter — the
 * export location is never a caller decision (protocol v1.15 §1.5 rule 2).
 */
export const EXPORT_DIR = join(tmpdir(), 'calicomp-mcp-exports');

/** The one environment variable that configures the export directory (Phase 166, D-09). */
export const EXPORT_DIR_ENV = 'CALICOMP_EXPORT_DIR';

/**
 * 24 hours in milliseconds. A stdio MCP process typically lives for the
 * duration of one conversation, so the next process start is the reliable
 * cleanup opportunity — a background timer would be unreliable in a
 * short-lived process (protocol v1.15 §1.5 rule 4).
 */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExportHandle {
  path: string;
  bytes: number;
  itemCount: number;
}

/**
 * The start error for an unusable CALICOMP_EXPORT_DIR. Its message names the
 * variable and the rule, never the configured path (protocol §1.5 rule 2): the
 * value is the athlete's own and has no place in a log line.
 */
export class ExportDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportDirError';
  }
}

/**
 * Resolve the export directory ONCE at process start (protocol §1.5 rule 2,
 * Phase 166, D-09, D-21).
 *
 *   - `raw` missing or empty: EXPORT_DIR under os.tmpdir(), exactly as before.
 *   - a leading `~/` (or `~` alone) expands to `home`; `~user` is not supported.
 *   - otherwise the value must be absolute.
 *   - `realpath` resolves a symlinked directory once; the result must be an
 *     existing directory, and it must not be the pruned tmpdir directory.
 *
 * Throws ExportDirError, whose message names CALICOMP_EXPORT_DIR and never the
 * path.
 *
 * @param raw       The value of CALICOMP_EXPORT_DIR (never a tool argument).
 * @param home      The home directory for `~/`. Defaults to `os.homedir()`.
 * @param prunedDir Test seam only. The directory `pruneExports` sweeps at start;
 *                  defaults to `EXPORT_DIR`.
 */
export async function resolveExportDir(
  raw: string | undefined,
  home: string = homedir(),
  prunedDir: string = EXPORT_DIR,
): Promise<string> {
  if (raw === undefined || raw === '') return EXPORT_DIR;
  let candidate: string;
  if (raw === '~') candidate = home;
  else if (raw.startsWith('~/')) candidate = join(home, raw.slice(2));
  else if (isAbsolute(raw)) candidate = raw;
  else {
    throw new ExportDirError(
      `${EXPORT_DIR_ENV} must be an absolute path or start with ~/; the configured value is neither.`,
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ExportDirError(`${EXPORT_DIR_ENV} does not name an existing directory.`);
  }
  let prunedResolved: string | null = null;
  try {
    prunedResolved = await realpath(prunedDir);
  } catch {
    prunedResolved = null; // the tmpdir directory does not exist yet, so it cannot be the same
  }
  if (prunedResolved !== null && prunedResolved === resolved) {
    // Rule 4: the TTL prune sweeps that directory, so it can never be the configured one.
    throw new ExportDirError(`${EXPORT_DIR_ENV} must not name the temporary export directory of the MCP.`);
  }
  return resolved;
}

/**
 * Write `payload` to a fresh JSON file inside `dir` and return its handle.
 *
 * `dir` is the export directory that `resolveExportDir` resolved once at start
 * (index.ts hands it to the tools through their config), or a test directory. It
 * is never connected to any tool argument, so no caller-supplied string can ever
 * reach path construction (T-137-06, T-166-19). The file name is always
 * `randomUUID()` plus `.json`; the file is created with
 * `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, so an existing file or
 * symlink at that name is refused, never followed or overwritten.
 *
 * @param payload   The full tool result to persist — never echoed back to the
 *                   caller (protocol v1.15 §1.5 rule 5).
 * @param itemCount The number of items the payload represents (sessions,
 *                   set-logs, etc.) — passed through unchanged into the handle.
 * @param dir       The start-resolved export directory. Defaults to `EXPORT_DIR`.
 */
export async function writeExportFile(
  payload: unknown,
  itemCount: number,
  dir: string = EXPORT_DIR,
): Promise<ExportHandle> {
  await mkdir(dir, { recursive: true });
  const json = JSON.stringify(payload);
  const path = join(dir, `${randomUUID()}.json`);
  // Owner read/write only (protocol §1.5 rule 3); a new file only, never through a
  // symlink at the target name (rule 2, Phase 166).
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(json);
  } finally {
    await file.close();
  }
  return { path, bytes: Buffer.byteLength(json), itemCount };
}

/**
 * Delete every file in `dir` whose modification time is older than
 * `EXPORT_TTL_MS` relative to `now`. Returns the number of files deleted.
 *
 * Runs ONLY over the tmpdir directory EXPORT_DIR (index.ts calls it without a
 * directory), never over the directory configured by CALICOMP_EXPORT_DIR
 * (protocol §1.5 rule 4, Phase 166, T-166-21); `resolveExportDir` refuses a
 * configured value equal to EXPORT_DIR.
 *
 * This function is cleanup work, not a contract: a missing directory, a
 * `stat` failure, or an `unlink` failure never throws — the function always
 * resolves. A process start that cannot clean up must never fail to start.
 *
 * @param now Reference instant (ms since epoch). Defaults to `Date.now()`.
 * @param dir Test seam only. Defaults to `EXPORT_DIR`.
 */
export async function pruneExports(
  now: number = Date.now(),
  dir: string = EXPORT_DIR,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  let deleted = 0;
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      const info = await stat(entryPath);
      if (now - info.mtimeMs > EXPORT_TTL_MS) {
        await unlink(entryPath);
        deleted++;
      }
    } catch {
      // One entry's stat/unlink failure must never abort the sweep.
      continue;
    }
  }
  return deleted;
}
