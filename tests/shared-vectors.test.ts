/**
 * PROVENANCE (D-01/D-02/D-03): Loads docs/coach-planning-vectors.json — the single
 * canonical cross-language test-vector corpus in the CaliCompanion super-repo — via
 * loadCoachPlanningVectors() and asserts the machine-checkable invariants a wrong corpus
 * edit would break.
 *
 * The Kotlin twin (TrainCounter's CoachPlanningVectorsTest.kt) replays the same `expansion`
 * vectors through the real RecurrenceExpander.expandDates(). As of Phase 135 this file
 * ALSO replays every `expansion` vector through the TypeScript port (src/recurrence.ts) —
 * the same three corpus vectors now gate both languages, proving byte-identical output
 * for every valid rule (SCHED-03).
 *
 * seriesHash and rruleAllowlist sections (plan 132-02) are proven loadable, Zod-validated,
 * and shape-asserted here; their real cross-language TypeScript consumers
 * (series-hash.ts / the RRULE-allowlist enforcement code) are Phase 136's job (D-19).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCoachPlanningVectors, resolveCorpusPath, RRULE_ALLOWLIST_REASON_CODES } from './shared-vectors.js';
import {
  expandDates,
  parseIsoDate,
  formatIsoDate,
  parseDeletedOccurrences,
  weekOffsetsForGroups,
  renderSeriesFields,
} from '../src/recurrence.js';
import { decrypt } from '../src/crypto.js';
import { decryptPlannedWorkout } from '../src/cache.js';
import { calculateLongestStreak, calculateCurrentStreak } from '../src/training-state/consistency.js';
import { toRadarValues, weightedCounts } from '../src/training-state/muscle-balance.js';
import { weightedCounts as capabilityWeightedCounts } from '../src/training-state/capability-balance.js';
import { amrapSummary, deathBySummary, emomIntervals } from '../src/training-state/format-progress.js';
import type { MiscSyncRow, DecryptedSetLog } from '../src/types.js';

/**
 * Phase 137-07 (STATE-02, D-04): the named float-comparison tolerance the muscleBalance
 * corpus's `_provenance.regeneration` entry requires — Kotlin's toRadarValues returns
 * Float, this port returns number (double precision), so the replay below compares
 * against expectedRadar within this tolerance, never bit-for-bit and never a bare
 * literal at the comparison site.
 */
const MUSCLE_BALANCE_FLOAT_TOLERANCE = 1e-6;

