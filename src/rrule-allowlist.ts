/**
 * Cross-language RRULE allowlist (protocol §3) — TypeScript twin of
 * `RRuleAllowlist.kt` (`TrainCounter/.../domain/coach/RRuleAllowlist.kt`), the second
 * of the two enforcement points protocol §3 names (the app's `RRuleAllowlist.kt` at
 * save-time is the first, already built in Phase 134). This file is the MCP-side one:
 * it rejects a coach-proposed RRULE at proposal-creation time, before a
 * `planned_update` proposal is ever built (PROP-08, T-136-01).
 *
 * Enforcement stance (protocol §3): the allowlist is a CLOSED SET. Any parameter name
 * outside {FREQ,INTERVAL,BYDAY,BYMONTHDAY,UNTIL} is rejected as
 * `RRuleRejectionCode.UNKNOWN_TOKEN` — the same catch-all that rejects `WKST` and any
 * future or mistyped token without a rule per token. `COUNT` and `BYSETPOS` are
 * checked as NAMED rejections even though they too are outside the permitted set, so
 * the coach gets the specific message the rejection table promises rather than the
 * generic one — this check ORDER is load-bearing and mirrors `RRuleAllowlist.kt`
 * verbatim: COUNT first, BYSETPOS second, then the unknown-parameter sweep, then
 * per-parameter bounds.
 *
 * T-136-01 (Denial of Service, high, mitigate): `INTERVAL` below 1 and `BYMONTHDAY`
 * below 1 are rejected here at proposal-creation time — both would hang (infinite
 * loop) or crash (uncaught `DateTimeException`, ported here as a thrown error inside
 * `expandDates`) `RecurrenceExpander`/`recurrence.ts` if they ever reached it. This is
 * the single most safety-critical check in Phase 136; it is proven by the corpus
 * `rruleAllowlist` vectors, not merely asserted.
 *
 * The write-time allowlist still rejects a `BYMONTHDAY` above 31, even though the
 * read-time `expandDates` clamps it to month-end without error (protocol §3, "The
 * MONTHLY Clamp Is a Deliberate Divergence") — this is a closed-grammar bound on the
 * accepted PROPOSAL surface, not a claim that the expander crashes on it. Do NOT
 * "fix" this asymmetry (135-05 errata, RESEARCH.md Pitfall 5).
 *
 * No console.* — pure module (T-120-04 style discipline).
 */

import { parseIsoDate } from './recurrence.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The eight `rruleAllowlist` reason codes from `docs/coach-planning-vectors.json` —
 * the stable identifier both this TypeScript enforcement point and the Kotlin one
 * (`RRuleAllowlist.kt`) key on, so the two cannot drift apart (protocol §3). */
export type RRuleRejectionCode =
  | 'COUNT_NOT_SUPPORTED'
  | 'YEARLY_NOT_SUPPORTED'
  | 'BYSETPOS_NOT_SUPPORTED'
  | 'ORDINAL_BYDAY_NOT_SUPPORTED'
  | 'MULTI_VALUE_BYMONTHDAY_NOT_SUPPORTED'
  | 'INTERVAL_MUST_BE_POSITIVE'
  | 'BYMONTHDAY_OUT_OF_RANGE'
  | 'UNKNOWN_TOKEN';

/** Verdict of validating a `recurrenceRule` string against the allowlist. */
export type RRuleValidation =
  | { valid: true }
  | { valid: false; reasonCode: RRuleRejectionCode; replacement: string | null };

// ---------------------------------------------------------------------------
// Closed-set grammar
// ---------------------------------------------------------------------------

const ALLOWED_PARAMS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'UNTIL']);
const ALLOWED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY']);
const ALLOWED_BYDAY = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/** Permitted substitute text per reason code — protocol §3's rejection table,
 * verbatim from `RRuleAllowlist.kt`'s `REPLACEMENTS` map. */
const REPLACEMENTS: Record<RRuleRejectionCode, string | null> = {
  COUNT_NOT_SUPPORTED: 'UNTIL=YYYYMMDD',
  YEARLY_NOT_SUPPORTED: 'FREQ=MONTHLY;INTERVAL=12',
  BYSETPOS_NOT_SUPPORTED: null,
  ORDINAL_BYDAY_NOT_SUPPORTED: 'BYDAY=MO combined with INTERVAL',
  MULTI_VALUE_BYMONTHDAY_NOT_SUPPORTED:
    'a single BYMONTHDAY value, or two roots sharing one recurrenceGroupId',
  INTERVAL_MUST_BE_POSITIVE: 'INTERVAL must be 1 or greater',
  BYMONTHDAY_OUT_OF_RANGE: 'BYMONTHDAY must be between 1 and 31',
  UNKNOWN_TOKEN: 'Omit the token — the grammar above is the full closed allowlist',
};

