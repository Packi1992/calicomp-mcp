/**
 * Tests for src/training-state/adherence.ts (Phase 137, STATE-03).
 *
 * Coverage:
 *   Block 1 (Task 1, no similarity): full-denominator counting, tolerance-window
 *     matching (symmetric), one-session-per-occurrence / one-occurrence-per-session
 *     greedy exclusivity, deterministic tie-breaking, removedOccurrenceCount scoping,
 *     adherenceRatio null-on-empty, the explanation text, time-zone-correct session
 *     day mapping, deletedAt/no-endTime exclusion.
 *   Block 2 (Task 2, similarity axis): templateId-less sessions matched via muscle
 *     similarity, uncertain tier counted separately, below-threshold sessions
 *     unmatched, magnitude sensitivity, Pitfall 2 (exact templateId match is never
 *     re-scored via similarity), axis ordering (exact wins over similarity), and the
 *     two "empty vector, no error" edge cases.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeAdherence,
  ADHERENCE_EXPLANATION,
  REMOVED_WITH_COMPLETED_SESSION_EXPLANATION,
} from '../../src/training-state/adherence.js';
import { getPlannedWorkouts } from '../../src/tools/get_planned_workouts.js';
import { protocolExplanation } from '../protocol-text.js';
import * as similarityModule from '../../src/training-state/muscle-similarity.js';
import {
  mockSnapshot,
  mockCatalog,
  TEMPLATE_ID_PUSH,
  CATALOG_EXERCISE_ID_PUSHUP,
  CATALOG_EXERCISE_ID_PULLUP,
  CATALOG_EXERCISE_ID_SQUAT,
} from '../fixture.js';
import type {
  DecryptedSnapshot,
  DecryptedPlannedWorkout,
  DecryptedSession,
  DecryptedSetLog,
} from '../../src/types.js';

const TZ = 'Europe/Berlin';
const TEMPLATE_ID_LEGS_EMPTY = 'cccccccc-0003-4000-c000-000000000099';

function epochMs(y: number, m: number, d: number, h = 12, mi = 0): number {
  return Date.UTC(y, m - 1, d, h, mi);
}

function root(overrides: Partial<DecryptedPlannedWorkout> & { id: string }): DecryptedPlannedWorkout {
  return {
    templateId: TEMPLATE_ID_PUSH,
    scheduledDate: epochMs(2026, 6, 4, 0, 0),
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    recurrenceGroupId: null,
    deletedOccurrencesRaw: null,
    completedSessionId: null,
    ...overrides,
  };
}

function session(overrides: Partial<DecryptedSession> & { id: string }): DecryptedSession {
  return {
    templateId: TEMPLATE_ID_PUSH,
    startTime: epochMs(2026, 6, 4),
    endTime: epochMs(2026, 6, 4, 13),
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: epochMs(2026, 6, 4),
    updatedAt: epochMs(2026, 6, 4, 13),
    ...overrides,
  };
}

function setLog(overrides: Partial<DecryptedSetLog> & { id: string; sessionId: string }): DecryptedSetLog {
  return {
    exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
    exerciseSource: 'CATALOG',
    completedReps: 10,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    createdAt: epochMs(2026, 6, 4),
    updatedAt: epochMs(2026, 6, 4),
    ...overrides,
  };
}

function snapshotWith(overrides: Partial<DecryptedSnapshot>): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    plannedWorkouts: [],
    sessions: [],
    setLogs: [],
    settings: [{ key: 'training_timezone_id', type: 's', value: TZ }],
    ...overrides,
  };
}

const ARGS = { toleranceDays: 1, matchThreshold: 0.5, uncertainThreshold: 0.25 };

// ---------------------------------------------------------------------------
// Block 1 — no similarity (Task 1)
// ---------------------------------------------------------------------------

describe('computeAdherence — full denominator, tolerance window, exact matches', () => {
  it('matches an occurrence and a same-template session on the same day: distance 0, via templateId', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', startTime: epochMs(2026, 6, 4) })],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      dateDistanceDays: 0,
      via: 'templateId',
      similarity: null,
      confidence: 'matched',
    });
    expect(result.matchedCount).toBe(1);
    expect(result.missedCount).toBe(0);
  });

  it('matches a session one day later within toleranceDays: 1, but misses it at toleranceDays: 0', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', startTime: epochMs(2026, 6, 5) })],
    });
    const tolerant = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', toleranceDays: 1, matchThreshold: 0.5, uncertainThreshold: 0.25 },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(tolerant.matches).toHaveLength(1);
    expect(tolerant.matches[0].dateDistanceDays).toBe(1);

    const strict = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', toleranceDays: 0, matchThreshold: 0.5, uncertainThreshold: 0.25 },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(strict.matches).toHaveLength(0);
    expect(strict.missedCount).toBe(1);
    expect(strict.unplannedSessionIds).toEqual(['s1']);
  });

  it('a session one day EARLIER behaves symmetrically to one day later — distance is a magnitude, not a direction', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', startTime: epochMs(2026, 6, 3) })],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].dateDistanceDays).toBe(1);
  });

  it('two occurrences on consecutive days and one session in between: exactly one match, the other stays missed', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [
        root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) }),
        root({ id: 'r2', scheduledDate: epochMs(2026, 6, 5, 0, 0) }),
      ],
      sessions: [session({ id: 's1', startTime: epochMs(2026, 6, 4, 20) })],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.missedCount).toBe(1);
  });

  it('two sessions on the same day and one occurrence: one match, one unplanned session', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [
        session({ id: 's1', startTime: epochMs(2026, 6, 4, 8) }),
        session({ id: 's2', startTime: epochMs(2026, 6, 4, 18), endTime: epochMs(2026, 6, 4, 19) }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.unplannedSessionIds).toHaveLength(1);
  });

  it('deterministic tie-break: same distance to two occurrences yields the same result across repeated runs', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [
        root({ id: 'r-a', scheduledDate: epochMs(2026, 6, 3, 0, 0) }),
        root({ id: 'r-b', scheduledDate: epochMs(2026, 6, 5, 0, 0) }),
      ],
      sessions: [session({ id: 's1', startTime: epochMs(2026, 6, 4) })],
    });
    const run1 = computeAdherence({ from: '2026-06-01', to: '2026-06-10', ...ARGS }, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    const run2 = computeAdherence({ from: '2026-06-01', to: '2026-06-10', ...ARGS }, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    expect(run1).toEqual(run2);
    expect(run1.matches).toHaveLength(1);
    expect(run1.matches[0].rootId).toBe('r-a'); // tie-break: (date, rootId) ascending — 'r-a' < 'r-b'
  });

  it('plannedCount excludes a deleted occurrence; removedOccurrenceCount counts it instead, only inside the window', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [
        root({
          id: 'r1',
          scheduledDate: epochMs(2026, 6, 2, 0, 0),
          recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
          deletedOccurrencesRaw: '["2026-06-09"]',
        }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-16', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    // Tuesdays in range: 06-02, 06-09 (deleted), 06-16 → plannedCount excludes 06-09
    expect(result.plannedCount).toBe(2);
    expect(result.removedOccurrenceCount).toBe(1);

    const narrower = computeAdherence(
      { from: '2026-06-01', to: '2026-06-03', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(narrower.removedOccurrenceCount).toBe(0);
  });

  it('adherenceRatio is null (not 0, not NaN) when nothing was planned in the window', () => {
    const snapshot = snapshotWith({});
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.plannedCount).toBe(0);
    expect(result.adherenceRatio).toBeNull();
  });

  it('explanation names both the removed-occurrence ambiguity (D-05) and the fully-deleted-root gap (D-07)', () => {
    const snapshot = snapshotWith({});
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.explanation).toBe(ADHERENCE_EXPLANATION);
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(result.explanation.toLowerCase()).toContain('removed');
    expect(result.explanation.toLowerCase()).toContain('as if nothing had ever been planned');
  });

  it('a session startTime at 23:30 UTC falls on the next day in Europe/Berlin and matches its occurrence there', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 5, 0, 0) })],
      sessions: [
        session({
          id: 's1',
          startTime: Date.UTC(2026, 5, 4, 23, 30), // 2026-06-04T23:30Z → 2026-06-05 in Europe/Berlin (CEST, UTC+2)
          endTime: Date.UTC(2026, 5, 5, 0, 30),
        }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].dateDistanceDays).toBe(0);
    expect(result.matches[0].sessionDate).toBe('2026-06-05');
  });

  it('sessions with deletedAt set, and sessions without endTime, never count as absolved', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [
        session({ id: 's-deleted', startTime: epochMs(2026, 6, 4), deletedAt: epochMs(2026, 6, 5) }),
        session({ id: 's-ongoing', startTime: epochMs(2026, 6, 4), endTime: undefined }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(0);
    expect(result.missedCount).toBe(1);
    expect(result.unplannedSessionIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Block 2 — muscle-similarity axis (Task 2)
// ---------------------------------------------------------------------------

describe('computeAdherence — the second axis: templateId-less sessions via muscle similarity', () => {
  it('a session without templateId, strongly overlapping the planned template, matches via muscleSimilarity', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      setLogs: [
        setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl2', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl3', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl4', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl5', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl6', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl7', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl8', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl9', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
      ],
    });
    // Plan vector (TEMPLATE_ID_PUSH, from fixture, WR-01/MUSC-07-fixed): push-up
    // sets:3 * BLOCK_ID_PUSH_A.rounds:3 = 9, pull-up sets:3 * rounds:3 = 9
    // → {chest:9, back:18, lats:9} (push-up: chest+back, pull-up: back+lats)
    // Session vector: 6x push-up + 3x pull-up → {chest:6, back:9, lats:3}
    // Ruzicka: sumMin=6+9+3=18, sumMax=9+18+9=36 → 0.5 → matched at threshold 0.5
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ via: 'muscleSimilarity', confidence: 'matched' });
    expect(result.matches[0].similarity).toBeCloseTo(0.5, 10);
    expect(result.matchedCount).toBe(1);
  });

  it('a borderline overlap between the two thresholds is assigned with confidence "uncertain" and counted separately', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      // Plan vector (WR-01/MUSC-07-fixed): {chest:9, back:18, lats:9} (sumMax basis = 36)
      // Six pull-up sets → session vector {back:6, lats:6}
      // Ruzicka: sumMin=0+6+6=12, sumMax=9+18+9=36 → 0.333 → between uncertainThreshold(0.25) and matchThreshold(0.5)
      setLogs: [
        setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl2', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl3', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl4', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl5', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
        setLog({ id: 'sl6', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe('uncertain');
    expect(result.matches[0].similarity).toBeCloseTo(1 / 3, 5);
    expect(result.uncertainCount).toBe(1);
    expect(result.matchedCount).toBe(0);
  });

  it('an overlap below the lower threshold is not assigned: the occurrence stays missed, the session stays unplanned', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      // One pull-up set only → session vector {back:1, lats:1}; sumMin=1, sumMax=12 → 0.0833 < 0.25
      setLogs: [setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PULLUP })],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(0);
    expect(result.missedCount).toBe(1);
    expect(result.unplannedSessionIds).toEqual(['s1']);
  });

  it('the magnitude case: a single warm-up set against a full template does not match (Ruzicka, not cosine)', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      // One push-up set only → session vector {chest:1, back:1}; plan {chest:3, back:6, lats:3}
      // sumMin = min(1,3)+min(1,6)+min(0,3) = 1+1+0 = 2; sumMax = 3+6+3=12 → 0.1667 < 0.25 (none)
      setLogs: [setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP })],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(0);
  });

  it('Pitfall 2: a session with a MATCHING templateId whose actual exercises diverge stays via templateId/matched — similarity is never computed for it', () => {
    const ruzickaSpy = vi.spyOn(similarityModule, 'ruzickaSimilarity');
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: TEMPLATE_ID_PUSH, startTime: epochMs(2026, 6, 4) })],
      // Completely different muscle content from the Push Day template (squats only) —
      // if similarity were (mis-)computed for this pair it would score far below threshold.
      setLogs: [setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_SQUAT })],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ via: 'templateId', confidence: 'matched', similarity: null });
    expect(ruzickaSpy).not.toHaveBeenCalled();
    ruzickaSpy.mockRestore();
  });

  it('axis ordering: an exact candidate wins over a similarity candidate for the same occurrence, even at a larger (still-tolerated) distance', () => {
    // Occurrence at 06-04. Exact-template session at 06-05 (distance 1, within tolerance 1).
    // A templateId-less, highly-similar session at 06-04 (distance 0) exists too, but the
    // exact match must win for this occurrence regardless of the similarity candidate's
    // smaller distance — pass 1 runs to completion before pass 2 ever starts.
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [
        session({ id: 's-exact', templateId: TEMPLATE_ID_PUSH, startTime: epochMs(2026, 6, 5) }),
        session({ id: 's-similar', templateId: undefined, startTime: epochMs(2026, 6, 4) }),
      ],
      setLogs: [
        setLog({ id: 'sl1', sessionId: 's-exact', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl2', sessionId: 's-similar', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl3', sessionId: 's-similar', exerciseId: CATALOG_EXERCISE_ID_PULLUP }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].sessionId).toBe('s-exact');
    expect(result.matches[0].via).toBe('templateId');
    // The similarity-candidate session never got a chance to match this (already-consumed) occurrence.
    expect(result.unplannedSessionIds).toEqual(['s-similar']);
  });

  it('a session whose exercises are absent from the catalog yields an empty vector and no match — no error', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_PUSH, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      setLogs: [setLog({ id: 'sl1', sessionId: 's1', exerciseId: 'unknown-exercise-id' })],
    });
    expect(() =>
      computeAdherence(
        { from: '2026-06-01', to: '2026-06-10', ...ARGS },
        { snapshot, catalog: mockCatalog, timeZoneId: TZ },
      ),
    ).not.toThrow();
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(0);
  });

  it('a template with no templateExercises yields an empty plan vector and no match — no error', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_LEGS_EMPTY, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      setLogs: [setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP })],
      templates: [
        ...mockSnapshot.templates,
        { id: TEMPLATE_ID_LEGS_EMPTY, name: 'Empty Template', createdAt: 1, updatedAt: 1, isFavoriteForWatch: false },
      ],
    });
    expect(() =>
      computeAdherence(
        { from: '2026-06-01', to: '2026-06-10', ...ARGS },
        { snapshot, catalog: mockCatalog, timeZoneId: TZ },
      ),
    ).not.toThrow();
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // WR-01 / MUSC-07 regression (138-15): planVectorFor must multiply
  // templateExercise.sets by the containing block's rounds. This is the exact
  // arithmetic bug 138-14's plausibility-floor check found in production: an
  // unchanged, same-day "A - KB Kraft" session scored 0.153 against its own
  // template instead of ~1.0, because a rounds:3 circuit block's sets:1 rows
  // were counted as 1 set instead of 3. Reproduced here at miniature scale:
  // one exercise, one block with rounds:3, sets:1 — a session performing all
  // 3 actual rounds (3 set-logs) must score a PERFECT 1.0 against this plan,
  // not the ~0.33 the pre-fix code (raw sets, no rounds multiplier) produces.
  // ---------------------------------------------------------------------------

  const TEMPLATE_ID_CIRCUIT = 'cccccccc-0003-4000-c000-000000000097';
  const BLOCK_ID_CIRCUIT = 'dddddddd-0004-4000-d000-000000000097';
  const TE_ID_CIRCUIT = 'eeeeeeee-0005-4000-e000-000000000097';

  it('WR-01/MUSC-07 regression: a rounds:3 circuit template, fully performed, scores near 1.0 — not the ~0.33 the pre-fix raw-sets vector gives', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [root({ id: 'r1', templateId: TEMPLATE_ID_CIRCUIT, scheduledDate: epochMs(2026, 6, 4, 0, 0) })],
      sessions: [session({ id: 's1', templateId: undefined, startTime: epochMs(2026, 6, 4) })],
      templates: [
        ...mockSnapshot.templates,
        { id: TEMPLATE_ID_CIRCUIT, name: 'Circuit', createdAt: 1, updatedAt: 1, isFavoriteForWatch: false },
      ],
      blocks: [
        ...mockSnapshot.blocks,
        {
          id: BLOCK_ID_CIRCUIT,
          templateId: TEMPLATE_ID_CIRCUIT,
          name: 'Zirkel',
          rounds: 3,
          orderIndex: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      templateExercises: [
        ...mockSnapshot.templateExercises,
        {
          id: TE_ID_CIRCUIT,
          templateId: TEMPLATE_ID_CIRCUIT,
          blockId: BLOCK_ID_CIRCUIT,
          exerciseId: CATALOG_EXERCISE_ID_PUSHUP,
          exerciseSource: 'CATALOG',
          mode: 'REPS',
          restTimeSeconds: 60,
          sets: 1,
          orderIndex: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      // 3 actual push-up sets = sets(1) * rounds(3) performed exactly, unchanged from the plan.
      setLogs: [
        setLog({ id: 'sl1', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl2', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
        setLog({ id: 'sl3', sessionId: 's1', exerciseId: CATALOG_EXERCISE_ID_PUSHUP }),
      ],
    });
    const result = computeAdherence(
      { from: '2026-06-01', to: '2026-06-10', ...ARGS },
      { snapshot, catalog: mockCatalog, timeZoneId: TZ },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ via: 'muscleSimilarity', confidence: 'matched' });
    // Plan vector (post-fix): chest:3, back:3 (push-up sets:1 * block.rounds:3, both PRIMARY).
    // Session vector: 3x push-up → chest:3, back:3. sumMin=6, sumMax=6 → 1.0, not the pre-fix
    // sets(1)-only value of 1/3.
    expect(result.matches[0].similarity).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Phase 155 (SC 2, T-155-28): foreign sport in the snapshot moves no template number
// ---------------------------------------------------------------------------

describe('computeAdherence — foreign sport is its own pass (Phase 155)', () => {
  it('P155 SC2 computeAdherence is identical with and without foreign data', () => {
    const FT_RUNNING = 'b85b2339-ddf1-385d-acb2-b0d3d498eeca';
    const base = snapshotWith({
      plannedWorkouts: [
        root({ id: 'r1', scheduledDate: epochMs(2026, 6, 2, 0, 0), recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU', deletedOccurrencesRaw: '["2026-06-09"]' }),
      ],
      sessions: [
        session({ id: 's1', startTime: epochMs(2026, 6, 2), endTime: epochMs(2026, 6, 2, 13) }),
        session({ id: 's-free', templateId: undefined, startTime: epochMs(2026, 6, 4), endTime: epochMs(2026, 6, 4, 13) }),
      ],
    });
    // Foreign data on the same days as template occurrences and sessions, plus a foreign
    // appointment on a template day, an own type and an unknown type.
    const withForeign: DecryptedSnapshot = {
      ...base,
      foreignActivityTypes: [
        { id: 'ft-own', name: 'Wandern', createdAt: epochMs(2026, 5, 1), updatedAt: epochMs(2026, 5, 1), deletedAt: null },
      ],
      foreignActivities: [
        { id: 'fa1', typeId: FT_RUNNING, performedOn: '2026-06-02', performedTime: '07:00', durationMinutes: 30, intensity: 3, dayForm: null, distanceMeters: null, note: null, createdAt: epochMs(2026, 6, 2), updatedAt: epochMs(2026, 6, 2) },
        { id: 'fa2', typeId: 'ft-own', performedOn: '2026-06-09', performedTime: null, durationMinutes: 90, intensity: null, dayForm: 2, distanceMeters: 5000, note: 'Notiz', createdAt: epochMs(2026, 6, 9), updatedAt: epochMs(2026, 6, 9) },
        { id: 'fa3', typeId: 'ft-unknown', performedOn: '2026-06-04', performedTime: null, durationMinutes: 20, intensity: 5, dayForm: null, distanceMeters: null, note: null, createdAt: epochMs(2026, 6, 4), updatedAt: epochMs(2026, 6, 4) },
      ],
      plannedForeignActivities: [
        { id: 'fr1', typeId: FT_RUNNING, scheduledDate: epochMs(2026, 6, 2, 0, 0), scheduledTime: '07:00', note: null, recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU', deletedOccurrencesRaw: '["2026-06-16"]', createdAt: epochMs(2026, 5, 1), updatedAt: epochMs(2026, 5, 1) },
      ],
    };
    const args = { from: '2026-06-01', to: '2026-06-21', ...ARGS };
    const without = computeAdherence(args, { snapshot: base, catalog: mockCatalog, timeZoneId: TZ });
    const withData = computeAdherence(args, { snapshot: withForeign, catalog: mockCatalog, timeZoneId: TZ });
    expect(withData).toEqual(without);
    expect(JSON.stringify(withData)).toBe(JSON.stringify(without));
    expect(without.plannedCount).toBe(2);
    expect(without.removedOccurrenceCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 155 (D-07, D-06): completed series dates the app wrote as removed
// ---------------------------------------------------------------------------
// Phase 166 (MCP-08, D-10, protocol §1.6 "Several candidates for one occurrence"): pass 1
// orders its candidates by date distance, then live set count (descending), then duration
// (descending), then the old tie-break. Invented ids: the losing session always carries the
// SMALLER id, so the order through 1.48 (smaller sessionId wins) decides visibly wrong.
// ---------------------------------------------------------------------------

describe('computeAdherence — several candidates for one occurrence (Phase 166, D-10)', () => {
  const args = { from: '2026-06-01', to: '2026-06-10', ...ARGS };
  const occurrenceRoot = root({ id: 'r1', scheduledDate: epochMs(2026, 6, 4, 0, 0) });

  it('P166 two sessions of one template on one day match the one with more live sets even with the larger session id', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [occurrenceRoot],
      sessions: [
        // Smaller id, three set rows but only ONE live (deleted sets never count), and the
        // LONGER duration: the live set count decides before the duration does.
        session({ id: 's-a', startTime: epochMs(2026, 6, 4, 8), endTime: epochMs(2026, 6, 4, 10) }),
        session({ id: 's-b', startTime: epochMs(2026, 6, 4, 18), endTime: epochMs(2026, 6, 4, 18, 30) }),
      ],
      setLogs: [
        setLog({ id: 'sl-a-1', sessionId: 's-a' }),
        setLog({ id: 'sl-a-2', sessionId: 's-a', deletedAt: epochMs(2026, 6, 4, 10) }),
        setLog({ id: 'sl-a-3', sessionId: 's-a', deletedAt: epochMs(2026, 6, 4, 10) }),
        setLog({ id: 'sl-b-1', sessionId: 's-b' }),
        setLog({ id: 'sl-b-2', sessionId: 's-b' }),
      ],
    });
    const result = computeAdherence(args, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ rootId: 'r1', sessionId: 's-b', via: 'templateId', confidence: 'matched' });
  });

  it('P166 equal set counts match the longer session', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [occurrenceRoot],
      sessions: [
        session({ id: 's-a', startTime: epochMs(2026, 6, 4, 8), endTime: epochMs(2026, 6, 4, 8, 20) }),
        session({ id: 's-b', startTime: epochMs(2026, 6, 4, 18), endTime: epochMs(2026, 6, 4, 19) }),
      ],
      setLogs: [
        setLog({ id: 'sl-a-1', sessionId: 's-a' }),
        setLog({ id: 'sl-a-2', sessionId: 's-a' }),
        setLog({ id: 'sl-b-1', sessionId: 's-b' }),
        setLog({ id: 'sl-b-2', sessionId: 's-b' }),
      ],
    });
    const result = computeAdherence(args, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].sessionId).toBe('s-b');
    expect(result.unplannedSessionIds).toEqual(['s-a']);
  });

  it('P166 the other candidate appears as unplanned and matchedCount stays the same', () => {
    const sessions = [
      session({ id: 's-a', startTime: epochMs(2026, 6, 4, 9), endTime: epochMs(2026, 6, 4, 9, 2) }),
      session({ id: 's-b', startTime: epochMs(2026, 6, 4, 8), endTime: epochMs(2026, 6, 4, 9) }),
    ];
    const setLogs = [
      setLog({ id: 'sl-a-1', sessionId: 's-a' }),
      setLog({ id: 'sl-b-1', sessionId: 's-b' }),
      setLog({ id: 'sl-b-2', sessionId: 's-b' }),
      setLog({ id: 'sl-b-3', sessionId: 's-b' }),
    ];
    const both = computeAdherence(args, {
      snapshot: snapshotWith({ plannedWorkouts: [occurrenceRoot], sessions, setLogs }),
      catalog: mockCatalog,
      timeZoneId: TZ,
    });
    expect(both.matches.map((m) => m.sessionId)).toEqual(['s-b']);
    expect(both.unplannedSessionIds).toEqual(['s-a']);
    // The measuring figures keep their definition: exactly one session is matched either way,
    // the same as with only one of the two sessions present.
    for (const only of sessions) {
      const single = computeAdherence(args, {
        snapshot: snapshotWith({ plannedWorkouts: [occurrenceRoot], sessions: [only], setLogs }),
        catalog: mockCatalog,
        timeZoneId: TZ,
      });
      expect(single.matchedCount).toBe(both.matchedCount);
      expect(single.adherenceRatio).toBe(both.adherenceRatio);
    }
    expect(both.matchedCount).toBe(1);
    expect(both.plannedCount).toBe(1);
    expect(both.missedCount).toBe(0);
    expect(both.adherenceRatio).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('computeAdherence — removedWithCompletedSessionCount (Phase 155, D-07)', () => {
  const OTHER_TEMPLATE = 'cccccccc-0002-4000-c000-0000000000aa';
  // Weekly on Tuesdays from 2026-06-02 (06-02, 06-09, 06-16); 06-09 and 06-16 stand in
  // deletedOccurrences, 06-09 because the app wrote the completed date there before 155-10.
  const seriesRoot = root({
    id: 'r-series',
    scheduledDate: epochMs(2026, 6, 2, 0, 0),
    recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
    deletedOccurrencesRaw: '["2026-06-09","2026-06-16"]',
  });
  const args = { from: '2026-06-01', to: '2026-06-21', ...ARGS };

  it('P155 D-07 a removed series date with a finished session of the same template on that calendar day is counted', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [seriesRoot],
      // 2026-06-08 22:30 UTC is 2026-06-09 00:30 in Europe/Berlin — the athlete's calendar day.
      sessions: [session({ id: 's-done', startTime: epochMs(2026, 6, 8, 22, 30), endTime: epochMs(2026, 6, 8, 23, 30) })],
    });
    const result = computeAdherence(args, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    expect(result.removedWithCompletedSessionCount).toBe(1);
    expect(result.removedWithCompletedSessionDates).toEqual([
      { date: '2026-06-09', rootId: 'r-series', templateId: TEMPLATE_ID_PUSH },
    ]);
    expect(result.removedWithCompletedSessionExplanation).toBe(REMOVED_WITH_COMPLETED_SESSION_EXPLANATION);
    // Appended after the existing keys, the existing order untouched.
    const keys = Object.keys(result);
    expect(keys.slice(-3)).toEqual([
      'removedWithCompletedSessionCount',
      'removedWithCompletedSessionDates',
      'removedWithCompletedSessionExplanation',
    ]);
    expect(keys.indexOf('explanation')).toBe(keys.length - 4);
  });

  it('P155 D-07 a session of another template, an unfinished session or a deleted session does not count', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [seriesRoot],
      sessions: [
        session({ id: 's-other', templateId: OTHER_TEMPLATE, startTime: epochMs(2026, 6, 9), endTime: epochMs(2026, 6, 9, 13) }),
        session({ id: 's-running', startTime: epochMs(2026, 6, 9), endTime: undefined }),
        session({ id: 's-deleted', startTime: epochMs(2026, 6, 16), endTime: epochMs(2026, 6, 16, 13), deletedAt: epochMs(2026, 6, 17) }),
        // Same template, but on a day that is NOT a removed date — counts nowhere here.
        session({ id: 's-other-day', startTime: epochMs(2026, 6, 10), endTime: epochMs(2026, 6, 10, 13) }),
      ],
    });
    const result = computeAdherence(args, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    expect(result.removedWithCompletedSessionCount).toBe(0);
    expect(result.removedWithCompletedSessionDates).toEqual([]);
  });

  it('P155 D-07 removedOccurrenceCount is unchanged', () => {
    const snapshot = snapshotWith({
      plannedWorkouts: [seriesRoot],
      sessions: [session({ id: 's-done', startTime: epochMs(2026, 6, 9), endTime: epochMs(2026, 6, 9, 13) })],
    });
    const result = computeAdherence(args, { snapshot, catalog: mockCatalog, timeZoneId: TZ });
    // The pre-155 definition, counted independently: every removed date of an emitted root
    // inside the window — the completed 06-09 included (D-07: never redefined).
    const denom = getPlannedWorkouts({ from: args.from, to: args.to }, snapshot);
    const independent = denom.roots
      .flatMap((r) => r.deletedOccurrences)
      .filter((d) => d >= args.from && d <= args.to).length;
    expect(independent).toBe(2);
    expect(result.removedOccurrenceCount).toBe(independent);
    expect(result.removedWithCompletedSessionCount).toBe(1);
    expect(result.plannedCount).toBe(1);
    expect(result.explanation).toBe(ADHERENCE_EXPLANATION);
  });

  it('P155 D-07 the explanation is verbatim in the protocol', () => {
    expect(REMOVED_WITH_COMPLETED_SESSION_EXPLANATION).toBe(
      protocolExplanation('REMOVED_WITH_COMPLETED_SESSION_EXPLANATION'),
    );
  });
});
