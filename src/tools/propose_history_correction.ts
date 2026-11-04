/**
 * propose_history_correction — propose a correction of a finished workout (Phase 168, plan 168-05, PERM-05, D-02,
 * D-27, D-28, protocol 1.56 §2.8 "History Correction Proposals").
 *
 * The tool itself changes nothing. It loads the decrypted history the coach reads (`getSnapshot().snapshot`), checks
 * the proposal against it (`validateHistoryCorrection`: the session exists, has ended and is not deleted; every
 * `setId` and `afterSetId` is a live set of that session; no id twice) and POSTs a proposal of type
 * `history_correction`. Set values are never plaintext on the server, so the payload is encrypted with the account
 * key (§2.8 "Why the payload is encrypted", Open Question 1, option B): outside the ciphertext stand exactly `v`,
 * `sessionId` and `encryptedPayload`; inside it the inner payload `{v, sessionId, seenSets, changes}`, where
 * `seenSets` names every live set of the session with its `updatedAt` (the stale guard the app compares before it
 * applies). The app decides what happens next: it presents the proposal in the coach inbox or, when the athlete
 * allowed this kind beforehand, applies it directly (docs/COACH-PERMISSIONS.md); it checks the targets again
 * against its own rows. The PAT can propose and read back, never apply (Propose-Only Boundary). The server accepts
 * the type once plan 168-03 is deployed (168-04).
 *
 * Exports:
 *   validateHistoryCorrection(args, snapshot)                  — the tool-side check against the history read
 *   buildHistoryCorrectionPayload(args, snapshot, keyB64, iv?) — the outer payload with the encrypted inner one
 *   registerToolProposeHistoryCorrection(server, cfg)          — registers the tool with the MCP server
 *
 * Security (threat model): T-168-19 (only `sessionId` in plaintext), T-168-20 (`encrypt` in the format of
 * `EncryptionManager`, corpus parity), T-168-22 (foreign, deleted and running targets refused without a request),
 * T-121-01 (an HttpError surfaces only `HTTP <status>`), T-121-07 (handler wrapped in try/catch, nothing on stdout;
 * the stderr log names no value).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposeHistoryCorrectionSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { encrypt } from '../crypto.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, HttpError } from '../http.js';
import type { DecryptedSetLog, DecryptedSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Pure helpers — importable for the corpus replay (tests/tools/propose_history_correction.test.ts)
// ---------------------------------------------------------------------------

interface HistoryCorrectionValues {
  reps?: number;
  timeSec?: number;
  weight?: number;
}

export type HistoryCorrectionChange =
  | ({ op: 'update'; setId: string } & HistoryCorrectionValues)
  | ({ op: 'add'; afterSetId: string } & HistoryCorrectionValues)
  | { op: 'remove'; setId: string };

export interface ProposeHistoryCorrectionArgs {
  sessionId: string;
  changes: HistoryCorrectionChange[];
  rationale: string;
}

/** The outer payload of a `history_correction` (§2.8 "Outer payload"), exactly these keys in this order. */
export interface HistoryCorrectionOuterPayload {
  v: 1;
  sessionId: string;
  encryptedPayload: string;
}

/** §2.8: `seenSets` holds 1 to 500 entries; a session with more live sets cannot be corrected by one proposal. */
const SEEN_SETS_MAX = 500;

const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';
const SESSION_NOT_FINISHED = 'SESSION_NOT_FINISHED';
const SESSION_TOO_LARGE = 'SESSION_TOO_LARGE';
const SET_NOT_IN_SESSION = 'SET_NOT_IN_SESSION';
const DUPLICATE_SET = 'DUPLICATE_SET';

