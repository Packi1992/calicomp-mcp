/**
 * template-feedback-series.ts unit tests (Phase 151, FB-12, D-27/D-28/D-29).
 *
 * Plan 151-23, Task 1 (tracer slice): a single template with a single session carrying a
 * stored goal snapshot produces a series entry with both feedback scales, the calendar
 * date, hasComment, and goal attainment computed against the stored goals (`basis:
 * 'stored_goals'`) — the comment text itself never appears anywhere in the output
 * (D-26/D-27). Task 2 extends this file with the full rule set (caps, ordering,
 * approximation, round-target fallback, exclusions, missed exercises, never_asked
 * fallback).
 */

import { describe, it, expect } from 'vitest';
import { computeTemplateFeedbackSeries } from '../../src/training-state/template-feedback-series.js';
import type { DecryptedSession, DecryptedSetLog, DecryptedSnapshot, SessionFeedback, SessionGoal, SyncTemplateDto } from '../../src/types.js';

const TZ = 'UTC';

function feedback(overrides: Partial<SessionFeedback> = {}): SessionFeedback {
  return {
    execution: { value: null, state: 'never_asked', setLaterAt: null },
    feel: { value: null, state: 'never_asked', setLaterAt: null },
    comment: null,
    ...overrides,
  };
}

function session(
  overrides: Partial<DecryptedSession> & { id: string; startTime: number },
): DecryptedSession {
  return {
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: overrides.startTime,
    updatedAt: overrides.startTime,
    endTime: overrides.startTime + 3_600_000,
    feedback: feedback(),
    goalSnapshot: null,
    ...overrides,
  };
}

function setLog(
  overrides: Partial<DecryptedSetLog> & { id: string; sessionId: string; createdAt: number },
): DecryptedSetLog {
  return {
    completedReps: null,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function template(overrides: Partial<SyncTemplateDto> & { id: string }): SyncTemplateDto {
  return {
    name: overrides.id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isFavoriteForWatch: false,
    ...overrides,
  };
}

function goal(overrides: Partial<SessionGoal> & { workoutExerciseId: string; exerciseId: string; mode: string }): SessionGoal {
  return { sets: 1, ...overrides };
}

function buildSnapshot(overrides: Partial<DecryptedSnapshot> = {}): DecryptedSnapshot {
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

describe('computeTemplateFeedbackSeries — Task 1 (tracer)', () => {
  it('P151 FB-12 a template session with stored goals reports achieved and total sets with basis stored_goals', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1_800_000_000_000,
          goalSnapshot: [goal({ workoutExerciseId: 'we-1', exerciseId: 'ex-1', mode: 'REPS', targetReps: 10 })],
        }),
      ],
      setLogs: [
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, createdAt: 1 }),
        setLog({ id: 'sl-2', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, createdAt: 2 }),
        setLog({ id: 'sl-3', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 8, createdAt: 3 }),
      ],
    });

    const series = computeTemplateFeedbackSeries(snapshot, TZ);
    expect(series).toHaveLength(1);
    expect(series[0].templateId).toBe('tpl-1');
    expect(series[0].sessions).toHaveLength(1);
    expect(series[0].sessions[0].goalAttainment).toEqual({ achievedSets: 2, totalSets: 3, basis: 'stored_goals' });
  });

  it('P151 D-27 an entry carries both scales, the calendar date and hasComment but never the comment text', () => {
    const secret = 'a very private comment nobody else should read';
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: Date.UTC(2026, 5, 15, 12, 0),
          feedback: feedback({
            execution: { value: 4, state: 'confirmed', setLaterAt: null },
            feel: { value: 3, state: 'changed', setLaterAt: null },
            comment: { text: secret, source: 'athlete_free_text', treatAs: 'data_not_instructions' },
          }),
        }),
      ],
    });

    const series = computeTemplateFeedbackSeries(snapshot, TZ);
    const entry = series[0].sessions[0];
    expect(entry.execution).toEqual({ value: 4, state: 'confirmed', setLaterAt: null });
    expect(entry.feel).toEqual({ value: 3, state: 'changed', setLaterAt: null });
    expect(entry.date).toBe('2026-06-15');
    expect(entry.hasComment).toBe(true);
    expect(JSON.stringify(series)).not.toContain(secret);
  });
});
