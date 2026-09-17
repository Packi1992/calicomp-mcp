/**
 * Hand-ported RecurrenceExpander — a 1:1 port of the app's calendar-expansion algorithm.
 *
 * Source analogue: TrainCounter/app/src/main/java/com/gehlich/calisthenicscompanion/
 *   ui/screens/calendar/RecurrenceExpander.kt
 *   — expandDates (:44-112), parseDeletedOccurrences (:118-131), parseRRuleConfig
 *     (:150-161), parseRRule / parseUntilDate (:232-247)
 *
 * Parity is corpus-verified (docs/coach-planning-vectors.json, `expansion` section,
 * replayed by both this suite and TrainCounter's CoachPlanningVectorsTest.kt) — this
 * algorithm is NOT to be "improved" or made RFC-5545-conformant. Where it diverges from
 * RFC 5545 (the MONTHLY clamp, the fixed-Monday week start, the two parser quirks below),
 * that divergence is the app's actual stored-data behavior and is what this port exists
 * to reproduce exactly.
 *
 * Cross-language risk 1 — date arithmetic (RESEARCH.md Pattern 1):
 *   `java.time.LocalDate.plusMonths` CLAMPS the day-of-month to the target month's length
 *   (Jan 31 + 1 month → Feb 28); native JavaScript `Date` month arithmetic OVERFLOWS
 *   instead (`new Date(Date.UTC(2026,0,31))` advanced one UTC month lands on 2026-03-03,
 *   verified this session). Every date computation in this module is therefore pure
 *   integer arithmetic over a zone-free `{y,m,d}` tuple / epoch-day count — `Date` is used
 *   ONLY inside `lengthOfMonth`, a non-mutating construction (`Date.UTC(y, m, 0)`), never
 *   a `.setMonth()`/`.setDate()` chain on an already-constructed date.
 *
 * Cross-language risk 2 — the FREQ-missing-but-not-blank asymmetry (RESEARCH.md Pattern 3,
 * RecurrenceExpander.kt:51-57): a null/blank `rrule` and a non-blank `rrule` with no `FREQ`
 * key are two textually DISTINCT branches in `expandDates` — the first checks
 * `deletedDates`, the second deliberately does NOT. A refactor that "cleans up" these into
 * one shared helper is a parity break, not a simplification — see the two `if` blocks at
 * the top of `expandDates` below, each carrying its own comment.
 *
 * No console.* — pure module (T-135-05 / T-120-18 style discipline).
 */

// ---------------------------------------------------------------------------
// CalDate — the zone-free calendar-date tuple every operation below is built on.
// ---------------------------------------------------------------------------

/** A calendar date with no time-of-day and no time zone. */
export interface CalDate {
  y: number;
  m: number; // 1-indexed (1 = January .. 12 = December)
  d: number;
}

const RRULE_DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

// ---------------------------------------------------------------------------
// Epoch-day arithmetic (Howard Hinnant's "days_from_civil" / "civil_from_days" —
// the standard integer proleptic-Gregorian algorithm). Epoch day 0 = 1970-01-01,
// matching Unix epoch-day numbering. This is the ONLY place calendar dates are
// converted to/from a linear integer; every plusX/withX function below operates
// through these two conversions, never through native Date mutation.
// ---------------------------------------------------------------------------

/** Convert a CalDate to a linear day count (epoch day 0 = 1970-01-01). */
export function epochDay(date: CalDate): number {
  const yy = date.y - (date.m <= 2 ? 1 : 0);
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400; // [0, 399]
  const doy = Math.floor((153 * (date.m + (date.m > 2 ? -3 : 9)) + 2) / 5) + date.d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Convert a linear day count (epoch day 0 = 1970-01-01) back to a CalDate. */
export function fromEpochDay(epoch: number): CalDate {
  const z = epoch + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  ); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** ISO 8601 `YYYY-MM-DD` → CalDate. Throws on any malformed or non-existent calendar date. */
export function parseIsoDate(s: string): CalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) throw new Error(`Invalid ISO date: "${s}"`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) throw new Error(`Invalid ISO date: "${s}"`);
  if (d < 1 || d > lengthOfMonth(y, m)) throw new Error(`Invalid ISO date: "${s}"`);
  return { y, m, d };
}

