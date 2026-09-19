/**
 * Cross-language parity proof for the format-template `plan_update` enforcement
 * points (Phase 134, G-134-12, Protocol v1.7 §2.5) — the second of two vectors this
 * plan is built to prove.
 *
 * Iterates the shared `formatProposal` corpus section (`docs/coach-planning-vectors.json`,
 * loaded via `loadCoachPlanningVectors()` — D-01/D-02, no copies, loud failure, never a
 * silent skip) and decides each vector through the SAME two-stage pipeline the real
 * `propose_plan_update` handler uses:
 *
 *   1. `ProposePlanUpdateSchema.safeParse` — the Zod boundary. Three of the six named
 *      refusal reasons are DECIDED here by design: `UNKNOWN_FORMAT_TYPE` (an
 *      unrecognized `formatParams.workoutType` — the `discriminatedUnion` itself
 *      refuses it), `FORMAT_PARAMS_INVALID` (a format's own field constraint, e.g. an
 *      empty exercise list), and `OPS_AND_FORMAT_PARAMS_EXCLUSIVE` (a `.superRefine`
 *      on `ProposePlanUpdateSchema` itself).
 *   2. `validateFormatProposal(vector.templateWorkoutType, parsed)` — the pure
 *      decision function this plan's Task 1 built, for the three refusal reasons that
 *      need the target template's own `workoutType` and can never be decided by the
 *      payload shape alone: `FORMAT_PARAMS_REQUIRED`, `FORMAT_PARAMS_NOT_ALLOWED`,
 *      `FORMAT_TYPE_MISMATCH`.
 *
 * One vector (`format-type-mismatch-circuit-target-amrap-discriminator`) is decided
 * at the Zod boundary too, but INCIDENTALLY rather than by design: its `formatParams`
 * declares `workoutType: 'AMRAP'` while carrying CIRCUIT-shaped fields
 * (`rounds`/`restSeconds` instead of `timeCapMinutes`) — the strict `discriminatedUnion`
 * member for AMRAP rejects the unrecognized keys before the discriminator mismatch is
 * ever compared. The Kotlin twin, `FormatProposalApplierTest.kt`
 * (`rejected vectors from the shared corpus validate to the named refusal reason where
 * parseable`), hits the EXACT SAME vector at its own strict-decoder layer for the
 * identical reason (its own `ignoreUnknownKeys = false` AMRAP member has no
 * `rounds`/`restSeconds` fields either) and documents it explicitly rather than
 * papering over it — this test mirrors that acknowledgment instead of forcing an
 * artificial symmetry the corpus's own vector shape does not support. Neither side
 * edits the corpus to make its own code pass (Protocol §6, the loud-failure rule this
 * file's loader already enforces at the file-not-found/JSON-parse layer).
 */

import { describe, it, expect } from 'vitest';
import { loadCoachPlanningVectors } from './shared-vectors.js';
import { ProposePlanUpdateSchema } from '../src/schemas.js';
import { validateFormatProposal, type FormatRefusalReason } from '../src/format_proposal.js';
import { buildPlanUpdatePayload } from '../src/tools/propose_plan_update.js';
import { mockCatalog } from './fixture.js';
import type { CatalogExercise } from '../src/types.js';

/** The three reason codes DELIBERATELY decided at the Zod boundary by this codebase's
 * own schema design — see this file's header comment. */
const DELIBERATE_ZOD_BOUNDARY_REASONS: ReadonlySet<FormatRefusalReason> = new Set([
  'UNKNOWN_FORMAT_TYPE',
  'FORMAT_PARAMS_INVALID',
  'OPS_AND_FORMAT_PARAMS_EXCLUSIVE',
]);

/** The one vector both languages' strict decoders reject INCIDENTALLY (shape
 * mismatch under a valid-but-wrong discriminator) rather than by design — see this
 * file's header comment and `FormatProposalApplierTest.kt`'s matching acknowledgment. */
const KNOWN_INCIDENTAL_ZOD_BOUNDARY_VECTOR = 'format-type-mismatch-circuit-target-amrap-discriminator';

