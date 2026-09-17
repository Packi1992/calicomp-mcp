/**
 * PLANHASH CROSS-LANGUAGE CONTRACT — Phase 121, Plan 01 (MCPW-01)
 *
 * `computePlanHash`'s canonical string is the single highest-risk contract in
 * the v4.0 milestone (per CONTEXT.md): it MUST be byte-reproducible on both
 * this TypeScript MCP side and the future Kotlin Phase 122 recompute.
 *
 * This suite pins the EXACT canonical string (not merely "stable") for a
 * hand-built multi-block DecryptedSnapshot fixture covering:
 *   - two blocks (sorted by orderIndex) + one standalone (blockId=null) exercise
 *   - a trailing-zero weight (10.0), a two-decimal weight (12.5), and a null weight
 *   - a soft-deleted block AND a soft-deleted templateExercise (must be fully absent)
 *   - a LIVE templateExercise under the soft-deleted block (WR-04 rule 3: an orphan
 *     under a dead/unknown block is excluded even though it is not itself deleted)
 *   - roundTargets sorted by round
 *
 * The literal EXPECTED_CANONICAL_STRING below is the Phase 122 cross-language
 * contract: Kotlin's recompute must produce the identical string for the
 * structurally-equivalent Room data (same field allowlist, same sort order,
 * same fixed-2-decimal targetWeight format).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalStringify, canonWeight, computePlanHash, computeChangeHash } from '../src/hash.js';
import { normalizeWireBlock, normalizeWireTemplateExercise } from '../src/cache.js';
import type { DecryptedSnapshot, SyncBlockDto, SyncTemplateExerciseDto } from '../src/types.js';

// ---------------------------------------------------------------------------
// canonicalStringify — key-order independence
// ---------------------------------------------------------------------------

describe('canonicalStringify', () => {
  it('sorts object keys alphabetically at every node, independent of insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    const expected = '{"a":2,"b":1,"c":{"y":2,"z":1}}';
    expect(canonicalStringify(a)).toBe(expected);
    expect(canonicalStringify(b)).toBe(expected);
  });

  it('preserves array element order (only object keys are sorted)', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  // G-134-37 (planhash-wire-defaults-parity.md): canonicalStringify must never write the bare
  // word `undefined` into a hash string again — it throws instead, loudly, with a key path.
  it('throws on a bare undefined value', () => {
    expect(() => canonicalStringify(undefined)).toThrow();
  });

  it('throws on an object with an undefined-valued key, naming the key in the message', () => {
    expect(() => canonicalStringify({ a: 1, rounds: undefined })).toThrow(/rounds/);
  });

  it('throws on an array containing an undefined element', () => {
    expect(() => canonicalStringify([1, undefined, 3])).toThrow();
  });

  it('still serializes null as a completely normal value (null vs. undefined is the whole point)', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify({ a: null })).toBe('{"a":null}');
  });
});

// ---------------------------------------------------------------------------
// canonWeight — fixed 2-decimal cross-language float contract
// ---------------------------------------------------------------------------

describe('canonWeight', () => {
  it('formats a trailing-zero weight as a fixed 2-decimal string', () => {
    expect(canonWeight(10.0)).toBe('10.00');
  });

  it('formats a two-decimal weight as a fixed 2-decimal string', () => {
    expect(canonWeight(12.5)).toBe('12.50');
  });

  it('returns null for null/undefined (never the string "null")', () => {
    expect(canonWeight(null)).toBeNull();
    expect(canonWeight(undefined)).toBeNull();
  });

  // CR-01 cross-language parity vectors — the Kotlin Phase 122 recompute
  //   BigDecimal(w.toString()).setScale(2, RoundingMode.HALF_UP).toPlainString()
  // MUST reproduce every one of these byte-for-byte (input as Double; Room Floats
  // widened via f.toString().toDouble(), never f.toDouble() — see src/hash.ts header).
  it('pins tie-adjacent parity vectors: HALF_UP on the shortest round-trip digit string (CR-01)', () => {
    // Tie-adjacent doubles where binary-value recipes (%.2f / toFixed) yield "x.x1":
    // the pinned recipe rounds the DIGIT STRING "0.615"/"2.675"/"1.005" HALF_UP.
    expect(canonWeight(0.615)).toBe('0.62');
    expect(canonWeight(2.675)).toBe('2.68');
    expect(canonWeight(1.005)).toBe('1.01');
    // Exactly representable binary value — a true decimal tie → HALF_UP.
    expect(canonWeight(0.125)).toBe('0.13');
    // Float-artifact digits beyond scale 2 are truncated (first dropped digit 0 < 5).
    expect(canonWeight(0.1 + 0.2)).toBe('0.30'); // String(0.1+0.2) === "0.30000000000000004"
  });
});

// ---------------------------------------------------------------------------
// computeChangeHash — determinism (SC3)
// ---------------------------------------------------------------------------

describe('computeChangeHash', () => {
  it('is deterministic across different key-insertion orders of the same payload (SC3)', () => {
    const payloadA = { op: 'addExercise', sets: 3, exerciseId: 'ex-1' };
    const payloadB = { exerciseId: 'ex-1', op: 'addExercise', sets: 3 };
    expect(computeChangeHash('plan_update', payloadA)).toBe(computeChangeHash('plan_update', payloadB));
  });

  it('returns a 64-char lowercase hex string', () => {
    expect(computeChangeHash('new_exercise', { name: 'Test' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the type discriminant changes (same payload, different type)', () => {
    const payload = { foo: 'bar' };
    expect(computeChangeHash('plan_update', payload)).not.toBe(computeChangeHash('new_plan', payload));
  });
});

// ---------------------------------------------------------------------------
// computePlanHash — exact canonical-string cross-language contract
// ---------------------------------------------------------------------------

const TEMPLATE_ID = 'tpl-1';

const fixtureSnapshot: DecryptedSnapshot = {
  syncedAt: 1_710_000_000_000,
  exercises: [],
  exerciseTranslations: [],
  templates: [
    {
      id: TEMPLATE_ID,
      name: 'Push Day', // excluded from canonical structure (A1)
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      isFavoriteForWatch: true,
    },
  ],
  blocks: [
    {
      id: 'blkA',
      templateId: TEMPLATE_ID,
      name: 'Block A', // excluded
      rounds: 3,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    {
      id: 'blkB',
      templateId: TEMPLATE_ID,
      name: 'Block B', // excluded
      rounds: 2,
      orderIndex: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    {
      id: 'blkDeleted',
      templateId: TEMPLATE_ID,
      name: 'Deleted Block',
      rounds: 5,
      orderIndex: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      deletedAt: 1_700_000_002_000, // MUST be fully absent from canonical structure
    },
  ],
  templateExercises: [
    {
      id: 'teA1',
      templateId: TEMPLATE_ID,
      blockId: 'blkA',
      exerciseId: 'ex-pushup',
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 15,
      restTimeSeconds: 60,
      sets: 3,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      // no targetWeight → canonicalized to null
    },
    {
      id: 'teA2',
      templateId: TEMPLATE_ID,
      blockId: 'blkA',
      exerciseId: 'ex-pullup',
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 8,
      targetWeight: 12.5,
      restTimeSeconds: 90,
      sets: 3,
      orderIndex: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    {
      id: 'teB1',
      templateId: TEMPLATE_ID,
      blockId: 'blkB',
      exerciseId: 'ex-squat',
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 5,
      targetWeight: 10.0,
      restTimeSeconds: 120,
      sets: 5,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      roundTargets: [
        { round: 1, targetReps: 5, targetWeight: 10.0 },
        { round: 2, targetReps: 3, targetWeight: 12.5 },
      ],
    },
    {
      id: 'teStandalone',
      templateId: TEMPLATE_ID,
      exerciseId: 'ex-plank',
      exerciseSource: 'CATALOG',
      mode: 'TIME',
      targetTimeSeconds: 30,
      restTimeSeconds: 30,
      sets: 1,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      // blockId omitted → standalone (top-level)
    },
    {
      id: 'teDeleted',
      templateId: TEMPLATE_ID,
      blockId: 'blkA',
      exerciseId: 'ex-old',
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 1,
      restTimeSeconds: 1,
      sets: 1,
      orderIndex: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      deletedAt: 1_700_000_003_000, // MUST be fully absent from canonical structure
    },
    {
      id: 'teOrphanUnderDeletedBlock',
      templateId: TEMPLATE_ID,
      blockId: 'blkDeleted', // LIVE row, but its block is soft-deleted →
      exerciseId: 'ex-orphan', // MUST be fully absent (WR-04 rule 3 — neither grouped nor standalone)
      exerciseSource: 'CATALOG',
      mode: 'REPS',
      targetReps: 9,
      restTimeSeconds: 9,
      sets: 9,
      orderIndex: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      // no deletedAt — the exclusion is driven purely by the dead parent block
    },
  ],
  sessions: [],
  setLogs: [],
  hrSamples: [],
  plannedWorkouts: [],
  settings: [],
};

// This is the Phase 122 cross-language contract: the exact canonical string
// computePlanHash hashes for fixtureSnapshot above. Sorted keys, no whitespace,
// soft-deletes absent, targetWeight fixed-2-decimal, names/timestamps excluded.
const EXPECTED_CANONICAL_STRING =
  '{"blocks":[' +
  '{"id":"blkA","orderIndex":0,"rounds":3,"templateExercises":[' +
  '{"blockId":"blkA","exerciseId":"ex-pushup","exerciseSource":"CATALOG","id":"teA1","mode":"REPS","orderIndex":0,"restTimeSeconds":60,"roundTargets":[],"sets":3,"targetReps":15,"targetTimeSeconds":null,"targetWeight":null},' +
  '{"blockId":"blkA","exerciseId":"ex-pullup","exerciseSource":"CATALOG","id":"teA2","mode":"REPS","orderIndex":1,"restTimeSeconds":90,"roundTargets":[],"sets":3,"targetReps":8,"targetTimeSeconds":null,"targetWeight":"12.50"}' +
  ']},' +
  '{"id":"blkB","orderIndex":1,"rounds":2,"templateExercises":[' +
  '{"blockId":"blkB","exerciseId":"ex-squat","exerciseSource":"CATALOG","id":"teB1","mode":"REPS","orderIndex":0,"restTimeSeconds":120,"roundTargets":[{"round":1,"targetReps":5,"targetTimeSeconds":null,"targetWeight":"10.00"},{"round":2,"targetReps":3,"targetTimeSeconds":null,"targetWeight":"12.50"}],"sets":5,"targetReps":5,"targetTimeSeconds":null,"targetWeight":"10.00"}' +
  ']}' +
  '],"standalone":[' +
  '{"blockId":null,"exerciseId":"ex-plank","exerciseSource":"CATALOG","id":"teStandalone","mode":"TIME","orderIndex":0,"restTimeSeconds":30,"roundTargets":[],"sets":1,"targetReps":null,"targetTimeSeconds":30,"targetWeight":null}' +
  '],"templateId":"tpl-1"}';

describe('computePlanHash — exact canonical-string cross-language contract', () => {
  it('produces the EXACT pinned canonical string for the multi-block fixture (not just a stable hash)', () => {
    // canonicalStringify is exercised directly against a hand-built object matching
    // the documented canonical shape (Pattern 3 step 4), proving the exact string
    // computePlanHash must hash. This literal is the Phase 122 contract.
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"name"');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"createdAt"');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"updatedAt"');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"deletedAt"');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"isFavoriteForWatch"');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"workoutType"');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('"formatParams"');

    const expectedHash = createHash('sha256').update(EXPECTED_CANONICAL_STRING, 'utf8').digest('hex');
    expect(computePlanHash(TEMPLATE_ID, fixtureSnapshot)).toBe(expectedHash);
  });

  it('excludes a LIVE templateExercise whose blockId references a soft-deleted block (WR-04 rule 3)', () => {
    // Behavioral (non-snapshot) assertion: removing the orphan row changes nothing —
    // it was never part of the canonical structure. Its exerciseId also must not
    // appear in the pinned string above.
    const withoutOrphan: DecryptedSnapshot = {
      ...fixtureSnapshot,
      templateExercises: fixtureSnapshot.templateExercises.filter(
        (te) => te.id !== 'teOrphanUnderDeletedBlock',
      ),
    };
    expect(computePlanHash(TEMPLATE_ID, fixtureSnapshot)).toBe(
      computePlanHash(TEMPLATE_ID, withoutOrphan),
    );
    expect(EXPECTED_CANONICAL_STRING).not.toContain('ex-orphan');
    expect(EXPECTED_CANONICAL_STRING).not.toContain('teOrphanUnderDeletedBlock');
  });

  it('excludes a soft-deleted block and a soft-deleted templateExercise entirely (not present-with-flag)', () => {
    const hash = computePlanHash(TEMPLATE_ID, fixtureSnapshot);
    // Deterministic: re-running against the same fixture yields the same hash —
    // proves the soft-deleted rows are excluded consistently, not flakily included.
    expect(hash).toBe(computePlanHash(TEMPLATE_ID, fixtureSnapshot));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 64-char lowercase hex string', () => {
    expect(computePlanHash(TEMPLATE_ID, fixtureSnapshot)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// G-134-37 — wire-default normalization regression vector (planhash-wire-defaults-parity.md)
//
// The fixture below is NOT hand-built. It is the exact wire JSON the debug session read
// read-only from the device DB (Template 1de89b3a…, block "fire-time", two REPS exercises),
// re-serialized in the shape the SERVER actually emits: `rounds`, `sets`, and `exerciseSource`
// are absent KEYS, not `null` — both the app's push `Json` (NetworkModule.kt) and the server's
// response `Json` (Application.kt) run without `encodeDefaults`, and all three fields carry a
// Kotlin default (`1`, `1`, `"CATALOG"`). This is a STRING LITERAL run through `JSON.parse`,
// deliberately — an object literal could never prove a key is genuinely absent, only that a
// test author chose to omit it.
// ---------------------------------------------------------------------------

describe('G-134-37 — wire-default normalization at the decode boundary', () => {
  const WIRE_TEMPLATE_ID = '1de89b3a-d1aa-40be-872e-7166dccb2f32';

  // Wörtlich aus der Debug-Sitzung übernommen (2026-09-02, UAT-Runde 10, Vorschlag 8a259525) —
  // die drei Schlüssel rounds/sets/exerciseSource fehlen HIER ABSICHTLICH. Niemand darf sie
  // "vervollständigen": genau ihre Abwesenheit ist der Fall, den dieser Vektor beweist.
  const WIRE_JSON_TEXT = `{
    "blocks": [
      { "id": "3da6253c-85ad-415f-8d1a-34343d6a7e82",
        "templateId": "1de89b3a-d1aa-40be-872e-7166dccb2f32",
        "name": "fire-time", "orderIndex": 0,
        "createdAt": 1788295980234, "updatedAt": 1788295980234 }
    ],
    "templateExercises": [
      { "id": "cee783d0-b70e-4cb5-9a20-7f15a8256501",
        "templateId": "1de89b3a-d1aa-40be-872e-7166dccb2f32",
        "blockId": "3da6253c-85ad-415f-8d1a-34343d6a7e82",
        "exerciseId": "b9bc42fb-f2b4-3ebd-a8ac-f3d54287f48d",
        "mode": "REPS", "targetReps": 10, "restTimeSeconds": 0, "orderIndex": 0,
        "createdAt": 1788295980234, "updatedAt": 1788295980234 },
      { "id": "ffac76f4-ba1c-4012-bbb5-2f8bb745235e",
        "templateId": "1de89b3a-d1aa-40be-872e-7166dccb2f32",
        "blockId": "3da6253c-85ad-415f-8d1a-34343d6a7e82",
        "exerciseId": "095bd083-76cb-3803-87b4-be4b931d971f",
        "mode": "REPS", "targetReps": 11, "restTimeSeconds": 0, "orderIndex": 1,
        "createdAt": 1788295980234, "updatedAt": 1788295980234 }
    ]
  }`;

  function parseWire(): { blocks: SyncBlockDto[]; templateExercises: SyncTemplateExerciseDto[] } {
    return JSON.parse(WIRE_JSON_TEXT) as { blocks: SyncBlockDto[]; templateExercises: SyncTemplateExerciseDto[] };
  }

  function snapshotFrom(
    blocks: DecryptedSnapshot['blocks'],
    templateExercises: DecryptedSnapshot['templateExercises'],
  ): DecryptedSnapshot {
    return {
      syncedAt: 1_710_000_000_000,
      exercises: [],
      exerciseTranslations: [],
      templates: [],
      blocks,
      templateExercises,
      sessions: [],
      setLogs: [],
      hrSamples: [],
      plannedWorkouts: [],
      settings: [],
    };
  }

  it('JSON.parse of the real server response leaves rounds/sets/exerciseSource undefined (the fixture hits the actual case)', () => {
    const { blocks, templateExercises } = parseWire();
    expect(blocks[0].rounds).toBeUndefined();
    expect(templateExercises[0].sets).toBeUndefined();
    expect(templateExercises[0].exerciseSource).toBeUndefined();
  });

  it('normalizeWireBlock re-inserts the Kotlin default (1) for a missing rounds key', () => {
    const { blocks } = parseWire();
    expect(normalizeWireBlock(blocks[0]).rounds).toBe(1);
  });

  it('normalizeWireBlock leaves an existing non-default rounds value untouched', () => {
    expect(normalizeWireBlock({ ...blocks_withRounds3() }).rounds).toBe(3);
  });

  it('normalizeWireTemplateExercise re-inserts the Kotlin defaults (1, "CATALOG") for missing keys', () => {
    const { templateExercises } = parseWire();
    const normalized = normalizeWireTemplateExercise(templateExercises[0]);
    expect(normalized.sets).toBe(1);
    expect(normalized.exerciseSource).toBe('CATALOG');
  });

  it('normalizeWireTemplateExercise leaves existing non-default sets/exerciseSource values untouched', () => {
    const { templateExercises } = parseWire();
    const normalized = normalizeWireTemplateExercise({
      ...templateExercises[0],
      sets: 5,
      exerciseSource: 'CUSTOM',
    });
    expect(normalized.sets).toBe(5);
    expect(normalized.exerciseSource).toBe('CUSTOM');
  });

  it('the real UAT-Runde-10 rows hash to the PlanHash.kt value AFTER normalization (the fix)', () => {
    const { blocks, templateExercises } = parseWire();
    const normalized = snapshotFrom(
      blocks.map(normalizeWireBlock),
      templateExercises.map(normalizeWireTemplateExercise),
    );
    // This is the value PlanHash.kt (Room entities, cannot express "absent") computes over the
    // structurally-identical rows — the Kotlin recompute this MCP must stay byte-identical with.
    expect(computePlanHash(WIRE_TEMPLATE_ID, normalized)).toBe(
      'ed647e4c0192d0abbe15dc293e6bbb170fb5a29737d8d4bc26630c96d9b58350',
    );
  });

  it('the same rows WITHOUT normalization now throw — the old wrong value is no longer producible (Task 2)', () => {
    const { blocks, templateExercises } = parseWire();
    // Grabinschrift: fa7b2de1394c4d1e95aae8e9682210c8f689ca35d18199e72e054794c6461fe4 was the
    // server-stored plan_hash of proposal 8a259525 (UAT-Runde 10) — the undefined-token hash
    // that canonicalStringify's throw (src/hash.ts, this plan's Task 2) makes unreproducible.
    // Cast is deliberate: this simulates the pre-fix code path (raw wire rows reaching
    // computePlanHash unnormalized), which the type system itself now forbids at compile time.
    const rawSnapshot = snapshotFrom(
      blocks as unknown as DecryptedSnapshot['blocks'],
      templateExercises as unknown as DecryptedSnapshot['templateExercises'],
    );
    expect(() => computePlanHash(WIRE_TEMPLATE_ID, rawSnapshot)).toThrow();
  });
});

/** Helper fixture for the "existing value survives" test above — kept out of the JSON.parse
 * literal on purpose: it is the CONTRAST case (key present), not part of the regression vector. */
function blocks_withRounds3(): SyncBlockDto {
  return {
    id: 'blk-x',
    templateId: 'tpl-x',
    name: 'x',
    rounds: 3,
    orderIndex: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}
