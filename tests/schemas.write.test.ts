/**
 * Negative-input tests for the 3 WRITE-tool Zod schemas (WR-06).
 *
 * The handler tests invoke registered handlers directly and therefore bypass the
 * SDK's validateToolInput layer — this suite exercises the schemas themselves via
 * `safeParse`, proving the validation boundary actually rejects:
 *   - dangling `{source:'new', tempId}` refs (WR-01 refine, both schemas)
 *   - duplicate tempIds / tempBlockIds (WR-07 refines)
 *   - oversized arrays (T-121-03 / WR-02 bounds)
 *   - negative numeric targets (WR-02 bounds)
 *   - unknown discriminant literals (T-121-06)
 */

import { describe, it, expect } from 'vitest';
import {
  ProposePlanUpdateSchema,
  ProposeNewPlanSchema,
  ProposeNewExerciseSchema,
  FormatParamsSchema,
} from '../src/schemas.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// Valid baselines (positive controls — every negative case below is a single
// mutation of one of these)
// ---------------------------------------------------------------------------

const validAddOp = {
  op: 'addExercise',
  blockId: null,
  exercise: { source: 'new', tempId: 'temp-1' },
  mode: 'REPS',
  restTimeSeconds: 60,
  sets: 3,
  orderIndex: 0,
};

const validUpdate = {
  templateId: VALID_UUID,
  rationale: 'add a dragon flag',
  newExercises: [{ tempId: 'temp-1', name: 'Dragon Flag', mode: 'REPS', usesWeight: false }],
  ops: [validAddOp],
};

const validNewPlan = {
  name: 'Core Day',
  rationale: 'a new core plan',
  newExercises: [{ tempId: 'temp-1', name: 'Dragon Flag', mode: 'REPS', usesWeight: false }],
  blocks: [
    {
      tempBlockId: 'block-1',
      rounds: 3,
      orderIndex: 0,
      exercises: [
        {
          exercise: { source: 'new', tempId: 'temp-1' },
          mode: 'REPS',
          targetReps: 8,
          restTimeSeconds: 60,
          sets: 3,
          orderIndex: 0,
        },
      ],
    },
  ],
};

const validNewExercise = {
  name: 'Dragon Flag',
  mode: 'REPS',
  usesWeight: false,
  rationale: 'core strength progression',
};

// ---------------------------------------------------------------------------
// Positive controls
// ---------------------------------------------------------------------------

