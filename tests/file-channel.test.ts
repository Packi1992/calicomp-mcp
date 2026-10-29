/**
 * Tests for src/file-channel.ts — the Local File Channel (protocol v1.15 §1.5, D-15).
 *
 * Every test binds `writeExportFile`/`pruneExports` to an isolated temporary
 * directory created via `mkdtemp` and removed in `afterEach` — no test ever
 * writes into the real `EXPORT_DIR` (the machine's actual
 * `os.tmpdir()/calicomp-mcp-exports`).
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fileChannel from '../src/file-channel.js';
import { EXPORT_DIR, EXPORT_TTL_MS, pruneExports, writeExportFile } from '../src/file-channel.js';

// Phase 166 (D-09): the file name stays `randomUUID()`. To plant a symlink at the exact target
// name, one test fixes the next UUID; every other call goes to the real generator.
const nextUuid = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      const fixed = nextUuid.value;
      nextUuid.value = undefined;
      return (fixed ?? actual.randomUUID()) as ReturnType<typeof actual.randomUUID>;
    },
  };
});

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'file-channel-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('writeExportFile', () => {
  it('creates the directory if it does not exist yet', async () => {
    const nested = join(testDir, 'nested', 'export-dir');
    const handle = await writeExportFile({ a: 1 }, 1, nested);
    const stats = await stat(handle.path);
    expect(stats.isFile()).toBe(true);
  });

  it('writes a file whose name ends in .json', async () => {
    const handle = await writeExportFile({ a: 1 }, 1, testDir);
    expect(handle.path.endsWith('.json')).toBe(true);
  });

  it('produces different paths on two consecutive calls (UUID filename)', async () => {
    const first = await writeExportFile({ a: 1 }, 1, testDir);
    const second = await writeExportFile({ a: 2 }, 1, testDir);
    expect(first.path).not.toBe(second.path);
  });

  it('returns a path that lies inside the target directory', async () => {
    const handle = await writeExportFile({ a: 1 }, 1, testDir);
    expect(handle.path.startsWith(testDir)).toBe(true);
  });

  it('writes the file with mode 0600 on POSIX', async () => {
    const handle = await writeExportFile({ a: 1 }, 1, testDir);
    const stats = await stat(handle.path);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('reports bytes as the actual byte length of the written file', async () => {
    const payload = { long: 'x'.repeat(500) };
    const handle = await writeExportFile(payload, 3, testDir);
    const stats = await stat(handle.path);
    expect(handle.bytes).toBe(stats.size);
  });

  it('passes itemCount through unchanged', async () => {
    const handle = await writeExportFile({ a: 1 }, 42, testDir);
    expect(handle.itemCount).toBe(42);
  });

  it('writes valid JSON identical to the supplied payload', async () => {
    const payload = { sessions: [{ id: 's1' }], setLogs: [{ id: 'sl1' }] };
    const handle = await writeExportFile(payload, 2, testDir);
    const written = await readFile(handle.path, 'utf-8');
    expect(JSON.parse(written)).toEqual(payload);
  });
});

describe('pruneExports', () => {
  it('deletes a file older than EXPORT_TTL_MS and keeps a younger one', async () => {
    const oldPath = join(testDir, 'old.json');
    const freshPath = join(testDir, 'fresh.json');
    await writeFile(oldPath, '{}');
    await writeFile(freshPath, '{}');

    const now = Date.now();
    const oldTime = new Date(now - EXPORT_TTL_MS - 60_000);
    await utimes(oldPath, oldTime, oldTime);

    const deleted = await pruneExports(now, testDir);

    expect(deleted).toBe(1);
    const remaining = await readdir(testDir);
    expect(remaining).toEqual(['fresh.json']);
  });

  it('returns 0 and does not throw for a non-existent directory', async () => {
    const missing = join(testDir, 'does-not-exist');
    await expect(pruneExports(Date.now(), missing)).resolves.toBe(0);
  });

  it('returns the count of files actually deleted when one entry cannot be deleted', async () => {
    // A directory entry cannot be removed via `unlink` (EISDIR) — this exercises
    // the real per-entry failure path without mocking node:fs/promises.
    const deletablePath = join(testDir, 'deletable.json');
    const stuckDirPath = join(testDir, 'stuck-dir');
    await writeFile(deletablePath, '{}');
    await mkdir(stuckDirPath);

    const now = Date.now();
    const oldTime = new Date(now - EXPORT_TTL_MS - 60_000);
    await utimes(deletablePath, oldTime, oldTime);
    await utimes(stuckDirPath, oldTime, oldTime);

    const deleted = await pruneExports(now, testDir);

    expect(deleted).toBe(1);
    const remaining = await readdir(testDir);
    expect(remaining).toEqual(['stuck-dir']);
  });
});

// ---------------------------------------------------------------------------
// Phase 166 (MCP-07, D-09, D-21, protocol §1.5 rules 2 and 4): the configured export dir
// ---------------------------------------------------------------------------

// The functions under test are read through the module namespace, so this file still loads
// (and every other case still runs) before `resolveExportDir` exists.
type ResolveExportDir = (raw: string | undefined, home?: string, prunedDir?: string) => Promise<string>;
function resolveExportDir(raw: string | undefined, home?: string, prunedDir?: string): Promise<string> {
  const fn = (fileChannel as unknown as { resolveExportDir?: ResolveExportDir }).resolveExportDir;
  if (typeof fn !== 'function') throw new Error('resolveExportDir is not exported by src/file-channel.ts');
  return fn(raw, home, prunedDir);
}

describe('P166 configured export dir', () => {
  it('P166 the export dir comes from CALICOMP_EXPORT_DIR and a leading tilde expands to the home dir', async () => {
    const home = join(testDir, 'home');
    await mkdir(join(home, 'training', 'personal'), { recursive: true });
    const dir = await resolveExportDir('~/training/personal', home);
    expect(dir).toBe(await realpath(join(home, 'training', 'personal')));
    const handle = await writeExportFile({ a: 1 }, 1, dir);
    expect(handle.path.startsWith(dir + '/')).toBe(true);
    // The start reads exactly this variable, once, and nothing from a tool argument.
    const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf-8');
    expect(index).toMatch(/resolveExportDir\(\s*process\.env\.CALICOMP_EXPORT_DIR\s*\)/);
  });

  it('P166 a relative export dir is rejected at start', async () => {
    for (const raw of ['training/personal', './exports', '~other/exports']) {
      const failure = await resolveExportDir(raw, testDir).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(failure).toBeInstanceOf(Error);
      // The message names the variable, never the configured path.
      expect(failure?.message).toContain('CALICOMP_EXPORT_DIR');
      expect(failure?.message).not.toContain(raw);
    }
    // A missing directory and a file are refused the same way.
    const asFile = join(testDir, 'a-file');
    await writeFile(asFile, 'x');
    for (const raw of [join(testDir, 'missing'), asFile]) {
      const failure = await resolveExportDir(raw, testDir).then(() => null, (e: unknown) => e as Error);
      expect(failure?.message).toContain('CALICOMP_EXPORT_DIR');
      expect(failure?.message).not.toContain(testDir);
    }
  });

  it('P166 a symlinked export dir is resolved once at start', async () => {
    const real = join(testDir, 'real');
    const other = join(testDir, 'other');
    await mkdir(real);
    await mkdir(other);
    const link = join(testDir, 'link');
    await symlink(real, link);
    const dir = await resolveExportDir(link, testDir);
    expect(dir).toBe(await realpath(real));
    // Retargeting the link after the start does not move the writes.
    await unlink(link);
    await symlink(other, link);
    const handle = await writeExportFile({ a: 1 }, 1, dir);
    expect(await readdir(real)).toHaveLength(1);
    expect(await readdir(other)).toHaveLength(0);
    expect(handle.path.startsWith(dir + '/')).toBe(true);
  });

  it('P166 a symlink at the target name is refused', async () => {
    const dir = await resolveExportDir(testDir, testDir);
    const victim = join(testDir, 'victim.txt');
    await writeFile(victim, 'untouched');
    const fixed = '00000000-0000-4000-8000-000000000166';
    await symlink(victim, join(dir, `${fixed}.json`));
    nextUuid.value = fixed;
    const failure = await writeExportFile({ secret: 'plaintext' }, 1, dir).then(() => null, (e: unknown) => e as NodeJS.ErrnoException);
    expect(failure).not.toBeNull();
    expect(['EEXIST', 'ELOOP']).toContain(failure?.code);
    expect(await readFile(victim, 'utf-8')).toBe('untouched');
    expect((await lstat(join(dir, `${fixed}.json`))).isSymbolicLink()).toBe(true);
    // The writer opens with O_EXCL and O_NOFOLLOW, never through a plain writeFile.
    const source = await readFile(new URL('../src/file-channel.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/O_WRONLY\s*\|\s*constants\.O_CREAT\s*\|\s*constants\.O_EXCL\s*\|\s*constants\.O_NOFOLLOW/);
  });

  it('P166 export files are created with mode 0600', async () => {
    const dir = await resolveExportDir(testDir, testDir);
    const handle = await writeExportFile({ a: 1 }, 1, dir);
    expect((await stat(handle.path)).mode & 0o777).toBe(0o600);
  });

  it('P166 an old file in the configured dir survives the prune', async () => {
    const configured = join(testDir, 'configured');
    const pruned = join(testDir, 'pruned');
    await mkdir(configured);
    await mkdir(pruned);
    const now = Date.now();
    const oldTime = new Date(now - EXPORT_TTL_MS - 60_000);
    const keep = join(configured, 'athlete-notes.json');
    const stale = join(pruned, 'stale.json');
    await writeFile(keep, '{}');
    await writeFile(stale, '{}');
    await utimes(keep, oldTime, oldTime);
    await utimes(stale, oldTime, oldTime);

    const dir = await resolveExportDir(configured, testDir, pruned);
    await pruneExports(now, pruned);
    expect(await readdir(dir)).toEqual(['athlete-notes.json']);
    expect(await readdir(pruned)).toEqual([]);
    // The pruned tmpdir directory can never be the configured one.
    const same = await resolveExportDir(pruned, testDir, pruned).then(() => null, (e: unknown) => e as Error);
    expect(same?.message).toContain('CALICOMP_EXPORT_DIR');
    // The start prunes only the tmpdir directory: one call, without a directory argument.
    const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf-8');
    expect(index.match(/pruneExports\(/g)).toHaveLength(1);
    expect(index).toMatch(/await\s+pruneExports\(\)/);
  });

  it('P166 without the variable exports go to the tmpdir dir as before', async () => {
    expect(await resolveExportDir(undefined, testDir)).toBe(EXPORT_DIR);
    expect(await resolveExportDir('', testDir)).toBe(EXPORT_DIR);
    expect(EXPORT_DIR).toBe(join(tmpdir(), 'calicomp-mcp-exports'));
  });
});

describe('module hygiene', () => {
  it('never calls console.log, console.warn, or console.error', async () => {
    const source = await readFile(new URL('../src/file-channel.ts', import.meta.url), 'utf-8');
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toMatch(/console\.(log|warn|error)/);
  });
});
