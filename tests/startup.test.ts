import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(__dirname, '..', 'dist', 'index.js');

const TEST_PAT = 'calicomp_pat_testpat1234567890abcdef';
const TEST_KEY = 'dGVzdGtleWJhc2U2NHZhbHVldGVzdA==';

function spawnEntry(env: Record<string, string>) {
  return spawnSync(process.execPath, [distEntry], {
    env: { ...env, PATH: process.env.PATH },
    timeout: 5000,
    encoding: 'utf-8',
  });
}

describe('startup fail-fast: missing CALICOMP_KEY', () => {
  it('exits non-zero when CALICOMP_KEY is absent', () => {
    const result = spawnEntry({ CALICOMP_PAT: TEST_PAT });
    expect(result.status).not.toBe(0);
  });

  it('writes the required error message to stderr', () => {
    const result = spawnEntry({ CALICOMP_PAT: TEST_PAT });
    expect(result.stderr).toContain('CALICOMP_PAT and CALICOMP_KEY');
  });

  it('does not leak the PAT value in any output', () => {
    const result = spawnEntry({ CALICOMP_PAT: TEST_PAT });
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    expect(combined).not.toContain('calicomp_pat_');
  });
});

describe('startup fail-fast: missing CALICOMP_PAT', () => {
  it('exits non-zero when CALICOMP_PAT is absent', () => {
    const result = spawnEntry({ CALICOMP_KEY: TEST_KEY });
    expect(result.status).not.toBe(0);
  });

  it('writes the required error message to stderr', () => {
    const result = spawnEntry({ CALICOMP_KEY: TEST_KEY });
    expect(result.stderr).toContain('CALICOMP_PAT and CALICOMP_KEY');
  });

  it('does not leak the KEY value in any output', () => {
    const result = spawnEntry({ CALICOMP_KEY: TEST_KEY });
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    expect(combined).not.toContain(TEST_KEY);
  });
});

// Protocol v1.15 §1.5 rule 4 (D-15): pruneExports() runs once, before the
// transport connects. This is verified structurally against the source
// rather than by spawning the real entry against the machine's real
// EXPORT_DIR — a subprocess test would either need to touch that real
// directory (which every other test in this plan deliberately avoids) or
// hang indefinitely waiting on stdio once the transport connects, since a
// successful startup never exits on its own.
describe('startup runs pruneExports before connecting the transport', () => {
  it('places the pruneExports() call before server.connect(transport) in src/index.ts', async () => {
    const source = await readFile(
      new URL('../src/index.ts', import.meta.url),
      'utf-8',
    );
    const pruneIndex = source.indexOf('pruneExports()');
    const connectIndex = source.indexOf('server.connect(transport)');

    expect(pruneIndex).toBeGreaterThan(-1);
    expect(connectIndex).toBeGreaterThan(-1);
    expect(pruneIndex).toBeLessThan(connectIndex);
  });

  it('awaits pruneExports() rather than firing-and-forgetting it', async () => {
    const source = await readFile(
      new URL('../src/index.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toMatch(/await\s+pruneExports\(\)/);
  });

  it('imports pruneExports from the single file-channel module', async () => {
    const source = await readFile(
      new URL('../src/index.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toMatch(/import\s*\{\s*pruneExports\s*\}\s*from\s*'\.\/file-channel\.js'/);
  });
});

// pruneExports() itself is proven never to throw under every tested failure
// mode (missing directory, per-entry stat/unlink failure) in
// tests/file-channel.test.ts — that non-throwing contract is exactly what
// guarantees a startup can never abort because of it. Nothing in src/index.ts
// wraps the call in its own try/catch, which is only safe because of that
// contract; this test pins the absence of a redundant wrapper as a marker
// that the design relies on file-channel.ts's own guarantee, not a local one.
describe('pruneExports failure isolation', () => {
  it('does not wrap the pruneExports() call in a local try/catch in src/index.ts', async () => {
    const source = await readFile(
      new URL('../src/index.ts', import.meta.url),
      'utf-8',
    );
    const pruneLine = source
      .split('\n')
      .find((line) => line.includes('pruneExports()'));
    expect(pruneLine).toBeDefined();
    expect(pruneLine).not.toMatch(/try|catch/);
  });
});
