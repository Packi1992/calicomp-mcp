/**
 * Tests for the session-to-template backfill proposal tool (Phase 138.1, Plan 25, CAP-08,
 * Richtung B). Exclusively synthetic fixtures — this file never touches real training data.
 * The real production run (device-database copy + live catalog) happens in a throwaway
 * driver script outside this repo's test suite; see 138.1-BACKFILL-LOG.md for how it was
 * produced and what it found.
 *
 * The seven cases below are the seven `<behavior>` bullets from 138.1-25-PLAN.md, one test
 * per bullet, in the same order.
 */

import { describe, it, expect } from 'vitest';
import {
  computeBackfillCandidates,
  type BackfillSnapshot,
  type ComputeBackfillCandidatesOptions,
} from '../../src/analysis/session-template-backfill.js';
import type { CatalogExercise } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared synthetic catalog — three single-muscle exercises (all PRIMARY, so the
// weighting factor is always 1.0 and vector arithmetic stays easy to hand-check),
// plus one exercise with neither a muscle-group nor a capability-axis link at all.
// ---------------------------------------------------------------------------

function catalogExercise(id: string, muscleKey?: string): CatalogExercise {
  return {
    id,
    key: id,
    nameEn: id,
    mode: 'REPS',
    usesWeight: false,
    lastModifiedAt: 0,
    translations: [],
    equipment: [],
    muscleGroups: muscleKey
      ? [{ id: `mg-${muscleKey}`, key: muscleKey, translations: [], involvementLevel: 'PRIMARY' }]
      : [],
    capabilities: [],
    origin: 'CATALOG',
  };
}

const EX_A = catalogExercise('ex-A', 'm1');
const EX_B = catalogExercise('ex-B', 'm2');
const EX_C = catalogExercise('ex-C', 'm3');
const EX_EMPTY = catalogExercise('ex-empty'); // no muscle group, no capability axis
const catalog: CatalogExercise[] = [EX_A, EX_B, EX_C, EX_EMPTY];

/** Three live templates, each a pure single-muscle template built from one of ex-A/B/C. */
function threeTemplatesBase() {
  return {
    templates: [
      { id: 'template-X', name: 'Template X' },
      { id: 'template-Y', name: 'Template Y' },
      { id: 'template-Z', name: 'Template Z' },
    ],
    blocks: [],
    templateExercises: [
      { id: 'te-X', templateId: 'template-X', exerciseId: 'ex-A', sets: 3 },
      { id: 'te-Y', templateId: 'template-Y', exerciseId: 'ex-B', sets: 3 },
      { id: 'te-Z', templateId: 'template-Z', exerciseId: 'ex-C', sets: 3 },
    ],
  };
}

const DEFAULT_OPTIONS: ComputeBackfillCandidatesOptions = { matchThreshold: 0.5, minMargin: 0.1 };

/** Recursively freezes an object graph so any attempted in-place mutation throws (strict mode). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('computeBackfillCandidates', () => {
  // Behavior 1: "Das Werkzeug liest ausschliesslich; es oeffnet die Kopie schreibgeschuetzt
  // und veraendert sie nicht."
  it('reads the snapshot and catalog read-only — never mutates either input', () => {
    const snapshot: BackfillSnapshot = deepFreeze(
      structuredClone({
        ...threeTemplatesBase(),
        sessions: [{ id: 'session-1', isManual: true }],
        setLogs: [
          { sessionId: 'session-1', exerciseId: 'ex-A' },
          { sessionId: 'session-1', exerciseId: 'ex-A' },
          { sessionId: 'session-1', exerciseId: 'ex-A' },
        ],
      }),
    );
    const frozenCatalog = deepFreeze(structuredClone(catalog));

    expect(() => computeBackfillCandidates(snapshot, frozenCatalog, DEFAULT_OPTIONS)).not.toThrow();
  });

  // Behavior 2: "Es findet genau die Sitzungen, die manuell erfasst wurden und keine
  // Vorlagen-Herkunft tragen."
  it('finds exactly the manually-recorded sessions without template provenance', () => {
    const snapshot: BackfillSnapshot = {
      ...threeTemplatesBase(),
      sessions: [
        { id: 'session-manual-no-template', isManual: true },
        { id: 'session-auto-no-template', isManual: false },
      ],
      setLogs: [
        { sessionId: 'session-manual-no-template', exerciseId: 'ex-A' },
        { sessionId: 'session-auto-no-template', exerciseId: 'ex-A' },
      ],
    };

    const result = computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS);

    expect(result.map((r) => r.sessionId)).toEqual(['session-manual-no-template']);
  });

  // Behavior 3: "Fuer jede solche Sitzung liefert es die beste und die zweitbeste Vorlage
  // mit je ihrem Aehnlichkeitswert."
  it('returns the best and second-best template with their similarity values', () => {
    const snapshot: BackfillSnapshot = {
      ...threeTemplatesBase(),
      sessions: [{ id: 'session-1', isManual: true }],
      setLogs: [
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
      ],
    };

    const [candidate] = computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS);

    expect(candidate.best?.templateId).toBe('template-X');
    expect(candidate.best?.similarity).toBeCloseTo(0.75, 5); // {m1:3,m2:1} vs {m1:3}: 3/4
    expect(candidate.secondBest?.templateId).toBe('template-Y');
    expect(candidate.secondBest?.similarity).toBeCloseTo(1 / 6, 5); // {m1:3,m2:1} vs {m2:3}: 1/6
    expect(candidate.margin).toBeCloseTo(0.75 - 1 / 6, 5);
  });

  // Behavior 4: "Eine Sitzung, deren bester Wert unter der geltenden Schwelle liegt, wird
  // als nicht zuordenbar ausgewiesen statt der besten Vorlage zugeschlagen."
  it('marks a session below the match threshold as not assignable', () => {
    const snapshot: BackfillSnapshot = {
      ...threeTemplatesBase(),
      sessions: [{ id: 'session-1', isManual: true }],
      setLogs: [{ sessionId: 'session-1', exerciseId: 'ex-A' }], // single set -> weak overlap everywhere
    };

    const [candidate] = computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS);

    expect(candidate.best?.similarity).toBeLessThan(DEFAULT_OPTIONS.matchThreshold);
    expect(candidate.verdict).toBe('below-threshold');
  });

  // Behavior 5: "Eine Sitzung, deren bester und zweitbester Wert dicht beieinanderliegen,
  // wird als mehrdeutig ausgewiesen, auch wenn der beste Wert ueber der Schwelle liegt."
  it('marks a session ambiguous when best and second-best lie too close together, even above threshold', () => {
    const snapshot: BackfillSnapshot = {
      templates: [
        { id: 'template-X', name: 'Template X' },
        { id: 'template-Y', name: 'Template Y (identical composition)' },
      ],
      blocks: [],
      templateExercises: [
        { id: 'te-X1', templateId: 'template-X', exerciseId: 'ex-A', sets: 3 },
        { id: 'te-X2', templateId: 'template-X', exerciseId: 'ex-B', sets: 3 },
        { id: 'te-Y1', templateId: 'template-Y', exerciseId: 'ex-A', sets: 3 },
        { id: 'te-Y2', templateId: 'template-Y', exerciseId: 'ex-B', sets: 3 },
      ],
      sessions: [{ id: 'session-1', isManual: true }],
      setLogs: [
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-A' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
        { sessionId: 'session-1', exerciseId: 'ex-B' },
      ],
    };

    const [candidate] = computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS);

    expect(candidate.best?.similarity).toBeCloseTo(1, 5);
    expect(candidate.best?.similarity).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.matchThreshold);
    expect(candidate.margin).toBeLessThan(DEFAULT_OPTIONS.minMargin);
    expect(candidate.verdict).toBe('ambiguous');
  });

  // Behavior 6: "Eine Sitzung, die bereits eine Vorlagen-Herkunft traegt, taucht im
  // Vorschlag nicht auf."
  it('excludes a session that already carries a template provenance, even if manually recorded', () => {
    const snapshot: BackfillSnapshot = {
      ...threeTemplatesBase(),
      sessions: [{ id: 'session-1', isManual: true, templateId: 'template-X' }],
      setLogs: [{ sessionId: 'session-1', exerciseId: 'ex-A' }],
    };

    const result = computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS);

    expect(result).toHaveLength(0);
  });

  // Behavior 7: "Eine Sitzung ohne jede Uebung mit Muskel- oder Faehigkeitszuordnung ergibt
  // keinen Fehler und wird als nicht zuordenbar ausgewiesen."
  it('produces no error and marks not-assignable for a session with no muscle- or capability-linked exercise', () => {
    const snapshot: BackfillSnapshot = {
      ...threeTemplatesBase(),
      sessions: [{ id: 'session-1', isManual: true }],
      setLogs: [
        { sessionId: 'session-1', exerciseId: 'ex-empty' },
        { sessionId: 'session-1', exerciseId: 'ex-empty' },
      ],
    };

    expect(() => computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS)).not.toThrow();
    const [candidate] = computeBackfillCandidates(snapshot, catalog, DEFAULT_OPTIONS);
    expect(candidate.verdict).toBe('below-threshold');
  });
});
