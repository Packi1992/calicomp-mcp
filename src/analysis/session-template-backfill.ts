/**
 * Session-to-template backfill proposal — CAP-08, Richtung B (Phase 138.1, Plan 25).
 *
 * `.planning/todos/pending/manuelles-workout-ohne-vorlagenbezug.md` (Richtung B) asks for
 * a rueckwirkende Zuordnung: a manually-recorded session that never had a `templateId` set
 * (the entire pre-`138.1-02` backlog) can still be attributed to the template it most
 * resembles, using the SAME muscle/capability-content similarity `adherence.ts` already
 * runs against live sessions (D-17, `buildCombinedVector` + `ruzickaSimilarity`,
 * `.planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md`).
 *
 * This module is a PURE, READ-ONLY computation over caller-supplied plain data — it never
 * opens a database connection, never touches the filesystem, never makes an HTTP call, and
 * never mutates any input it is given (verified by this file's own test suite via
 * `Object.freeze` on every input). Loading a device-database copy and the live exercise
 * catalog is the CALLER's job (Task 1's own throwaway driver, never committed to this
 * repo — mirrors the precedent set by `ruzicka-threshold.ts`/`138-14`/`138.1-22`, where the
 * permanent analysis tool stays pure and a temporary script supplies real data).
 *
 * Why the runner-up matters as much as the absolute value (T-138.1-66, the todo file's own
 * warning): a session that scores high against TWO different templates is not more
 * confidently matched than one that scores high against only one — it is exactly the case
 * where a too-generous assignment attaches training to the wrong plan. `matchThreshold`
 * (the absolute floor) and `minMargin` (the gap to the second-best candidate) are therefore
 * two INDEPENDENT gates a candidate must clear, never one standing in for the other:
 *
 *   - `best.similarity < matchThreshold`              -> verdict `'below-threshold'`
 *   - `best.similarity >= matchThreshold` AND
 *     `margin (best - secondBest) < minMargin`         -> verdict `'ambiguous'`
 *   - otherwise                                        -> verdict `'assignable'`
 *
 * The threshold check is evaluated FIRST and independently of the margin — a session whose
 * best value sits below the floor is `'below-threshold'` regardless of how large its margin
 * to the runner-up happens to be (e.g. an empty vector scoring 0 against every template,
 * Edge/Behavior 7 below, where margin is technically 0 but the correct reason to report is
 * the absolute floor, not ambiguity).
 *
 * Vector construction mirrors `ruzicka-threshold.ts`'s `buildLabelledPairs` (WR-01/MUSC-07:
 * a template exercise's true prescribed volume is `sets * (containing block).rounds`, a
 * set-log's exercise resolves via its own `exerciseId` first and its `workoutExerciseId`
 * only as a fallback, and every `deletedAt` is filtered on sessions, set-logs AND
 * template-exercises) — deliberately NOT imported from that file, because
 * `buildLabelledPairs` answers a different question (known-`templateId` ground truth,
 * every session against every template) from the one this file answers (each
 * `templateId`-less session against every LIVE template, ranked). Re-implementing the same
 * three small joins here, rather than distorting `buildLabelledPairs`'s own contract to
 * serve a second caller, keeps both tools' behavior legible on their own terms. This is
 * still exactly ONE similarity MEASURE and ONE vector CONSTRUCTION — `buildCombinedVector`
 * and `ruzickaSimilarity`, imported from `training-state/muscle-similarity.ts`, never
 * reimplemented (T-138.1-55, mirroring T-138-35).
 *
 * Exports:
 *   BackfillSnapshot                    — the narrow input shape (sessions, set-logs,
 *                                          templates, template-exercises, blocks)
 *   TemplateScore                       — one (template, similarity) result
 *   BackfillVerdict                     — 'assignable' | 'below-threshold' | 'ambiguous'
 *   BackfillCandidate                   — one session's full proposal (best, second-best,
 *                                          margin, verdict)
 *   ComputeBackfillCandidatesOptions    — the two independent gates (see above)
 *   computeBackfillCandidates           — snapshot + catalog + options -> one
 *                                          `BackfillCandidate` per eligible session
 *
 * Security (threat model):
 *   T-138.1-66: two independent criteria (threshold AND margin), never one standing in for
 *               the other — see the verdict logic above. A session failing either gate is
 *               reported as not-assignable, never silently upgraded.
 *   T-138.1-55: only `buildCombinedVector`/`ruzickaSimilarity` (imported) compute vectors
 *               and similarity here — no second implementation of either (grep-gated in
 *               the plan's `<verify>`).
 *   T-138.1-59: this module reads and returns only ids, dates and computed numbers — no
 *               exercise names, session content, or user identifiers ever flow through it
 *               beyond what the caller already supplied as ids/names.
 *   T-120-17/T-120-18: no I/O, no console output — a pure, synchronous, exception-free
 *               (for any well-typed input) computation over in-memory data.
 *
 * Patterns: src/analysis/ruzicka-threshold.ts (the file this module deliberately does NOT
 *           import from, and why), src/training-state/muscle-similarity.ts (the imported
 *           functions), 138.1-CONTEXT.md D-18,
 *           .planning/todos/pending/manuelles-workout-ohne-vorlagenbezug.md.
 */

