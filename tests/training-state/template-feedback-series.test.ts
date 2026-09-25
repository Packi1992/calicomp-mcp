/**
 * template-feedback-series.ts unit tests (Phase 151, FB-12, D-27/D-28/D-29).
 *
 * Covers `computeTemplateFeedbackSeries`/`computeGoalAttainment`: session selection
 * (template-kind, completed, not soft-deleted), the MAX_SERIES_SESSIONS/MAX_SERIES_TEMPLATES
 * caps and ordering, the stored-goals vs. approximation-current-template basis, the per-set
 * attainment rule mirroring `ProgressionAnalyzer.sessionMeetsTarget` (round-target fallback,
 * MAX/weight exclusion, sets without a workoutExerciseId), missed-exercise naming, and the
 * never_asked feedback fallback. The comment text itself is proven absent from every output
 * (D-26/D-27) — only `hasComment` ever appears.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTemplateFeedbackSeries,
  computeGoalAttainment,
  MAX_SERIES_SESSIONS,
  MAX_SERIES_TEMPLATES,
} from '../../src/training-state/template-feedback-series.js';
import type {
  DecryptedSession,
  DecryptedSetLog,
  DecryptedSnapshot,
  NormalizedTemplateExercise,
  SessionFeedback,
  SessionGoal,
  SyncTemplateDto,
} from '../../src/types.js';
import type { ExerciseNameResolver } from '../../src/exercise-names.js';

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

function templateExercise(
  overrides: Partial<NormalizedTemplateExercise> & { id: string; templateId: string; exerciseId: string },
): NormalizedTemplateExercise {
  return {
    exerciseSource: 'CATALOG',
    mode: 'REPS',
    restTimeSeconds: 60,
    sets: 1,
    orderIndex: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
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

// ---------------------------------------------------------------------------
// Plan 151-23, Task 1 (tracer)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Plan 151-23, Task 2 (full rules)
// ---------------------------------------------------------------------------

describe('computeTemplateFeedbackSeries — Task 2 (full rules)', () => {
  it('P151 D-27 at most eight sessions per template newest first regardless of the window', () => {
    const sessions: DecryptedSession[] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push(session({ id: `sess-${i}`, templateId: 'tpl-1', startTime: 1_000_000 * (i + 1) }));
    }
    const snapshot = buildSnapshot({ templates: [template({ id: 'tpl-1' })], sessions });

    const series = computeTemplateFeedbackSeries(snapshot, TZ);
    expect(series[0].sessions).toHaveLength(MAX_SERIES_SESSIONS);
    // Newest first: sess-9 (startTime 10_000_000) down to sess-2 (the 8 newest of 10).
    expect(series[0].sessions.map((s) => s.sessionId)).toEqual([
      'sess-9', 'sess-8', 'sess-7', 'sess-6', 'sess-5', 'sess-4', 'sess-3', 'sess-2',
    ]);
  });

  it('P151 D-27 at most twenty templates ordered by their latest session', () => {
    const templates: SyncTemplateDto[] = [];
    const sessions: DecryptedSession[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `tpl-${i}`;
      templates.push(template({ id }));
      sessions.push(session({ id: `sess-${i}`, templateId: id, startTime: 1_000_000 * (i + 1) }));
    }
    const snapshot = buildSnapshot({ templates, sessions });

    const series = computeTemplateFeedbackSeries(snapshot, TZ);
    expect(series).toHaveLength(MAX_SERIES_TEMPLATES);
    // Newest session first: tpl-24 (startTime 25) down to tpl-5 (the 20 newest of 25).
    expect(series[0].templateId).toBe('tpl-24');
    expect(series.map((s) => s.templateId)).not.toContain('tpl-4');
    expect(series.map((s) => s.templateId)).not.toContain('tpl-0');
  });

  it('P151 D-29 a session without stored goals uses the current template and is marked approximation', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      templateExercises: [
        templateExercise({ id: 'we-1', templateId: 'tpl-1', exerciseId: 'ex-1', mode: 'REPS', targetReps: 10 }),
      ],
      sessions: [session({ id: 'sess-1', templateId: 'tpl-1', startTime: 1, goalSnapshot: null })],
      setLogs: [
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, createdAt: 1 }),
        setLog({ id: 'sl-2', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 3, createdAt: 2 }),
      ],
    });

    const attainment = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0].goalAttainment;
    expect(attainment).toEqual({ achievedSets: 1, totalSets: 2, basis: 'approximation_current_template' });
  });

  it('P151 D-29 a deleted template without stored goals has no attainment and status deleted', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1', deletedAt: 999 })],
      templateExercises: [],
      sessions: [session({ id: 'sess-1', templateId: 'tpl-1', startTime: 1, goalSnapshot: null })],
      setLogs: [setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, createdAt: 1 })],
    });

    const series = computeTemplateFeedbackSeries(snapshot, TZ);
    expect(series[0].templateStatus).toBe('deleted');
    expect(series[0].sessions[0].goalAttainment).toBeNull();
  });

  it('P151 D-29 MAX exercises never count', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1,
          goalSnapshot: [
            goal({ workoutExerciseId: 'we-max', exerciseId: 'ex-max', mode: 'MAX' }),
            goal({ workoutExerciseId: 'we-reps', exerciseId: 'ex-reps', mode: 'REPS', targetReps: 5 }),
          ],
        }),
      ],
      setLogs: [
        setLog({ id: 'sl-max', sessionId: 'sess-1', workoutExerciseId: 'we-max', completedReps: 100, createdAt: 1 }),
        setLog({ id: 'sl-reps', sessionId: 'sess-1', workoutExerciseId: 'we-reps', completedReps: 5, createdAt: 2 }),
      ],
    });

    const attainment = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0].goalAttainment;
    expect(attainment).toEqual({ achievedSets: 1, totalSets: 1, basis: 'stored_goals' });
  });

  it('P151 D-29 weight never counts', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1,
          goalSnapshot: [goal({ workoutExerciseId: 'we-1', exerciseId: 'ex-1', mode: 'REPS', targetReps: 10, targetWeight: 50 })],
        }),
      ],
      setLogs: [
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, weightUsed: 0, createdAt: 1 }),
      ],
    });

    const attainment = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0].goalAttainment;
    expect(attainment).toEqual({ achievedSets: 1, totalSets: 1, basis: 'stored_goals' });
  });

  it('P151 D-29 set logs without workoutExerciseId count neither way', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1,
          goalSnapshot: [goal({ workoutExerciseId: 'we-1', exerciseId: 'ex-1', mode: 'REPS', targetReps: 10 })],
        }),
      ],
      setLogs: [
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, createdAt: 1 }),
        setLog({ id: 'sl-2', sessionId: 'sess-1', exerciseId: 'ex-1', completedReps: 100, createdAt: 2 }),
      ],
    });

    const attainment = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0].goalAttainment;
    expect(attainment).toEqual({ achievedSets: 1, totalSets: 1, basis: 'stored_goals' });
  });

  it('P151 D-29 the nth set is judged against round target n and falls back to the exercise target', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1,
          goalSnapshot: [
            goal({
              workoutExerciseId: 'we-1',
              exerciseId: 'ex-1',
              mode: 'REPS',
              targetReps: 5,
              roundTargets: [{ round: 1, targetReps: 10 }],
            }),
          ],
        }),
      ],
      setLogs: [
        // 1st set (n=1): judged against round-1's targetReps 10 — fails at 8.
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 8, createdAt: 1 }),
        // 2nd set (n=2): no round-2 row — falls back to the exercise's own targetReps 5 — passes at 6.
        setLog({ id: 'sl-2', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 6, createdAt: 2 }),
      ],
    });

    const attainment = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0].goalAttainment;
    expect(attainment).toEqual({ achievedSets: 1, totalSets: 2, basis: 'stored_goals' });
  });

  it('P151 D-29 a goal without a target for its mode does not count', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1,
          goalSnapshot: [
            goal({ workoutExerciseId: 'we-no-target', exerciseId: 'ex-no-target', mode: 'REPS' }), // no targetReps
            goal({ workoutExerciseId: 'we-time', exerciseId: 'ex-time', mode: 'TIME', targetTimeSeconds: 30 }),
          ],
        }),
      ],
      setLogs: [
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-no-target', completedReps: 5, createdAt: 1 }),
        setLog({ id: 'sl-2', sessionId: 'sess-1', workoutExerciseId: 'we-time', completedTimeSeconds: 40, createdAt: 2 }),
      ],
    });

    const attainment = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0].goalAttainment;
    expect(attainment).toEqual({ achievedSets: 1, totalSets: 1, basis: 'stored_goals' });
  });

  it('P151 D-27 missed exercises carry names from the resolver and appear once in first-miss order', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({
          id: 'sess-1',
          templateId: 'tpl-1',
          startTime: 1,
          goalSnapshot: [
            goal({ workoutExerciseId: 'we-a', exerciseId: 'ex-a', mode: 'REPS', targetReps: 10 }),
            goal({ workoutExerciseId: 'we-b', exerciseId: 'ex-b', mode: 'REPS', targetReps: 10 }),
          ],
        }),
      ],
      setLogs: [
        setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-b', completedReps: 5, createdAt: 1_000 }), // ex-b misses first
        setLog({ id: 'sl-2', sessionId: 'sess-1', workoutExerciseId: 'we-a', completedReps: 5, createdAt: 2_000 }), // ex-a misses second
        setLog({ id: 'sl-3', sessionId: 'sess-1', workoutExerciseId: 'we-a', completedReps: 20, createdAt: 3_000 }), // ex-a recovers
        setLog({ id: 'sl-4', sessionId: 'sess-1', workoutExerciseId: 'we-b', completedReps: 5, createdAt: 4_000 }), // ex-b misses again — already recorded
      ],
    });

    const resolver: ExerciseNameResolver = {
      forExerciseId: (id) =>
        id === 'ex-a'
          ? { exerciseName: 'Ex A', exerciseKey: 'ex_a_key' }
          : id === 'ex-b'
            ? { exerciseName: 'Ex B', exerciseKey: 'ex_b_key' }
            : { exerciseName: null, exerciseKey: null },
      forSetLog: () => ({ exerciseName: null, exerciseKey: null }),
    };

    const entry = computeTemplateFeedbackSeries(snapshot, TZ, resolver)[0].sessions[0];
    expect(entry.missedExercises).toEqual([
      { exerciseId: 'ex-b', exerciseName: 'Ex B', exerciseKey: 'ex_b_key' },
      { exerciseId: 'ex-a', exerciseName: 'Ex A', exerciseKey: 'ex_a_key' },
    ]);
  });

  it('P151 D-27 quick challenges, templateless, running and deleted sessions are excluded', () => {
    const snapshot = buildSnapshot({
      templates: [template({ id: 'tpl-1' })],
      sessions: [
        session({ id: 'sess-qc', templateId: 'tpl-1', startTime: 1, isQuickChallenge: true }),
        session({ id: 'sess-templateless', templateId: undefined, startTime: 2 }),
        session({ id: 'sess-running', templateId: 'tpl-1', startTime: 3, endTime: undefined }),
        session({ id: 'sess-deleted', templateId: 'tpl-1', startTime: 4, deletedAt: 999 }),
        session({ id: 'sess-good', templateId: 'tpl-1', startTime: 5 }),
      ],
    });

    const series = computeTemplateFeedbackSeries(snapshot, TZ);
    expect(series).toHaveLength(1);
    expect(series[0].sessions.map((s) => s.sessionId)).toEqual(['sess-good']);
  });

  it('P151 D-27 a session without feedback reports never_asked', () => {
    const bareSession: DecryptedSession = {
      id: 'sess-1',
      templateId: 'tpl-1',
      startTime: 1,
      endTime: 3_600_001,
      isManual: false,
      isCorrected: false,
      isQuickChallenge: false,
      createdAt: 1,
      updatedAt: 1,
      // `feedback` intentionally omitted — a fixture predating this field.
    };
    const snapshot = buildSnapshot({ templates: [template({ id: 'tpl-1' })], sessions: [bareSession] });

    const entry = computeTemplateFeedbackSeries(snapshot, TZ)[0].sessions[0];
    expect(entry.execution).toEqual({ value: null, state: 'never_asked', setLaterAt: null });
    expect(entry.feel).toEqual({ value: null, state: 'never_asked', setLaterAt: null });
    expect(entry.hasComment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeGoalAttainment — direct unit coverage (used internally by the series above)
// ---------------------------------------------------------------------------

describe('computeGoalAttainment', () => {
  it('returns null when nothing counted', () => {
    const snapshot = buildSnapshot();
    const sess = session({ id: 'sess-1', templateId: 'tpl-1', startTime: 1, goalSnapshot: [] });
    expect(computeGoalAttainment(sess, [], snapshot)).toBeNull();
  });

  it('ignores deleted set logs', () => {
    const snapshot = buildSnapshot();
    const sess = session({
      id: 'sess-1',
      templateId: 'tpl-1',
      startTime: 1,
      goalSnapshot: [goal({ workoutExerciseId: 'we-1', exerciseId: 'ex-1', mode: 'REPS', targetReps: 10 })],
    });
    const logs = [
      setLog({ id: 'sl-1', sessionId: 'sess-1', workoutExerciseId: 'we-1', completedReps: 10, createdAt: 1, deletedAt: 999 }),
    ];
    expect(computeGoalAttainment(sess, logs, snapshot)).toBeNull();
  });
});
