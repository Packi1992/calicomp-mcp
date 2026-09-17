/**
 * Cross-language canonical hashing — planHash (stale-guard) + changeHash (dedupe).
 *
 * CRITICAL — this is the single highest-risk contract in Phase 121 (per CONTEXT.md):
 * `computePlanHash` MUST be byte-reproducible on BOTH this TypeScript MCP side and
 * the future Kotlin Phase 122 recompute. The exact field allowlist below mirrors
 * RESEARCH.md Pattern 3 — the wire-DTO field set (SyncTemplateDto/SyncBlockDto/
 * SyncTemplateExerciseDto/SyncRoundTargetDto), NOT the Room entity field set, which
 * carries additional device/sync-only columns (workoutType, formatParams, syncStatus,
 * serverId, lastModifiedAt, watchSyncVersion) that never survive the server round-trip
 * and MUST NOT leak into the canonical structure.
 *
 * Cross-language float gotcha (CR-01): the one Float field, `targetWeight`, is converted
 * to a FIXED 2-decimal STRING (via canonWeight) before hashing — never raw
 * JSON.stringify — because naive JS/Kotlin float formatting diverges on trailing zeros,
 * locale decimal separators, AND on tie-adjacent doubles (0.615, 2.675). The pinned
 * recipe is string-based decimal HALF_UP rounding applied to the SHORTEST ROUND-TRIP
 * decimal representation of the value — NOT binary-value rounding (`%.2f`, `toFixed`,
 * `Math.round(w*100)`), all of which diverge cross-language on tie-adjacent inputs.
 *
 * Kotlin Phase 122 recompute — the byte-identical recipe (input MUST be a Double):
 *
 *     fun canonWeight(w: Double?): String? = w?.let {
 *         BigDecimal(it.toString()).setScale(2, RoundingMode.HALF_UP).toPlainString()
 *     }
 *
 *   - JS `String(number)` and Kotlin/JVM `Double.toString()` (Android ART; JDK 19+ —
 *     older JDKs may emit non-shortest digits for rare doubles, verify with the parity
 *     vectors) both emit the shortest round-trip decimal representation, so both sides
 *     round the IDENTICAL digit string.
 *   - If the source value is a Room `Float` (the targetWeight column), it MUST be
 *     widened via its decimal string — `f.toString().toDouble()` — NEVER `f.toDouble()`:
 *     binary widening changes the digits (2.675f.toDouble() == 2.674999952316284 →
 *     "2.67", whereas the wire/shortest string "2.675" → "2.68").
 *   - Parity vectors (byte-for-byte, pinned in tests/hash.test.ts): 0.615→"0.62",
 *     2.675→"2.68", 1.005→"1.01", 0.125→"0.13", (0.1+0.2)→"0.30", 12.5→"12.50",
 *     10.0→"10.00".
 *
 * Names excluded (A1): template.name and block.name are deliberately absent from the
 * canonical structure — a rename does not trip the stale-guard, only structural drift
 * (added/removed/reordered exercises, changed sets/reps/targets) does.
 *
 * Soft-delete exclusion rules (WR-04) — the Kotlin recompute MUST implement all THREE,
 * not just the obvious first two:
 *   1. blocks with `deletedAt != null` are excluded (together with everything under them);
 *   2. templateExercises with `deletedAt != null` are excluded;
 *   3. a LIVE (non-deleted) templateExercise whose `blockId` references a soft-deleted
 *      or unknown block is ALSO excluded entirely: grouping is
 *      `te.blockId === survivingBlock.id` per surviving block, and `standalone` takes
 *      ONLY `te.blockId == null` — an orphan under a dead/unknown block falls into
 *      neither partition and never reaches the canonical structure. A recompute
 *      implemented as "filter templateExercises by deletedAt == null, group by blockId"
 *      WITHOUT this rule would include such orphans and diverge.
 *
 * No console.* — pure module (T-121-04).
 *
 * `canonicalStringify` throws on `undefined` (G-134-37, planhash-wire-defaults-parity.md):
 * `JSON.stringify(undefined)` returns no string at all — not even `"undefined"` — so the
 * previous unguarded recursion produced the bare, invalid-JSON word `undefined` inside the
 * object/array template literal wherever a caller forgot to guard an optional field. That is
 * exactly how the stale-guard's `plan_hash` diverged from `PlanHash.kt` for nine UAT rounds
 * without a single reported error: the wrong hash was silent, not loud. `canonicalStringify`
 * is now the last-resort guard for every future field of this kind, not only the three this
 * plan fixes at the source (`cache.ts`'s `normalizeWireBlock`/`normalizeWireTemplateExercise`).
 */

