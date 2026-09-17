/**
 * Tests for src/file-channel.ts — the Local File Channel (protocol v1.15 §1.5, D-15).
 *
 * Every test binds `writeExportFile`/`pruneExports` to an isolated temporary
 * directory created via `mkdtemp` and removed in `afterEach` — no test ever
 * writes into the real `EXPORT_DIR` (the machine's actual
 * `os.tmpdir()/calicomp-mcp-exports`).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_TTL_MS, pruneExports, writeExportFile } from '../src/file-channel.js';

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
