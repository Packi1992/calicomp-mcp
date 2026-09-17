/**
 * narrative.ts unit tests (Phase 137, D-18).
 *
 * Covers determinism (same input -> byte-identical output, twice), the defined null
 * case for each clause (zero streak, equal/zero-baseline frequency comparison, an
 * unplanned adherence window), the deterministic exercise pick when several qualify,
 * the empty-input case, and the absence of evaluative vocabulary anywhere in the output.
 */

import { describe, it, expect } from 'vitest';
import { buildNarrative, type NarrativeInput, type NarrativeRecentExercise } from '../../src/training-state/narrative.js';

// A named list of forbidden evaluative/judgmental/prescriptive vocabulary — the plan's
// own prohibition requires no clause to contain an assessment, a recommendation, or a
// causal attribution. Checked case-insensitively as whole words.
const FORBIDDEN_VOCABULARY = [
  'good',
  'bad',
  'great',
  'excellent',
  'poor',
  'should',
  'must',
  'recommend',
  'strong',
  'weak',
  'impressive',
  'disappointing',
  'improve',
  'worse',
  'better',
  'best',
  'worst',
  'well done',
  'keep it up',
  'because',
];

function assertNoForbiddenVocabulary(sentence: string): void {
  const lower = sentence.toLowerCase();
  for (const word of FORBIDDEN_VOCABULARY) {
    const pattern = new RegExp(`\\b${word}\\b`, 'i');
    expect(pattern.test(lower), `expected no occurrence of forbidden word "${word}" in: ${sentence}`).toBe(false);
  }
}

function exercise(overrides: Partial<NarrativeRecentExercise> = {}): NarrativeRecentExercise {
  return {
    exerciseId: 'ex-1',
    exerciseName: 'Push-Up',
    lastTrainedOn: '2026-09-01',
    direction: 'up',
    ...overrides,
  };
}

function baseInput(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
  return {
    currentStreakWeeks: 3,
    sessionsLast4Weeks: 5,
    sessionsPrior4Weeks: 4,
    adherence: { plannedCount: 8, matchedCount: 6, adherenceRatio: 0.75 },
    recentExercises: [exercise()],
    ...overrides,
  };
}