import type { CatalogExercise } from '../types.js';
import { buildCombinedVector, ruzickaSimilarity, type MuscleHit } from '../training-state/muscle-similarity.js';

// ---------------------------------------------------------------------------
// Input shapes — deliberately narrow (only the fields this module reads).
// ---------------------------------------------------------------------------

export interface BackfillSessionInput {
  id: string;
  /** Present and resolvable to a live template = the session already has provenance. */
  templateId?: string;
  deletedAt?: number;
  /** Only manually-recorded sessions are ever eligible for backfill (D-18). */
  isManual: boolean;
}

export interface BackfillSetLogInput {
  sessionId: string;
  exerciseId?: string;
  workoutExerciseId?: string;
  deletedAt?: number;
}

export interface BackfillTemplateInput {
  id: string;
  name: string;
  deletedAt?: number;
}

/** A template's containing block — its `rounds` count multiplies every exercise inside it. */
export interface BackfillBlockInput {
  id: string;
  rounds: number;
  deletedAt?: number;
}

export interface BackfillTemplateExerciseInput {
  id: string;
  templateId: string;
  exerciseId: string;
  sets: number;
  /** The containing block, if any. Absent (or deleted/unknown) -> rounds defaults to 1. */
  blockId?: string;
  deletedAt?: number;
}