/** CalDate → ISO 8601 `YYYY-MM-DD`. */
export function formatIsoDate(date: CalDate): string {
  const y = String(date.y).padStart(4, '0');
  const m = String(date.m).padStart(2, '0');
  const d = String(date.d).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add (or subtract, for a negative n) whole days. */
export function plusDays(date: CalDate, n: number): CalDate {
  return fromEpochDay(epochDay(date) + n);
}

/** Add (or subtract) whole weeks. */
export function plusWeeks(date: CalDate, n: number): CalDate {
  return plusDays(date, n * 7);
}

/**
 * Length in days of 1-indexed month `m` of year `y`. The one permitted use of `Date`
 * inside this module's arithmetic core — `Date.UTC(y, m, 0)` addresses "day 0 of the
 * (0-indexed) month `m`", i.e. the last day of 1-indexed month `m`. This is a
 * construction, never a mutation of an already-built `Date`.
 */
export function lengthOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Add (or subtract) whole months, clamping the day-of-month to the resulting month's
 * length — matching `java.time.LocalDate.plusMonths` exactly (the day-of-month is
 * "adjusted to be valid for the resulting month and year", never overflowed into the
 * following month the way native JS `Date` month arithmetic does).
 */
export function plusMonths(date: CalDate, n: number): CalDate {
  const totalMonths = date.y * 12 + (date.m - 1) + n;
  const y = Math.floor(totalMonths / 12);
  const m = ((totalMonths % 12) + 12) % 12 + 1;
  const d = Math.min(date.d, lengthOfMonth(y, m));
  return { y, m, d };
}

/**
 * Return a CalDate with the same year/month as `date` but day-of-month `day`. Callers
 * are responsible for clamping `day` to `lengthOfMonth` first — this function does not
 * validate, matching how `expandDates`'s MONTHLY branch always clamps before calling it.
 */
export function withDayOfMonth(date: CalDate, day: number): CalDate {
  return { y: date.y, m: date.m, d: day };
}

/** ISO-8601 day-of-week: 1 = Monday .. 7 = Sunday. */
export function dayOfWeekIso(date: CalDate): number {
  const ed = epochDay(date);
  return (((ed + 3) % 7) + 7) % 7 + 1;
}

/**
 * The Monday of `date`'s own ISO week — moves backward, or is a no-op when `date`
 * already is a Monday. NEVER moves forward to the next Monday. Because this always
 * produces a date on or before `date`, Kotlin's defensive
 * `if (weekStart.isAfter(startDate)) weekStart = weekStart.minusWeeks(1)` guard
 * (RecurrenceExpander.kt:82-83, :202-205) is structurally unreachable given a correct
 * Monday computation and is not reproduced here.
 */
export function mondayOf(date: CalDate): CalDate {
  return plusDays(date, -(dayOfWeekIso(date) - 1));
}

/** Three-way comparison: negative if a < b, zero if equal, positive if a > b. */
export function compareCalDate(a: CalDate, b: CalDate): number {
  return epochDay(a) - epochDay(b);
}

function isWithinRange(date: CalDate, start: CalDate, end: CalDate): boolean {
  return compareCalDate(date, start) >= 0 && compareCalDate(date, end) <= 0;
}

// ---------------------------------------------------------------------------
// RRULE parsing (private helpers — RecurrenceExpander.kt's parseRRule/parseUntilDate)
// ---------------------------------------------------------------------------

/**
 * `;`-split into KEY=VALUE pairs, `=`-split with a limit of 2 (so a value may itself
 * contain `=`). A part with no `=` at all maps to the empty string, matching Kotlin's
 * `split("=", limit = 2)` + `getOrElse(1) { "" }`.
 */
function parseRRule(rrule: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      result[part] = '';
    } else {
      result[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  }
  return result;
}

/**
 * Kotlin's `String.toIntOrNull()` — optional leading sign, no other characters, and
 * bounded to the 32-bit signed integer range (`Int.MIN_VALUE`..`Int.MAX_VALUE`, i.e.
 * -2147483648..2147483647). Kotlin's `Int` is a 32-bit type, so `toIntOrNull()` returns
 * `null` for any numeral outside that range even though it parses as a valid JS number
 * (135-05, WR-02): using `Number.isSafeInteger`'s much wider ±2^53 bound would accept an
 * `INTERVAL`/`BYMONTHDAY` value between `Int.MAX_VALUE` and 2^53 where Kotlin rejects it,
 * silently diverging from the parity contract this parser exists to uphold.
 */
function parseIntOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Take the first 8 characters, parse as `YYYYMMDD`, return null on any failure. */
function parseUntilDate(s: string): CalDate | null {
  const digits = s.slice(0, 8);
  if (!/^\d{8}$/.test(digits)) return null;
  const y = Number(digits.slice(0, 4));
  const m = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > lengthOfMonth(y, m)) return null;
  return { y, m, d };
}