/** The live sets of a session in the order of every session view (`createdAt`, then `id`). */
function liveSetsOf(snapshot: DecryptedSnapshot, sessionId: string): DecryptedSetLog[] {
  return snapshot.setLogs
    .filter((sl) => sl.sessionId === sessionId && sl.deletedAt == null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The set id a change names and the field it stands in. */
function targetOf(change: HistoryCorrectionChange): { field: 'setId' | 'afterSetId'; id: string } {
  return change.op === 'add' ? { field: 'afterSetId', id: change.afterSetId } : { field: 'setId', id: change.setId };
}

/**
 * The tool-side check of a correction against the history the MCP read (§2.8 "Scope"). Returns the tool error text,
 * which names fields, never values, or `undefined` when the proposal may be sent.
 */
export function validateHistoryCorrection(
  args: ProposeHistoryCorrectionArgs,
  snapshot: DecryptedSnapshot,
): string | undefined {
  const session = snapshot.sessions.find((s) => s.id === args.sessionId && s.deletedAt == null);
  if (session === undefined) {
    return `${SESSION_NOT_FOUND}: sessionId names no workout session that exists and is not deleted.`;
  }
  if (session.endTime == null) {
    return `${SESSION_NOT_FINISHED}: sessionId names a workout that has not ended; only a finished workout can be corrected.`;
  }
  const liveIds = new Set(liveSetsOf(snapshot, args.sessionId).map((sl) => sl.id));
  if (liveIds.size > SEEN_SETS_MAX) {
    return `${SESSION_TOO_LARGE}: the session has more than ${SEEN_SETS_MAX} live sets; it cannot be corrected by a proposal.`;
  }
  const named = new Set<string>();
  for (const [index, change] of args.changes.entries()) {
    const { field, id } = targetOf(change);
    if (!liveIds.has(id)) {
      return `${SET_NOT_IN_SESSION}: changes[${index}].${field} is not a live set of this session.`;
    }
    if (named.has(id)) {
      return (
        `${DUPLICATE_SET}: changes[${index}].${field} names a set an earlier change already names; ` +
        'every set id stands at most once over setId and afterSetId. Send a second proposal for a second set.'
      );
    }
    named.add(id);
  }
  return undefined;
}

/** One change of the inner payload, keys in the order of §2.8, each value only when set. */
function innerChange(change: HistoryCorrectionChange): Record<string, unknown> {
  if (change.op === 'remove') return { op: 'remove', setId: change.setId };
  return {
    op: change.op,
    ...(change.op === 'add' ? { afterSetId: change.afterSetId } : { setId: change.setId }),
    ...(change.reps !== undefined ? { reps: change.reps } : {}),
    ...(change.timeSec !== undefined ? { timeSec: change.timeSec } : {}),
    ...(change.weight !== undefined ? { weight: change.weight } : {}),
  };
}

/**
 * The outer payload of a validated correction: `{v: 1, sessionId, encryptedPayload}`, where `encryptedPayload` is the
 * inner payload `{v: 1, sessionId, seenSets, changes}` encrypted with the account key (§2.8). `iv` exists only for the
 * corpus parity test; the tool always encrypts with a random IV.
 */
export function buildHistoryCorrectionPayload(
  args: ProposeHistoryCorrectionArgs,
  snapshot: DecryptedSnapshot,
  keyB64: string,
  iv?: Buffer,
): HistoryCorrectionOuterPayload {
  const inner = {
    v: 1,
    sessionId: args.sessionId,
    seenSets: liveSetsOf(snapshot, args.sessionId).map((sl) => ({ id: sl.id, updatedAt: sl.updatedAt })),
    changes: args.changes.map(innerChange),
  };
  return {
    v: 1,
    sessionId: args.sessionId,
    encryptedPayload: encrypt(JSON.stringify(inner), keyB64, iv),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_history_correction` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposeHistoryCorrection(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_history_correction',
    {
      title: 'Propose History Correction',
      description:
        'Propose to the athlete a correction of a finished workout: change the repetitions (reps), the time in ' +
        'seconds (timeSec) or the weight in kilograms (weight) of a set, add a forgotten set after an existing ' +
        'one (afterSetId), or remove a wrong set. The tool itself changes nothing; it sends the encrypted proposal ' +
        'to the app. It reads the encrypted training history and writes the correction encrypted with the account ' +
        'key, so the server sees only the sessionId. Pass the sessionId of a finished, not deleted workout and set ' +
        'ids from get_history. Every named set must be a live set of that session, and a set id stands at most once ' +
        'over setId and afterSetId; a running workout, a deleted set or a set of another session is refused before ' +
        'anything is sent. An update sets only the values you name, an added set takes the exercise of the set it ' +
        'follows, and a removed set is kept as a deletion mark. A correction never changes the exercise of a set, ' +
        'the notes or the rating. A second forgotten set after the same set is a second proposal. This proposal ' +
        'type is live only once the server has been deployed with it; before that the server answers with an HTTP ' +
        'error.',
      inputSchema: ProposeHistoryCorrectionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposeHistoryCorrectionArgs;

        const data = await getSnapshot(pat, keyB64, serverUrl);
        const refusal = validateHistoryCorrection(typedArgs, data.snapshot);
        if (refusal !== undefined) {
          return { isError: true, content: [{ type: 'text' as const, text: refusal }] };
        }

        const payload    = buildHistoryCorrectionPayload(typedArgs, data.snapshot, keyB64);
        const changeHash = computeChangeHash('history_correction', payload);
        const sourceLlm  = getSourceLlm(server);

        const result = await postSuggest(
          {
            type:      'history_correction',
            payload:   JSON.stringify(payload),
            rationale: typedArgs.rationale,
            sourceLlm,
            changeHash,
          },
          pat,
          serverUrl,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof HttpError) {
          console.error(`propose_history_correction: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose history correction error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
