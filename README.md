# CalisthenicsCompanion-MCP

Local stdio MCP server for CalisthenicsCompanion.

**Package name:** `@gehlich/calicomp-mcp`

## Purpose

Allows an LLM client (e.g. Claude Desktop) to read a user's locally-decrypted
training data and propose plan updates — without any direct mutations.

## Repository Layout

```
CalisthenicsCompanion-MCP/
├── src/
│   ├── index.ts          # Fail-fast entry point, MCP server setup
│   ├── crypto.ts         # AES-256-GCM decrypt (parity with Android CryptoManager)
│   ├── http.ts           # Authenticated HTTP client for /api/mcp/data/pull
│   ├── cache.ts          # In-memory snapshot cache (TTL 60 s)
│   ├── types.ts          # TypeScript types (DecryptedSnapshot, etc.)
│   ├── schemas.ts        # Zod schemas for tool inputs
│   ├── e1rm.ts           # Epley e1RM formula (parity with Android)
│   └── tools/            # Tool handlers (get_profile, list_templates, …)
├── tests/
│   ├── startup.test.ts   # Fail-fast env-check spawn tests
│   ├── crypto.test.ts    # AES-256-GCM cross-language parity fixture test
│   └── …
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── .eslintrc.json
```

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `CALICOMP_PAT` | Personal Access Token (prefixed `calicomp_pat_`). Created in the CalisthenicsCompanion app. |
| `CALICOMP_KEY` | AES-256 encryption key in raw base64 (no prefix). Exported from the app alongside the PAT. |
| `CALICOMP_SERVER_URL` | *(Optional)* Override the API base URL. Defaults to `https://api.calicompanion.de`. |

## Transport

Runs as a local stdio MCP server. The LLM client communicates via JSON-RPC 2.0
over stdin/stdout. All diagnostics are written to stderr only — stdout is the
exclusive JSON-RPC channel.

## Usage

```json
{
  "mcpServers": {
    "calicomp": {
      "command": "npx",
      "args": ["-y", "@gehlich/calicomp-mcp"],
      "env": {
        "CALICOMP_PAT": "<your-pat>",
        "CALICOMP_KEY": "<your-key-base64>"
      }
    }
  }
}
```

## Building

```bash
npm install
npm run build      # tsup → dist/index.js (shebang'd, single-file ESM)
npm run lint       # ESLint no-console gate
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```
