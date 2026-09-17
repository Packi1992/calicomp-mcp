/**
 * The `get_training_state` overview's summary sentence — a deterministic text template
 * over numbers the caller has ALREADY computed (Phase 137, D-18, STATE-02/03/05).
 *
 * D-18 is explicit about what this module must never be: a second LLM call. A
 * server-side summarizer would be non-deterministic, untestable, and a second
 * hallucination surface in a tool whose entire value is its reliability. `buildNarrative`
 * is therefore plain string assembly over pre-computed values — no model call, no
 * network, no randomness, no clock read of its own.
 *
 * `NarrativeInput` deliberately carries NO snapshot and NO catalog — only the numbers
 * `get_training_state.ts` has already produced (consistency, the adherence short form,
 * a narrow list of recently trained exercises with their direction label). What this
 * function cannot see, it cannot claim; it summarizes, it never interprets. There is no
 * evaluative language anywhere in this file — no "good"/"bad", no "should", no causal
 * attribution. The coach gets a hook to start a conversation, not a verdict.
 *
 * Every sentence has a defined null case that NAMES the absence instead of omitting the
 * fact silently (a zero-week streak is stated, not skipped; a fully-unplanned window is
 * stated, not left out; an empty training history still yields a short, valid sentence,
 * never an empty string and never a thrown error).
 *
 * Exports:
 *   NarrativeInput      — the pre-computed values this module is allowed to see
 *   buildNarrative      — assembles the one-to-two-sentence summary, deterministically
 *
 * Security (threat model):
 *   T-137-36 (Repudiation): the summary sentence claims more than the numbers support.
 *             Mitigated by the snapshot-less input type (nothing to over-claim FROM),
 *             a synchronous/no-randomness/no-clock implementation (a grep gate in the
 *             plan's own `<verify>` proves the absence of `fetch`/`await`/`Math.random`/
 *             `Date.now`), and a test asserting the same input always yields the exact
 *             same string.
 *
 * Patterns: src/training-state/exercise-progress.ts (DIRECTION_RULE — a rule string
 *           travels with a label rather than standing for a verdict; this module's
 *           narrative never repeats a direction claim beyond the label it was handed).
 */

import type { DirectionLabel } from './exercise-progress.js';

// ---------------------------------------------------------------------------
// Types — pre-computed values only, no snapshot, no catalog
// ---------------------------------------------------------------------------

/** One recently trained exercise, narrowed to exactly what the narrative may reference. */
export interface NarrativeRecentExercise {
  exerciseId: string;
  exerciseName: string | null;
  /** The calendar day (YYYY-MM-DD) of the exercise's most recent session — used only to pick a deterministic exercise when several qualify, never rendered as its own clause. */
  lastTrainedOn: string;
  /** The best-set direction outcome's label (D-12) — the narrative names it, never re-derives it. */
  direction: DirectionLabel;
}

/** The adherence short form the narrative may reference — the same three fields `get_training_state` already carries, nothing more. */
export interface NarrativeAdherence {
  plannedCount: number;
  matchedCount: number;
  adherenceRatio: number | null;
}

/**
 * Everything `buildNarrative` is allowed to see — ALREADY COMPUTED values, never a
 * snapshot or a catalog. If a fact is not in this shape, the sentence cannot claim it.
 */
export interface NarrativeInput {
  currentStreakWeeks: number;
  sessionsLast4Weeks: number;
  sessionsPrior4Weeks: number;
  adherence: NarrativeAdherence;
  recentExercises: NarrativeRecentExercise[];
}

// ---------------------------------------------------------------------------
// Sentence builders — each has a defined null case that names the absence
// ---------------------------------------------------------------------------

function streakClause(currentStreakWeeks: number): string {
  if (currentStreakWeeks === 0) {
    return 'The current training streak is 0 weeks.';
  }
  const weekWord = currentStreakWeeks === 1 ? 'week' : 'weeks';
  return `The current training streak is ${currentStreakWeeks} ${weekWord}.`;
}

