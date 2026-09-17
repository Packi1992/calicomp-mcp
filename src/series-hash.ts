/**
 * Cross-language series-structure fingerprint (protocol §4) — TypeScript twin of
 * `SeriesHash.kt` (`TrainCounter/.../domain/coach/SeriesHash.kt`). Named explicitly by
 * protocol §6 as the shared-corpus proof this file exists to satisfy: both Kotlin's
 * `computeSeriesHash` and this one must reproduce the identical digest for the
 * identical root-record set.
 *
 * Imports `canonicalStringify` from `./hash.js` — same "import, don't reimplement"
 * precedent `computePlanHash` already sets (`e1rm.ts` does the same). Never a second
 * canonicalizer.
 *
 * Field allowlist (protocol §4), exactly seven named fields, never a spread: `id`,
 * `templateId`, `scheduledDate`, `scheduledTime`, `recurrenceRule`, `recurrenceGroupId`,
 * `deletedOccurrences`. Excluded: `note` (free text — a typo must not trip a structural
 * guard, mirroring `planHash`'s own exclusion of `template.name`/`block.name`),
 * `completedSessionId`/`calendarEventId` (device/link metadata), `createdAt`/
 * `deletedAt` (bookkeeping, not planning structure).
 *
 * `scheduledDate` is hashed as the RAW STORED EPOCH MILLISECONDS, exactly as
 * persisted — no date conversion of any kind. A structural fingerprint has no zone
 * semantics; the calendar's UTC-read fix (protocol §1.4) is orthogonal to hash
 * correctness and the two must never be coupled.
 *
 * No console.* — pure module.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify } from './hash.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The seven-field allowlist a root must be reduced to before hashing.
 * `deletedOccurrencesRaw` is the STORED COLUMN text (verbatim, or null) — never a
 * pre-parsed array — because the whole point of parsing it here (not trusting the
 * caller's own parse) is that the stored form is untrustworthy on its own and the
 * canonical form is derived from it independently, every time.
 */
export interface SeriesHashRoot {
  id: string;
  templateId: string;
  scheduledDate: number;
  scheduledTime: string | null;
  recurrenceRule: string | null;
  recurrenceGroupId: string | null;
  deletedOccurrencesRaw: string | null;
}

// ---------------------------------------------------------------------------
// deletedOccurrences — independent raw-column parse, deduplicated + sorted
// ---------------------------------------------------------------------------

/**
 * Independently parses the stored `deletedOccurrences` column text (protocol §4) —
 * deliberately does NOT call `recurrence.ts`'s `parseDeletedOccurrences`, which
 * additionally validates every token as an ISO date and discards the WHOLE set on any
 * single parse failure (an all-or-nothing catch appropriate for calendar rendering,
 * wrong for a structural hash). This mirrors `SeriesHash.kt`'s own
 * `canonicalDeletedOccurrences`: strip the surrounding brackets, split on commas, trim,
 * strip a surrounding pair of double quotes, drop empties, then deduplicate and sort
 * ascending as plain strings — ISO date strings sort identically as strings and as
 * dates, so string sorting is the canonical order. A null or blank column yields an
 * empty list, never a JSON null.
 */
function parseDeduplicatedSorted(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') return [];
  let body = raw.trim();
  if (body.length >= 2 && body.startsWith('[') && body.endsWith(']')) {
    body = body.slice(1, -1);
  }
  const dates: string[] = [];
  for (const rawToken of body.split(',')) {
    let token = rawToken.trim();
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
      token = token.slice(1, -1);
    }
    if (token === '') continue;
    dates.push(token);
  }
  return Array.from(new Set(dates)).sort();
}

// ---------------------------------------------------------------------------
// canonicalSeriesString / computeSeriesHash
// ---------------------------------------------------------------------------

/**
 * Sorts `roots` ascending by `id` (plain string comparison over the lowercase
 * canonical UUID form — not a signed natural-order comparator, which can disagree
 * with string order), maps each to the seven-field allowlist, and canonicalizes the
 * resulting BARE array — no wrapper object. The grouping rule (protocol §4) falls out
 * of this directly: a `recurrenceGroupId` group is just "every root of that group, in
 * this list, sorted by id"; a standalone root without a group hashes alone because it
 * is the only element of its own singleton list.
 */
export function canonicalSeriesString(roots: SeriesHashRoot[]): string {
  const sorted = [...roots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const objects = sorted.map((r) => ({
    id: r.id,
    templateId: r.templateId,
    scheduledDate: r.scheduledDate,
    scheduledTime: r.scheduledTime ?? null,
    recurrenceRule: r.recurrenceRule ?? null,
    recurrenceGroupId: r.recurrenceGroupId ?? null,
    deletedOccurrences: parseDeduplicatedSorted(r.deletedOccurrencesRaw),
  }));
  return canonicalStringify(objects);
}

/**
 * Digests `canonicalSeriesString` with SHA-256 over UTF-8 bytes, returning a 64-char
 * lowercase hex string — the same digest shape `computePlanHash` returns.
 */
export function computeSeriesHash(roots: SeriesHashRoot[]): string {
  return createHash('sha256').update(canonicalSeriesString(roots), 'utf8').digest('hex');
}
