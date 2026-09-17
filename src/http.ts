/**
 * Authenticated HTTP fetch wrappers for CalisthenicsServer endpoints.
 *
 * Nine functions:
 *   fetchSnapshot        — GET  /api/mcp/data/pull                       (Bearer PAT)
 *   fetchProfile         — GET  /api/mcp/profile                         (Bearer PAT)
 *   fetchCatalog         — GET  /api/exercises                            (unauthenticated)
 *   postSuggest          — POST /api/mcp/suggest                          (Bearer PAT) — Phase 121 propose-only write
 *   fetchSuggestions     — GET  /api/mcp/coach/suggestions                (Bearer PAT) — Phase 136 PROP-10 read-back list
 *   fetchSuggestion      — GET  /api/mcp/coach/suggestions/{id}           (Bearer PAT) — Phase 136 PROP-10 read-back single
 *   postWithdraw         — POST /api/mcp/coach/suggestions/{id}/withdraw  (Bearer PAT) — Phase 136 PROP-11 the one named
 *                           exception to propose-only
 *   fetchCoachParameters — GET  /api/mcp/coach/parameters                 (Bearer PAT) — Phase 137 STATE-06 read
 *   putCoachParameters   — PUT  /api/mcp/coach/parameters                 (Bearer PAT) — Phase 137 STATE-06 the SECOND
 *                           named exception to propose-only
 *
 * The `/coach/` prefix on these five routes is load-bearing (D-17, protocol v1.11
 * §5.5), not cosmetic — `GET /api/mcp/suggestions` (unprefixed) is a separate,
 * JWT-only route the app owns; a PAT request there 401s. Never write a helper against
 * the unprefixed path.
 *
 * `putCoachParameters` is the client side of the SECOND named exception to the
 * propose-only boundary (protocol v1.15 §5.5, Plan 137-04). Its narrowness lives in
 * the server route and its key/type allowlist (`ALLOWED_COACH_PARAMETER_KEYS`) —
 * never in trust placed in this client.
 *
 * Error contract (T-120-13 / T-121-01):
 *   Non-2xx throws HttpError carrying ONLY the status code + endpoint path.
 *   The PAT, CALICOMP_KEY, or Authorization header value NEVER appear in
 *   error messages, stack traces, or any other observable output from this module.
 *
 * Timeout (WR-05): every fetch carries AbortSignal.timeout(REQUEST_TIMEOUT_MS)
 *   (30 s) — undici has no default request timeout, so a black-holed server would
 *   otherwise hang tool calls indefinitely. On expiry fetch rejects with a DOMException
 *   TimeoutError ("The operation was aborted due to timeout") — a fixed message with
 *   no header/PAT material — which the tool handlers' existing generic catch surfaces
 *   as a structured isError result.
 *
 * stdout discipline: no console.* calls — all diagnostics go to console.error
 * (handled by callers).
 */

import type {
  SyncPullResponse,
  UserProfileResponse,
  CatalogExerciseWire,
  SuggestRequestBody,
  SuggestionDtoResponse,
  SuggestionSummaryDtoResponse,
} from './types.js';
import type { CoachParameters } from './coach-parameters.js';

// ---------------------------------------------------------------------------
// Typed HTTP error — carries status + path, never secrets
// ---------------------------------------------------------------------------

/**
 * Thrown when the server responds with a non-2xx status code.
 * The message contains only the numeric HTTP status and the endpoint path —
 * never the PAT, key, or Authorization header value.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    path: string,
  ) {
    super(`HTTP ${status} from ${path}`);
    this.name = 'HttpError';
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function assertOk(res: Response, path: string): Promise<void> {
  if (!res.ok) {
    throw new HttpError(res.status, path);
  }
}

// ---------------------------------------------------------------------------
// Public fetch wrappers
// ---------------------------------------------------------------------------

/** Per-request timeout (WR-05) — bounds every fetch in this module. */
const REQUEST_TIMEOUT_MS = 30_000;

const DATA_PULL_PATH      = '/api/mcp/data/pull';
const PROFILE_PATH        = '/api/mcp/profile';
const CATALOG_PATH        = '/api/exercises';
const SUGGEST_PATH        = '/api/mcp/suggest';
// D-17 / protocol v1.11 §5.5 — the coach-only PAT prefix. Deliberately distinct
// from SUGGEST_PATH's sibling `/api/mcp/suggestions` (JWT-only, app-owned).
const COACH_SUGGESTIONS_PATH = '/api/mcp/coach/suggestions';
// D-17 / protocol v1.15 §5.5 — the coach-parameters route, second named exception
// to propose-only (Phase 137, STATE-06). Exported: the interface contract 137-05
// publishes to later Phase 137 plans, unlike its sibling constants above.
export const COACH_PARAMETERS_PATH = '/api/mcp/coach/parameters';

