/**
 * Row-decode primitives shared by `cache.ts` and `own-exercise-cipher.ts` (Phase 164).
 *
 * These lived in `cache.ts` until plan 164-19. They moved here unchanged so that the
 * decoder of own exercises can reuse them without importing `cache.ts` — `cache.ts` itself
 * imports that decoder, and the import cycle would hand a test that mocks `cache.js` a mocked
 * `RowDecodeError`. `cache.ts` re-exports every name below, so its public surface is the same.
 *
 * Never logs. No message built here carries payload content.
 */

import type { UnreadableReason } from './types.js';

/**
 * Thrown by a `decrypt*` helper for exactly one row instead of aborting the whole
 * `decryptMerge` call. Carries the classification `read-guard.ts` and `decryptMerge`
 * need — never plaintext, ciphertext or key material (T-120-17); the `message` names
 * only the entity, the row id and the cause.
 */
export class RowDecodeError extends Error {
  constructor(message: string, public readonly reason: UnreadableReason) {
    super(message);
    this.name = 'RowDecodeError';
  }
}

/** A non-empty string, else `undefined` — the test for a required id field. */
export function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The set W of protocol §1.7 "Blank text" as ONE character class over UTF-16 code units
 * (no `u` flag: the class tests code units, exactly the unit §1.7 names):
 * U+0009–U+000D, U+001C–U+0020, U+00A0, U+1680, U+2000–U+200D, U+2028, U+2029, U+202F,
 * U+205F, U+2060, U+3000, U+FEFF.
 *
 * Deliberately NOT `String.prototype.trim()`: JavaScript's trim cuts U+FEFF but not U+001F
 * (Kotlin's `isBlank()` does the opposite), and neither cuts U+200B although it looks just as
 * empty. Both sides therefore test against this written-out list; the corpus pins it at the
 * vectors `name-blank-unit-separator` (U+001F), `name-blank-zero-width` (U+200B U+FEFF),
 * `name-blank-bom`, `name-blank-all-of-w` and `name-invisible-outside-w` (U+180E, readable).
 */
const BLANK_OVERRIDE_TEXT = /^[\u0009-\u000D\u001C-\u0020\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]*$/;

/**
 * Whether `value` is blank in the sense of protocol §1.7 "Blank text": empty, or only code
 * units of the set W (`BLANK_OVERRIDE_TEXT`). Pure; never trims — blankness decides readable
 * or unreadable, never the value (a visible name keeps code units of W at its edges).
 */
export function isBlankOverrideText(value: string): boolean {
  return BLANK_OVERRIDE_TEXT.test(value);
}

/** A canonical lower-case UUID — the only readable `exerciseId` (§1.7 "Decoded rows", rule 5); since Phase 164 also every id of §1.9. */
export const CANONICAL_LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Phase 166 (plan 166-10, review finding 156-IN-MCP-05): whether one element of a wire array is
 * a row object at all. A `null`, a number, a string or an array is not; every decode loop of
 * `cache.ts` checks this first, so such an element takes the same per-row path as a row that
 * cannot be decoded (reported as `malformed_payload`) instead of aborting the whole pull with a
 * property read on `null`.
 */
export function isWireRowObject(row: unknown): row is object {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
}

/**
 * The time of day of the foreign sport plaintext (protocol §1.6): `HH:mm` with hours 00 to 23 and
 * minutes 00 to 59, the form the app's time picker writes and `LocalTime.parse` reads.
 */
export const LOCAL_TIME_HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