describe('buildNarrative', () => {
  it('is deterministic: the same input yields the exact same string twice', () => {
    const input = baseInput();
    const first = buildNarrative(input);
    const second = buildNarrative(input);
    expect(first).toBe(second);
  });

  it('names the current streak, the 4-week comparison, and the adherence ratio when present', () => {
    const result = buildNarrative(baseInput());
    expect(result).toContain('3 weeks');
    expect(result).toContain('5 sessions');
    expect(result).toContain('4 in the');
    expect(result).toContain('75%');
    expect(result).toContain('6 of 8');
  });

  it('names a null adherence ratio instead of omitting or fabricating a percentage', () => {
    const input = baseInput({
      sessionsLast4Weeks: 3,
      sessionsPrior4Weeks: 3,
      adherence: { plannedCount: 0, matchedCount: 0, adherenceRatio: null },
    });
    const result = buildNarrative(input);
    expect(result).not.toMatch(/%/);
    expect(result.toLowerCase()).toContain('nothing was scheduled');
  });

  it('names a zero-week streak instead of omitting it', () => {
    const input = baseInput({ currentStreakWeeks: 0 });
    const result = buildNarrative(input);
    expect(result).toContain('0 weeks');
  });

  it('names equality when the last 4 weeks match the prior 4 weeks, without a percentage', () => {
    const input = baseInput({ sessionsLast4Weeks: 3, sessionsPrior4Weeks: 3 });
    const result = buildNarrative(input);
    expect(result.toLowerCase()).toContain('unchanged');
    expect(result).not.toMatch(/\d+%\)/); // no parenthesized percentage attached to the frequency clause
  });

  it('never divides by zero when the prior window is zero and the last window is nonzero', () => {
    const input = baseInput({ sessionsLast4Weeks: 4, sessionsPrior4Weeks: 0 });
    const result = buildNarrative(input);
    expect(result).not.toContain('Infinity');
    expect(result).not.toContain('NaN');
    expect(result).toContain('4 session');
  });

  it('never divides by zero when the last window is zero and the prior window is nonzero', () => {
    const input = baseInput({ sessionsLast4Weeks: 0, sessionsPrior4Weeks: 4 });
    const result = buildNarrative(input);
    expect(result).not.toContain('Infinity');
    expect(result).not.toContain('NaN');
    expect(result.toLowerCase()).toContain('no sessions were logged in the last 4 weeks');
  });

  it('names one "up"-direction exercise when at least one recently trained exercise trends up', () => {
    const input = baseInput({ recentExercises: [exercise({ exerciseName: 'Pull-Up', direction: 'up' })] });
    const result = buildNarrative(input);
    expect(result).toContain('Pull-Up');
  });

  it('deterministically picks the exercise with the most recent lastTrainedOn among several "up" exercises', () => {
    const input = baseInput({
      recentExercises: [
        exercise({ exerciseId: 'ex-a', exerciseName: 'Squat', lastTrainedOn: '2026-08-01', direction: 'up' }),
        exercise({ exerciseId: 'ex-b', exerciseName: 'Row', lastTrainedOn: '2026-09-01', direction: 'up' }),
        exercise({ exerciseId: 'ex-c', exerciseName: 'Dip', lastTrainedOn: '2026-01-01', direction: 'down' }),
      ],
    });
    const result = buildNarrative(input);
    expect(result).toContain('Row');
    expect(result).not.toContain('Squat');
    expect(result).not.toContain('Dip');
  });

  it('breaks a tie on lastTrainedOn deterministically by exerciseId, across repeated runs', () => {
    const input = baseInput({
      recentExercises: [
        exercise({ exerciseId: 'ex-z', exerciseName: 'Zercher Squat', lastTrainedOn: '2026-09-01', direction: 'up' }),
        exercise({ exerciseId: 'ex-a', exerciseName: 'Arch Hold', lastTrainedOn: '2026-09-01', direction: 'up' }),
      ],
    });
    const first = buildNarrative(input);
    const second = buildNarrative({ ...input, recentExercises: [...input.recentExercises] });
    expect(first).toBe(second);
    expect(first).toContain('Arch Hold');
    expect(first).not.toContain('Zercher Squat');
  });

  it('omits the progress clause entirely when no recently trained exercise trends up', () => {
    const input = baseInput({ recentExercises: [exercise({ direction: 'flat' })] });
    const result = buildNarrative(input);
    expect(result).not.toContain('trending upward');
  });

  it('produces a short, valid, non-throwing sentence for a fully empty input state', () => {
    const input: NarrativeInput = {
      currentStreakWeeks: 0,
      sessionsLast4Weeks: 0,
      sessionsPrior4Weeks: 0,
      adherence: { plannedCount: 0, matchedCount: 0, adherenceRatio: null },
      recentExercises: [],
    };
    let result = '';
    expect(() => {
      result = buildNarrative(input);
    }).not.toThrow();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('0 weeks');
  });

  it('contains no evaluative, prescriptive, or causal vocabulary from the forbidden list, across every case above', () => {
    const cases: NarrativeInput[] = [
      baseInput(),
      baseInput({ adherence: { plannedCount: 0, matchedCount: 0, adherenceRatio: null } }),
      baseInput({ currentStreakWeeks: 0 }),
      baseInput({ sessionsLast4Weeks: 3, sessionsPrior4Weeks: 3 }),
      baseInput({ sessionsLast4Weeks: 0, sessionsPrior4Weeks: 4 }),
      baseInput({ sessionsLast4Weeks: 4, sessionsPrior4Weeks: 0 }),
      baseInput({ recentExercises: [exercise({ direction: 'down' })] }),
      {
        currentStreakWeeks: 0,
        sessionsLast4Weeks: 0,
        sessionsPrior4Weeks: 0,
        adherence: { plannedCount: 0, matchedCount: 0, adherenceRatio: null },
        recentExercises: [],
      },
    ];
    for (const input of cases) {
      assertNoForbiddenVocabulary(buildNarrative(input));
    }
  });
});