/** Shared config shape for the three Phase 136 coach-suggestion helpers below. */
interface CoachSuggestionsConfig {
  pat: string;
  serverUrl: string;
}

/**
 * Fetch the full encrypted snapshot from the MCP data endpoint.
 *
 * Sends `Authorization: Bearer <pat>`. Throws HttpError on non-2xx.
 * Returns the raw SyncPullResponse (may contain zeroed plaintext fields
 * when encryptedPayload is present — see cache.ts for decrypt-merge).
 */
export async function fetchSnapshot(
  pat: string,
  serverUrl: string,
): Promise<SyncPullResponse> {
  const path = DATA_PULL_PATH;
  const res = await fetch(`${serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await assertOk(res, path);
  return res.json() as Promise<SyncPullResponse>;
}

/**
 * Fetch the authenticated user's profile.
 *
 * Sends `Authorization: Bearer <pat>`. Throws HttpError on non-2xx.
 */
export async function fetchProfile(
  pat: string,
  serverUrl: string,
): Promise<UserProfileResponse> {
  const path = PROFILE_PATH;
  const res = await fetch(`${serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await assertOk(res, path);
  return res.json() as Promise<UserProfileResponse>;
}

/**
 * Fetch the public exercise catalog (unauthenticated).
 *
 * GET /api/exercises requires no Authorization header — the endpoint is
 * publicly accessible per ExerciseRoutes.kt (no authenticate wrapper).
 * Throws HttpError on non-2xx.
 *
 * Returns `CatalogExerciseWire[]`, NOT `CatalogExercise[]` — the raw JSON can legitimately
 * omit `capabilities`/`equipment`/`isSkill` per `Dtos.kt`'s Kotlin-side defaults and
 * kotlinx.serialization's `encodeDefaults = false` (CAP-05 gap-closure, 2026-09-06; see
 * `CatalogExerciseWire`'s doc in types.ts for the measured 75/189 and 164/189 figures). Callers
 * MUST run this through `cache.ts`'s `normalizeCatalog()` before treating it as a
 * `CatalogExercise[]` — never add a second call site that skips that step.
 */
export async function fetchCatalog(
  serverUrl: string,
): Promise<CatalogExerciseWire[]> {
  const path = CATALOG_PATH;
  const res = await fetch(`${serverUrl}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await assertOk(res, path);
  return res.json() as Promise<CatalogExerciseWire[]>;
}

/**
 * POST a propose-only write to the server (T-121-01: never mutates directly —
 * the server transports the proposal into `plan_suggestions` for human review).
 *
 * Sends `Authorization: Bearer <pat>` + `Content-Type: application/json`.
 * Throws HttpError on non-2xx. Never interpolates the PAT, key, or request
 * body into any error/message/log — reuses the existing HttpError/assertOk
 * verbatim (no second error type).
 */
export async function postSuggest(
  body: SuggestRequestBody,
  pat: string,
  serverUrl: string,
): Promise<SuggestionDtoResponse> {
  const path = SUGGEST_PATH;
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await assertOk(res, path);
  return res.json() as Promise<SuggestionDtoResponse>;
}

/**
 * List the calling PAT's own proposals as the cheap summary projection (Phase 136,
 * D-08/D-09, PROP-10) — no `payload`/`appliedPayload` member (T-136-16).
 *
 * GET /api/mcp/coach/suggestions[?status=...][&limit=...] — an absent `status` or
 * `limit` is omitted from the query string entirely rather than sent empty, so the
 * server's own default (200, no filter) applies unambiguously. Sends
 * `Authorization: Bearer <pat>`. Throws HttpError on non-2xx (including the case
 * where the server has nothing to return but a genuine failure occurred — an empty
 * inbox itself answers 200 with `[]`, never a non-2xx).
 */
export async function fetchSuggestions(
  cfg: CoachSuggestionsConfig,
  status?: string,
  limit?: number,
): Promise<SuggestionSummaryDtoResponse[]> {
  const path = COACH_SUGGESTIONS_PATH;
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();
  const res = await fetch(`${cfg.serverUrl}${path}${query ? `?${query}` : ''}`, {
    headers: { Authorization: `Bearer ${cfg.pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await assertOk(res, path);
  return res.json() as Promise<SuggestionSummaryDtoResponse[]>;
}

/**
 * Fetch one of the calling PAT's own proposals in full — `payload`, `appliedPayload`
 * and `seriesHash` included (Phase 136, D-08/D-09, PROP-10).
 *
 * GET /api/mcp/coach/suggestions/{id}. Sends `Authorization: Bearer <pat>`. Returns
 * `null` on a 404 (foreign id, unknown id — the server's identical no-leak body,
 * T-118-05/T-133-02) instead of throwing, so the tool layer can turn it into a
 * structured `isError` result naming that the proposal was not found. Throws
 * HttpError on any other non-2xx.
 */
export async function fetchSuggestion(
  cfg: CoachSuggestionsConfig,
  id: string,
): Promise<SuggestionDtoResponse | null> {
  const path = `${COACH_SUGGESTIONS_PATH}/${encodeURIComponent(id)}`;
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${cfg.pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  await assertOk(res, path);
  return res.json() as Promise<SuggestionDtoResponse>;
}

/** Outcome of {@link postWithdraw} — deliberately not a boolean: 'not-withdrawable'
 * covers three structurally indistinguishable server-side causes (foreign id,
 * unknown id, already-decided own row) that must stay indistinguishable here too
 * (T-136-19 — see withdraw_suggestion.ts). */
export type WithdrawOutcome = 'withdrawn' | 'not-withdrawable';

/**
 * Withdraw one of the calling PAT's own still-`pending` proposals — the single
 * named exception to the propose-only boundary (Phase 136, D-08, PROP-11).
 *
 * POST /api/mcp/coach/suggestions/{id}/withdraw with no request body — this route
 * accepts no status and no body field of any kind; it can express nothing but the
 * single `pending` → `withdrawn` transition the server hard-codes. Sends
 * `Authorization: Bearer <pat>`. A 404 (foreign id, unknown id, or an own row in any
 * status other than `pending`/`withdrawn`) maps to `'not-withdrawable'` rather than
 * throwing — the server's own identical-404 no-leak body is not something a helper
 * layer should try to further interpret. A 200 (including an idempotent repeat
 * against an already-withdrawn row) maps to `'withdrawn'`. Throws HttpError on any
 * other non-2xx.
 */
export async function postWithdraw(
  cfg: CoachSuggestionsConfig,
  id: string,
): Promise<WithdrawOutcome> {
  const path = `${COACH_SUGGESTIONS_PATH}/${encodeURIComponent(id)}/withdraw`;
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return 'not-withdrawable';
  await assertOk(res, path);
  return 'withdrawn';
}

/**
 * Fetch the calling PAT's stored coach parameters (Phase 137, D-09/D-23, STATE-06).
 *
 * GET /api/mcp/coach/parameters. Sends `Authorization: Bearer <pat>`. A 404 maps to
 * `null` rather than throwing, matching the defensive not-found idiom every other
 * helper in this module uses (`fetchSuggestion`, `postWithdraw`) — the live server
 * route never actually answers 404 for this path (it returns the seven defaults
 * instead, Plan 137-04), but this helper does not assume that will always hold.
 * Throws HttpError on any other non-2xx.
 */
export async function fetchCoachParameters(
  cfg: CoachSuggestionsConfig,
): Promise<{ params: Partial<CoachParameters>; updatedAt: number | null } | null> {
  const path = COACH_PARAMETERS_PATH;
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${cfg.pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  await assertOk(res, path);
  return res.json() as Promise<{ params: Partial<CoachParameters>; updatedAt: number | null }>;
}

/**
 * Write a partial update to the calling PAT's coach parameters — the SECOND named
 * exception to the propose-only boundary, client side (Phase 137, D-23, STATE-06,
 * protocol v1.15 §5.5).
 *
 * PUT /api/mcp/coach/parameters. Sends `Authorization: Bearer <pat>` and
 * `Content-Type: application/json`; the body carries exactly one key, `params`,
 * holding the subset of the seven coach parameters being set — no other field is
 * ever sent. A 400 (the server's own key-allowlist-and-type check, Plan 137-04)
 * maps to the string `'rejected'` rather than throwing: the server declined the
 * input, an expected outcome, not a transport failure. Throws HttpError on any
 * other non-2xx (including 401 — a JWT holder never reaches this route). The
 * narrowness that keeps this exception safe lives in the route itself and in the
 * server's key/type allowlist (`ALLOWED_COACH_PARAMETER_KEYS`), never in trust
 * placed in this client.
 */
export async function putCoachParameters(
  cfg: CoachSuggestionsConfig,
  params: Partial<CoachParameters>,
): Promise<{ params: Partial<CoachParameters>; updatedAt: number | null } | 'rejected'> {
  const path = COACH_PARAMETERS_PATH;
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 400) return 'rejected';
  await assertOk(res, path);
  return res.json() as Promise<{ params: Partial<CoachParameters>; updatedAt: number | null }>;
}