describe('shared formatProposal corpus — MCP/Kotlin enforcement-point parity (G-134-12)', () => {
  const corpus = loadCoachPlanningVectors();

  it('carries at least one vector for all eight formats plus the CLASSIC refusal case', () => {
    const seenTemplateTypes = new Set(corpus.formatProposal.map((v) => v.templateWorkoutType));
    for (const type of ['CIRCUIT', 'EMOM', 'AMRAP', 'TABATA', 'LADDER', 'FOR_TIME', 'CHIPPER', 'DEATH_BY']) {
      expect(seenTemplateTypes.has(type)).toBe(true);
    }
  });

  it('every accepted vector validates to format or classicOps — all eight formats, no filter', () => {
    const accepted = corpus.formatProposal.filter((v) => v.accepted);
    // A silently emptied corpus section must fail loudly, not vacuously pass every assertion.
    expect(accepted.length).toBeGreaterThan(0);

    const workoutTypesSeen = new Set<string>();
    for (const vector of accepted) {
      workoutTypesSeen.add(vector.templateWorkoutType);
      const candidateArgs = { ...vector.payload, rationale: 'corpus vector' };
      const zodResult = ProposePlanUpdateSchema.safeParse(candidateArgs);
      expect(zodResult.success, `vector "${vector.name}" expected to parse`).toBe(true);
      if (!zodResult.success) continue;

      const verdict = validateFormatProposal(vector.templateWorkoutType, zodResult.data);
      expect(
        verdict.kind === 'format' || verdict.kind === 'classicOps',
        `vector "${vector.name}" expected format/classicOps, got ${JSON.stringify(verdict)}`,
      ).toBe(true);
    }

    // All eight non-CLASSIC workout types must appear among the accepted vectors —
    // otherwise "no filter" could vacuously mean "no vectors for some format existed".
    const allEightFormats = new Set([
      'CIRCUIT', 'EMOM', 'AMRAP', 'TABATA', 'LADDER', 'FOR_TIME', 'CHIPPER', 'DEATH_BY',
    ]);
    expect(workoutTypesSeen).toStrictEqual(allEightFormats);
  });

  it('every rejected vector is refused — either by validateFormatProposal with the exact named reason, or at the Zod boundary for a deliberate or known-incidental reason', () => {
    const rejected = corpus.formatProposal.filter((v) => !v.accepted);
    expect(rejected.length).toBeGreaterThan(0);

    let validatedCount = 0;
    let zodBoundaryCount = 0;

    for (const vector of rejected) {
      const candidateArgs = { ...vector.payload, rationale: 'corpus vector' };
      const zodResult = ProposePlanUpdateSchema.safeParse(candidateArgs);

      if (!zodResult.success) {
        zodBoundaryCount++;
        const isDeliberate = DELIBERATE_ZOD_BOUNDARY_REASONS.has(vector.reason as FormatRefusalReason);
        const isKnownIncidental = vector.name === KNOWN_INCIDENTAL_ZOD_BOUNDARY_VECTOR;
        expect(
          isDeliberate || isKnownIncidental,
          `vector "${vector.name}" failed at the Zod boundary for an unaccounted-for reason`,
        ).toBe(true);
        continue;
      }

      validatedCount++;
      const verdict = validateFormatProposal(vector.templateWorkoutType, zodResult.data);
      expect(verdict.kind, `vector "${vector.name}" expected refused`).toBe('refused');
      if (verdict.kind === 'refused') {
        expect(verdict.reason, `vector "${vector.name}"`).toBe(vector.reason);
      }
    }

    // The corpus carries 8 rejected vectors (134-16, plus one in 134-44 and one for
    // review finding WR-01): 6 decided at the Zod boundary (5 deliberate + 1
    // known-incidental), 2 reaching validateFormatProposal.
    //
    // Both EMOM window additions are Zod-boundary decisions for the same reason: their
    // `FORMAT_PARAMS_INVALID` is raised inside the EMOM object's own `superRefine`
    // (schemas.ts), one of the three deliberate reasons, not by `validateFormatProposal`.
    //   - 134-44's `emom-window-above-range-time-station-still-refused` — a TIME station
    //     whose target (400) sits above the raw windowSeconds AND above the CLAMPED 300.
    //   - WR-01's `emom-window-above-range-time-station-at-exact-ceiling-refused` — the
    //     same shape at EXACTLY 300. Only this value distinguishes the correct `>=` rule
    //     from an accidental `>`; 400 refuses under both operators and 299 is accepted
    //     under both, so neither pins it.
    expect(zodBoundaryCount).toBe(6);
    expect(validatedCount).toBe(2);
  });

  it('rewrites the tempId vector\'s {source:"new"} ref in formatParams to the matched catalog UUID', () => {
    const vector = corpus.formatProposal.find((v) => v.name === 'circuit-full-update-with-new-exercise-tempid');
    expect(vector).toBeDefined();
    if (!vector) return;

    const candidateArgs = { ...vector.payload, rationale: 'corpus vector' };
    const parsed = ProposePlanUpdateSchema.safeParse(candidateArgs);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // The corpus's novel exercise is named "Dead Hang"; mockCatalog (tests/fixture.ts)
    // carries no such entry, so a catalog carrying one is built here specifically to
    // exercise the MATCH path — proving the {source:'new'} ref inside `formatParams`
    // is rewritten to `{source:'catalog', exerciseId}` exactly like an `ops[]` ref
    // already is (A2), the SAME rewrite path `buildPlanUpdatePayload` applies to both.
    const DEAD_HANG_UUID = 'bbbbbbbb-0002-4bbb-8bbb-bbbbbbbbbbbb';
    const catalogWithDeadHang: CatalogExercise[] = [
      ...mockCatalog,
      {
        id: DEAD_HANG_UUID,
        key: 'dead_hang',
        nameEn: 'Dead Hang',
        mode: 'TIME',
        usesWeight: false,
        lastModifiedAt: 1_700_000_000_000,
        translations: [],
        muscleGroups: [],
        equipment: [],
        capabilities: [],
        origin: 'CATALOG',
      },
    ];

    const payload = buildPlanUpdatePayload(parsed.data, catalogWithDeadHang);
    expect(payload.newExercises).toStrictEqual([]);
    const formatParams = payload.formatParams as { exercises: { exercise: unknown }[] } | undefined;
    expect(formatParams).toBeDefined();
    expect(formatParams?.exercises[1].exercise).toStrictEqual({ source: 'catalog', exerciseId: DEAD_HANG_UUID });
  });
});
