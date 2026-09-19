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

## Credential Storage

The "Copy MCP config" button in the app's PAT settings screen produces the JSON block shown
under [Usage](#usage) below, with `CALICOMP_PAT` and `CALICOMP_KEY` filled in. That block is not
an ordinary configuration snippet — **both values are plaintext secrets**. `CALICOMP_KEY` in
particular is what turns the encrypted payload the server stores back into readable training
data; the server itself only ever sees ciphertext. Treat the whole block the same way you would
treat a password.

**Where it must NOT go:** any file your project's version control tracks. Pasting the block into
a repo-committed config file — even a "local" one that ends up staged by accident — puts a live
token and decryption key into git history, which is not something a later `git rm` undoes.

**Where it should go instead:** a file outside any repository that only your own user account
can read (`chmod 600`), or your MCP client's user-scope server registration instead of a
project-scope one. Concretely, the same approach this project uses for its own recurring MCP
calls: an env file under your user config directory (e.g. `~/.config/calicomp/mcp.env`, mode
`600`) that a wrapper script or your client's env-var substitution reads at invocation time — or,
if your client supports it directly, register the server in its *user* config rather than a
project's `.mcp.json` (Claude Code, for example, distinguishes `claude mcp add --scope user` from
a project-scoped registration). Either way, the secret lives in exactly one place your user
account controls, never in a directory a `git add .` could reach.

**What the snippet leaves out:** `CALICOMP_SERVER_URL`. For the hosted default
(`https://api.calicompanion.de`, see the table above) this is harmless — the server falls back to
that same default when the variable is absent, so registration works without it. If you run your
own server, however, the snippet gives you no hint that this variable exists or that you need to
add it by hand; without it you will silently talk to the wrong server with no error message
pointing at the cause. Add `CALICOMP_SERVER_URL` to the `env` block yourself in that case.

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

## Exercise Catalog: Curated Entries and Custom Exercises (since 1.1.0)

`get_exercise_catalog` — and every training-state calculation that resolves an exercise id —
returns two kinds of entries, distinguished by the `origin` field:

- **`"CATALOG"`** — the curated, admin-maintained catalog (`GET /api/exercises`). These carry
  muscle-group, equipment and capability-axis ratings.
- **`"CUSTOM"`** — a user's own exercise, created because they cannot write to the curated
  catalog at all. For the closed test circle this is the normal case, not an exception: a custom
  exercise is real training data, but it carries **no** muscle, equipment or capability rating —
  there is nothing to invent, so those fields are always empty. Treat an empty rating as "not
  rated", never as a measured zero.

**This does not replace curating the catalog.** If you have admin access and can run the
catalog round trip (`tools/exercise.mjs` in the super-repo), your own exercises still belong in
the curated catalog — cleanly, with real ratings. The `CUSTOM` read path exists for everyone who
cannot do that, so their training data is not silently invisible to the coach. Two user groups,
two answers; this section covers the one that has no other option.

`propose_new_exercise`'s duplicate check only ever matches against `"CATALOG"` entries — a
proposal for a new catalog exercise can never be blocked by someone else's same-named custom
exercise.

## Building

```bash
npm install
npm run build      # tsup → dist/index.js (shebang'd, single-file ESM)
npm run lint       # ESLint no-console gate
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```