function withRootSuffix(message: string, rootId?: string): string {
  return rootId !== undefined ? `${message} (root ${rootId})` : message;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Thrown by `expandDates` for the two inputs where the Kotlin expander HANGS
 * (`INTERVAL < 1` — an infinite loop) or CRASHES (`BYMONTHDAY` below 1, under
 * `FREQ=MONTHLY` — an uncaught `DateTimeException`), per D-15. A `BYMONTHDAY` above 31
 * does NOT crash Kotlin — `RecurrenceExpander.kt`'s MONTHLY branch clamps it to the
 * month length before applying it, so it never leaves the accepted day range; this port
 * clamps the same way and never throws for that case (135-05, correcting CR-01). This
 * is a deliberate divergence ONLY in the failure case: for every valid rule, this port's
 * output stays byte-identical to Kotlin's. `code` matches the RRULE-allowlist reason
 * codes the shared corpus already uses (`RRULE_ALLOWLIST_REASON_CODES`), so Phase 136
 * inherits one vocabulary.
 */
export class RecurrenceRuleError extends Error {
  readonly code: 'INTERVAL_MUST_BE_POSITIVE' | 'BYMONTHDAY_OUT_OF_RANGE';
  readonly rootId: string | undefined;

  constructor(
    message: string,
    code: 'INTERVAL_MUST_BE_POSITIVE' | 'BYMONTHDAY_OUT_OF_RANGE',
    rootId?: string,
  ) {
    super(message);
    this.name = 'RecurrenceRuleError';
    this.code = code;
    this.rootId = rootId;
  }
}

/**
 * Port of `parseRRuleConfig` (RecurrenceExpander.kt:150-161). Blank/null input returns
 * Kotlin's literal defaults (`WEEKLY` / `1` / empty / `null`), not a null object.
 * Unknown `BYDAY` tokens are dropped silently; a non-numeric `INTERVAL` becomes `1`;
 * `byDay` is always emitted in Monday-first order regardless of the order the tokens
 * appear in the stored rule.
 */
export function parseRRuleConfig(rrule: string | null): {
  freq: string;
  interval: number;
  byDay: string[];
  until: string | null;
} {
  if (rrule === null || rrule.trim() === '') {
    return { freq: 'WEEKLY', interval: 1, byDay: [], until: null };
  }
  const params = parseRRule(rrule);
  const freq = params['FREQ'] ?? 'WEEKLY';
  const interval = parseIntOrNull(params['INTERVAL']) ?? 1;
  const byDayTokens = new Set(
    (params['BYDAY'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => (RRULE_DAY_ORDER as readonly string[]).includes(t)),
  );
  const byDay = RRULE_DAY_ORDER.filter((d) => byDayTokens.has(d));
  const untilDate = params['UNTIL'] !== undefined ? parseUntilDate(params['UNTIL']) : null;
  const until = untilDate !== null ? formatIsoDate(untilDate) : null;
  return { freq, interval, byDay, until };
}

/**
 * Port of `parseDeletedOccurrences` (RecurrenceExpander.kt:118-131). Returns a SORTED,
 * DEDUPLICATED array of ISO date strings (D-09) — never the raw stored order. Parse
 * tolerance matches Kotlin exactly: blank/null → `[]`; a surrounding `[`…`]` pair is
 * stripped only when BOTH are present; split on `,`; each token is trimmed and a
 * surrounding pair of `"` is stripped only when both are present; empty tokens (after
 * that) are skipped; every remaining token is parsed strictly as `YYYY-MM-DD`.
 * Reproduces Kotlin's all-or-nothing catch: if ANY remaining token fails to parse, the
 * WHOLE column yields `[]` — one bad entry discards the set, never just that token.
 */
export function parseDeletedOccurrences(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') return [];
  try {
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
      dates.push(formatIsoDate(parseIsoDate(token))); // throws on any parse failure
    }
    return Array.from(new Set(dates)).sort();
  } catch {
    return [];
  }
}

/**
 * Port of `expandDates` (RecurrenceExpander.kt:44-112). Expands an RRULE into
 * concrete dates within `[rangeStart, rangeEnd]` (both inclusive), excluding any date
 * present in `deletedDates` (ISO strings). `rootId`, when supplied, is folded into a
 * D-15 error message so the caller can identify which planned-workout root failed.
 */
export function expandDates(
  startDate: CalDate,
  rrule: string | null,
  rangeStart: CalDate,
  rangeEnd: CalDate,
  deletedDates: ReadonlySet<string>,
  rootId?: string,
): CalDate[] {
  // Degenerate branch 1 — rrule is null/blank: checks deletedDates. Must stay
  // textually separate from branch 2 below (RESEARCH.md Pattern 3) — merging them
  // into one shared helper is a parity break, not a cleanup.
  if (rrule === null || rrule.trim() === '') {
    if (isWithinRange(startDate, rangeStart, rangeEnd) && !deletedDates.has(formatIsoDate(startDate))) {
      return [startDate];
    }
    return [];
  }

  const params = parseRRule(rrule);
  const freq = params['FREQ'];

  // Degenerate branch 2 — rrule is non-blank but carries no FREQ key: deliberately
  // does NOT check deletedDates (RecurrenceExpander.kt:56-57). Must stay textually
  // separate from branch 1 above.
  if (freq === undefined) {
    return isWithinRange(startDate, rangeStart, rangeEnd) ? [startDate] : [];
  }

  const interval = parseIntOrNull(params['INTERVAL']) ?? 1;
  // D-15(a): a non-positive INTERVAL would loop forever in every branch below —
  // guard immediately after INTERVAL is parsed, before any loop can start.
  if (interval < 1) {
    throw new RecurrenceRuleError(
      withRootSuffix(`Recurrence rule "${rrule}" has INTERVAL below 1 — refusing to expand (would loop forever)`, rootId),
      'INTERVAL_MUST_BE_POSITIVE',
      rootId,
    );
  }

  const byDay = new Set(
    (params['BYDAY'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => (RRULE_DAY_ORDER as readonly string[]).includes(t)),
  );
  const byMonthDay = parseIntOrNull(params['BYMONTHDAY']) ?? undefined;
  const ruleUntil = params['UNTIL'] !== undefined ? parseUntilDate(params['UNTIL']) : null;
  const effectiveEnd = ruleUntil !== null && compareCalDate(ruleUntil, rangeEnd) < 0 ? ruleUntil : rangeEnd;

  const results: CalDate[] = [];

  if (freq === 'DAILY') {
    let current = startDate;
    while (compareCalDate(current, effectiveEnd) <= 0) {
      if (compareCalDate(current, rangeStart) >= 0 && !deletedDates.has(formatIsoDate(current))) {
        results.push(current);
      }
      current = plusDays(current, interval);
    }
  } else if (freq === 'WEEKLY') {
    if (byDay.size === 0) {
      let current = startDate;
      while (compareCalDate(current, effectiveEnd) <= 0) {
        if (compareCalDate(current, rangeStart) >= 0 && !deletedDates.has(formatIsoDate(current))) {
          results.push(current);
        }
        current = plusWeeks(current, interval);
      }
    } else {
      let weekStart = mondayOf(startDate);
      while (compareCalDate(weekStart, effectiveEnd) <= 0) {
        for (let offset = 0; offset < RRULE_DAY_ORDER.length; offset++) {
          const token = RRULE_DAY_ORDER[offset];
          if (!byDay.has(token)) continue;
          const date = plusDays(weekStart, offset);
          if (
            compareCalDate(date, startDate) >= 0 &&
            compareCalDate(date, effectiveEnd) <= 0 &&
            compareCalDate(date, rangeStart) >= 0 &&
            !deletedDates.has(formatIsoDate(date))
          ) {
            results.push(date);
          }
        }
        weekStart = plusWeeks(weekStart, interval);
      }
    }
  } else if (freq === 'MONTHLY') {
    // D-15(b): BYMONTHDAY guard lives HERE — inside the MONTHLY branch only, before
    // the loop — because the Kotlin expander only reaches `withDayOfMonth` on this
    // branch; a WEEKLY rule carrying the same BYMONTHDAY value never throws. Narrowed
    // to `< 1` only (135-05, correcting CR-01): Kotlin's MONTHLY branch computes
    // `minOf(dayOfMonth, current.lengthOfMonth())` BEFORE calling `withDayOfMonth`, so
    // any value above 31 always resolves to `lengthOfMonth` (always in [28, 31]) and
    // can never leave the accepted day range — it clamps, it never throws. Only a
    // value below 1 drives that `minOf` below 1 and genuinely crashes Kotlin. Phase
    // 136's write-time allowlist still refuses a value above 31 as a closed-grammar
    // bound, not because Kotlin crashes on it — do not restore the upper end here.
    if (byMonthDay !== undefined && byMonthDay < 1) {
      throw new RecurrenceRuleError(
        withRootSuffix(`Recurrence rule "${rrule}" has BYMONTHDAY=${byMonthDay} below 1`, rootId),
        'BYMONTHDAY_OUT_OF_RANGE',
        rootId,
      );
    }
    const dayOfMonth = byMonthDay ?? startDate.d;
    let current = startDate;
    while (compareCalDate(current, effectiveEnd) <= 0) {
      const day = Math.min(dayOfMonth, lengthOfMonth(current.y, current.m));
      const date = withDayOfMonth(current, day);
      if (
        compareCalDate(date, startDate) >= 0 &&
        compareCalDate(date, effectiveEnd) <= 0 &&
        compareCalDate(date, rangeStart) >= 0 &&
        !deletedDates.has(formatIsoDate(date))
      ) {
        results.push(date);
      }
      // The CURSOR (`current`) is itself clamped by plusMonths — a 31st-of-month
      // series walks 31 Jan -> cursor 28 Feb -> emits 31 Mar. Do not collapse the
      // cursor/emitted-date two-variable structure into one.
      current = plusMonths(current, interval);
    }
  }
  // An unrecognised FREQ value yields an empty list — it does not throw (matches
  // Kotlin's `when` with no matching branch).

  return results;
}

// ---------------------------------------------------------------------------
// Series-field derivation (phase 135-03, SCHED-02, D-07/D-08/D-10)
// ---------------------------------------------------------------------------

/**
 * epoch-ms (UTC midnight, per PlannedWorkoutEntity's KDoc) → CalDate, read in UTC.
 * Exported (135-05, WR-01) so `src/tools/get_planned_workouts.ts` imports this single
 * definition instead of redefining it — the day-boundary rule cannot drift between the
 * expander and the read tool if there is only one copy.
 */
export function epochMsToUtcCalDate(ms: number): CalDate {
  return fromEpochDay(Math.floor(ms / 86_400_000));
}

/**
 * Render a root's parsed RRULE into the corpus's `seriesFields` shape — `freq`,
 * `interval`, `byDay` (Monday-first RRULE tokens) and `until` (ISO date or null).
 * `parseRRuleConfig`'s return shape already IS this shape; this thin, named wrapper
 * exists so the `shared-vectors.test.ts` replay and `get_planned_workouts.ts`'s tool
 * both import ONE function for "the four series fields a root carries" rather than each
 * depending directly on `parseRRuleConfig`'s return shape staying stable — the replay
 * and the tool cannot disagree about Monday-first ordering or the `until` format,
 * because they call the same function.
 */
export function renderSeriesFields(recurrenceRule: string | null): {
  freq: string;
  interval: number;
  byDay: string[];
  until: string | null;
} {
  return parseRRuleConfig(recurrenceRule);
}

/**
 * Port of `reconstructSeriesConfig`'s reference-Monday derivation
 * (RecurrenceExpander.kt:180-228) — computing the offset from a root's OWN date instead
 * of the group's reference Monday is the divergence the `seriesFields` corpus vectors
 * (in particular the Sunday-anchored one) exist to catch (D-10).
 *
 * Groups `roots` by `recurrenceGroupId`. A root with a null `recurrenceGroupId` maps to
 * `0` (D-07) without consulting any other root. Inside a group: keep roots with a
 * non-null `recurrenceRule`, or every root when the group has exactly one member — sort
 * that filtered set by `scheduledDate` ascending, falling back to the WHOLE group sorted
 * when the filter empties it (mirrors `roots.filter { it.recurrenceRule != null ||
 * roots.size == 1 }.sortedBy { it.scheduledDate }.ifEmpty { roots.sortedBy {
 * it.scheduledDate } }`); take the Monday of the first entry's date (read in UTC, never
 * host-local time) as the reference. Every root of the group — INCLUDING the ones the
 * filter dropped — then gets an offset of `(epochDay(mondayOf(rootDate)) -
 * epochDay(refMonday)) / 7`: a root the filter excluded from setting the reference still
 * reports its own week-offset, exactly like `reconstructSeriesConfig`'s per-root loop
 * computes `weekOffset` for that root even though `weekDays` (a different, production-
 * only aggregate) never receives an entry for it.
 */
export function weekOffsetsForGroups(
  roots: ReadonlyArray<{
    id: string;
    scheduledDate: number;
    recurrenceRule: string | null;
    recurrenceGroupId: string | null;
  }>,
): Map<string, number> {
  const offsets = new Map<string, number>();
  const groups = new Map<string, (typeof roots)[number][]>();

  for (const root of roots) {
    if (root.recurrenceGroupId === null) {
      offsets.set(root.id, 0); // D-07
      continue;
    }
    const existing = groups.get(root.recurrenceGroupId);
    if (existing) {
      existing.push(root);
    } else {
      groups.set(root.recurrenceGroupId, [root]);
    }
  }

  for (const group of groups.values()) {
    const filtered = group.filter((r) => r.recurrenceRule !== null || group.length === 1);
    const sorted = (filtered.length > 0 ? filtered : group)
      .slice()
      .sort((a, b) => a.scheduledDate - b.scheduledDate);
    const refMonday = mondayOf(epochMsToUtcCalDate(sorted[0].scheduledDate));
    const refMondayEpoch = epochDay(refMonday);
    for (const root of group) {
      const rootMonday = mondayOf(epochMsToUtcCalDate(root.scheduledDate));
      offsets.set(root.id, (epochDay(rootMonday) - refMondayEpoch) / 7);
    }
  }

  return offsets;
}
