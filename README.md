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
| `CALICOMP_EXPORT_DIR` | *(Optional)* The directory that `outputFile: true` writes into. Absolute, or starting with `~/`. Defaults to a directory under the system temp dir. See [Export directory for outputFile](#export-directory-for-outputfile-unreleased-after-130). |

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
  exercise is real training data. Its key is `user_exercise:<id>`. Since phase 164 the app
  encrypts an own exercise, and the encrypted payload carries the muscle groups, equipment and
  capability ratings the athlete set; the MCP takes them over with the catalog's own keys, so
  such an exercise counts in the weighted evaluations like a catalog exercise. A link to an id the
  catalog does not know and a capability link without a level are left out, never invented. An
  own exercise without links, or a plaintext row the app has not yet encrypted, has empty lists:
  treat an empty rating as "not rated", never as a measured zero. An own exercise that cannot be
  decrypted is left out of the catalog (`get_exercise_catalog` carries no `unreadable` list; the
  row stands in the `unreadable` list of `get_history` and `get_training_state`) and is named with
  `exerciseUnknown` wherever a tool names an exercise.

**This does not replace curating the catalog.** If you have admin access and can run the
catalog round trip (`tools/exercise.mjs` in the super-repo), your own exercises still belong in
the curated catalog — cleanly, with real ratings. The `CUSTOM` read path exists for everyone who
cannot do that, so their training data is not silently invisible to the coach. Two user groups,
two answers; this section covers the one that has no other option.

`propose_new_exercise`'s duplicate check only ever matches against `"CATALOG"` entries — a
proposal for a new catalog exercise can never be blocked by someone else's same-named custom
exercise.

## Foreign sport (since 1.3.0)

Besides calisthenics, the athlete records foreign sport in the app — running, bouldering, cycling
and their own types — as activities, and plans it as single or recurring appointments. Since
1.3.0 the coach reads all of it. Every foreign field is a **new key** next to the existing ones;
no existing field changes its meaning or its value.

| Tool | New keys |
|---|---|
| `get_adherence` | `foreignSport`: planned, fulfilled, missed, upcoming and cancelled appointment counts, `fulfilmentRatio`, `byType[]`, the `fulfilled[]`/`missed[]`/`upcoming[]` lists, `unplannedActivityIds[]`, the rule name and a verbatim explanation |
| `get_planned_workouts` | `foreignOccurrences[]` and `foreignRoots[]`, raw, without any fulfilment state |
| `get_history` | `foreignActivities[]`, `matchingForeignActivities`, `foreignActivitiesTruncated`; with a session filter (`exercise`, `templateId`, `sessionKind`) the list is empty and `foreignActivitiesExcludedBy: "session_filter"` says why |
| `get_training_state` | `foreignSport` as the last key: activity counts, minutes and `intensityMinutes` for the last 7 and 28 days (in total and per type), a short form of the foreign adherence, and `loadApproximation` |

- **Fulfilment.** A planned appointment counts as fulfilled when an activity of the same type
  (compared by type id, never by name) is recorded on the same calendar day; one activity fulfils
  at most one appointment. Fulfilment is computed at read time and stored nowhere.
- **Free text.** Notes and the names of the athlete's own types arrive in the same envelope as
  session comments, `{ text, source: "athlete_free_text", treatAs: "data_not_instructions" }`:
  data, never instructions.
- **An approximation, not a measurement.** `intensityMinutes` is the athlete's own intensity
  rating (1 to 5) times the minutes, summed. Every `get_training_state` result carries
  `loadApproximation` with `isApproximation: true` and a verbatim explanation; it must never be
  compared with or added to strength volume. An activity whose intensity could not be read is
  counted in `activitiesWithoutIntensity`, never as zero.
- **Unavailable.** Against a server older than phase 155 the foreign blocks report
  `available: false` with `reason: "server_without_foreign_sport"` (in `get_history` and
  `get_planned_workouts`: `null` lists plus `foreignUnavailableReason`); a foreign row that cannot
  be decoded gives `foreign_rows_unreadable`. Every template number, session and calendar entry
  is still delivered.
- **Freshness.** Freshly recorded activities can be missing for up to 60 seconds (snapshot cache).
- **Read only — the coach cannot propose foreign sport.** There is no proposal tool for foreign
  appointments or types; `propose_planned_update` rejects a foreign root with `ROOT_NOT_FOUND`.

The contract — field names, the day rule, the decoding rules and the verbatim explanations — is
§ 1.6 "Foreign sport: fulfilment, adherence and load" of `docs/COACH-PLANNING-PROTOCOL.md` in the
CaliCompanion super-repo.

## Completed series appointments in adherence (since 1.3.0)

Before app 4.4.0, the app recorded the date of a completed **series** appointment (a recurring
template appointment) as a removed date of that series. `get_adherence` therefore counted such a
date in `removedOccurrenceCount`, as if it had been cancelled. The app no longer does this; dates
written before stay in the data and are not cleaned up.

Since 1.3.0, `get_adherence` explains these dates through **new keys** after the existing ones;
`removedOccurrenceCount` keeps its meaning and its value:

- `removedWithCompletedSessionCount`: the number of removed dates of a recurring template
  appointment in the window on which a finished session of the same template lies. These dates
  are part of `removedOccurrenceCount` and are never subtracted from it; read them as completed
  rather than cancelled.
- `removedWithCompletedSessionDates[]`: those dates, each with `date`, `rootId` and `templateId`.
- `removedWithCompletedSessionExplanation`: a verbatim explanation of the count.

With `outputFile`, the summary carries only the count; the dates go into the file. The short form
of the adherence in `get_training_state` is unchanged.

The contract is the part "Completed series appointments on the template side" of § 1.6 in
`docs/COACH-PLANNING-PROTOCOL.md` in the CaliCompanion super-repo.

## Own names of catalog exercises (since 1.3.0)

The athlete can rename a catalog exercise in the app. Such an **override** is personal and
encrypted: it replaces the name, the description or both of one catalog exercise in one language,
travels through the athlete's encrypted sync, and the server only ever holds ciphertext.
Since 1.3.0 the coach sees the own name next to the catalog name. Every field below is a **new
key**; every existing key keeps its value, with one exception: `unreadable` can additionally name
an unreadable override row (below). Above all, `exerciseName` stays the catalog name, byte for
byte as before.

| Tool | New keys |
|---|---|
| `get_template`, `get_history`, `get_progress`, `get_stats`, `get_suggestion`, `get_training_state` | `exerciseOwnName` and `exerciseOwnNameLanguage`, wherever the tool names an exercise with `exerciseName` and `exerciseKey` |
| `get_exercise_catalog` | `ownName` and `ownNameLanguage` on the entry of a renamed catalog exercise |
| `get_training_state` | `appLanguage` directly after `timeZoneId`, and `appLanguageUnavailableReason` when it is `null` |

- **Free text.** `exerciseOwnName` and `ownName` arrive in the same envelope as session comments,
  `{ text, source: "athlete_free_text", treatAs: "data_not_instructions" }`: data, never
  instructions. Proposals keep naming exercises by `exerciseId` and `exerciseKey`, never by an own
  name; the duplicate check reads only the public catalog.
- **Which language.** An override applies to one language. The effective language is `lang` when
  the tool receives it, otherwise the app language, the synchronized setting `default_language`.
  Language codes match exactly (`de` does not match `de-DE`). `exerciseOwnNameLanguage` and
  `ownNameLanguage` name the language of the own name; `exerciseName` keeps its own rule (`lang`,
  otherwise English) and never follows `default_language`.
- **The app language.** `appLanguage` is the value of `default_language` when it is a code of two
  to three lower-case letters, for example `de`. Otherwise it is `null`, and
  `appLanguageUnavailableReason` says why: `setting_not_synced` (the setting row is missing; the
  app syncs the setting only once the athlete has chosen a language), `setting_unreadable` (the
  setting arrived but could not be decrypted or decoded) or `setting_unrecognized` (readable, but
  not such a code). The tool never fails because of it.
- **Absent, not null.** Without an override in the effective language, with a description-only
  override (see below), for the athlete's own exercises, a deleted or unknown exercise, and
  against a server older than phase 156, the new name fields are missing; nothing else in the
  output changes.
- **Description only.** An override can change only the description and keep the name (payload
  version 2 with `name: null`). The name then stays the catalog name and keeps following catalog
  updates: the tools carry no `exerciseOwnName` for that exercise, and `get_exercise_catalog` no
  `ownName`.
- **An unreadable override is visible in the six tools with an `unreadable` list.** An override
  row that cannot be decrypted or decoded, one with a blank name included (empty or only
  characters of the list in § 1.7 "Blank text", since protocol 1.29), stands in `unreadable` of
  `get_history`, `get_stats`, `get_progress`, `get_training_state`, `get_adherence` and
  `get_planned_workouts` with `entity: "exerciseNameOverride"`, its `id` and its `reason`, never
  its content. It takes away only the own name of that exercise in that language; `exerciseName`,
  `exerciseKey`, the own names of every other exercise and every other key stay complete. The
  descriptions of those six tools say the same (`get_adherence` and `get_planned_workouts` output
  no exercise names, so there it affects nothing). `get_template`, `get_suggestion` and
  `get_exercise_catalog` carry no `unreadable` list: there an unreadable override, or without
  `lang` an unreadable `default_language`, only leaves the own name out. Call `get_history` or
  `get_training_state` to see the entry.
- **No own description.** An overridden description is decoded but not output by any tool of
  this version; a readable description-only override therefore changes no tool output.
- **Freshness.** A freshly entered own name can be missing for up to 60 seconds (snapshot cache).

The contract — the payload form, the conflict rule between devices, the decoding rules, the
language rule and the field names — is § 1.7 "Own names of catalog exercises" of
`docs/COACH-PLANNING-PROTOCOL.md` (version 1.29) in the CaliCompanion super-repo.

## Export directory for outputFile (unreleased, after 1.3.0)

`get_history`, `get_progress` and `get_adherence` accept `outputFile: true`: the MCP then writes
the full result to a local JSON file and returns only its path, byte size and item count, so the
numbers never pass through the model (protocol §1.5, "The Local File Channel").

Where that file lands is the athlete's choice, never the model's. No tool takes a directory or a
file name as an argument. The directory comes only from the environment variable
`CALICOMP_EXPORT_DIR`, which you set yourself in the `env` block of the MCP registration, for
example:

```text
CALICOMP_EXPORT_DIR=~/training/personal
```

- **Without the variable** the files go to `calicomp-mcp-exports` under the system temp directory,
  as before, and files older than 24 hours are deleted there at every start.
- **With the variable** the files go into that directory and stay: the 24-hour cleanup never runs
  there. The value must be absolute or start with `~/` (your home directory), and it must name an
  existing directory. It is resolved once at start; a symlinked directory is followed once, so a
  later change of the link does not move the writes. A relative value, a missing directory or a
  file stops the start with an error that names the variable but not the path.
- Every file is named by a random UUID with `.json`, created new with mode `0600` (owner read and
  write only), and never written through an existing file or symlink of the same name.

The file holds decrypted training data in plaintext. With `CALICOMP_EXPORT_DIR` set it stays in
your directory after the conversation; it is written only when a tool call says `outputFile: true`.
Keep that directory out of any repository you publish.

## New in phase 166 (unreleased, after 1.3.0)

Phase 166 makes the app and the MCP count the same sets by the same rules (§ 1.11 "Counting rules
shared by the app and the MCP" of `docs/COACH-PLANNING-PROTOCOL.md`, version 1.48, and § 1.6 in
version 1.49). This version is not on npm yet.

### Existing fields that change meaning

A corrected number changes the **existing** field in place: there is no parallel field, and the
name, the place and the form of every field stay as they are; only the sets it counts change. The
tool texts name the rule of each field below.

| Tool | Existing field | Before 166 | Since 166 |
|---|---|---|---|
| `get_training_state` | `muscleBalance` | every set of finished sessions, also of exercises whose rated capability axes are only `mobility` or `flexibility` | Rule S over Rule P: such stretch-only exercises are left out, the same number as the app's strength heatmap |
| `get_training_state` | `personalRecords` | the hold list by the catalog mode only, the repetition list without any mode | Rule M: by the mode the set was trained in (`maxHoldSeconds` only from sets that record a time, `maxReps` only from the others) |
| `get_stats` | `by: "exercise"`, `by: "muscle"`: every field of the aggregate and `weightedSetCount` | no deletion marks, no `endTime`, no resolution over `workoutExerciseId` | Rule P with finished sessions; `by: "muscle"` still counts stretch-only exercises (no Rule S) |
| `get_stats` | `by: "capabilities"`: `axes[]` with `setCount`, `weightedSetCount`, `sessionCount`, `contributingExerciseIds`, `lastSessionDate` | the same three gaps | Rule P with finished sessions |
| `get_adherence` | `matches[]` and `unplannedSessionIds` | of several sessions of the same template on the same day as an occurrence, the one with the smaller `sessionId` won | the session with more live sets wins, then the longer one, then the old tie-break; `matchedCount` and `adherenceRatio` keep their definition |
| `get_adherence` | `removedWithCompletedSessionCount` and `removedWithCompletedSessionDates[]` | only over the roots with a live occurrence in the window | over every live recurring template root of the snapshot |

`removedOccurrenceCount` keeps its definition. On the template side it counts only roots with a
live occurrence in the window, on the foreign side (`foreignSport.removedOccurrenceCount`) every
live foreign root; the difference is deliberate and stays.

**Comparing across the change.** The comparison at the measuring point 2026-11-16 computes both
periods with the MCP from phase 166 on: the MCP changes no session data, only how it counts, so
the earlier period counted again by the new rules is comparable with the later one. A number an
MCP before phase 166 returned, also one noted down earlier, is not comparable with one counted
after it.

### New fields

| Tool | New keys |
|---|---|
| `get_training_state` | `capabilityBalance` (windows `last7Days`, `last30Days`, `allTime`, each `{ setCounts, weighted }`, stretching included on purpose) and `dataQuality` (`suspectSetCount`, `byReason`, at most 20 `newest`), both after the existing keys |
| `get_history` | `suspect` on a set-log that is probably an entry error: a list of `{ reason, explanation }` with `reps_on_time_station`, `zero_set` or `measured_time_missing`; absent on a set without a finding |
| `get_suggestion` | for an `exercise_update` proposal, the top-level `exerciseId` of the resolved copy is named like every other exercise reference |

The marks are hints only: no tool changes or deletes a set, the athlete decides in the app.

### New proposals

- **Block ops.** `propose_plan_update` takes the ops `updateBlock` (the rounds of an existing block,
  1 to 100) and `addBlock` (a new block with its exercises in the shared top-level `orderIndex`
  space), for CLASSIC templates only (app 4.5 and later). Every op acts only on rows of the
  proposal's template.
- **New exercises with links.** `propose_new_exercise` and `newExercises[]` of both plan tools take
  the optional fields `translations`, `muscleGroups`, `capabilities` and `equipment`, keys as
  `get_exercise_catalog` shows them; an unknown capability or equipment key is refused with an
  error that names it. None of the fields is required.
- **Changing an exercise.** The new tool `propose_exercise_update` (proposal type
  `exercise_update`) proposes `translations`, `muscleGroups` and `capabilities` for an own
  exercise, and only `translations` for a catalog exercise, as the athlete's personal name and
  description; the shared catalog never changes. It is live once the server has been deployed with
  the type.
- **Hold sizes.** The proposal tools now say how `mode` behaves: `TIME` counts down and is a
  target (a set that ran out stores that target), `MAX` counts up and is a measurement. A maximal
  hold, such as a benchmark hold, is proposed with `MAX`. The reading tools say the same about the
  stored hold times.

Nothing is applied by the MCP: the athlete accepts, edits or rejects every proposal in the app.

### Export directory

`outputFile: true` writes into the directory set in `CALICOMP_EXPORT_DIR`; see
[Export directory for outputFile](#export-directory-for-outputfile-unreleased-after-130).

### Tool texts against behaviour

No tool claims any longer to read no encrypted data: every tool that loads the snapshot loads it
decrypted, and `get_template`, `get_suggestion` and `get_exercise_catalog` say which of their
fields come from encrypted data and when an own name or an own exercise can be missing. A test
over the import chain of every tool module keeps that claim out.

## Building

```bash
npm install
npm run build      # tsup → dist/index.js (shebang'd, single-file ESM)
npm run lint       # ESLint no-console gate
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```