import { createHash } from 'node:crypto';
import type { DecryptedSnapshot, SyncRoundTargetDto } from './types.js';

// ---------------------------------------------------------------------------
// canonicalStringify — sorted-key, no-whitespace, order-preserving-array JSON
// ---------------------------------------------------------------------------

/**
 * Recursively serialize a value to a deterministic JSON string:
 *   - primitives/null → JSON.stringify(value)
 *   - arrays → element order preserved, each element canonicalized
 *   - objects → keys sorted alphabetically at every node, no whitespace
 *   - `undefined` (anywhere in the tree, including nested object values and array
 *     elements) → throws, naming the key path where the value sat (G-134-37)
 *
 * Two objects with identical content but different key-insertion order
 * produce the IDENTICAL canonical string.
 *
 * @param value The value to canonicalize. Public single-argument call form.
 * @param path  Internal — the key path accumulated so far, for the thrown error message
 *              only. Callers never pass this; it defaults to the root and is threaded
 *              through the object/array recursion steps below.
 */
export function canonicalStringify(value: unknown, path = '<root>'): string {
  if (value === undefined) {
    throw new Error(
      `canonicalStringify: refusing to serialize undefined at "${path}". A field this hash ` +
        'depends on is missing. JSON.stringify(undefined) produces no string at all, so a ' +
        'prior version of this function silently wrote the bare word `undefined` into the ' +
        'hash input here — invalid JSON, and a hash that could never match the Kotlin side ' +
        '(G-134-37: exactly this bug on rounds/sets/exerciseSource, planhash-wire-defaults-parity.md). ' +
        'Fix the caller to supply a real value or an explicit null, not this function.',
    );
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalStringify(v, `${path}[${i}]`)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k], path === '<root>' ? k : `${path}.${k}`)}`)
    .join(',')}}`;
}

// ---------------------------------------------------------------------------
// canonWeight — fixed 2-decimal string, the cross-language float contract
// ---------------------------------------------------------------------------

/**
 * Convert a nullable weight to a fixed 2-decimal string for hashing.
 * `null`/`undefined` → `null` (never the string "null").
 * 12.5 → "12.50"; 10.0 → "10.00" (trailing-zero-safe, locale-independent).
 *
 * Recipe (CR-01, cross-language contract — see file header for the Kotlin twin):
 * take the shortest round-trip decimal representation `String(w)` and apply
 * HALF_UP rounding at scale 2 on the DECIMAL DIGIT STRING (BigDecimal-style),
 * never on the binary double value. This makes 0.615 → "0.62" ("0.615" is the
 * digit string; HALF_UP on the third fraction digit), whereas binary-value
 * recipes (`toFixed`, `%.2f`) yield "0.61" because the double is 0.61499…
 */
export function canonWeight(w: number | null | undefined): string | null {
  return w == null ? null : decimalHalfUpScale2(String(w));
}

/**
 * BigDecimal-style HALF_UP rounding at scale 2, operating purely on the decimal
 * digit string (handles scientific notation and negative values; HALF_UP rounds
 * away from zero, matching java.math.RoundingMode.HALF_UP).
 */
function decimalHalfUpScale2(repr: string): string {
  let s = repr;
  let sign = '';
  if (s.startsWith('-')) {
    sign = '-';
    s = s.slice(1);
  }
  // Split off a scientific-notation exponent, if any ("1.5e-7" → mantissa "1.5", exp -7).
  let mantissa = s;
  let exp = 0;
  const eIdx = s.search(/[eE]/);
  if (eIdx !== -1) {
    mantissa = s.slice(0, eIdx);
    exp = Number.parseInt(s.slice(eIdx + 1), 10);
  }
  // Flatten to a pure digit string plus the decimal-point position within it.
  const dot = mantissa.indexOf('.');
  const digits = dot === -1 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  let pointPos = (dot === -1 ? mantissa.length : dot) + exp;
  let padded = digits;
  if (pointPos < 0) {
    padded = '0'.repeat(-pointPos) + padded;
    pointPos = 0;
  }
  if (pointPos + 2 > padded.length) {
    padded = padded + '0'.repeat(pointPos + 2 - padded.length);
  }
  // Keep integer digits + 2 fraction digits; HALF_UP on the first dropped digit.
  let scaled = BigInt(padded.slice(0, pointPos + 2));
  const rest = padded.slice(pointPos + 2);
  if (rest !== '' && rest.charCodeAt(0) >= 0x35 /* '5' */) {
    scaled += 1n;
  }
  const abs = scaled.toString().padStart(3, '0');
  const out = `${abs.slice(0, -2)}.${abs.slice(-2)}`;
  return sign !== '' && out !== '0.00' ? `${sign}${out}` : out;
}

