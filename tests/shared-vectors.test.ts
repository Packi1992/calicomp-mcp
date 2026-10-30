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
import { loadCoachPlanningVectors, resolveCorpusPath, RRULE_ALLOWLIST_REASON_CODES, corpusCatalog, corpusSnapshot } from './shared-vectors.js';
import {
  expandDates,
  parseIsoDate,
  formatIsoDate,
  parseDeletedOccurrences,
  weekOffsetsForGroups,
  renderSeriesFields,
} from '../src/recurrence.js';
import { decrypt } from '../src/crypto.js';
import { createHmac } from 'node:crypto';
import {
  decodeOwnExercisePlaintext,
  decodeOwnExerciseTranslationPlaintext,
  decryptOwnExercise,
  decryptOwnExerciseTranslation,
} from '../src/own-exercise-cipher.js';
import {
  decryptPlannedWorkout,
  decryptSession,
  decryptForeignActivity,
  decryptForeignActivityType,
  decryptPlannedForeignActivity,
  decryptExerciseNameOverride,
  decodeExerciseNameOverridePlaintext,
  RowDecodeError,
} from '../src/cache.js';
import { FOREIGN_BUILTIN_TYPES } from '../src/foreign-types.js';
import { assignForeignFulfilment, foreignFulfilmentRatio } from '../src/training-state/foreign-adherence.js';
import { calculateLongestStreak, calculateCurrentStreak, computePersonalRecords } from '../src/training-state/consistency.js';
import {
  toRadarValues,
  weightedCounts,
  strengthLevelSetCounts,
  strengthLevelSetCountsForSession,
} from '../src/training-state/muscle-balance.js';
import { weightedCounts as capabilityWeightedCounts } from '../src/training-state/capability-balance.js';
import { amrapSummary, deathBySummary, emomIntervals } from '../src/training-state/format-progress.js';
import {
  MUSCLE_KEY,
  NewExerciseDefSchema,
  ProposeExerciseUpdateSchema,
  ProposeNewExerciseSchema,
  ProposeNewPlanSchema,
  ProposePlanUpdateSchema,
} from '../src/schemas.js';
import { buildExerciseUpdatePayload, validateExerciseUpdate } from '../src/tools/propose_exercise_update.js';
import { buildNewExercisePayload, findUnknownLinkKey } from '../src/tools/propose_new_exercise.js';
import { computeChangeHash } from '../src/hash.js';
import { buildNewPlanPayload, type ProposeNewPlanArgs } from '../src/tools/propose_new_plan.js';
import { buildPlanUpdatePayload, type ProposePlanUpdateArgs } from '../src/tools/propose_plan_update.js';
import type { MiscSyncRow, DecryptedSetLog, SyncSessionDto, DecryptedSnapshot, UnreadableRow, CatalogExercise } from '../src/types.js';
import { resolveAppLanguage } from '../src/app-language.js';
import { createExerciseNameResolver } from '../src/exercise-names.js';

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
  // sessionCipher section (Phase 151, FB-09/FB-11): the crypto-parity fixture proving
  // the MCP decrypts an app-written session payload (protocol §1.3 "The session
  // payload") correctly — byte-identical plaintext, and `decryptSession()` — the real
  // decode boundary `cache.ts` uses — decoding every vector to the normative
  // `expectedDecoded` form. `decryptSession(row, keyB64)` is fed a minimal
  // `SyncSessionDto` row built from each vector; the result is picked down to
  // {startTime, endTime, feedback, goalSnapshot} and round-tripped through
  // JSON.parse(JSON.stringify(...)) before comparison: an undefined field becomes
  // absent (matching a vector with no claim about it), except `endTime`, which is
  // explicitly normalized to `null` when undefined (an ongoing session) because every
  // vector's `expectedDecoded.endTime` is an explicit `null`, never an absent key.
  // -----------------------------------------------------------------------

  function sessionRowFromVector(vector: (typeof corpus.sessionCipher)[number]): SyncSessionDto {
    return {
      id: `sessioncipher-${vector.name}`,
      startTime: 0,
      endTime: undefined,
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      encryptedPayload: vector.ciphertextJson,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  describe('sessionCipher vectors', () => {
    it('P151 FB-09 every sessionCipher vector decrypts to its exact plaintext string', () => {
      for (const vector of corpus.sessionCipher) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
      }
    });

    it('P151 FB-09 decryptSession decodes every sessionCipher vector to expectedDecoded', () => {
      for (const vector of corpus.sessionCipher) {
        const row = sessionRowFromVector(vector);
        // Loosely typed on purpose — DecryptedSession does not carry feedback/goalSnapshot
        // yet at the RED stage of this plan's tracer task; typecheck must stay green
        // through both the RED and GREEN commits.
        const decoded = decryptSession(row, vector.keyB64) as unknown as Record<string, unknown>;
        const picked = JSON.parse(
          JSON.stringify({
            startTime: decoded.startTime,
            endTime: (decoded.endTime as number | undefined) ?? null,
            feedback: decoded.feedback,
            goalSnapshot: decoded.goalSnapshot,
          }),
        );
        expect(picked).toEqual(vector.expectedDecoded);
      }
    });

    it('P151 FB-09 the hostile comment arrives byte-identical', () => {
      for (const vector of corpus.sessionCipher) {
        const row = sessionRowFromVector(vector);
        const decoded = decryptSession(row, vector.keyB64) as unknown as {
          feedback: { comment: { text: string } | null };
        };
        const expectedComment = (vector.expectedPlaintext as Record<string, unknown>).fc;
        if (typeof expectedComment === 'string' && expectedComment.length > 0) {
          expect(decoded.feedback.comment?.text).toBe(expectedComment);
        } else {
          expect(decoded.feedback.comment).toBeNull();
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // foreignActivityCipher section (Phase 155, FA-08): crypto parity for an app-written
  // `foreign_activity` payload — byte-identical plaintext through `decrypt()`, and
  // `decryptForeignActivity()` — the real decode boundary `decryptMerge` uses — returning
  // exactly the §1.6 normal form `expectedDecoded`, the hostile note included.
  // -----------------------------------------------------------------------

  function miscRowFromVector(
    vector: { name: string; ciphertextJson: string },
    kind: string,
  ): MiscSyncRow {
    return {
      id: `${kind}-${vector.name}`,
      kind,
      clientLocalId: `${kind}-${vector.name}`,
      encryptedPayload: vector.ciphertextJson,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  describe('foreignActivityCipher vectors', () => {
    it('P155 foreignActivityCipher section is non-empty', () => {
      expect(corpus.foreignActivityCipher.length).toBeGreaterThan(0);
    });

    it('P155 FA-08 every foreignActivityCipher vector decrypts to its exact plaintext string', () => {
      for (const vector of corpus.foreignActivityCipher) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
      }
    });

    it('P155 FA-08 decryptForeignActivity decodes every foreignActivityCipher vector to expectedDecoded', () => {
      for (const vector of corpus.foreignActivityCipher) {
        const decoded = decryptForeignActivity(miscRowFromVector(vector, 'foreign_activity'), vector.keyB64);
        // toStrictEqual: same keys, same values, nothing extra — the normal form exactly.
        expect({ ...decoded }).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded)).toEqual(Object.keys(vector.expectedDecoded));
      }
    });

    it('P155 FA-08 the hostile activity note arrives byte-identical', () => {
      let hostileSeen = 0;
      for (const vector of corpus.foreignActivityCipher) {
        const decoded = decryptForeignActivity(miscRowFromVector(vector, 'foreign_activity'), vector.keyB64);
        const expectedNote = (vector.expectedPlaintext as Record<string, unknown>).note;
        if (typeof expectedNote === 'string') {
          expect(decoded.note).toBe(expectedNote);
          expect(Buffer.from(decoded.note ?? '', 'utf8').equals(Buffer.from(expectedNote, 'utf8'))).toBe(true);
          if (expectedNote.includes('Ignore all previous instructions')) hostileSeen += 1;
        } else {
          expect(decoded.note).toBeNull();
        }
      }
      // The corpus must actually carry the hostile note, or this test proves nothing.
      expect(hostileSeen).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // foreignActivityTypes, foreignActivityTypeCipher, plannedForeignActivityCipher
  // (Phase 155, FA-08, E-15): the predefined type table, and crypto parity for own types
  // and appointment roots through the real decoders `decryptMerge` uses.
  // -----------------------------------------------------------------------

  describe('foreignActivityTypes section', () => {
    it('P155 foreignActivityTypes section is non-empty', () => {
      expect(corpus.foreignActivityTypes.length).toBeGreaterThan(0);
    });

    it('P155 E-15 the builtin type table matches the foreignActivityTypes corpus', () => {
      expect(FOREIGN_BUILTIN_TYPES.map((t) => ({ ...t }))).toStrictEqual(corpus.foreignActivityTypes);
    });
  });

  describe('foreignActivityTypeCipher vectors', () => {
    it('P155 foreignActivityTypeCipher section is non-empty', () => {
      expect(corpus.foreignActivityTypeCipher.length).toBeGreaterThan(0);
    });

    it('P155 FA-08 every foreignActivityTypeCipher vector decrypts to its exact plaintext string', () => {
      for (const vector of corpus.foreignActivityTypeCipher) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
      }
    });

    it('P155 FA-08 decryptForeignActivityType decodes every foreignActivityTypeCipher vector to expectedDecoded', () => {
      for (const vector of corpus.foreignActivityTypeCipher) {
        const decoded = decryptForeignActivityType(miscRowFromVector(vector, 'foreign_activity_type'), vector.keyB64);
        expect({ ...decoded }).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded)).toEqual(Object.keys(vector.expectedDecoded));
      }
    });

    it('P155 FA-08 the hostile type name arrives byte-identical', () => {
      let hostileSeen = 0;
      for (const vector of corpus.foreignActivityTypeCipher) {
        const decoded = decryptForeignActivityType(miscRowFromVector(vector, 'foreign_activity_type'), vector.keyB64);
        const expectedName = (vector.expectedPlaintext as Record<string, unknown>).name as string;
        expect(Buffer.from(decoded.name, 'utf8').equals(Buffer.from(expectedName, 'utf8'))).toBe(true);
        if (expectedName.includes('Ignore all')) hostileSeen += 1;
      }
      expect(hostileSeen).toBeGreaterThan(0);
    });
  });

  describe('plannedForeignActivityCipher vectors', () => {
    it('P155 plannedForeignActivityCipher section is non-empty', () => {
      expect(corpus.plannedForeignActivityCipher.length).toBeGreaterThan(0);
    });

    it('P155 FA-08 every plannedForeignActivityCipher vector decrypts to its exact plaintext string', () => {
      for (const vector of corpus.plannedForeignActivityCipher) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
      }
    });

    it('P155 FA-08 decryptPlannedForeignActivity decodes every plannedForeignActivityCipher vector to expectedDecoded', () => {
      for (const vector of corpus.plannedForeignActivityCipher) {
        const decoded = decryptPlannedForeignActivity(
          miscRowFromVector(vector, 'planned_foreign_activity'),
          vector.keyB64,
        );
        expect({ ...decoded }).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded)).toEqual(Object.keys(vector.expectedDecoded));
        // deletedOccurrences stays the raw stored string, never parsed here.
        expect(decoded.deletedOccurrencesRaw).toBe(
          (vector.expectedPlaintext as Record<string, unknown>).deletedOccurrences,
        );
      }
    });

    it('P155 FA-08 the hostile appointment note arrives byte-identical', () => {
      let hostileSeen = 0;
      for (const vector of corpus.plannedForeignActivityCipher) {
        const decoded = decryptPlannedForeignActivity(
          miscRowFromVector(vector, 'planned_foreign_activity'),
          vector.keyB64,
        );
        const expectedNote = (vector.expectedPlaintext as Record<string, unknown>).note;
        if (typeof expectedNote === 'string') {
          expect(Buffer.from(decoded.note ?? '', 'utf8').equals(Buffer.from(expectedNote, 'utf8'))).toBe(true);
          if (expectedNote.includes('Ignore all previous instructions')) hostileSeen += 1;
        } else {
          expect(decoded.note).toBeNull();
        }
      }
      expect(hostileSeen).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // exerciseNameOverrideCipher section (Phase 156, REN-01, D-11): crypto parity for an
  // app-written `exercise_name_override` payload — byte-identical plaintext through
  // `decrypt()`, and `decryptExerciseNameOverride()` — the real decode boundary
  // `decryptMerge` uses — returning exactly the §1.7 normal form `expectedDecoded`, the
  // hostile name at NAME_MAX and the description at DESCRIPTION_MAX included.
  // -----------------------------------------------------------------------

  /**
   * An `exercise_name_override` wire row for a cipher vector. Since 156-29 the decoder
   * checks `clientLocalId === "<exerciseId>:<languageCode>"` (§1.7 "Decoded rows", rule 5),
   * so the row carries the key the app writes for this payload. Since plan 166-10
   * (156-GR-MCP-07) the key comes from the vector's INPUT, its decrypted ciphertext, and never
   * from `expectedDecoded`: comparing the decoder's normal form against the expectation is then
   * a real check. The rule "key = payload" itself (a key that names another exercise or
   * language) is pinned by the decode vectors `clientLocalId-mismatch` and
   * `clientLocalId-other-exercise` of `exerciseNameOverrideDecode`.
   */
  function overrideRowFromVector(vector: {
    name: string;
    keyB64: string;
    ciphertextJson: string;
    expectedDecoded: Record<string, unknown>;
  }): MiscSyncRow {
    const input = JSON.parse(decrypt(vector.ciphertextJson, vector.keyB64)) as { exerciseId?: unknown; languageCode?: unknown };
    return {
      ...miscRowFromVector(vector, 'exercise_name_override'),
      clientLocalId: `${String(input.exerciseId)}:${String(input.languageCode)}`,
    };
  }

  // Plan 166-10 (D-19, 156-GR-MCP-07): the row key of a cipher vector comes from the vector's
  // INPUT (its ciphertext, decrypted), never from expectedDecoded — otherwise a decoder that
  // swapped exerciseId and languageCode would still meet a key built from the expectation.
  it('P166 GR-MCP-07 the corpus test derives clientLocalId from the input not from the expectation', () => {
    let checked = 0;
    for (const vector of [...corpus.exerciseNameOverrideCipher, ...corpus.exerciseNameOverrideCipherV2]) {
      const plain = JSON.parse(decrypt(vector.ciphertextJson, vector.keyB64)) as { exerciseId: string; languageCode: string };
      const fromInput = `${plain.exerciseId}:${plain.languageCode}`;
      expect(overrideRowFromVector(vector).clientLocalId, vector.name).toBe(fromInput);
      // Planted control: a tampered expectation must not move the key.
      const tampered = {
        ...vector,
        expectedDecoded: { ...vector.expectedDecoded, exerciseId: '00000000-0000-4000-8000-000000000000', languageCode: 'xx' },
      };
      expect(overrideRowFromVector(tampered).clientLocalId, vector.name).toBe(fromInput);
      checked += 1;
    }
    expect(checked, 'NICHT GEMESSEN: no cipher vector of exerciseNameOverride').toBeGreaterThanOrEqual(4);
  });

  describe('exerciseNameOverrideCipher vectors', () => {
    it('P156 exerciseNameOverrideCipher section is non-empty', () => {
      expect(corpus.exerciseNameOverrideCipher.length).toBeGreaterThan(0);
    });

    it('P156 D-11 every exerciseNameOverrideCipher vector decrypts to its exact plaintext string', () => {
      for (const vector of corpus.exerciseNameOverrideCipher) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
      }
    });

    it('P156 D-11 decryptExerciseNameOverride decodes every exerciseNameOverrideCipher vector to expectedDecoded', () => {
      for (const vector of corpus.exerciseNameOverrideCipher) {
        const decoded = decryptExerciseNameOverride(overrideRowFromVector(vector), vector.keyB64);
        // toStrictEqual: same keys, same values, nothing extra — the normal form exactly.
        expect({ ...decoded }).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded)).toEqual(Object.keys(vector.expectedDecoded));
      }
    });

    it('P156 D-11 the hostile own name and description arrive byte-identical', () => {
      let hostileNameSeen = 0;
      let nameAtLimitSeen = 0;
      let descriptionAtLimitSeen = 0;
      let nullDescriptionSeen = 0;
      for (const vector of corpus.exerciseNameOverrideCipher) {
        const decoded = decryptExerciseNameOverride(overrideRowFromVector(vector), vector.keyB64);
        const plaintext = vector.expectedPlaintext as Record<string, unknown>;
        const expectedName = plaintext.name as string;
        expect(decoded.name).toBe(expectedName);
        expect(Buffer.from(decoded.name ?? '', 'utf8').equals(Buffer.from(expectedName, 'utf8'))).toBe(true);
        if (expectedName.includes('Ignore all')) hostileNameSeen += 1;
        // NAME_MAX = 255 UTF-16 code units (protocol §1.7) — the decoder never cuts.
        if (expectedName.length === 255) nameAtLimitSeen += 1;
        const expectedDescription = plaintext.description;
        if (typeof expectedDescription === 'string') {
          expect(decoded.description).toBe(expectedDescription);
          expect(
            Buffer.from(decoded.description ?? '', 'utf8').equals(Buffer.from(expectedDescription, 'utf8')),
          ).toBe(true);
          // DESCRIPTION_MAX = 1000 UTF-16 code units (protocol §1.7).
          if (expectedDescription.length === 1000) descriptionAtLimitSeen += 1;
        } else {
          expect(expectedDescription).toBeNull();
          expect(decoded.description).toBeNull();
          nullDescriptionSeen += 1;
        }
      }
      // The corpus must actually carry each edge, or this test proves nothing.
      expect(hostileNameSeen).toBeGreaterThan(0);
      expect(nameAtLimitSeen).toBeGreaterThan(0);
      expect(descriptionAtLimitSeen).toBeGreaterThan(0);
      expect(nullDescriptionSeen).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // exerciseNameOverrideCipherV2 section (Phase 156 gap round, D-22): the plaintext form
  // version 2 of §1.7 — a description-only override (`name: null`) and a version-2 row
  // with a name — through the same real decode boundary `decryptMerge` uses.
  // -----------------------------------------------------------------------

  describe('exerciseNameOverrideCipherV2 vectors', () => {
    it('P156 D-22 exerciseNameOverrideCipherV2 section holds both vectors', () => {
      // A replay that read fewer vectors than the corpus carries would pass vacuously.
      expect(corpus.exerciseNameOverrideCipherV2.map((v) => v.name)).toEqual([
        'description-only-hostile-description-at-limit',
        'v2-with-name-read-only',
      ]);
    });

    it('P156 D-22 every exerciseNameOverrideCipherV2 vector decrypts to its exact plaintext string', () => {
      for (const vector of corpus.exerciseNameOverrideCipherV2) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
      }
    });

    it('P156 D-22 decryptExerciseNameOverride decodes every exerciseNameOverrideCipherV2 vector to expectedDecoded', () => {
      let decodedCount = 0;
      let nullNameSeen = 0;
      for (const vector of corpus.exerciseNameOverrideCipherV2) {
        const decoded = decryptExerciseNameOverride(overrideRowFromVector(vector), vector.keyB64);
        // toStrictEqual: same keys, same values, nothing extra — the normal form exactly.
        expect({ ...decoded }).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded)).toEqual(Object.keys(vector.expectedDecoded));
        // The hostile description arrives byte for byte (it is never output by a tool).
        const expectedDescription = vector.expectedDecoded.description;
        if (expectedDescription !== null) {
          expect(
            Buffer.from(decoded.description ?? '', 'utf8').equals(Buffer.from(expectedDescription, 'utf8')),
          ).toBe(true);
        }
        if (decoded.name === null) nullNameSeen += 1;
        decodedCount += 1;
      }
      expect(decodedCount).toBe(2);
      expect(nullNameSeen).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // exerciseNameOverrideDecode section (Phase 156 gap round, WR-MCP-03, IN-TC-07): the
  // decoding rules of §1.7 "Decoded rows" at the plaintext level, through the REAL
  // `decodeExerciseNameOverridePlaintext` that `decryptExerciseNameOverride` (and thereby
  // `decryptMerge`) uses. The Kotlin twin (ExerciseNameOverrideDecodeVectorsTest.kt, plan
  // 156-32) replays the same vectors, so both languages decide every row the same way.
  // Expected outcomes are derived by hand from §1.7 and never adjusted to the code.
  // -----------------------------------------------------------------------

  describe('exerciseNameOverrideDecode vectors', () => {
    it('P164 exerciseNameOverrideDecode section holds all 63 vectors', () => {
      // A replay that read fewer vectors than the corpus carries would pass vacuously.
      // 57 until plan 166-10, which added six vectors of GR-MCP-01.
      expect(corpus.exerciseNameOverrideDecode).toHaveLength(63);
      expect(new Set(corpus.exerciseNameOverrideDecode.map((v) => v.name)).size).toBe(63);
    });

    it('P156 WR-MCP-03 every exerciseNameOverrideDecode vector decodes to its expected outcome', () => {
      let readableSeen = 0;
      let unreadableSeen = 0;
      for (const vector of corpus.exerciseNameOverrideDecode) {
        const row = { id: `exercise_name_override-${vector.name}`, clientLocalId: vector.clientLocalId };
        const expected = vector.expected;
        if (expected.readable) {
          const decoded = decodeExerciseNameOverridePlaintext(vector.plaintext, row);
          // toStrictEqual: same keys, same values, nothing extra — the normal form exactly,
          // byte for byte (no trimming, no cutting for length).
          expect({ ...decoded }, vector.name).toStrictEqual(expected.decoded);
          expect(Object.keys(decoded), vector.name).toEqual(Object.keys(expected.decoded));
          readableSeen += 1;
        } else {
          let caught: unknown;
          try {
            decodeExerciseNameOverridePlaintext(vector.plaintext, row);
          } catch (err) {
            caught = err;
          }
          expect(caught, vector.name).toBeInstanceOf(RowDecodeError);
          expect((caught as RowDecodeError).reason, vector.name).toBe(expected.reason);
          // The message names the row id and the cause only, never content from the payload.
          expect((caught as RowDecodeError).message, vector.name).toMatch(
            new RegExp(
              `^exercise_name_override row ${row.id} has (a malformed payload|an unknown schema version)$`,
            ),
          );
          unreadableSeen += 1;
        }
      }
      expect(readableSeen + unreadableSeen).toBe(63);
      expect(readableSeen).toBeGreaterThan(0);
      expect(unreadableSeen).toBeGreaterThan(0);
    });

    // Plan 166-10 (D-19, 156 review GR-MCP-01): plaintext a lenient JSON reader would accept
    // (an unquoted literal, `01`, `+1`, a bare word, `NaN`) is no JSON and fails rule 3 with
    // malformed_payload before the version is read; an updatedAt outside ±(2^53 - 1) fails
    // rule 5, also in the exponent spelling. Both decoder sections, the real decoders.
    it('P166 GR-MCP-01 every decode vector with invalid JSON or an unsafe integer yields its reason', () => {
      const overrideNames = [
        'unquoted-literal-in-unknown-key', 'v-leading-zero', 'v-plus-sign', 'v-bare-word', 'v-not-a-number',
        'updatedAt-exponent-beyond-safe-integer', 'updatedAt-outside-safe-integer', 'updatedAt-beyond-long',
      ];
      const ownNames = [
        'unquoted-literal-in-unknown-key', 'v-leading-zero', 'updatedAt-exponent-beyond-safe-integer',
        'updatedAt-outside-safe-integer', 'updatedAt-beyond-long',
      ];
      const reasonOf = (fn: () => unknown): string | undefined => {
        try {
          fn();
        } catch (err) {
          return err instanceof RowDecodeError ? err.reason : `not a RowDecodeError: ${String(err)}`;
        }
        return undefined;
      };
      for (const name of overrideNames) {
        const vector = corpus.exerciseNameOverrideDecode.find((v) => v.name === name);
        expect(vector, name).toBeDefined();
        expect(vector!.expected, name).toEqual({ readable: false, reason: 'malformed_payload' });
        const row = { id: `exercise_name_override-${name}`, clientLocalId: vector!.clientLocalId };
        expect(reasonOf(() => decodeExerciseNameOverridePlaintext(vector!.plaintext, row)), name).toBe('malformed_payload');
      }
      for (const name of ownNames) {
        const vector = corpus.ownExerciseDecode.find((v) => v.name === name);
        expect(vector, name).toBeDefined();
        expect(vector!.reason, name).toBe('malformed_payload');
        expect(reasonOf(() => decodeOwnExercisePlaintext(vector!.plaintext, vector!.rowId)), name).toBe('malformed_payload');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Own exercises, encrypted (Phase 164, CRYPT-01, D-25; protocol 1.45 §1.9): the four corpus
  // sections `ownExerciseCipher`, `ownExerciseTranslationCipher`, `ownExerciseDecode` and
  // `keyCheck`, replayed through the REAL decoders of `src/own-exercise-cipher.ts` that
  // `decryptMerge` uses. The Kotlin twin (plan 164-07) replays the same vectors, so both
  // languages decide every row the same way. Expected outcomes come from the corpus and are
  // never adjusted to the code.
  // -----------------------------------------------------------------------

  describe('own exercise vectors (Phase 164)', () => {
    /** An exercise row as `GET /api/mcp/data/pull?exerciseCipher=1` sends it: placeholders in the content fields (§1.9). */
    function ownExerciseRow(rowId: string, ciphertextJson: string): {
      id: string; name: string; mode: string; usesWeight: boolean; encryptedPayload: string; createdAt: number; updatedAt: number;
    } {
      return { id: rowId, name: '', mode: 'REPS', usesWeight: false, encryptedPayload: ciphertextJson, createdAt: 0, updatedAt: 0 };
    }

    /** The message of a decode error names the entity, the row id and the cause only, never payload content. */
    const OWN_EXERCISE_ERROR_MESSAGE =
      /^(exercise|exercise_translation) row [0-9a-f-]+ (has a malformed payload|has an unknown schema version|could not be decrypted|arrived with an empty encryptedPayload)$/;

    it('P164 own exercise sections hold all vectors', () => {
      // A replay that read fewer vectors than the corpus carries would pass vacuously.
      expect(corpus.ownExerciseCipher).toHaveLength(6);
      expect(corpus.ownExerciseTranslationCipher).toHaveLength(3);
      // 33 until plan 166-10, which added three vectors of GR-MCP-01.
      expect(corpus.ownExerciseDecode).toHaveLength(36);
      expect(corpus.keyCheck).toHaveLength(3);
    });

    it('P164 every ownExerciseCipher vector decrypts to its exact plaintext and decodes to expectedDecoded', () => {
      let decodedCount = 0;
      let hostileSeen = 0;
      let nameAtLimitSeen = 0;
      let descriptionAtLimitSeen = 0;
      let nullDescriptionSeen = 0;
      for (const vector of corpus.ownExerciseCipher) {
        if (!('expectedDecoded' in vector)) continue;
        expect(decrypt(vector.ciphertextJson, vector.keyB64), vector.name).toBe(vector.expectedPlaintextString);
        const decoded = decryptOwnExercise(ownExerciseRow(vector.rowId, vector.ciphertextJson), vector.keyB64);
        // toStrictEqual: same keys, same values, nothing extra — the normal form exactly.
        expect({ ...decoded }, vector.name).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded), vector.name).toEqual(Object.keys(vector.expectedDecoded));
        // Byte for byte: the reader never trims, cuts or interprets a name (O-6).
        expect(Buffer.from(decoded.name, 'utf8').equals(Buffer.from(vector.expectedDecoded.name, 'utf8'))).toBe(true);
        if (vector.expectedDecoded.name.includes('Ignore all')) hostileSeen += 1;
        if (vector.expectedDecoded.name.length === 255) nameAtLimitSeen += 1;
        if (vector.expectedDecoded.description === null) nullDescriptionSeen += 1;
        else if (vector.expectedDecoded.description.length === 1000) descriptionAtLimitSeen += 1;
        decodedCount += 1;
      }
      expect(decodedCount).toBe(5);
      // The corpus must actually carry each edge, or this test proves nothing.
      expect(hostileSeen).toBeGreaterThan(0);
      expect(nameAtLimitSeen).toBeGreaterThan(0);
      expect(descriptionAtLimitSeen).toBeGreaterThan(0);
      expect(nullDescriptionSeen).toBeGreaterThan(0);
    });

    it('P164 a tampered ownExerciseCipher vector is decrypt_failed', () => {
      let reasonCount = 0;
      for (const vector of corpus.ownExerciseCipher) {
        if (!('expectedReason' in vector)) continue;
        let caught: unknown;
        try {
          decryptOwnExercise(ownExerciseRow(vector.rowId, vector.ciphertextJson), vector.keyB64);
        } catch (err) {
          caught = err;
        }
        expect(caught, vector.name).toBeInstanceOf(RowDecodeError);
        expect((caught as RowDecodeError).reason, vector.name).toBe(vector.expectedReason);
        expect((caught as RowDecodeError).message, vector.name).toMatch(OWN_EXERCISE_ERROR_MESSAGE);
        reasonCount += 1;
      }
      expect(reasonCount).toBe(1);
      expect(corpus.ownExerciseCipher.some((v) => 'expectedReason' in v && v.expectedReason === 'decrypt_failed')).toBe(true);
    });

    it('P164 an empty encryptedPayload is malformed_payload (rule 1, no corpus vector)', () => {
      // The corpus carries no vector for rule 1 (an empty payload has no ciphertext to pin), so
      // this replay checks it directly — the app's decoder checks the same rule in its own test.
      const key = corpus.ownExerciseCipher[0].keyB64;
      const rowId = corpus.ownExerciseCipher[0].rowId;
      for (const decodeEmpty of [
        () => decryptOwnExercise({ id: rowId, encryptedPayload: '' }, key),
        () =>
          decryptOwnExerciseTranslation(
            { id: rowId, exerciseId: rowId, languageCode: 'en', encryptedPayload: '' },
            key,
          ),
      ]) {
        let caught: unknown;
        try {
          decodeEmpty();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(RowDecodeError);
        expect((caught as RowDecodeError).reason).toBe('malformed_payload');
        expect((caught as RowDecodeError).message).toMatch(OWN_EXERCISE_ERROR_MESSAGE);
      }
    });

    it('P164 every ownExerciseTranslationCipher vector decodes to expectedDecoded', () => {
      let decodedCount = 0;
      let hostileSeen = 0;
      let nullDescriptionSeen = 0;
      for (const vector of corpus.ownExerciseTranslationCipher) {
        expect(decrypt(vector.ciphertextJson, vector.keyB64), vector.name).toBe(vector.expectedPlaintextString);
        const row = {
          id: vector.rowId,
          exerciseId: vector.expectedDecoded.exerciseId,
          languageCode: vector.expectedDecoded.languageCode,
          name: '',
          encryptedPayload: vector.ciphertextJson,
        };
        const decoded = decryptOwnExerciseTranslation(row, vector.keyB64);
        expect({ ...decoded }, vector.name).toStrictEqual(vector.expectedDecoded);
        expect(Object.keys(decoded), vector.name).toEqual(Object.keys(vector.expectedDecoded));
        expect(Buffer.from(decoded.name, 'utf8').equals(Buffer.from(vector.expectedDecoded.name, 'utf8'))).toBe(true);
        if (vector.expectedDecoded.name.includes('Ignore')) hostileSeen += 1;
        if (vector.expectedDecoded.description === null) nullDescriptionSeen += 1;
        decodedCount += 1;
      }
      expect(decodedCount).toBe(3);
      expect(hostileSeen).toBeGreaterThan(0);
      expect(nullDescriptionSeen).toBeGreaterThan(0);
    });

    it('P164 every ownExerciseDecode vector yields its decoded form or its reason', () => {
      let readableSeen = 0;
      let unreadableSeen = 0;
      let translationSeen = 0;
      for (const vector of corpus.ownExerciseDecode) {
        const decode = (): unknown =>
          vector.kind === 'exercise'
            ? decodeOwnExercisePlaintext(vector.plaintext, vector.rowId)
            : decodeOwnExerciseTranslationPlaintext(vector.plaintext, {
                id: vector.rowId,
                exerciseId: vector.rowExerciseId as string,
                languageCode: vector.rowLanguageCode as string,
              });
        if (vector.kind === 'translation') translationSeen += 1;
        if (vector.decoded !== undefined) {
          const decoded = decode() as Record<string, unknown>;
          // toStrictEqual: same keys, same values, nothing extra — byte for byte, never trimmed.
          expect({ ...decoded }, vector.name).toStrictEqual(vector.decoded);
          expect(Object.keys(decoded), vector.name).toEqual(Object.keys(vector.decoded));
          readableSeen += 1;
        } else {
          let caught: unknown;
          try {
            decode();
          } catch (err) {
            caught = err;
          }
          expect(caught, vector.name).toBeInstanceOf(RowDecodeError);
          expect((caught as RowDecodeError).reason, vector.name).toBe(vector.reason);
          // The message names the row id and the cause only, never content from the payload.
          expect((caught as RowDecodeError).message, vector.name).toBe(
            `${vector.kind === 'exercise' ? 'exercise' : 'exercise_translation'} row ${vector.rowId} has ` +
              (vector.reason === 'unknown_version' ? 'an unknown schema version' : 'a malformed payload'),
          );
          unreadableSeen += 1;
        }
      }
      expect(readableSeen + unreadableSeen).toBe(36);
      expect(readableSeen).toBe(5);
      expect(translationSeen).toBe(5);
    });

    it('P164 every keyCheck vector equals the HMAC of its key', () => {
      // §1.10 "The key check": HMAC-SHA256 under the raw key over the UTF-8 label, lower-case hex.
      // Computed here directly (no production function needed in the MCP, plan 164-19).
      for (const vector of corpus.keyCheck) {
        const mac = createHmac('sha256', Buffer.from(vector.keyB64, 'base64'))
          .update('calicomp:key-check:v1', 'utf8')
          .digest('hex');
        expect(mac, vector.name).toBe(vector.keyCheck);
      }
      expect(corpus.keyCheck.map((v) => v.keyCheck)).toContain(
        'e34cf841f37e34b33e1d5e2f88088008392e5d04a3970d62cb28cee62ba93a45',
      );
    });
  });

  // -----------------------------------------------------------------------
  // foreignFulfilment section (Phase 155, FA-06, D-13): the day rule of protocol §1.6,
  // replayed through the REAL `assignForeignFulfilment` (LEARNINGS § 9) — the Kotlin twin
  // replays the same vectors, so both languages run one rule. Expected values are derived
  // by hand from §1.6 and never adjusted to the code.
  // -----------------------------------------------------------------------

  describe('foreignFulfilment vectors', () => {
    it('P155 foreignFulfilment section is non-empty', () => {
      expect(corpus.foreignFulfilment.length).toBeGreaterThan(0);
    });

    it('P155 FA-06 assignForeignFulfilment reproduces every foreignFulfilment vector', () => {
      for (const vector of corpus.foreignFulfilment) {
        const actual = assignForeignFulfilment(vector.occurrences, vector.activities, vector.asOfDate);
        const label = `vector "${vector.name}"`;
        expect(
          actual.fulfilled.map((f) => ({ rootId: f.rootId, date: f.date, activityId: f.activityId })),
          label,
        ).toEqual(vector.expected.fulfilled);
        expect(actual.missed.map((m) => ({ rootId: m.rootId, date: m.date })), label).toEqual(vector.expected.missed);
        expect(actual.upcoming.map((u) => ({ rootId: u.rootId, date: u.date })), label).toEqual(
          vector.expected.upcoming,
        );
        expect(actual.unplannedActivityIds, label).toEqual(vector.expected.unplannedActivityIds);
        // A cancelled date never produces an occurrence (§1.6 "Cancelled dates").
        for (const removed of vector.removedDates) {
          expect(
            vector.occurrences.some((o) => o.rootId === removed.rootId && o.date === removed.date),
            label,
          ).toBe(false);
        }
        expect(
          {
            planned: actual.fulfilled.length + actual.missed.length + actual.upcoming.length,
            fulfilled: actual.fulfilled.length,
            missed: actual.missed.length,
            upcoming: actual.upcoming.length,
            removed: vector.removedDates.length,
          },
          label,
        ).toEqual(vector.expected.counts);
        expect(foreignFulfilmentRatio(actual.fulfilled.length, actual.missed.length), label).toBe(
          vector.expected.fulfilmentRatio,
        );
      }
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
  // newPlan (Phase 150-08, COACH-05, D-22/D-24): replays every corpus vector through
  // the real ProposeNewPlanSchema and buildNewPlanPayload — the same two functions the
  // registered propose_new_plan tool calls — proving the schema/payload-shape contract
  // docs/COACH-PLANNING-PROTOCOL.md §2.6 describes actually holds for each vector.
  // -----------------------------------------------------------------------

  it('P150 D-24 the newPlan section is present and has rejection vectors', () => {
    expect(corpus.newPlan.length).toBeGreaterThan(0);
    const hasRejection = corpus.newPlan.some((vector) => vector.expectRejection === true);
    expect(hasRejection).toBe(true);
  });

  it.each(corpus.newPlan)(
    'P150 D-24 newPlan vectors replay through ProposeNewPlanSchema and buildNewPlanPayload: $name',
    (vector) => {
      const zodResult = ProposeNewPlanSchema.safeParse(vector.input);

      if (vector.expectRejection) {
        expect(zodResult.success, `vector "${vector.name}" expected to be rejected`).toBe(false);
        if (!zodResult.success) {
          const messages = zodResult.error.issues.map((issue) => issue.message);
          expect(
            messages.some((m) => m.includes(vector.expectedIssue ?? '')),
            `vector "${vector.name}" expected an issue containing "${vector.expectedIssue}", got ${JSON.stringify(messages)}`,
          ).toBe(true);
        }
        return;
      }

      expect(zodResult.success, `vector "${vector.name}" expected to parse`).toBe(true);
      if (!zodResult.success) return;

      const payload = buildNewPlanPayload(zodResult.data as ProposeNewPlanArgs, []);
      expect(payload).toStrictEqual(vector.expectedPayload);
      expect('standalone' in payload).toBe('standalone' in (vector.expectedPayload ?? {}));
    },
  );

  // -----------------------------------------------------------------------
  // Phase 166 (plan 166-04, STAT-01, D-01): Rule S of protocol §1.11 over the population of
  // Rule P, replayed against the function behind get_training_state.muscleBalance.
  // -----------------------------------------------------------------------

  const byLevelRow = (a: { muscleGroupKey: string; involvementLevel: string | null }, b: { muscleGroupKey: string; involvementLevel: string | null }): number =>
    a.muscleGroupKey.localeCompare(b.muscleGroupKey) || String(a.involvementLevel).localeCompare(String(b.involvementLevel));

  it('P166 every strengthHeatmapSelection vector yields its expected level counts', () => {
    expect(corpus.strengthHeatmapSelection.length).toBeGreaterThanOrEqual(10);
    for (const vector of corpus.strengthHeatmapSelection) {
      const actual = strengthLevelSetCounts(corpusSnapshot(vector), corpusCatalog(vector), vector.sinceMs);
      expect([...actual].sort(byLevelRow), vector.name).toEqual([...vector.expectedLevelCounts].sort(byLevelRow));
    }
  });

  it('P166 the per-session strengthHeatmapSelection variant yields its expected session level counts', () => {
    const perSession = corpus.strengthHeatmapSelection.filter((v) => v.sessionId !== undefined);
    expect(perSession.length).toBeGreaterThanOrEqual(2);
    expect(perSession.some((v) => (v.expectedSessionLevelCounts ?? []).length === 0)).toBe(true);
    for (const vector of perSession) {
      expect(vector.expectedSessionLevelCounts, vector.name).toBeDefined();
      const actual = strengthLevelSetCountsForSession(corpusSnapshot(vector), corpusCatalog(vector), vector.sessionId as string);
      expect([...actual].sort(byLevelRow), vector.name).toEqual([...(vector.expectedSessionLevelCounts ?? [])].sort(byLevelRow));
    }
  });

  // -----------------------------------------------------------------------
  // Phase 166 (plan 166-04, STAT-02, D-02): Rule M of protocol §1.11, replayed against the
  // function behind get_training_state.personalRecords.
  // -----------------------------------------------------------------------

  it('P166 every personalRecordsByTrainingMode vector yields its expected records', () => {
    expect(corpus.personalRecordsByTrainingMode.length).toBeGreaterThanOrEqual(5);
    const byExercise = (a: { exerciseId: string }, b: { exerciseId: string }): number => a.exerciseId.localeCompare(b.exerciseId);
    for (const vector of corpus.personalRecordsByTrainingMode) {
      const records = computePersonalRecords(corpusSnapshot(vector), corpusCatalog(vector), 'Europe/Berlin');
      const pick = (list: { exerciseId: string; value: number }[]) =>
        list.map((r) => ({ exerciseId: r.exerciseId, value: r.value })).sort(byExercise);
      expect(pick(records.maxReps), `${vector.name} maxReps`).toEqual([...vector.expectedMaxReps].sort(byExercise));
      expect(pick(records.maxHoldSeconds), `${vector.name} maxHoldSeconds`).toEqual([...vector.expectedMaxTime].sort(byExercise));
    }
  });

  // Phase 166, gap plan 166-22 (STAT-02, E-17, protocol 1.52 §1.11 Rule M steps 3 to 5): the third record kind.
  // The corpus lists the entries in the order of protocol 1.52 (exerciseId, durationSeconds, weightKg with null
  // first); the MCP must return exactly that order. The date is not pinned (the app takes the row of SQLite's MAX).
  it('P166 E-17 every personalRecordsByTrainingMode vector yields its expected repetitions in time', () => {
    const vectors = corpus.personalRecordsByTrainingMode;
    expect(vectors.length).toBeGreaterThanOrEqual(17);
    expect(vectors.some((v) => v.expectedRepsInTime.length > 0)).toBe(true);
    for (const vector of vectors) {
      const records = computePersonalRecords(corpusSnapshot(vector), corpusCatalog(vector), 'Europe/Berlin');
      const actual = records.repsInTime.map((r) => ({
        exerciseId: r.exerciseId,
        durationSeconds: r.durationSeconds,
        weightKg: r.weightKg,
        value: r.value,
      }));
      expect(actual, `${vector.name} repsInTime`).toEqual(vector.expectedRepsInTime);
    }
  });

  // -----------------------------------------------------------------------
  // Phase 166 (plan 166-08, MCP-05, D-12): protocol §2.6 block ops on the MCP side. Every
  // planUpdateOps payload goes through the real ProposePlanUpdateSchema (the tool's input
  // schema, with a rationale added because the payload carries none) and must be accepted or
  // rejected exactly as acceptedBy.mcp says; an accepted payload must come out of
  // buildPlanUpdatePayload unchanged (no catalog, so no dedupe rewrite).
  // -----------------------------------------------------------------------

  it('P166 every planUpdateOps vector is accepted or rejected by the schema as the corpus says', () => {
    expect(corpus.planUpdateOps.length).toBeGreaterThanOrEqual(8);
    expect(corpus.planUpdateOps.some((v) => v.acceptedBy.mcp === false)).toBe(true);
    expect(corpus.planUpdateOps.some((v) => v.acceptedBy.mcp === true)).toBe(true);
    const opKinds = new Set<string>();
    for (const vector of corpus.planUpdateOps) {
      const result = ProposePlanUpdateSchema.safeParse({ ...vector.payload, rationale: 'corpus replay' });
      expect(result.success, `${vector.name}: acceptedBy.mcp is ${vector.acceptedBy.mcp}`).toBe(vector.acceptedBy.mcp);
      if (!result.success) continue;
      for (const op of result.data.ops ?? []) opKinds.add(op.op);
      const built = buildPlanUpdatePayload(result.data as ProposePlanUpdateArgs, []);
      expect(built, vector.name).toStrictEqual(vector.payload);
    }
    // NICHT GEMESSEN guard: the replay must have reached both new ops through the schema.
    expect(opKinds.has('updateBlock')).toBe(true);
    expect(opKinds.has('addBlock')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Phase 166 (plan 166-08, MCP-06, D-11): protocol §2.7 new_exercise links on the MCP side.
  // The MCP accepts a vector when BOTH of its enforcement points accept it: the input schema
  // (ProposeNewExerciseSchema for new_exercise, NewExerciseDefSchema for newExercises[], both
  // must agree) and the key check against the catalog the MCP loaded (vector.catalog). An
  // accepted payload comes out of buildNewExercisePayload unchanged; the byte-identity vector
  // also pins the payload string and its changeHash.
  // -----------------------------------------------------------------------

  it('P166 every newExerciseLinks vector is accepted or rejected by the MCP as the corpus says', () => {
    expect(corpus.newExerciseLinks.length).toBeGreaterThanOrEqual(9);
    expect(corpus.newExerciseLinks.some((v) => v.acceptedBy.mcp === false)).toBe(true);
    const pinned = corpus.newExerciseLinks.filter((v) => v.expectedChangeHash !== undefined);
    expect(pinned.length).toBeGreaterThanOrEqual(1);
    let keyRefusals = 0;
    let fieldsSeen = 0;
    let normalisedSeen = 0;
    for (const vector of corpus.newExerciseLinks) {
      // The corpus muscle vocabulary is exactly MUSCLE_KEY: the schema is the MCP's muscle check.
      expect([...vector.catalog.muscleGroupKeys].sort(), vector.name).toEqual([...MUSCLE_KEY.options].sort());
      const vocabulary = {
        capabilityKeys: new Set(vector.catalog.capabilityAxisKeys),
        equipmentKeys: new Set(vector.catalog.equipmentKeys),
      };
      const asTool = ProposeNewExerciseSchema.safeParse({ ...vector.payload, rationale: 'corpus replay' });
      const asEntry = NewExerciseDefSchema.safeParse({ ...vector.payload, tempId: 't-corpus' });
      expect(asEntry.success, `${vector.name}: both schemas agree`).toBe(asTool.success);
      const unknownKey = asTool.success ? findUnknownLinkKey(asTool.data, vocabulary) : undefined;
      if (unknownKey !== undefined) keyRefusals += 1;
      const accepted = asTool.success && unknownKey === undefined;
      expect(accepted, `${vector.name}: acceptedBy.mcp is ${vector.acceptedBy.mcp}`).toBe(vector.acceptedBy.mcp);
      if (!accepted || !asTool.success) continue;
      const built = buildNewExercisePayload(asTool.data);
      // Protocol 1.54 (166-REVIEW WR-03): a vector with expectedPayload is sent normalised.
      expect(built, vector.name).toStrictEqual(vector.expectedPayload ?? vector.payload);
      if (vector.expectedPayload !== undefined) normalisedSeen += 1;
      for (const field of ['translations', 'muscleGroups', 'capabilities', 'equipment']) {
        if (field in built) fieldsSeen += 1;
      }
      if (vector.expectedPayloadString !== undefined) {
        expect(JSON.stringify(built), vector.name).toBe(vector.expectedPayloadString);
        expect(computeChangeHash('new_exercise', built), vector.name).toBe(vector.expectedChangeHash);
      }
    }
    // NICHT GEMESSEN guards: the key check refused at least one vector, and accepted payloads
    // carried new fields through the builder.
    expect(keyRefusals).toBeGreaterThanOrEqual(1);
    expect(fieldsSeen).toBeGreaterThanOrEqual(4);
    // NICHT GEMESSEN guard (protocol 1.54): at least one accepted vector is sent normalised.
    expect(normalisedSeen).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Phase 166 (plan 166-08, MCP-06, D-15): protocol §2.7 exercise_update on the MCP side. The
  // MCP accepts a vector when the input schema accepts it AND validateExerciseUpdate (the check
  // the tool runs against the exercises it read) finds nothing to refuse: the exercise must be
  // known (vector.catalog.exerciseIds), a catalog exercise takes translations only, and every
  // capability key must be in the loaded vocabulary. An accepted payload is sent unchanged.
  // -----------------------------------------------------------------------

  it('P166 every exerciseUpdate vector is accepted or rejected by the MCP as the corpus says', () => {
    expect(corpus.exerciseUpdate.length).toBeGreaterThanOrEqual(8);
    expect(corpus.exerciseUpdate.some((v) => v.acceptedBy.mcp === false)).toBe(true);
    expect(corpus.exerciseUpdate.some((v) => v.target === 'catalog' && v.acceptedBy.mcp === true)).toBe(true);
    let checkRefusals = 0;
    for (const vector of corpus.exerciseUpdate) {
      expect([...vector.catalog.muscleGroupKeys].sort(), vector.name).toEqual([...MUSCLE_KEY.options].sort());
      const vocabulary = { capabilityKeys: new Set(vector.catalog.capabilityAxisKeys), equipmentKeys: new Set<string>() };
      const parsed = ProposeExerciseUpdateSchema.safeParse({ ...vector.payload, rationale: 'corpus replay' });
      let accepted = parsed.success;
      if (parsed.success) {
        const known = vector.catalog.exerciseIds.includes(parsed.data.exerciseId);
        const target = known ? { origin: vector.target === 'own' ? ('CUSTOM' as const) : ('CATALOG' as const) } : undefined;
        const refusal = validateExerciseUpdate(parsed.data, target, vocabulary);
        if (refusal !== undefined) checkRefusals += 1;
        accepted = refusal === undefined;
        if (accepted) {
          expect(buildExerciseUpdatePayload(parsed.data), vector.name).toStrictEqual(vector.payload);
        }
      }
      expect(accepted, `${vector.name}: acceptedBy.mcp is ${vector.acceptedBy.mcp}`).toBe(vector.acceptedBy.mcp);
    }
    // NICHT GEMESSEN guard: the tool-side check refused at least one vector (the catalog muscles).
    expect(checkRefusals).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Phase 166, gap plan 166-20 (E-16, protocol 1.50 §1.7): the app language over both setting rows and the
  // name of a catalog exercise in the effective language.
  // -----------------------------------------------------------------------

  /** The `mcp` side of an appLanguageSync vector as a snapshot plus the decode report of the same read. */
  function appLanguageInputs(settings: (typeof corpus.appLanguageSync)[number]['mcp']['settings']): {
    snapshot: DecryptedSnapshot;
    report: { unreadable: UnreadableRow[] };
  } {
    const readable = settings.flatMap((row) => ('value' in row ? [{ key: row.key, type: 's', value: row.value }] : []));
    const unreadable = settings.flatMap((row): UnreadableRow[] =>
      'unreadable' in row ? [{ entity: 'setting', id: `p166-${row.key}`, reason: 'decrypt_failed', key: row.key }] : [],
    );
    return { snapshot: { ...emptyLanguageSnapshot(), settings: readable }, report: { unreadable } };
  }

  function emptyLanguageSnapshot(): DecryptedSnapshot {
    return {
      syncedAt: 1_700_000_000_000,
      exercises: [],
      exerciseTranslations: [],
      templates: [],
      blocks: [],
      templateExercises: [],
      sessions: [],
      setLogs: [],
      hrSamples: [],
      plannedWorkouts: [],
      settings: [],
    };
  }

  it('P166 E-16 every appLanguageSync vector yields its app language or reason', () => {
    expect(corpus.appLanguageSync.length).toBeGreaterThanOrEqual(9);
    for (const v of corpus.appLanguageSync) {
      const { snapshot, report } = appLanguageInputs(v.mcp.settings);
      const resolved = resolveAppLanguage(snapshot, report);
      expect(resolved.languageCode, `${v.name} languageCode`).toBe(v.mcp.expectedAppLanguage);
      if (v.mcp.expectedAppLanguage === null) {
        expect(resolved, `${v.name} reason`).toEqual({ languageCode: null, reason: v.mcp.expectedReason });
      } else {
        expect(v.mcp.expectedReason, `${v.name} carries no reason beside a language`).toBeUndefined();
        expect(resolved, v.name).toEqual({ languageCode: v.mcp.expectedAppLanguage });
      }
    }
  });

  it('P166 E-16 every appLanguageSync vector with an app side reads exactly the rows the app mirrors', () => {
    const withApp = corpus.appLanguageSync.filter((v) => v.app !== null);
    // NICHT GEMESSEN guard: the corpus names four vectors with an app side.
    expect(withApp.length).toBeGreaterThanOrEqual(4);
    for (const v of withApp) {
      const app = v.app!;
      const expectedRows = [
        ...(app.chosen === null ? [] : [{ key: 'default_language', value: app.chosen }]),
        { key: 'effective_language', value: app.expectedMirror },
      ];
      const byKey = (a: { key: string }, b: { key: string }): number => a.key.localeCompare(b.key);
      expect([...v.mcp.settings].sort(byKey), `${v.name} binding`).toEqual(expectedRows.sort(byKey));
      // The app's rule: the explicit choice, otherwise the device language, a code of its list, otherwise en.
      const resolved = resolveAppLanguage(appLanguageInputs(v.mcp.settings).snapshot);
      expect(resolved.languageCode, `${v.name} the coach reads what the app shows`).toBe(app.chosen ?? app.expectedMirror);
    }
  });

  it('P166 E-16 every exerciseNameLanguage vector names the exercise like the corpus says', () => {
    expect(corpus.exerciseNameLanguage.length).toBeGreaterThanOrEqual(3);
    const exerciseId = '16620000-0000-4000-8000-000000000001';
    for (const v of corpus.exerciseNameLanguage) {
      const catalog: CatalogExercise[] = [
        {
          id: exerciseId,
          key: 'p166_wall_hold',
          nameEn: v.translations.en,
          mode: 'TIME',
          usesWeight: false,
          lastModifiedAt: 1_700_000_000_000,
          translations: Object.entries(v.translations)
            .filter(([code]) => code !== 'en')
            .map(([languageCode, name]) => ({ languageCode, name })),
          muscleGroups: [],
          equipment: [],
          capabilities: [],
          origin: 'CATALOG',
        },
      ];
      const withLang = createExerciseNameResolver({ catalog, snapshot: emptyLanguageSnapshot(), lang: v.language });
      const withAppLanguage = createExerciseNameResolver({
        catalog,
        snapshot: { ...emptyLanguageSnapshot(), settings: [{ key: 'effective_language', type: 's', value: v.language }] },
      });
      expect(withLang.forExerciseId(exerciseId).exerciseName, `${v.name} with lang`).toBe(v.expectedName);
      expect(withAppLanguage.forExerciseId(exerciseId).exerciseName, `${v.name} without lang`).toBe(v.expectedName);
    }
  });

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