describe('WRITE schemas — positive controls', () => {
  it('accepts the valid baselines', () => {
    expect(ProposePlanUpdateSchema.safeParse(validUpdate).success).toBe(true);
    expect(ProposeNewPlanSchema.safeParse(validNewPlan).success).toBe(true);
    expect(ProposeNewExerciseSchema.safeParse(validNewExercise).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProposePlanUpdateSchema — negatives
// ---------------------------------------------------------------------------

describe('ProposePlanUpdateSchema — negative inputs', () => {
  it('rejects a dangling tempId ref (source:"new" without a newExercises definition) — WR-01/refine', () => {
    const bad = {
      ...validUpdate,
      ops: [{ ...validAddOp, exercise: { source: 'new', tempId: 'temp-undefined' } }],
    };
    const result = ProposePlanUpdateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects duplicate newExercises[].tempId values — WR-07', () => {
    const bad = {
      ...validUpdate,
      newExercises: [
        { tempId: 'temp-1', name: 'Dragon Flag', mode: 'REPS', usesWeight: false },
        { tempId: 'temp-1', name: 'Human Flag', mode: 'TIME', usesWeight: false },
      ],
    };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an oversized ops array (> 50) — T-121-03', () => {
    const op = { op: 'removeExercise', workoutExerciseId: VALID_UUID };
    const bad = { ...validUpdate, newExercises: [], ops: Array.from({ length: 51 }, () => op) };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an oversized reorder.order array (> 200) — WR-02', () => {
    const bad = {
      ...validUpdate,
      newExercises: [],
      ops: [{ op: 'reorder', blockId: null, order: Array.from({ length: 201 }, () => VALID_UUID) }],
    };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative targetReps — WR-02', () => {
    const bad = { ...validUpdate, ops: [{ ...validAddOp, targetReps: -1 }] };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative targetWeight inside roundTargets — WR-02', () => {
    const bad = {
      ...validUpdate,
      ops: [{ ...validAddOp, roundTargets: [{ round: 1, targetWeight: -5 }] }],
    };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown op discriminant — T-121-06', () => {
    const bad = {
      ...validUpdate,
      newExercises: [],
      ops: [{ op: 'dropTable', workoutExerciseId: VALID_UUID }],
    };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a malformed templateId UUID', () => {
    expect(ProposePlanUpdateSchema.safeParse({ ...validUpdate, templateId: 'not-a-uuid' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProposeNewPlanSchema — negatives
// ---------------------------------------------------------------------------

describe('ProposeNewPlanSchema — negative inputs', () => {
  it('rejects a dangling tempId ref in blocks[].exercises — WR-01', () => {
    const bad = {
      ...validNewPlan,
      blocks: [
        {
          ...validNewPlan.blocks[0],
          exercises: [
            {
              ...validNewPlan.blocks[0].exercises[0],
              exercise: { source: 'new', tempId: 'temp-undefined' },
            },
          ],
        },
      ],
    };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate newExercises[].tempId values — WR-07', () => {
    const bad = {
      ...validNewPlan,
      newExercises: [
        { tempId: 'temp-1', name: 'Dragon Flag', mode: 'REPS', usesWeight: false },
        { tempId: 'temp-1', name: 'Human Flag', mode: 'TIME', usesWeight: false },
      ],
    };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate blocks[].tempBlockId values — WR-07', () => {
    const bad = {
      ...validNewPlan,
      blocks: [validNewPlan.blocks[0], { ...validNewPlan.blocks[0], orderIndex: 1 }],
    };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an oversized exercises-per-block array (> 50) — WR-02', () => {
    const catalogExercise = {
      exercise: { source: 'catalog', exerciseId: VALID_UUID },
      mode: 'REPS',
      restTimeSeconds: 60,
      sets: 3,
      orderIndex: 0,
    };
    const bad = {
      ...validNewPlan,
      newExercises: [],
      blocks: [
        {
          ...validNewPlan.blocks[0],
          exercises: Array.from({ length: 51 }, () => catalogExercise),
        },
      ],
    };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty exercises array in a block — WR-02', () => {
    const bad = { ...validNewPlan, newExercises: [], blocks: [{ ...validNewPlan.blocks[0], exercises: [] }] };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative targetReps in a block exercise — WR-02', () => {
    const bad = {
      ...validNewPlan,
      blocks: [
        {
          ...validNewPlan.blocks[0],
          exercises: [{ ...validNewPlan.blocks[0].exercises[0], targetReps: -1 }],
        },
      ],
    };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown exercise-ref source discriminant — T-121-06', () => {
    const bad = {
      ...validNewPlan,
      blocks: [
        {
          ...validNewPlan.blocks[0],
          exercises: [
            {
              ...validNewPlan.blocks[0].exercises[0],
              exercise: { source: 'raw_sql', exerciseId: VALID_UUID },
            },
          ],
        },
      ],
    };
    expect(ProposeNewPlanSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProposeNewExerciseSchema — negatives
// ---------------------------------------------------------------------------

describe('ProposeNewExerciseSchema — negative inputs', () => {
  it('rejects a blank name', () => {
    expect(ProposeNewExerciseSchema.safeParse({ ...validNewExercise, name: '' }).success).toBe(false);
  });

  it('rejects an unknown mode discriminant — T-121-06', () => {
    expect(ProposeNewExerciseSchema.safeParse({ ...validNewExercise, mode: 'HOLD' }).success).toBe(false);
  });

  it('rejects an oversized rationale (> 2000)', () => {
    expect(
      ProposeNewExerciseSchema.safeParse({ ...validNewExercise, rationale: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FormatParamsSchema — Phase 134 (G-134-12), Protocol v1.7 §2.5.
// All eight non-CLASSIC workoutType values, one accepted baseline and one or
// more format-own-constraint rejections each — mirroring what
// FormatProposalApplierTest.kt (Kotlin) proves for the same eight formats.
// ---------------------------------------------------------------------------

const CATALOG_REF = { source: 'catalog', exerciseId: VALID_UUID };

const validCircuit = {
  workoutType: 'CIRCUIT',
  rounds: 3,
  restSeconds: 60,
  exercises: [{ exercise: CATALOG_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
};

const validEmom = {
  workoutType: 'EMOM',
  windowSeconds: 90,
  rounds: 10,
  stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 45, orderIndex: 0 }],
};

const validAmrap = {
  workoutType: 'AMRAP',
  timeCapMinutes: 15,
  exercises: [{ exercise: CATALOG_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
};

const validTabata = {
  workoutType: 'TABATA',
  workSeconds: 20,
  restSeconds: 10,
  rounds: 8,
  exercises: [{ exercise: CATALOG_REF, orderIndex: 0 }],
};

const validLadder = {
  workoutType: 'LADDER',
  pattern: 'ASCENDING',
  startReps: 1,
  step: 2,
  restSeconds: 45,
  repsPerRound: [1, 3, 5],
  exercises: [{ exercise: CATALOG_REF, orderIndex: 0 }],
};

const validForTime = {
  workoutType: 'FOR_TIME',
  rounds: 3,
  raceTimer: true,
  exercises: [{ exercise: CATALOG_REF, mode: 'REPS', targetReps: 21, orderIndex: 0 }],
};

const validChipper = {
  workoutType: 'CHIPPER',
  raceTimer: true,
  exercises: [{ exercise: CATALOG_REF, mode: 'REPS', targetReps: 50, orderIndex: 0 }],
};

const validDeathBy = {
  workoutType: 'DEATH_BY',
  startReps: 2,
  step: 1,
  roundCap: 25,
  exercises: [{ exercise: CATALOG_REF, orderIndex: 0 }],
};

describe('FormatParamsSchema — positive controls (all eight formats)', () => {
  it('accepts a minimal valid payload for each of the eight formats', () => {
    expect(FormatParamsSchema.safeParse(validCircuit).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validEmom).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validAmrap).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validTabata).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validLadder).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validForTime).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validChipper).success).toBe(true);
    expect(FormatParamsSchema.safeParse(validDeathBy).success).toBe(true);
  });

  it('rejects an unrecognized workoutType discriminant (UNKNOWN_FORMAT_TYPE)', () => {
    expect(FormatParamsSchema.safeParse({ workoutType: 'PILATES', exercises: [] }).success).toBe(false);
  });
});

describe('FormatParamsSchema — CIRCUIT', () => {
  it('rejects a REPS entry with no targetReps (FORMAT_PARAMS_INVALID)', () => {
    const bad = { ...validCircuit, exercises: [{ exercise: CATALOG_REF, mode: 'REPS', orderIndex: 0 }] };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a TIME entry with no targetTimeSeconds (FORMAT_PARAMS_INVALID)', () => {
    const bad = { ...validCircuit, exercises: [{ exercise: CATALOG_REF, mode: 'TIME', orderIndex: 0 }] };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty exercises list (FORMAT_PARAMS_INVALID)', () => {
    expect(FormatParamsSchema.safeParse({ ...validCircuit, exercises: [] }).success).toBe(false);
  });

  it('applies the documented defaults (rounds=3, restSeconds=60) when omitted', () => {
    const { rounds: _rounds, restSeconds: _restSeconds, ...rest } = validCircuit;
    const result = FormatParamsSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success && result.data.workoutType === 'CIRCUIT') {
      expect(result.data.rounds).toBe(3);
      expect(result.data.restSeconds).toBe(60);
    }
  });
});

describe('FormatParamsSchema — EMOM window/target boundary (in-range window, unaffected by T-134-21-01)', () => {
  it('rejects a TIME station whose targetTimeSeconds equals windowSeconds', () => {
    const bad = {
      ...validEmom,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 90, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a TIME station whose targetTimeSeconds is one less than windowSeconds', () => {
    const ok = {
      ...validEmom,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 89, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(ok).success).toBe(true);
  });
});

// The boundaries below look upside-down at first glance: with windowSeconds=15, a
// TIME station at 29 is ACCEPTED and one at 30 is REJECTED — the refusal rule runs
// against the NORMALIZED window (30..300), never the raw proposed one. That is
// exactly the contract T-134-21-01 restores: the MCP passes `windowSeconds` through
// unchanged (proven by the pass-through cases below), but the TIME-station refusal
// rule still enforces the range the App's `SaveNormalization` will clamp to
// (T-134-21-03 parity — see the KDoc above the EMOM member in src/schemas.ts).
describe('FormatParamsSchema — EMOM windowSeconds pass-through (T-134-21-01: the MCP no longer clamps)', () => {
  it('parses a below-range window (15) unchanged — not clamped to 30', () => {
    // validEmom's default station targets 45s, which would fail the TIME-station
    // refusal rule against a normalized window of 30 — a REPS station sidesteps that
    // rule entirely so this test isolates windowSeconds pass-through alone.
    const result = FormatParamsSchema.safeParse({
      ...validEmom,
      windowSeconds: 15,
      stations: [{ exercise: CATALOG_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.workoutType === 'EMOM') {
      expect(result.data.windowSeconds).toBe(15);
    }
  });

  it('parses an above-range window (600) unchanged — not clamped to 300', () => {
    const result = FormatParamsSchema.safeParse({ ...validEmom, windowSeconds: 600 });
    expect(result.success).toBe(true);
    if (result.success && result.data.workoutType === 'EMOM') {
      expect(result.data.windowSeconds).toBe(600);
    }
  });

  it('parses an in-range window (90) unchanged', () => {
    const result = FormatParamsSchema.safeParse({ ...validEmom, windowSeconds: 90 });
    expect(result.success).toBe(true);
    if (result.success && result.data.workoutType === 'EMOM') {
      expect(result.data.windowSeconds).toBe(90);
    }
  });

  it('rejects a window of 0 — still below the lower bound of 1', () => {
    expect(FormatParamsSchema.safeParse({ ...validEmom, windowSeconds: 0 }).success).toBe(false);
  });

  it('applies the documented default of 60 when windowSeconds is omitted', () => {
    const { windowSeconds: _windowSeconds, ...rest } = validEmom;
    const result = FormatParamsSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success && result.data.workoutType === 'EMOM') {
      expect(result.data.windowSeconds).toBe(60);
    }
  });

  it('rejects a TIME station at the normalized ceiling (30) of a below-range window (15)', () => {
    const bad = {
      ...validEmom,
      windowSeconds: 15,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 30, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a TIME station one below the normalized ceiling (29) of a below-range window (15)', () => {
    const ok = {
      ...validEmom,
      windowSeconds: 15,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 29, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts a TIME station below the raw window (25) of a below-range window (15) — the comparison runs against 30, not 15', () => {
    const ok = {
      ...validEmom,
      windowSeconds: 15,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 25, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects a TIME station well above the normalized ceiling (300) of an above-range window (600)', () => {
    const bad = {
      ...validEmom,
      windowSeconds: 600,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 400, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a TIME station exactly at the normalized ceiling (300) of an above-range window (600)', () => {
    const bad = {
      ...validEmom,
      windowSeconds: 600,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 300, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a TIME station below the normalized ceiling (299) of an above-range window (600) — the comparison runs against 300, not 600', () => {
    const ok = {
      ...validEmom,
      windowSeconds: 600,
      stations: [{ exercise: CATALOG_REF, mode: 'TIME', targetTimeSeconds: 299, orderIndex: 0 }],
    };
    expect(FormatParamsSchema.safeParse(ok).success).toBe(true);
  });
});

describe('FormatParamsSchema — TABATA (slot form, no mode/target)', () => {
  it('rejects an entry carrying mode', () => {
    const bad = { ...validTabata, exercises: [{ exercise: CATALOG_REF, orderIndex: 0, mode: 'REPS' }] };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an entry carrying targetReps', () => {
    const bad = { ...validTabata, exercises: [{ exercise: CATALOG_REF, orderIndex: 0, targetReps: 10 }] };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });
});

describe('FormatParamsSchema — LADDER (repsPerRound authoritative)', () => {
  it('accepts the valid baseline with a 5-entry ramp not derivable from startReps/step', () => {
    const ok = { ...validLadder, repsPerRound: [1, 3, 5, 7, 9] };
    expect(FormatParamsSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects an empty repsPerRound', () => {
    expect(FormatParamsSchema.safeParse({ ...validLadder, repsPerRound: [] }).success).toBe(false);
  });

  it('rejects a repsPerRound entry below 1', () => {
    expect(FormatParamsSchema.safeParse({ ...validLadder, repsPerRound: [1, 0, 5] }).success).toBe(false);
  });

  it('rejects an unrecognized pattern', () => {
    expect(FormatParamsSchema.safeParse({ ...validLadder, pattern: 'RANDOM' }).success).toBe(false);
  });
});

describe('FormatParamsSchema — CHIPPER', () => {
  // Deviation from this plan's own draft text (which specified omitting `rounds`
  // entirely): the frozen shared corpus's `chipper-rounds-normalized-not-rejected`
  // vector carries `rounds: 3` on the wire, and the Kotlin side (Plan 134-20,
  // confirmed decision) keeps `rounds` on `FormatParamsProposal.Chipper` to match
  // FOR_TIME's shape exactly and stay parseable against that vector. A payload
  // carrying `rounds` MUST be accepted here, not rejected — the app normalizes it
  // to 1 at apply time; this schema does not validate `rounds` at all for CHIPPER.
  it('accepts a payload carrying rounds (normalized to 1 at apply time on the app side, not here)', () => {
    expect(FormatParamsSchema.safeParse({ ...validChipper, rounds: 3 }).success).toBe(true);
  });

  // WR-03 (134-REVIEW.md): unlike every sibling format's `rounds` field (all `.min(1)`),
  // CHIPPER's `rounds` is NOT a FORMAT_PARAMS_INVALID condition on the Kotlin side
  // (`FormatProposalApplier.validateParams`'s CHIPPER branch never checks `rounds` at
  // all) — a `rounds: 0` or negative value must reach the app to be normalized to 1,
  // not be refused here before the coach can even propose it.
  it('accepts rounds: 0 — CHIPPER rounds is never a rejection condition, unlike every sibling format', () => {
    expect(FormatParamsSchema.safeParse({ ...validChipper, rounds: 0 }).success).toBe(true);
  });

  it('accepts a negative rounds value for the same reason', () => {
    expect(FormatParamsSchema.safeParse({ ...validChipper, rounds: -5 }).success).toBe(true);
  });

  it('rejects an empty exercises list', () => {
    expect(FormatParamsSchema.safeParse({ ...validChipper, exercises: [] }).success).toBe(false);
  });
});

describe('FormatParamsSchema — DEATH_BY', () => {
  it('applies the default roundCap of 30 when omitted', () => {
    const { roundCap: _roundCap, ...rest } = validDeathBy;
    const result = FormatParamsSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success && result.data.workoutType === 'DEATH_BY') {
      expect(result.data.roundCap).toBe(30);
    }
  });

  it('rejects startReps below 1', () => {
    expect(FormatParamsSchema.safeParse({ ...validDeathBy, startReps: 0 }).success).toBe(false);
  });
});

describe('FormatParamsSchema — AMRAP', () => {
  it('rejects timeCapMinutes below 1', () => {
    expect(FormatParamsSchema.safeParse({ ...validAmrap, timeCapMinutes: 0 }).success).toBe(false);
  });

  it('rejects an empty exercises list', () => {
    expect(FormatParamsSchema.safeParse({ ...validAmrap, exercises: [] }).success).toBe(false);
  });
});

describe('FormatParamsSchema — FOR_TIME', () => {
  it('rejects rounds below 1', () => {
    expect(FormatParamsSchema.safeParse({ ...validForTime, rounds: 0 }).success).toBe(false);
  });

  it('rejects a non-boolean raceTimer', () => {
    expect(FormatParamsSchema.safeParse({ ...validForTime, raceTimer: 'yes' }).success).toBe(false);
  });
});

describe('FormatParamsSchema — strict unknown-key rejection (T-134-21-03 parity)', () => {
  it('rejects an unknown top-level key on a CIRCUIT payload', () => {
    expect(FormatParamsSchema.safeParse({ ...validCircuit, extraField: 'nope' }).success).toBe(false);
  });

  it('rejects an unknown key on a formatExerciseEntry', () => {
    const bad = { ...validCircuit, exercises: [{ ...validCircuit.exercises[0], extraField: 'nope' }] };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown key on a formatWeightEntry (LADDER)', () => {
    const bad = { ...validLadder, exercises: [{ ...validLadder.exercises[0], extraField: 'nope' }] };
    expect(FormatParamsSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ProposePlanUpdateSchema — formatParams integration', () => {
  it('accepts a payload carrying formatParams and no ops key at all', () => {
    const ok = {
      templateId: VALID_UUID,
      rationale: 'propose a circuit',
      formatParams: validCircuit,
    };
    expect(ProposePlanUpdateSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects a payload carrying neither ops nor formatParams (FORMAT_PARAMS_REQUIRED)', () => {
    const bad = { templateId: VALID_UUID, rationale: 'neither set' };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a payload carrying both a non-empty ops[] and formatParams (OPS_AND_FORMAT_PARAMS_EXCLUSIVE)', () => {
    const bad = {
      templateId: VALID_UUID,
      rationale: 'both set',
      ops: [{ op: 'removeExercise', workoutExerciseId: VALID_UUID }],
      formatParams: validCircuit,
    };
    expect(ProposePlanUpdateSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-134-21-01 (third finding, Plan 134-47): a formatParams entry whose
// {source:'new', tempId} ref is not declared in newExercises[] is refused, not
// silently dropped — the same tempId-declaration condition the ops[]/blocks[]
// `.refine`s above already enforce, applied a third time for formatParams. Two
// entry-list field names are exercised: CIRCUIT's `exercises` and EMOM's
// `stations` — the tempId-declaration check must not know only one field name.
// ---------------------------------------------------------------------------
describe('ProposePlanUpdateSchema — formatParams New-ref tempId declaration (T-134-21-01)', () => {
  const declaredNewExercise = { tempId: 'temp-format-1', name: 'Dragon Flag', mode: 'REPS', usesWeight: false };
  const NEW_REF = { source: 'new', tempId: 'temp-format-1' };

  it('accepts a CIRCUIT entry whose New ref tempId IS declared in newExercises[]', () => {
    const ok = {
      templateId: VALID_UUID,
      rationale: 'circuit with a genuinely new exercise',
      newExercises: [declaredNewExercise],
      formatParams: {
        ...validCircuit,
        exercises: [{ exercise: NEW_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
      },
    };
    expect(ProposePlanUpdateSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects a CIRCUIT entry whose New ref tempId is NOT declared in newExercises[] (FORMAT_PARAMS_INVALID)', () => {
    const bad = {
      templateId: VALID_UUID,
      rationale: 'circuit referencing an undeclared tempId',
      formatParams: {
        ...validCircuit,
        exercises: [{ exercise: NEW_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
      },
    };
    const result = ProposePlanUpdateSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('FORMAT_PARAMS_INVALID'))).toBe(true);
    }
  });

  it('accepts an EMOM station whose New ref tempId IS declared in newExercises[] (stations, not exercises)', () => {
    const ok = {
      templateId: VALID_UUID,
      rationale: 'emom with a genuinely new exercise',
      newExercises: [{ ...declaredNewExercise, mode: 'TIME' }],
      formatParams: {
        ...validEmom,
        stations: [{ exercise: NEW_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
      },
    };
    expect(ProposePlanUpdateSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects an EMOM station whose New ref tempId is NOT declared in newExercises[] (FORMAT_PARAMS_INVALID, stations field)', () => {
    const bad = {
      templateId: VALID_UUID,
      rationale: 'emom station referencing an undeclared tempId',
      formatParams: {
        ...validEmom,
        stations: [{ exercise: NEW_REF, mode: 'REPS', targetReps: 10, orderIndex: 0 }],
      },
    };
    const result = ProposePlanUpdateSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('FORMAT_PARAMS_INVALID'))).toBe(true);
    }
  });

  it('leaves a Catalog-only formatParams untouched by the rule, with newExercises present and unrelated', () => {
    const ok = {
      templateId: VALID_UUID,
      rationale: 'circuit with only catalog refs, unrelated newExercises present',
      newExercises: [declaredNewExercise],
      formatParams: validCircuit,
    };
    expect(ProposePlanUpdateSchema.safeParse(ok).success).toBe(true);
  });

  it('leaves a Catalog-only formatParams untouched by the rule, with no newExercises[] at all', () => {
    const ok = {
      templateId: VALID_UUID,
      rationale: 'circuit with only catalog refs, no newExercises',
      formatParams: validCircuit,
    };
    expect(ProposePlanUpdateSchema.safeParse(ok).success).toBe(true);
  });
});