// ---------------------------------------------------------------------------
// computePlanHash — the stale-guard hash (D-02)
// ---------------------------------------------------------------------------

interface CanonicalRoundTarget {
  round: number;
  targetReps: number | null;
  targetTimeSeconds: number | null;
  targetWeight: string | null;
}

interface CanonicalTemplateExercise {
  id: string;
  blockId: string | null;
  exerciseId: string;
  exerciseSource: string;
  mode: string;
  targetReps: number | null;
  targetTimeSeconds: number | null;
  restTimeSeconds: number;
  sets: number;
  targetWeight: string | null;
  orderIndex: number;
  roundTargets: CanonicalRoundTarget[];
}

interface CanonicalBlock {
  id: string;
  rounds: number;
  orderIndex: number;
  templateExercises: CanonicalTemplateExercise[];
}

interface CanonicalPlan {
  templateId: string;
  blocks: CanonicalBlock[];
  standalone: CanonicalTemplateExercise[];
}

function canonicalizeRoundTarget(rt: SyncRoundTargetDto): CanonicalRoundTarget {
  return {
    round: rt.round,
    targetReps: rt.targetReps ?? null,
    targetTimeSeconds: rt.targetTimeSeconds ?? null,
    targetWeight: canonWeight(rt.targetWeight),
  };
}

function compareByOrderIndexThenId(
  a: { orderIndex: number; id: string },
  b: { orderIndex: number; id: string },
): number {
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compute the SHA-256 planHash over the deterministic canonical structure of
 * one template — soft-deletes filtered, deterministically sorted, explicit
 * field allowlist (never a DTO spread), targetWeight fixed-2-decimal.
 *
 * Exclusion contract (WR-04, see file header): deleted blocks, deleted
 * templateExercises, AND live templateExercises whose blockId points at a
 * deleted/unknown block are all absent from the canonical structure.
 *
 * Returns a 64-char lowercase hex string.
 */
export function computePlanHash(templateId: string, snapshot: DecryptedSnapshot): string {
  // Step 1: filter soft-deletes + scope to this template.
  const blocks = snapshot.blocks
    .filter((b) => b.templateId === templateId && b.deletedAt == null)
    .sort(compareByOrderIndexThenId);

  const templateExercises = snapshot.templateExercises.filter(
    (te) => te.templateId === templateId && te.deletedAt == null,
  );

  // Step 4: build the canonical object with an explicit key allowlist.
  const canonical: CanonicalPlan = {
    templateId,
    blocks: blocks.map((block) => {
      const exercisesForBlock = templateExercises
        .filter((te) => te.blockId === block.id)
        .sort(compareByOrderIndexThenId)
        .map((te) => canonicalizeTemplateExercise(te));
      return {
        id: block.id,
        rounds: block.rounds,
        orderIndex: block.orderIndex,
        templateExercises: exercisesForBlock,
      };
    }),
    standalone: templateExercises
      .filter((te) => te.blockId == null)
      .sort(compareByOrderIndexThenId)
      .map((te) => canonicalizeTemplateExercise(te)),
  };

  return createHash('sha256').update(canonicalStringify(canonical), 'utf8').digest('hex');
}

function canonicalizeTemplateExercise(
  te: DecryptedSnapshot['templateExercises'][number],
): CanonicalTemplateExercise {
  const roundTargets = (te.roundTargets ?? [])
    .slice()
    .sort((a, b) => a.round - b.round)
    .map(canonicalizeRoundTarget);
  return {
    id: te.id,
    blockId: te.blockId ?? null,
    exerciseId: te.exerciseId,
    exerciseSource: te.exerciseSource,
    mode: te.mode,
    targetReps: te.targetReps ?? null,
    targetTimeSeconds: te.targetTimeSeconds ?? null,
    restTimeSeconds: te.restTimeSeconds,
    sets: te.sets,
    targetWeight: canonWeight(te.targetWeight),
    orderIndex: te.orderIndex,
    roundTargets,
  };
}

// ---------------------------------------------------------------------------
// computeChangeHash — the dedupe hash (D-02a)
// ---------------------------------------------------------------------------

/**
 * changeHash = sha256(`${type}:${canonicalStringify(payload)}`).
 * `rationale`/`sourceLlm` are never inside `payload` (they're separate top-level
 * SuggestRequestBody fields), so their exclusion is automatic — no filtering step.
 */
export function computeChangeHash(
  type: 'plan_update' | 'new_plan' | 'new_exercise' | 'planned_update',
  payload: unknown,
): string {
  return createHash('sha256').update(`${type}:${canonicalStringify(payload)}`, 'utf8').digest('hex');
}
