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
 *   EXPORT_DIR      — fixed export directory under os.tmpdir(); never a
 *                      caller-supplied value
 *   EXPORT_TTL_MS   — 24 hours in milliseconds; files older than this are
 *                      deleted at process startup
 *   ExportHandle    — { path, bytes, itemCount } — what a tool result reports
 *   writeExportFile — writes a payload to a fresh file, returns its handle
 *   pruneExports    — deletes stale export files; never throws
 *
 * Security (threat model, Plan 137-06):
 *   T-137-05 (Information Disclosure): decrypted training data could survive the
 *     conversation on disk. Mitigated by mode 0600 (owner read/write only),
 *     placement under os.tmpdir() (never the repo or the home directory), and
 *     TTL-based pruning at every process startup. The channel opens ONLY on the
 *     caller's explicit `outputFile: true` — there is no size threshold or other
 *     heuristic that opens it (protocol v1.15 §1.5 rule 1).
 *   T-137-06 (Tampering — path traversal): a caller could try to steer the write
 *     target. Mitigated structurally: the path is always built from EXPORT_DIR
 *     plus `randomUUID()`. No caller-supplied string ever reaches path
 *     construction. The `dir` parameter below is a TEST SEAM ONLY — it is never
 *     wired to any tool argument.
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

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fixed export directory. A module-level constant, not a parameter — the
 * export location is never a caller decision (protocol v1.15 §1.5 rule 2).
 */
export const EXPORT_DIR = join(tmpdir(), 'calicomp-mcp-exports');

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
 * Write `payload` to a fresh JSON file inside `dir` and return its handle.
 *
 * The `dir` parameter is a TEST SEAM ONLY. Production callers always rely on
 * the default (`EXPORT_DIR`) — it is never connected to any tool argument, so
 * no caller-supplied string can ever reach path construction (T-137-06).
 *
 * @param payload   The full tool result to persist — never echoed back to the
 *                   caller (protocol v1.15 §1.5 rule 5).
 * @param itemCount The number of items the payload represents (sessions,
 *                   set-logs, etc.) — passed through unchanged into the handle.
 * @param dir       Test seam only. Defaults to `EXPORT_DIR`.
 */
export async function writeExportFile(
  payload: unknown,
  itemCount: number,
  dir: string = EXPORT_DIR,
): Promise<ExportHandle> {
  await mkdir(dir, { recursive: true });
  const json = JSON.stringify(payload);
  const path = join(dir, `${randomUUID()}.json`);
  // Owner read/write only (protocol v1.15 §1.5 rule 3).
  await writeFile(path, json, { mode: 0o600 });
  return { path, bytes: Buffer.byteLength(json), itemCount };
}

/**
 * Delete every file in `dir` whose modification time is older than
 * `EXPORT_TTL_MS` relative to `now`. Returns the number of files deleted.
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
