import { createRequire } from 'node:module';

// Name and version the server reports in the MCP handshake (serverInfo). The version has exactly
// one source: package.json. Read at runtime relative to this module -- src/version.ts (tests) and
// the bundled dist/index.js (what npm ships) both sit one level below the package root, and npm
// always ships package.json. Phase 151 review round 2 IN-02: the handshake used to report a
// hard-coded 0.1.0, so the athlete could not tell which release the client had loaded.
const requireJson = createRequire(import.meta.url);
const pkg = requireJson('../package.json') as { version: string };

export const SERVER_NAME = 'calicomp';
export const SERVER_VERSION: string = pkg.version;