function reject(code: RRuleRejectionCode): RRuleValidation {
  return { valid: false, reasonCode: code, replacement: REPLACEMENTS[code] };
}

/**
 * Split an RRULE string into a `key -> value` map on `;`. A part with no `=` maps to
 * the empty string. Duplicate keys: the LAST occurrence wins — matches Kotlin's
 * `associate` semantics (`RRuleAllowlist.kt`).
 */
function parseRRuleParams(rrule: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) {
      params[part] = '';
    } else {
      params[part.slice(0, idx)] = part.slice(idx + 1);
    }
  }
  return params;
}

/**
 * Kotlin's `String.toIntOrNull()`: optional leading sign, digits only, and bounded to
 * the 32-bit signed integer range — matches `recurrence.ts`'s private `parseIntOrNull`
 * (same parity contract, WR-02), reimplemented here because `RRuleAllowlist.kt` itself
 * has no shared helper with `RecurrenceExpander.kt` either — the two Kotlin files are
 * independent, and this port stays independent too.
 */
function parseIntOrNull(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** `YYYYMMDD` → valid calendar date, reusing `recurrence.ts`'s own `parseIsoDate`
 * (inserting dashes) instead of reimplementing date-validity arithmetic. */
function isValidUntilDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const y = value.slice(0, 4);
  const m = value.slice(4, 6);
  const d = value.slice(6, 8);
  try {
    parseIsoDate(`${y}-${m}-${d}`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// validateRRule — the closed-set validator
// ---------------------------------------------------------------------------

/**
 * Validate a `recurrenceRule` string against protocol §3's closed grammar. `null`,
 * `undefined` and blank all mean "no rule" (a standalone root) and are always Valid —
 * matching `RRuleAllowlist.kt`'s `rrule.isNullOrBlank()` guard.
 *
 * Check order (load-bearing, mirrors the Kotlin original exactly):
 *   1. COUNT named-rejection
 *   2. BYSETPOS named-rejection
 *   3. sweep over unknown parameters
 *   4. FREQ bounds (YEARLY named-rejection, then the allowed-value check)
 *   5. BYDAY bounds (ordinal weekday rejection)
 *   6. BYMONTHDAY bounds (multi-value, then out-of-range)
 *   7. INTERVAL bounds
 *   8. UNTIL form
 */
export function validateRRule(rrule: string | null | undefined): RRuleValidation {
  if (rrule == null || rrule.trim() === '') return { valid: true };

  const params = parseRRuleParams(rrule);

  // Named rejections that win over the generic UNKNOWN_TOKEN even though COUNT/BYSETPOS
  // are themselves outside the permitted parameter set (protocol §3).
  if ('COUNT' in params) return reject('COUNT_NOT_SUPPORTED');
  if ('BYSETPOS' in params) return reject('BYSETPOS_NOT_SUPPORTED');

  for (const key of Object.keys(params)) {
    if (!ALLOWED_PARAMS.has(key)) return reject('UNKNOWN_TOKEN');
  }

  const freq = params.FREQ;
  if (freq === 'YEARLY') return reject('YEARLY_NOT_SUPPORTED');
  if (freq !== undefined && !ALLOWED_FREQ.has(freq)) return reject('UNKNOWN_TOKEN');

  if (params.BYDAY !== undefined) {
    const codes = params.BYDAY.split(',').map((c) => c.trim());
    if (codes.some((c) => !ALLOWED_BYDAY.has(c))) return reject('ORDINAL_BYDAY_NOT_SUPPORTED');
  }

  if (params.BYMONTHDAY !== undefined) {
    if (params.BYMONTHDAY.includes(',')) return reject('MULTI_VALUE_BYMONTHDAY_NOT_SUPPORTED');
    const value = parseIntOrNull(params.BYMONTHDAY);
    if (value === null || value < 1 || value > 31) return reject('BYMONTHDAY_OUT_OF_RANGE');
  }

  if (params.INTERVAL !== undefined) {
    const value = parseIntOrNull(params.INTERVAL);
    if (value === null || value < 1) return reject('INTERVAL_MUST_BE_POSITIVE');
  }

  if (params.UNTIL !== undefined) {
    if (!isValidUntilDate(params.UNTIL)) return reject('UNKNOWN_TOKEN');
  }

  return { valid: true };
}
