/**
 * format-progress.ts unit tests (Phase 137-09, STATE-02, D-20).
 *
 * Port block mirrors FormatSummaryTest.kt case for case — these are also the literal
 * source for the shared `formatProgress` corpus vectors (docs/coach-planning-vectors.json),
 * proven cross-language by tests/shared-vectors.test.ts and CoachPlanningVectorsTest.kt.
 *
 * The longitudinal-series block below (computeFormatProgress) covers logic with no Kotlin
 * analogue — it is NOT corpus-gated (see the module doc-header's parity boundary: only the
 * per-session value is parity-bound, the series itself is new).
 */

import { describe, it, expect } from 'vitest';
import {
  amrapSummary,
  deathBySummary,
  emomIntervals,
  FORMAT_SUMMARY_TYPES,
  computeFormatProgress,
} from '../../src/training-state/format-progress.js';
import type { DecryptedSetLog, DecryptedSession, DecryptedSnapshot, SyncTemplateDto } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Minimal fixture builders (local to this file, same style as muscle-balance.test.ts —
// the fine-grained control this suite needs does not fit tests/fixture.ts's shared
// narrative fixture).
// ---------------------------------------------------------------------------

function row(overrides: Partial<DecryptedSetLog> & { id: string; sessionId: string }): DecryptedSetLog {
  return {
    completedReps: null,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let rowCounter = 0;
function repRow(reps: number | null): DecryptedSetLog {
  rowCounter += 1;
  return row({ id: `row-${rowCounter}`, sessionId: 'session', completedReps: reps });
}
function timeRow(seconds: number): DecryptedSetLog {
  rowCounter += 1;
  return row({ id: `row-${rowCounter}`, sessionId: 'session', completedTimeSeconds: seconds });
}

function buildTemplate(overrides: Partial<SyncTemplateDto> & { id: string }): SyncTemplateDto {
  return {
    name: overrides.id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isFavoriteForWatch: false,
    ...overrides,
  };
}

function buildSession(overrides: Partial<DecryptedSession> & { id: string; startTime: number }): DecryptedSession {
  return {
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: overrides.startTime,
    updatedAt: overrides.startTime,
    endTime: overrides.startTime + 3_600_000,
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<DecryptedSnapshot>): DecryptedSnapshot {
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
    ...overrides,
  };
}

const TZ = 'Europe/Berlin';

// ---------------------------------------------------------------------------
// Port block — mirrors FormatSummaryTest.kt case for case
// ---------------------------------------------------------------------------

describe('amrapSummary', () => {
  it('8 rows at 3 exercises per round yields 2 full rounds plus trailing partial reps', () => {
    const rows = [repRow(5), repRow(5), repRow(5), repRow(5), repRow(5), repRow(5), repRow(3), repRow(4)];
    expect(amrapSummary(rows, 3)).toEqual({ rounds: 2, reps: 7 });
  });

  it('6 rows at 3 exercises per round is a clean round boundary with zero trailing reps', () => {
    const rows = Array.from({ length: 6 }, () => repRow(5));
    expect(amrapSummary(rows, 3)).toEqual({ rounds: 2, reps: 0 });
  });

  it('exercisesPerRound of zero guards against divide-by-zero and yields zero rounds', () => {
    const rows = [repRow(5), repRow(3)];
    const score = amrapSummary(rows, 0);
    expect(score.rounds).toBe(0);
    expect(score.reps).toBe(8);
  });

  it('trailing partial round sums REPS rows and TIME rows contribute zero', () => {
    const rows = [repRow(5), repRow(5), repRow(5), repRow(3), timeRow(30)];
    expect(amrapSummary(rows, 3)).toEqual({ rounds: 1, reps: 3 });
  });

  it('an empty row list yields zero rounds and zero reps without error', () => {
    expect(amrapSummary([], 3)).toEqual({ rounds: 0, reps: 0 });
  });
});

describe('deathBySummary', () => {
  it('12 rows under roundCap 30 yields highest full round 12 and not complete', () => {
    const rows = Array.from({ length: 12 }, (_, i) => repRow(i + 1));
    expect(deathBySummary(rows, 30)).toEqual({ highestFullRound: 12, complete: false });
  });

  it('30 rows at roundCap 30 is complete', () => {
    const rows = Array.from({ length: 30 }, (_, i) => repRow(i + 1));
    expect(deathBySummary(rows, 30)).toEqual({ highestFullRound: 30, complete: true });
  });

  it('31 rows at roundCap 30 is also complete', () => {
    const rows = Array.from({ length: 31 }, (_, i) => repRow(i + 1));
    expect(deathBySummary(rows, 30)).toEqual({ highestFullRound: 31, complete: true });
  });

  it('an empty row list yields highestFullRound 0 and not complete', () => {
    expect(deathBySummary([], 30)).toEqual({ highestFullRound: 0, complete: false });
  });
});

describe('emomIntervals', () => {
  it('counts one row per completed minute window', () => {
    const rows = Array.from({ length: 9 }, () => repRow(10));
    expect(emomIntervals(rows)).toBe(9);
  });

  it('an empty row list yields zero intervals', () => {
    expect(emomIntervals([])).toBe(0);
  });
});

describe('FORMAT_SUMMARY_TYPES', () => {
  it('contains exactly AMRAP, DEATH_BY and EMOM', () => {
    expect([...FORMAT_SUMMARY_TYPES].sort()).toEqual(['AMRAP', 'DEATH_BY', 'EMOM']);
  });
});

// ---------------------------------------------------------------------------
// Longitudinal series block — computeFormatProgress (new, parity-free)
// ---------------------------------------------------------------------------

describe('computeFormatProgress', () => {
  it('builds one series per format template, chronologically ascending, with the correct score per session', () => {
    const template = buildTemplate({
      id: 'tpl-amrap',
      workoutType: 'AMRAP',
      formatParams: JSON.stringify({ workoutType: 'AMRAP', timeCapMinutes: 10, exercises: [{}, {}, {}] }),
    });
    const session1 = buildSession({ id: 'session-1', templateId: 'tpl-amrap', startTime: 1_000 });
    const session2 = buildSession({ id: 'session-2', templateId: 'tpl-amrap', startTime: 2_000 });

    const rowsSession1 = [5, 5, 5, 5, 5, 5].map((reps, i) =>
      row({ id: `s1-row-${i}`, sessionId: 'session-1', completedReps: reps, createdAt: i }),
    );
    const rowsSession2 = [5, 5, 5, 3].map((reps, i) =>
      row({ id: `s2-row-${i}`, sessionId: 'session-2', completedReps: reps, createdAt: i }),
    );

    const snapshot = buildSnapshot({
      templates: [template],
      sessions: [session2, session1], // deliberately out of order
      setLogs: [...rowsSession1, ...rowsSession2],
    });

    const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });

    expect(result).toHaveLength(1);
    expect(result[0].templateId).toBe('tpl-amrap');
    expect(result[0].workoutType).toBe('AMRAP');
    expect(result[0].points.map((p) => p.sessionId)).toEqual(['session-1', 'session-2']); // ascending by startTime
    expect(result[0].points[0]).toMatchObject({ rounds: 2, reps: 0 });
    expect(result[0].points[1]).toMatchObject({ rounds: 1, reps: 3 });
  });

  it('caps a series to maxPoints, keeping the most recent points', () => {
    const template = buildTemplate({ id: 'tpl-emom', workoutType: 'EMOM' });
    const sessions = Array.from({ length: 5 }, (_, i) =>
      buildSession({ id: `session-${i}`, templateId: 'tpl-emom', startTime: i * 1_000 }),
    );
    const setLogs = sessions.map((s, i) =>
      row({ id: `row-${i}`, sessionId: s.id, completedReps: 10, createdAt: 0 }),
    );

    const snapshot = buildSnapshot({ templates: [template], sessions, setLogs });
    const result = computeFormatProgress({ maxPoints: 2 }, { snapshot, timeZoneId: TZ });

    expect(result[0].points).toHaveLength(2);
    expect(result[0].points.map((p) => p.sessionId)).toEqual(['session-3', 'session-4']);
  });

  describe('sort contract: startedAt takes precedence, createdAt is the fallback', () => {
    it('sorts by startedAt ascending regardless of array/createdAt order', () => {
      const template = buildTemplate({
        id: 'tpl-amrap',
        workoutType: 'AMRAP',
        formatParams: JSON.stringify({ exercises: [{}, {}, {}] }),
      });
      const session = buildSession({ id: 'session-1', templateId: 'tpl-amrap', startTime: 1_000 });

      // Correct order by startedAt: 5,5,5 (round 1), then 3,4 trailing -> rounds=1 reps=7.
      // createdAt is deliberately the exact REVERSE of startedAt, so a bug that sorted by
      // createdAt (or trusted array order) instead would compute a different score.
      const a1 = row({ id: 'a1', sessionId: 'session-1', completedReps: 5, startedAt: 1, createdAt: 50 });
      const a2 = row({ id: 'a2', sessionId: 'session-1', completedReps: 5, startedAt: 2, createdAt: 40 });
      const a3 = row({ id: 'a3', sessionId: 'session-1', completedReps: 5, startedAt: 3, createdAt: 30 });
      const a4 = row({ id: 'a4', sessionId: 'session-1', completedReps: 3, startedAt: 4, createdAt: 20 });
      const a5 = row({ id: 'a5', sessionId: 'session-1', completedReps: 4, startedAt: 5, createdAt: 10 });

      const snapshot = buildSnapshot({
        templates: [template],
        sessions: [session],
        setLogs: [a5, a3, a1, a4, a2], // scrambled insertion order
      });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].points[0]).toMatchObject({ rounds: 1, reps: 7 });
    });

    it('falls back to createdAt ascending when startedAt is null on every row', () => {
      const template = buildTemplate({
        id: 'tpl-amrap',
        workoutType: 'AMRAP',
        formatParams: JSON.stringify({ exercises: [{}, {}, {}] }),
      });
      const session = buildSession({ id: 'session-2', templateId: 'tpl-amrap', startTime: 2_000 });

      const b1 = row({ id: 'b1', sessionId: 'session-2', completedReps: 5, startedAt: null, createdAt: 1 });
      const b2 = row({ id: 'b2', sessionId: 'session-2', completedReps: 5, startedAt: null, createdAt: 2 });
      const b3 = row({ id: 'b3', sessionId: 'session-2', completedReps: 5, startedAt: null, createdAt: 3 });
      const b4 = row({ id: 'b4', sessionId: 'session-2', completedReps: 3, startedAt: null, createdAt: 4 });
      const b5 = row({ id: 'b5', sessionId: 'session-2', completedReps: 4, startedAt: null, createdAt: 5 });

      const snapshot = buildSnapshot({
        templates: [template],
        sessions: [session],
        setLogs: [b4, b1, b5, b2, b3], // scrambled insertion order
      });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].points[0]).toMatchObject({ rounds: 1, reps: 7 });
    });
  });

  describe('Pitfall 5 — sessions with no recognized format are silently excluded, never an error', () => {
    it('workoutType null is excluded and increments skippedSessionCount', () => {
      const knownTemplate = buildTemplate({ id: 'tpl-known', workoutType: 'EMOM' });
      const nullTemplate = buildTemplate({ id: 'tpl-null', workoutType: null });
      const knownSession = buildSession({ id: 'session-known', templateId: 'tpl-known', startTime: 1_000 });
      const nullSession = buildSession({ id: 'session-null', templateId: 'tpl-null', startTime: 2_000 });

      const snapshot = buildSnapshot({
        templates: [knownTemplate, nullTemplate],
        sessions: [knownSession, nullSession],
        setLogs: [row({ id: 'r1', sessionId: 'session-known', completedReps: 1 })],
      });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result).toHaveLength(1);
      expect(result.flatMap((s) => s.points.map((p) => p.sessionId))).not.toContain('session-null');
      expect(result[0].skippedSessionCount).toBe(1);
    });

    it('workoutType undefined (absent key) is excluded and increments skippedSessionCount', () => {
      const knownTemplate = buildTemplate({ id: 'tpl-known', workoutType: 'EMOM' });
      const undefinedTemplate = buildTemplate({ id: 'tpl-undefined' }); // no workoutType key at all
      const knownSession = buildSession({ id: 'session-known', templateId: 'tpl-known', startTime: 1_000 });
      const undefinedSession = buildSession({
        id: 'session-undefined',
        templateId: 'tpl-undefined',
        startTime: 2_000,
      });

      const snapshot = buildSnapshot({
        templates: [knownTemplate, undefinedTemplate],
        sessions: [knownSession, undefinedSession],
        setLogs: [row({ id: 'r1', sessionId: 'session-known', completedReps: 1 })],
      });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].skippedSessionCount).toBe(1);
    });

    it('workoutType CLASSIC is excluded and increments skippedSessionCount', () => {
      const knownTemplate = buildTemplate({ id: 'tpl-known', workoutType: 'EMOM' });
      const classicTemplate = buildTemplate({ id: 'tpl-classic', workoutType: 'CLASSIC' });
      const knownSession = buildSession({ id: 'session-known', templateId: 'tpl-known', startTime: 1_000 });
      const classicSession = buildSession({ id: 'session-classic', templateId: 'tpl-classic', startTime: 2_000 });

      const snapshot = buildSnapshot({
        templates: [knownTemplate, classicTemplate],
        sessions: [knownSession, classicSession],
        setLogs: [row({ id: 'r1', sessionId: 'session-known', completedReps: 1 })],
      });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].skippedSessionCount).toBe(1);
    });

    it('a session whose template is entirely absent from the snapshot is excluded and increments skippedSessionCount', () => {
      const knownTemplate = buildTemplate({ id: 'tpl-known', workoutType: 'EMOM' });
      const knownSession = buildSession({ id: 'session-known', templateId: 'tpl-known', startTime: 1_000 });
      const orphanSession = buildSession({ id: 'session-orphan', templateId: 'tpl-gone', startTime: 2_000 });

      const snapshot = buildSnapshot({
        templates: [knownTemplate], // 'tpl-gone' deliberately absent
        sessions: [knownSession, orphanSession],
        setLogs: [row({ id: 'r1', sessionId: 'session-known', completedReps: 1 })],
      });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].skippedSessionCount).toBe(1);
    });
  });

  describe('formatParams defaults match the app UI', () => {
    it('unparsable formatParams falls back to exercisesPerRound=0 for AMRAP', () => {
      const template = buildTemplate({ id: 'tpl-amrap', workoutType: 'AMRAP', formatParams: 'not json' });
      const session = buildSession({ id: 'session-1', templateId: 'tpl-amrap', startTime: 1_000 });
      const rows = [
        row({ id: 'r1', sessionId: 'session-1', completedReps: 5 }),
        row({ id: 'r2', sessionId: 'session-1', completedReps: 3 }),
      ];
      const snapshot = buildSnapshot({ templates: [template], sessions: [session], setLogs: rows });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].points[0]).toMatchObject({ rounds: 0, reps: 8 });
    });

    it('missing formatParams falls back to roundCap=30 for Death-By', () => {
      const template = buildTemplate({ id: 'tpl-deathby', workoutType: 'DEATH_BY' });
      const session = buildSession({ id: 'session-1', templateId: 'tpl-deathby', startTime: 1_000 });
      const rows = Array.from({ length: 30 }, (_, i) =>
        row({ id: `r${i}`, sessionId: 'session-1', completedReps: i + 1 }),
      );
      const snapshot = buildSnapshot({ templates: [template], sessions: [session], setLogs: rows });

      const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
      expect(result[0].points[0]).toMatchObject({ rounds: 30, complete: true });
    });
  });

  it('a session with deletedAt set produces no point', () => {
    const template = buildTemplate({ id: 'tpl-emom', workoutType: 'EMOM' });
    const session = buildSession({ id: 'session-1', templateId: 'tpl-emom', startTime: 1_000, deletedAt: 1_500 });
    const snapshot = buildSnapshot({ templates: [template], sessions: [session], setLogs: [] });

    const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
    expect(result).toHaveLength(0);
  });

  it('a session without endTime (ongoing) produces no point', () => {
    const template = buildTemplate({ id: 'tpl-emom', workoutType: 'EMOM' });
    const session = buildSession({ id: 'session-1', templateId: 'tpl-emom', startTime: 1_000, endTime: undefined });
    const snapshot = buildSnapshot({ templates: [template], sessions: [session], setLogs: [] });

    const result = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
    expect(result).toHaveLength(0);
  });

  it('filters to exactly the requested template when templateId is set; returns all series when omitted', () => {
    const templateA = buildTemplate({ id: 'tpl-a', workoutType: 'EMOM' });
    const templateB = buildTemplate({
      id: 'tpl-b',
      workoutType: 'AMRAP',
      formatParams: JSON.stringify({ exercises: [{}] }),
    });
    const sessionA = buildSession({ id: 'session-a', templateId: 'tpl-a', startTime: 1_000 });
    const sessionB = buildSession({ id: 'session-b', templateId: 'tpl-b', startTime: 2_000 });
    const snapshot = buildSnapshot({
      templates: [templateA, templateB],
      sessions: [sessionA, sessionB],
      setLogs: [
        row({ id: 'r1', sessionId: 'session-a', completedReps: 1 }),
        row({ id: 'r2', sessionId: 'session-b', completedReps: 1 }),
      ],
    });

    const filtered = computeFormatProgress({ templateId: 'tpl-a', maxPoints: 10 }, { snapshot, timeZoneId: TZ });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].templateId).toBe('tpl-a');

    const unfiltered = computeFormatProgress({ maxPoints: 10 }, { snapshot, timeZoneId: TZ });
    expect(unfiltered).toHaveLength(2);
  });
});