export interface BackfillSnapshot {
  sessions: BackfillSessionInput[];
  setLogs: BackfillSetLogInput[];
  templates: BackfillTemplateInput[];
  templateExercises: BackfillTemplateExerciseInput[];
  blocks: BackfillBlockInput[];
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One (template, similarity) result — the "beste"/"zweitbeste Vorlage mit Wert" the plan asks for. */
export interface TemplateScore {
  templateId: string;
  templateName: string;
  similarity: number;
}

/**
 * `'assignable'`      — best clears `matchThreshold` AND the margin to the runner-up clears
 *                        `minMargin` (or there is no runner-up to be ambiguous against).
 * `'below-threshold'` — best does not clear `matchThreshold` (checked first, independently
 *                        of the margin).
 * `'ambiguous'`        — best clears `matchThreshold` but the margin to the runner-up does
 *                        not clear `minMargin` — two templates fit almost equally well.
 */
export type BackfillVerdict = 'assignable' | 'below-threshold' | 'ambiguous';

export interface BackfillCandidate {
  sessionId: string;
  /** Undefined only when there is no live template at all to compare against. */
  best?: TemplateScore;
  /** Undefined when fewer than two live templates exist (no runner-up possible). */
  secondBest?: TemplateScore;
  /** `best.similarity - secondBest.similarity`. Undefined whenever `secondBest` is. */
  margin?: number;
  verdict: BackfillVerdict;
}

export interface ComputeBackfillCandidatesOptions {
  /** Ruzicka similarity at/above which a candidate clears the absolute floor. */
  matchThreshold: number;
  /** Minimum required gap between `best` and `secondBest` for a non-ambiguous verdict. */
  minMargin: number;
}

// ---------------------------------------------------------------------------
// computeBackfillCandidates
// ---------------------------------------------------------------------------

/**
 * Computes, for every LIVE manually-recorded session without a resolvable `templateId`
 * (D-18's Richtung B backlog), its best- and second-best-matching live template under the
 * SAME similarity measure production uses (`buildCombinedVector` + `ruzickaSimilarity`).
 *
 * Never mutates `snapshot` or `catalog` — every intermediate structure is a newly
 * constructed `Map`/array; no input array or object is ever assigned into or pushed onto.
 */
export function computeBackfillCandidates(
  snapshot: BackfillSnapshot,
  catalog: CatalogExercise[],
  options: ComputeBackfillCandidatesOptions,
): BackfillCandidate[] {
  const catalogById = new Map(catalog.map((ex) => [ex.id, ex]));

  const liveTemplates = snapshot.templates.filter((t) => t.deletedAt === undefined);
  const liveTemplateIds = new Set(liveTemplates.map((t) => t.id));
  const templateNameById = new Map(liveTemplates.map((t) => [t.id, t.name]));

  // WR-01/MUSC-07 (mirrors ruzicka-threshold.ts): a template exercise's true prescribed
  // volume is sets * (containing block).rounds. A missing, deleted, or unknown block falls
  // back to 1 (no multiplier).
  const blockById = new Map(snapshot.blocks.map((b) => [b.id, b]));
  function roundsFor(te: BackfillTemplateExerciseInput): number {
    if (te.blockId === undefined) return 1;
    const block = blockById.get(te.blockId);
    if (block === undefined || block.deletedAt !== undefined) return 1;
    return block.rounds;
  }

  const templateExercisesByTemplateId = new Map<string, { exerciseId: string; sets: number }[]>();
  for (const te of snapshot.templateExercises) {
    if (te.deletedAt !== undefined) continue;
    if (!liveTemplateIds.has(te.templateId)) continue;
    const list = templateExercisesByTemplateId.get(te.templateId) ?? [];
    list.push({ exerciseId: te.exerciseId, sets: te.sets * roundsFor(te) });
    templateExercisesByTemplateId.set(te.templateId, list);
  }

  const templateVectorCache = new Map<string, Map<string, number>>();
  function templateVectorFor(templateId: string): Map<string, number> {
    const cached = templateVectorCache.get(templateId);
    if (cached) return cached;
    const hits: MuscleHit[] = (templateExercisesByTemplateId.get(templateId) ?? []).map((te) => ({
      exerciseId: te.exerciseId,
      setCount: te.sets,
    }));
    const vector = buildCombinedVector(hits, catalogById);
    templateVectorCache.set(templateId, vector);
    return vector;
  }

  const liveTemplateExerciseById = new Map(
    snapshot.templateExercises.filter((te) => te.deletedAt === undefined).map((te) => [te.id, te]),
  );

  const setLogsBySessionId = new Map<string, BackfillSetLogInput[]>();
  for (const setLog of snapshot.setLogs) {
    if (setLog.deletedAt !== undefined) continue;
    const list = setLogsBySessionId.get(setLog.sessionId) ?? [];
    list.push(setLog);
    setLogsBySessionId.set(setLog.sessionId, list);
  }

  function sessionVectorFor(sessionId: string): Map<string, number> {
    const hits: MuscleHit[] = [];
    for (const setLog of setLogsBySessionId.get(sessionId) ?? []) {
      const exerciseId =
        setLog.exerciseId ??
        (setLog.workoutExerciseId !== undefined
          ? liveTemplateExerciseById.get(setLog.workoutExerciseId)?.exerciseId
          : undefined);
      if (exerciseId === undefined) continue;
      hits.push({ exerciseId, setCount: 1 });
    }
    return buildCombinedVector(hits, catalogById);
  }

  const liveTemplateIdList = [...liveTemplateIds];

  // D-18: only manually-recorded, live sessions with NO resolvable templateId are eligible.
  // A session that already carries provenance (even an unresolvable one, since that is a
  // pre-existing data-integrity question outside this plan's scope, not a backfill target)
  // never appears in the result.
  const eligibleSessions = snapshot.sessions.filter(
    (s) => s.deletedAt === undefined && s.isManual && s.templateId === undefined,
  );

  const candidates: BackfillCandidate[] = [];
  for (const session of eligibleSessions) {
    const sessionVector = sessionVectorFor(session.id);
    const scores: TemplateScore[] = liveTemplateIdList
      .map((templateId) => ({
        templateId,
        templateName: templateNameById.get(templateId) ?? templateId,
        similarity: ruzickaSimilarity(sessionVector, templateVectorFor(templateId)),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const best = scores[0];
    const secondBest = scores[1];
    const margin =
      best !== undefined && secondBest !== undefined ? best.similarity - secondBest.similarity : undefined;

    let verdict: BackfillVerdict;
    if (best === undefined || best.similarity < options.matchThreshold) {
      verdict = 'below-threshold';
    } else if (margin !== undefined && margin < options.minMargin) {
      verdict = 'ambiguous';
    } else {
      verdict = 'assignable';
    }

    candidates.push({ sessionId: session.id, best, secondBest, margin, verdict });
  }

  return candidates;
}