/**
 * Compares the last 4 weeks against the prior 4 weeks. Equality (including the
 * both-zero case) is named directly rather than computed as a 0% change; a percentage
 * is only ever computed when the divisor (`sessionsPrior4Weeks`) is nonzero — this
 * never divides by zero and never fabricates a percentage for an undefined baseline.
 */
function frequencyClause(sessionsLast4Weeks: number, sessionsPrior4Weeks: number): string {
  if (sessionsLast4Weeks === sessionsPrior4Weeks) {
    return `Training frequency is unchanged: ${sessionsLast4Weeks} sessions in each of the last two 4-week windows.`;
  }
  if (sessionsPrior4Weeks === 0) {
    return (
      `${sessionsLast4Weeks} session(s) were logged in the last 4 weeks, versus none in the ` +
      'previous 4-week window.'
    );
  }
  if (sessionsLast4Weeks === 0) {
    return `No sessions were logged in the last 4 weeks, versus ${sessionsPrior4Weeks} in the previous 4-week window.`;
  }
  const relativePercent = Math.round(((sessionsLast4Weeks - sessionsPrior4Weeks) / sessionsPrior4Weeks) * 100);
  const signedPercent = relativePercent >= 0 ? `+${relativePercent}` : `${relativePercent}`;
  return (
    `${sessionsLast4Weeks} sessions were logged in the last 4 weeks versus ${sessionsPrior4Weeks} in the ` +
    `previous 4-week window (${signedPercent}%).`
  );
}

/**
 * `adherenceRatio: null` means "nothing was planned in the window" (see
 * `ADHERENCE_EXPLANATION` in `adherence.ts`) — that absence is named directly rather than
 * silently dropping the adherence clause from the sentence.
 */
function adherenceClause(adherence: NarrativeAdherence): string {
  if (adherence.adherenceRatio === null) {
    return 'Nothing was scheduled in the adherence window, so no adherence percentage applies.';
  }
  const percent = Math.round(adherence.adherenceRatio * 100);
  return (
    `Adherence over the window is ${percent}% ` +
    `(${adherence.matchedCount} of ${adherence.plannedCount} planned sessions matched).`
  );
}

/**
 * Names ONE recently trained exercise whose direction label is `up`, if any exist — never
 * a verdict on the athlete's training, just a pointer at a series someone might want to
 * look at via `get_progress`. When several qualify, the choice is deterministic: the one
 * with the most recent `lastTrainedOn`, tied broken by `exerciseId` ascending. Returns
 * `null` (no clause) when nothing qualifies — the plan does not require this absence to
 * be named, unlike the streak/adherence clauses above.
 */
function progressClause(recentExercises: NarrativeRecentExercise[]): string | null {
  const trendingUp = recentExercises.filter((e) => e.direction === 'up');
  if (trendingUp.length === 0) return null;

  trendingUp.sort((a, b) => {
    if (a.lastTrainedOn !== b.lastTrainedOn) return a.lastTrainedOn < b.lastTrainedOn ? 1 : -1;
    return a.exerciseId.localeCompare(b.exerciseId);
  });
  const chosen = trendingUp[0];
  const name = chosen.exerciseName ?? chosen.exerciseId;
  return `${name} is trending upward across recent sessions.`;
}

// ---------------------------------------------------------------------------
// buildNarrative — synchronous, deterministic, no I/O, no randomness, no clock
// ---------------------------------------------------------------------------

/**
 * Assembles the one-to-two-sentence overview narrative from values the caller has
 * already computed. Synchronous, deterministic, no network call, no random source, no
 * time source of its own (`nowMs` never appears in this file) — the same input ALWAYS
 * produces the exact same string.
 *
 * The sentence summarizes; it never evaluates, recommends, or attributes a cause. No
 * clause in this file contains an evaluative word ("good"/"bad"/"should"/etc.) — the
 * calling test enforces this with a named forbidden-vocabulary list.
 */
export function buildNarrative(input: NarrativeInput): string {
  const clauses = [
    streakClause(input.currentStreakWeeks),
    frequencyClause(input.sessionsLast4Weeks, input.sessionsPrior4Weeks),
    adherenceClause(input.adherence),
  ];
  const progress = progressClause(input.recentExercises);
  if (progress !== null) clauses.push(progress);
  return clauses.join(' ');
}
