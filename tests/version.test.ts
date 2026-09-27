import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';

// Phase 151 review round 2, IN-02: the MCP handshake must report the package version, not a
// hard-coded 0.1.0 -- the athlete checks serverInfo.version after a restart to see whether the
// client loaded the newly published release.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

// Starts the BUILT entry (same artefact npm ships) and performs a real MCP initialize over stdio.
// TMPDIR points at a fresh directory, so the startup pruneExports() only ever sees that directory,
// never the machine's real export directory. No tool is called, so no network request is made.
async function handshakeServerInfo(): Promise<{ name: string; version: string }> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'calicomp-mcp-version-test-'));
  const child = spawn(process.execPath, [distEntry], {
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmp,
      CALICOMP_PAT: 'calicomp_pat_testpat1234567890abcdef',
      CALICOMP_KEY: 'dGVzdGtleWJhc2U2NHZhbHVldGVzdA==',
      CALICOMP_SERVER_URL: 'http://127.0.0.1:9',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    return await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('no initialize response within 10 s')), 10_000);
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`server exited early with ${String(code)}`)));
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue;
          let msg: { id?: number; result?: { serverInfo?: { name: string; version: string } } };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue; // incomplete line, wait for more data
          }
          if (msg.id === 1 && msg.result?.serverInfo) {
            clearTimeout(timer);
            resolve(msg.result.serverInfo);
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'version-test', version: '0.0.0' },
          },
        }) + '\n',
      );
    });
  } finally {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('server version (IN-02)', () => {
  it('SERVER_VERSION is the version from package.json', async () => {
    expect(SERVER_VERSION).toBe(await packageVersion());
    expect(SERVER_NAME).toBe('calicomp');
  });

  it('the built server reports the package version in the MCP handshake', async () => {
    const serverInfo = await handshakeServerInfo();
    expect(serverInfo.name).toBe('calicomp');
    expect(serverInfo.version).toBe(await packageVersion());
    expect(serverInfo.version).not.toBe('0.1.0');
  });

  it('src/index.ts takes name and version from src/version.ts, no literal version', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/new McpServer\(\{\s*name:\s*SERVER_NAME,\s*version:\s*SERVER_VERSION\s*\}\)/);
    expect(source).not.toMatch(/version:\s*'\d+\.\d+\.\d+'/);
  });
});