describe('shared coach-planning vector corpus', () => {
  const corpus = loadCoachPlanningVectors();

  // -----------------------------------------------------------------------
  // Corpus-present direction (task 1): shape + invariants a wrong edit would break.
  // -----------------------------------------------------------------------

  it('loads all top-level sections', () => {
    expect(corpus._provenance).toBeDefined();
    expect(Array.isArray(corpus.expansion)).toBe(true);
    expect(Array.isArray(corpus.seriesHash)).toBe(true);
    expect(Array.isArray(corpus.seriesFields)).toBe(true);
    expect(Array.isArray(corpus.rruleAllowlist)).toBe(true);
  });

  it('carries the tracer vector monthly-clamp-31-to-shorter-month with exactly four expected dates', () => {
    const vector = corpus.expansion.find((v) => v.name === 'monthly-clamp-31-to-shorter-month');
    expect(vector).toBeDefined();
    expect(vector?.expectedDates).toHaveLength(4);
  });

  it.each(corpus.expansion)(
    'expansion vector "$name": every expectedDates entry lies within [rangeStart, rangeEnd]',
    (vector) => {
      for (const date of vector.expectedDates) {
        expect(date >= vector.rangeStart).toBe(true);
        expect(date <= vector.rangeEnd).toBe(true);
      }
    },
  );

  it.each(corpus.expansion)(
    'expansion vector "$name": expectedDates is strictly ascending with no duplicates',
    (vector) => {
      for (let i = 1; i < vector.expectedDates.length; i++) {
        expect(vector.expectedDates[i] > vector.expectedDates[i - 1]).toBe(true);
      }
    },
  );

  it.each(corpus.expansion.filter((v) => !v.deletedOccurrencesRaw))(
    'expansion vector "$name": no expectedDates entry appears in deletedOccurrences',
    (vector) => {
      // Narrowed (phase 135) to exclude vectors carrying `deletedOccurrencesRaw` —
      // `freq-missing-deleted-occurrences-ignored-asymmetry` deliberately violates this
      // invariant BY DESIGN (RecurrenceExpander.kt's FREQ-missing branch never consults
      // deletedDates), so it is exempt rather than failing this generic structural check.
      const deleted = new Set(vector.deletedOccurrences);
      for (const date of vector.expectedDates) {
        expect(deleted.has(date)).toBe(false);
      }
    },
  );

  it.each(corpus.expansion)('expansion vector "$name": rrule is a non-empty string', (vector) => {
    expect(typeof vector.rrule).toBe('string');
    expect(vector.rrule.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // expansion section, TypeScript replay (Phase 135, SCHED-03): the real
  // cross-language gate — every corpus vector fed through the hand-ported
  // src/recurrence.ts expandDates() must produce the byte-identical expectedDates
  // list, same values, same order. This is what proves the port, not merely a
  // shape check on the corpus file.
  // -----------------------------------------------------------------------

  it('expansion section is non-empty (a silently emptied corpus must fail loudly, not pass vacuously)', () => {
    expect(corpus.expansion.length).toBeGreaterThan(0);
  });

  it.each(corpus.expansion)(
    'expansion vector "$name": TypeScript expandDates() replay matches expectedDates exactly',
    (vector) => {
      // Phase 135, D-09: when the vector carries the stored deletedOccurrences COLUMN
      // (deletedOccurrencesRaw), derive the excluded set via this port's own
      // parseDeletedOccurrences instead of trusting the corpus's already-parsed array —
      // and assert the derived list deep-equals that array, so the vector pins the parse
      // result and the expansion result in one pass.
      const excluded =
        vector.deletedOccurrencesRaw !== undefined && vector.deletedOccurrencesRaw !== null
          ? parseDeletedOccurrences(vector.deletedOccurrencesRaw)
          : vector.deletedOccurrences;
      if (vector.deletedOccurrencesRaw !== undefined && vector.deletedOccurrencesRaw !== null) {
        expect(excluded).toEqual(vector.deletedOccurrences);
      }
      const dates = expandDates(
        parseIsoDate(vector.startDate),
        vector.rrule,
        parseIsoDate(vector.rangeStart),
        parseIsoDate(vector.rangeEnd),
        new Set(excluded),
      );
      expect(dates.map(formatIsoDate)).toEqual(vector.expectedDates);
    },
  );

  // -----------------------------------------------------------------------
  // seriesHash section (plan 132-02, D-13/D-14/D-15): shape invariants a wrong
  // corpus edit would break. The real cross-language digest computation is exercised
  // by TrainCounter's SeriesHashTest.kt; series-hash.ts is Phase 136's job.
  // -----------------------------------------------------------------------

  it.each(corpus.seriesHash)('seriesHash vector "$name": expectedHash is 64 lowercase hex characters', (vector) => {
    expect(vector.expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(corpus.seriesHash)(
    'seriesHash vector "$name": expectedCanonicalString is a bare array (starts with "[" and ends with "]")',
    (vector) => {
      expect(vector.expectedCanonicalString.startsWith('[')).toBe(true);
      expect(vector.expectedCanonicalString.endsWith(']')).toBe(true);
    },
  );

  // -----------------------------------------------------------------------
  // seriesFields section (phase 135-03, SCHED-02, D-07/D-08/D-10): the real
  // cross-language gate for the derived series fields AND the weekOffset
  // reference-Monday derivation — the second WKST trap this phase guards against.
  // The Kotlin twin (TrainCounter's SeriesFieldsTest.kt) replays the same vectors
  // against RecurrenceExpander.parseRRuleConfig/reconstructSeriesConfig.
  // -----------------------------------------------------------------------

  it('seriesFields section is non-empty (a silently emptied corpus must fail loudly, not pass vacuously)', () => {
    expect(corpus.seriesFields.length).toBeGreaterThan(0);
  });

  it.each(corpus.seriesFields)(
    'seriesFields vector "$name": weekOffsetsForGroups + renderSeriesFields replay matches every expectedFields entry',
    (vector) => {
      const roots = vector.roots.map((r) => ({
        id: r.id,
        scheduledDate: r.scheduledDate,
        recurrenceRule: r.recurrenceRule,
        recurrenceGroupId: r.recurrenceGroupId,
      }));
      const offsets = weekOffsetsForGroups(roots);

      for (const expectation of vector.expectedFields) {
        const root = vector.roots.find((r) => r.id === expectation.rootId);
        expect(root, `vector "${vector.name}" expectedFields.rootId "${expectation.rootId}" has no matching root`).toBeDefined();

        const rendered = renderSeriesFields(root!.recurrenceRule);
        expect(rendered.freq).toBe(expectation.freq);
        expect(rendered.interval).toBe(expectation.interval);
        expect(rendered.byDay).toEqual(expectation.byDay);
        expect(rendered.until).toBe(expectation.until);
        expect(offsets.get(expectation.rootId)).toBe(expectation.weekOffset);
      }
    },
  );

  // -----------------------------------------------------------------------
  // rruleAllowlist section (plan 132-02, D-16/D-17/D-18/D-19): shape invariants.
  // -----------------------------------------------------------------------

  it('rruleAllowlist has at least one accepted case and at least one rejected case', () => {
    expect(corpus.rruleAllowlist.some((c) => c.accepted === true)).toBe(true);
    expect(corpus.rruleAllowlist.some((c) => c.accepted === false)).toBe(true);
  });

  it('every reason code in RRULE_ALLOWLIST_REASON_CODES is exercised by at least one rejected case', () => {
    const usedReasons = new Set(corpus.rruleAllowlist.filter((c) => !c.accepted).map((c) => c.reason));
    for (const code of RRULE_ALLOWLIST_REASON_CODES) {
      expect(usedReasons.has(code)).toBe(true);
    }
  });

  it('no two rruleAllowlist cases share an identical rrule string', () => {
    const rrules = corpus.rruleAllowlist.map((c) => c.rrule);
    expect(new Set(rrules).size).toBe(rrules.length);
  });

  // -----------------------------------------------------------------------
  // _provenance.enforcementPoints (D-19): the corpus is the shared regression guard
  // for BOTH RRULE-allowlist enforcement sites — removing either from the corpus must
  // fail this suite, not just go unnoticed in a document.
  // -----------------------------------------------------------------------

  it('_provenance.enforcementPoints names both PROP-08 and EDIT-07 exactly once', () => {
    const requirements = corpus._provenance.enforcementPoints.map((p) => p.requirement);
    expect(requirements.filter((r) => r === 'PROP-08')).toHaveLength(1);
    expect(requirements.filter((r) => r === 'EDIT-07')).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // plannedWorkoutCipher section (phase 135-04, SCHED-01, D-12/D-13/D-14): the
  // crypto-parity fixture proving the MCP decrypts an app-written
  // PlannedWorkoutSnapshot correctly. Replayed through BOTH the raw decrypt()
  // boundary AND decryptPlannedWorkout() — the exact function the MCP's real
  // decode boundary (cache.ts) uses — so the parity proof covers the real decode
  // boundary, not a test-local re-implementation of it.
  //
  // Note: tests/vectors/parity-vector.ts + tests/crypto.test.ts stay in place —
  // that fixture pins the raw AES-GCM wire form for the codebase at large and
  // predates the shared corpus; this vector pins one app-written entity end to
  // end, a different claim.
  // -----------------------------------------------------------------------

  describe('plannedWorkoutCipher vector', () => {
    const vector = corpus.plannedWorkoutCipher;

    it('keyB64 decodes to 32 bytes (the fixed test key) and the ciphertext IV decodes to 12 bytes', () => {
      expect(Buffer.from(vector.keyB64, 'base64').length).toBe(32);
      const { iv } = JSON.parse(vector.ciphertextJson) as { iv: string; ct: string };
      expect(Buffer.from(iv, 'base64').length).toBe(12);
    });

    it('decrypts through src/crypto.ts decrypt() to exactly the expected plaintext', () => {
      const plaintext = JSON.parse(decrypt(vector.ciphertextJson, vector.keyB64));
      expect(plaintext).toEqual(vector.expectedPlaintext);
    });

    it('decryptPlannedWorkout() — the real decode boundary — returns exactly the D-06-allowed fields, no more', () => {
      const plaintext = vector.expectedPlaintext;
      const row: MiscSyncRow = {
        id: plaintext.id as string,
        kind: 'planned_workout',
        clientLocalId: plaintext.id as string,
        encryptedPayload: vector.ciphertextJson,
        createdAt: 0,
        updatedAt: 0,
      };
      const decrypted = decryptPlannedWorkout(row, vector.keyB64);

      expect(decrypted.id).toBe(plaintext.id);
      expect(decrypted.templateId).toBe(plaintext.templateId);
      expect(decrypted.scheduledDate).toBe(plaintext.scheduledDate);
      expect(decrypted.scheduledTime).toBe(plaintext.scheduledTime);
      expect(decrypted.note).toBe(plaintext.note);
      expect(decrypted.recurrenceRule).toBe(plaintext.recurrenceRule);
      expect(decrypted.recurrenceGroupId).toBe(plaintext.recurrenceGroupId);
      expect(decrypted.deletedOccurrencesRaw).toBe(plaintext.deletedOccurrences);
      expect(decrypted.completedSessionId).toBe(plaintext.completedSessionId);

      // D-06: assert on the KEY SET, not only the values, so a future field that
      // leaks calendarEventId/createdAt onto DecryptedPlannedWorkout fails here.
      expect(Object.keys(decrypted).sort()).toEqual(
        [
          'id',
          'templateId',
          'scheduledDate',
          'scheduledTime',
          'note',
          'recurrenceRule',
          'recurrenceGroupId',
          'deletedOccurrencesRaw',
          'completedSessionId',
        ].sort(),
      );
    });

    it('a single altered character in the ciphertext ct value makes decrypt() throw (GCM auth tag enforced)', () => {
      const parsed = JSON.parse(vector.ciphertextJson) as { iv: string; ct: string };
      const ctBuf = Buffer.from(parsed.ct, 'base64');
      ctBuf[ctBuf.length - 1] ^= 0xff;
      const tampered = JSON.stringify({ iv: parsed.iv, ct: ctBuf.toString('base64') });
      expect(() => decrypt(tampered, vector.keyB64)).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // streak section (Phase 137-01, STATE-02, D-04 TRACER SLICE): the real
  // cross-language gate for the ported TrainingStreakCalculator.kt logic —
  // CoachPlanningVectorsTest.kt replays the same vectors against the real Kotlin
  // calculator, so this section proves both languages agree, not merely that this
  // port agrees with itself.
  // -----------------------------------------------------------------------

  it('streak section is non-empty (a silently emptied corpus must fail loudly, not pass vacuously)', () => {
    expect(corpus.streak.length).toBeGreaterThan(0);
  });

  it.each(corpus.streak)(
    'streak vector "$name": calculateLongestStreak/calculateCurrentStreak replay matches expectedLongest/expectedCurrent',
    (vector) => {
      expect(calculateLongestStreak(vector.sortedWeeks)).toBe(vector.expectedLongest);
      expect(calculateCurrentStreak(vector.sortedWeeks, vector.currentWeekKey)).toBe(vector.expectedCurrent);
    },
  );

  // -----------------------------------------------------------------------
  // muscleBalance section, step 2: weightedCounts (Phase 138-12, MUSC-06, D-12/D-17): the
  // real cross-language gate for the ported MuscleInvolvementWeighting.kt logic —
  // CoachPlanningVectorsTest.kt replays the same vectors' levelCounts against the real
  // Kotlin MuscleInvolvementWeighting.weightedCounts, so this proves both languages agree,
  // not merely that this port agrees with itself. levelCounts/expectedWeighted are now
  // MANDATORY on every vector (the Zod schema enforces this — a vector missing either
  // field fails to load at all, not merely this section's assertions).
  // -----------------------------------------------------------------------

  it('muscleBalance section is non-empty (a silently emptied corpus must fail loudly, not pass vacuously)', () => {
    expect(corpus.muscleBalance.length).toBeGreaterThan(0);
  });

  it('at least one muscleBalance vector carries a null (default-PRIMARY, D-03) involvementLevel — a section that quietly dropped the default-primary case must fail loudly, not pass vacuously', () => {
    const hasNullLevel = corpus.muscleBalance.some((vector) =>
      vector.levelCounts.some((row) => row.involvementLevel === null),
    );
    expect(hasNullLevel).toBe(true);
  });

  it('at least one muscleBalance vector carries a STABILIZER involvementLevel — a section that quietly dropped the STABILIZER case must fail loudly, not pass vacuously', () => {
    const hasStabilizerLevel = corpus.muscleBalance.some((vector) =>
      vector.levelCounts.some((row) => row.involvementLevel === 'STABILIZER'),
    );
    expect(hasStabilizerLevel).toBe(true);
  });

  it.each(corpus.muscleBalance)(
    'muscleBalance vector "$name": weightedCounts replay matches expectedWeighted within the named float tolerance',
    (vector) => {
      const actual = weightedCounts(vector.levelCounts);
      for (const [muscleGroupKey, expected] of Object.entries(vector.expectedWeighted)) {
        expect(Math.abs(actual[muscleGroupKey] - expected)).toBeLessThanOrEqual(MUSCLE_BALANCE_FLOAT_TOLERANCE);
      }
    },
  );

  // -----------------------------------------------------------------------
  // muscleBalance section, step 2: toRadarValues (Phase 137-07, STATE-02, D-04): the real
  // cross-language gate for the ported MuscleBalanceCalculator.kt logic —
  // CoachPlanningVectorsTest.kt replays the same vectors against the real Kotlin
  // calculator, so this section proves both languages agree, not merely that this port
  // agrees with itself. Every vector's muscleSetCounts IS its weighted map (step 1's
  // output) — this step proves the second half of the stage→factor→radar chain (D-17).
  // -----------------------------------------------------------------------

  it.each(corpus.muscleBalance)(
    'muscleBalance vector "$name": toRadarValues replay matches expectedRadar within the named float tolerance',
    (vector) => {
      const actual = toRadarValues(vector.muscleSetCounts);
      for (const [category, expected] of Object.entries(vector.expectedRadar)) {
        expect(Math.abs(actual[category] - expected)).toBeLessThanOrEqual(MUSCLE_BALANCE_FLOAT_TOLERANCE);
      }
    },
  );

  // -----------------------------------------------------------------------
  // formatProgress section (Phase 137-09, STATE-02, D-20): the real cross-language
  // gate for the ported FormatSummary.kt logic — CoachPlanningVectorsTest.kt replays
  // the same vectors against the real Kotlin functions, so this section proves both
  // languages agree, not merely that this port agrees with itself. Only the
  // per-session value is parity-bound (see this section's schema doc-comment in
  // shared-vectors.ts) — the longitudinal series computeFormatProgress builds is not.
  // -----------------------------------------------------------------------

  it('formatProgress section is non-empty (a silently emptied corpus must fail loudly, not pass vacuously)', () => {
    expect(corpus.formatProgress.length).toBeGreaterThan(0);
  });

  it.each(corpus.formatProgress)(
    'formatProgress vector "$name" ($workoutType): the real port function matches expected',
    (vector) => {
      const rows: DecryptedSetLog[] = vector.rows.map((r, i) => ({
        id: `row-${i}`,
        sessionId: 'session',
        completedReps: r.completedReps,
        completedTimeSeconds: null,
        weightUsed: null,
        startedAt: null,
        measuredTimeSeconds: null,
        createdAt: i,
        updatedAt: i,
      }));

      if (vector.workoutType === 'AMRAP') {
        const score = amrapSummary(rows, vector.exercisesPerRound ?? 0);
        expect(score.rounds).toBe(vector.expected.rounds);
        expect(score.reps).toBe(vector.expected.reps);
      } else if (vector.workoutType === 'DEATH_BY') {
        const score = deathBySummary(rows, vector.roundCap ?? 30);
        expect(score.highestFullRound).toBe(vector.expected.highestFullRound);
        expect(score.complete).toBe(vector.expected.complete);
      } else {
        expect(emomIntervals(rows)).toBe(vector.expected.intervals);
      }
    },
  );

  // -----------------------------------------------------------------------
  // capabilityBalance section (Phase 138.1, CAP-01/CAP-05, `138.1-17`): the real
  // cross-language gate for the ported CapabilityInvolvementWeighting.kt logic —
  // CoachPlanningVectorsTest.kt (`138.1-16`) replays the same vectors' levelCounts
  // against the real Kotlin CapabilityInvolvementWeighting.weightedCounts, so this
  // proves both languages agree, not merely that this port agrees with itself. Unlike
  // muscleBalance, this section proves only the stage->factor fold — D-14 forbids
  // densifying capability axes into a handful of radar categories, so there is no
  // second replay step here. Reuses MUSCLE_BALANCE_FLOAT_TOLERANCE (not a new named
  // constant) — the same Kotlin-Float-vs-TypeScript-double precision reasoning applies
  // verbatim to this section's replay.
  // -----------------------------------------------------------------------

  it('capabilityBalance section is non-empty (a silently emptied corpus must fail loudly, not pass vacuously)', () => {
    expect(corpus.capabilityBalance.length).toBeGreaterThan(0);
  });

  it('at least one capabilityBalance vector carries expectRejection: true — the D-04 null-level rejection case must not be silently dropped', () => {
    const hasRejection = corpus.capabilityBalance.some((vector) => vector.expectRejection === true);
    expect(hasRejection).toBe(true);
  });

  it.each(corpus.capabilityBalance.filter((v) => v.expectRejection !== true))(
    'capabilityBalance vector "$name": weightedCounts replay matches expectedWeighted within the named float tolerance',
    (vector) => {
      const actual = capabilityWeightedCounts(vector.levelCounts);
      for (const [axisKey, expected] of Object.entries(vector.expectedWeighted ?? {})) {
        expect(Math.abs(actual[axisKey] - expected)).toBeLessThanOrEqual(MUSCLE_BALANCE_FLOAT_TOLERANCE);
      }
    },
  );

  it.each(corpus.capabilityBalance.filter((v) => v.expectRejection === true))(
    'capabilityBalance vector "$name": weightedCounts throws — D-04 has no default level across the language boundary',
    (vector) => {
      expect(() => capabilityWeightedCounts(vector.levelCounts)).toThrow();
    },
  );

  // -----------------------------------------------------------------------
  // Corpus-absent direction (task 2, D-02): both directions covered.
  // -----------------------------------------------------------------------

  describe('loadCoachPlanningVectors failure path', () => {
    const emptyDirs: string[] = [];

    afterAll(() => {
      for (const dir of emptyDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws a named D-02 diagnostic when the corpus is unreachable', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'gsd-132-'));
      emptyDirs.push(emptyDir);

      const resolvedPath = resolveCorpusPath(emptyDir);

      expect(() => loadCoachPlanningVectors(emptyDir)).toThrow(/coach-planning-vectors\.json/);
      expect(() => loadCoachPlanningVectors(emptyDir)).toThrow(/D-02/);
      expect(() => loadCoachPlanningVectors(emptyDir)).toThrow(resolvedPath);
    });
  });
});
