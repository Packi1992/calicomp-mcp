/**
 * Coach parameters — the seven training-state calculators' shared tuning surface
 * (Phase 137, D-06/D-09/D-13/D-21/D-23, STATE-06).
 *
 * D-09 makes self-description a REQUIREMENT, not a convenience: "there should be
 * default values, and the MCP has to be able to tell the agent what is possible."
 * This module is the single definition site for the seven parameters — defaults,
 * ranges, a strict Zod schema that rejects rather than silently corrects an
 * out-of-range value, and the machine-readable self-description `get_coach_parameters`
 * (Task 3) reads.
 *
 * IMPORTANT — gemischter Kalibrierungsstand: fuenf der sieben Zahlen unten
 * (toleranceDays, adherenceWindowWeeks, consistencyWindowWeeks, exerciseTrendPoints,
 * recentExerciseCount — Defaults UND Bereiche) sind weiterhin unkalibrierte
 * Startwerte aus 137-RESEARCH.md's Assumptions-Log (A3, A4, A5, A6, A8), keine
 * gemessenen Groessen. `matchThreshold`/`uncertainThreshold` sind seit Plan 138.1-22
 * (D-17) gegen den KOMBINIERTEN Vektor (Muskelgruppen PLUS Faehigkeitsachsen,
 * `buildCombinedVector`) HERGELEITET — die Faehigkeitsachsen ruecken die
 * Positiv-/Negativ-Verteilung in derselben Herleitung konsistent weiter auseinander
 * als der reine Muskelvektor, siehe
 * `.planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md` fuer
 * Datenbasis (134 positive / 4020 negative Paare), Methode und den
 * Plausibilitaetstest (1.0 in beiden Laeufen). Die Plan-138-15-Werte (0.537/0.529,
 * am reinen Muskelvektor kalibriert) sind damit VERALTET — eine alte Schwelle an
 * einem neuen Vektor waere schlimmer als keine Herleitung (D-17, woertlich). Wer die
 * fuenf
 * unkalibrierten Werte aendert, aendert keine Messung, sondern eine Auslegung — sie
 * sind als Coach-Parameter genau deshalb zur Laufzeit einstellbar (D-23). Dasselbe
 * gilt fuer die beiden hergeleiteten Schwellen: die Herleitung liefert einen
 * begruendeten Startwert, keine unveraenderliche Konstante — auch sie bleiben zur
 * Laufzeit einstellbar und werden mit wachsender Trainingshistorie erneut hergeleitet
 * (`src/analysis/ruzicka-threshold.ts`, das Werkzeug selbst; siehe dort fuer das
 * Wiederholungs-Rezept — `docs/RUZICKA-THRESHOLDS.md` beschreibt nur noch den
 * historischen, seit 138.1-22 ueberholten Lauf gegen den reinen Muskelvektor).
 *
 * Exports:
 *   CoachParameters               — the seven-field shape
 *   COACH_PARAMETER_DEFAULTS      — the seven default values
 *   COACH_PARAMETER_RANGES        — min/max/integer/description per key (D-09's
 *                                   machine-readable basis)
 *   CoachParametersSchema         — strict Zod schema, validated against the
 *                                   defaults (the static instance index.ts registers)
 *   coachParametersSchemaFor      — factory: the same strict schema, its threshold
 *                                   invariant resolved against a real current state
 *   mergeCoachParameters          — layer a partial update over the defaults
 *   describeCoachParameters       — the D-09 self-description: value + default +
 *                                   range + description per key
 *   loadCoachParameters           — fetch-or-default (never throws on a network
 *                                   failure; the fallback source is visible, T-137-20)
 *
 * Security (threat model):
 *   T-120-10/T-120-11: every one of the seven parameters carries a real range
 *             check; an out-of-range value is rejected, never silently clamped
 *             to a default.
 *   T-120-17: `loadCoachParameters` never throws its underlying network error
 *             into a caller-visible message — no PAT or key can leak through it.
 *   T-120-18: no `console.*` call anywhere in this module.
 */

import { z } from 'zod';
import { fetchCoachParameters } from './http.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The seven coach-tunable parameters (D-23, protocol §5.5). */
export interface CoachParameters {
  /** Calendar-day slack for "trained on the planned day" matching (D-06). Read by the adherence calculator. */
  toleranceDays: number;
  /** Rolling window (weeks) the adherence calculator scores against. */
  adherenceWindowWeeks: number;
  /** Rolling window (weeks) the training-consistency/streak calculator considers. */
  consistencyWindowWeeks: number;
  /** How many recent data points the per-exercise trend calculator returns (D-13). */
  exerciseTrendPoints: number;
  /** How many recent sessions the "recent exercises" overview lists. */
  recentExerciseCount: number;
  /** Ruzicka similarity at/above which an unmatched session counts as `matched` (D-21). */
  matchThreshold: number;
  /** Ruzicka similarity at/above which an unmatched session counts as `uncertain` (D-21). Must stay strictly below `matchThreshold`. */
  uncertainThreshold: number;
}

/**
 * toleranceDays/adherenceWindowWeeks/consistencyWindowWeeks/exerciseTrendPoints/
 * recentExerciseCount are unkalibrierte Startwerte — siehe Doku-Kopf. RESEARCH.md
 * Assumptions-Log A3–A6, A8.
 *
 * matchThreshold/uncertainThreshold (Plan 138.1-22, D-17): hergeleitet gegen 134
 * positive / 4020 negative (Session, Vorlage)-Paare aus echten Produktivdaten,
 * gegen den KOMBINIERTEN Vektor (`buildCombinedVector`, Muskelgruppen PLUS
 * Faehigkeitsachsen) — der Plausibilitaetstest (dieselbe unveraendert uebernommene
 * "A - KB Kraft"-Session wie in Plan 138-15) liegt exakt bei 1.0. Ersetzt die
 * Plan-138-15-Werte (0.537/0.529), die am reinen Muskelvektor kalibriert waren und
 * mit dem Umstieg auf `buildCombinedVector` (`adherence.ts`, D-17) veraltet sind.
 * Volle Herleitung, beide Verteilungen und die Begruendung der Aufnahme:
 * `.planning/phases/138.1-faehigkeiten-neben-muskeln/138.1-VECTOR-DERIVATION.md`.
 */
export const COACH_PARAMETER_DEFAULTS: CoachParameters = {
  toleranceDays: 1,
  adherenceWindowWeeks: 4,
  consistencyWindowWeeks: 12,
  exerciseTrendPoints: 10,
  recentExerciseCount: 5,
  matchThreshold: 0.542,
  uncertainThreshold: 0.454,
};

/** Per-key range metadata — the machine-readable basis of the D-09 self-description. */
export const COACH_PARAMETER_RANGES: Record<
  keyof CoachParameters,
  { min: number; max: number; integer: boolean; description: string }
> = {
  toleranceDays: {
    min: 0,
    max: 7,
    integer: true,
    description: 'Calendar-day slack for counting a session as matching its planned day.',
  },
  adherenceWindowWeeks: {
    min: 1,
    max: 52,
    integer: true,
    description: 'Rolling window, in weeks, the adherence calculator scores against.',
  },
  consistencyWindowWeeks: {
    min: 4,
    max: 52,
    integer: true,
    description: 'Rolling window, in weeks, the training-consistency calculator considers.',
  },
  exerciseTrendPoints: {
    min: 3,
    max: 30,
    integer: true,
    description: 'How many recent data points a per-exercise trend series returns.',
  },
  recentExerciseCount: {
    min: 1,
    max: 20,
    integer: true,
    description: 'How many recent sessions the "recent exercises" overview lists.',
  },
  matchThreshold: {
    min: 0.0,
    max: 1.0,
    integer: false,
    description: 'Ruzicka similarity at/above which an unplanned session counts as a matched candidate.',
  },
  uncertainThreshold: {
    min: 0.0,
    max: 1.0,
    integer: false,
    description:
      'Ruzicka similarity at/above which an unplanned session counts as an uncertain candidate. Must stay strictly below matchThreshold.',
  },
};

// ---------------------------------------------------------------------------
// Zod schema — strict, rejects rather than silently corrects
// ---------------------------------------------------------------------------

/**
 * The strict object shape, WITHOUT the threshold invariant — every field optional
 * (nothing set is a legal call), `.strict()` so an unknown key is rejected rather
 * than dropped (T-120-10). Range checks come straight from `COACH_PARAMETER_RANGES`
 * so the two never drift apart.
 */
function baseCoachParametersObject() {
  const r = COACH_PARAMETER_RANGES;
  return z
    .object({
      toleranceDays: z.number().int().min(r.toleranceDays.min).max(r.toleranceDays.max).optional(),
      adherenceWindowWeeks: z
        .number()
        .int()
        .min(r.adherenceWindowWeeks.min)
        .max(r.adherenceWindowWeeks.max)
        .optional(),
      consistencyWindowWeeks: z
        .number()
        .int()
        .min(r.consistencyWindowWeeks.min)
        .max(r.consistencyWindowWeeks.max)
        .optional(),
      exerciseTrendPoints: z
        .number()
        .int()
        .min(r.exerciseTrendPoints.min)
        .max(r.exerciseTrendPoints.max)
        .optional(),
      recentExerciseCount: z
        .number()
        .int()
        .min(r.recentExerciseCount.min)
        .max(r.recentExerciseCount.max)
        .optional(),
      matchThreshold: z.number().min(r.matchThreshold.min).max(r.matchThreshold.max).optional(),
      uncertainThreshold: z.number().min(r.uncertainThreshold.min).max(r.uncertainThreshold.max).optional(),
    })
    .strict();
}

/**
 * The strict coach-parameters schema, its threshold invariant (`uncertainThreshold`
 * strictly less than `matchThreshold`) resolved against `current` rather than the
 * defaults — a partial update that sets only one of the two thresholds must be
 * checked against the OTHER threshold's real, currently-effective value, not its
 * default (Task 1 behavior: setting only `uncertainThreshold` against a real
 * `matchThreshold` of 0.5 rejects `0.9` even though the default `matchThreshold`
 * is also 0.5 — the two only coincide by accident here).
 */
export function coachParametersSchemaFor(current: CoachParameters) {
  return baseCoachParametersObject().refine(
    (data) => {
      const effectiveMatch = data.matchThreshold ?? current.matchThreshold;
      const effectiveUncertain = data.uncertainThreshold ?? current.uncertainThreshold;
      return effectiveUncertain < effectiveMatch;
    },
    { message: 'uncertainThreshold must be strictly less than matchThreshold' },
  );
}

/**
 * The static schema instance registered as the tool's `inputSchema` — its
 * invariant resolved against `COACH_PARAMETER_DEFAULTS`. `set_coach_parameters`
 * (Task 3) additionally validates every call a SECOND time via
 * `coachParametersSchemaFor(current)` against the real, currently-effective
 * state — this static instance exists so the schema is inspectable/readable by
 * the calling agent before any network round-trip (see the doc-comment on
 * `set_coach_parameters.ts` for why both checks are intentional, not redundant).
 */
export const CoachParametersSchema = coachParametersSchemaFor(COACH_PARAMETER_DEFAULTS);

// ---------------------------------------------------------------------------
// Merge + self-description
// ---------------------------------------------------------------------------

/** Layer a partial update (or `null`, meaning "nothing stored yet") over the seven defaults. */
export function mergeCoachParameters(partial: Partial<CoachParameters> | null): CoachParameters {
  if (partial === null) return { ...COACH_PARAMETER_DEFAULTS };
  return { ...COACH_PARAMETER_DEFAULTS, ...partial };
}

/** Per-key self-description entry (D-09) — the shape `get_coach_parameters` returns for each of the seven keys. */
export interface CoachParameterDescriptionEntry {
  value: number;
  default: number;
  min: number;
  max: number;
  integer: boolean;
  description: string;
}

/** The full D-09 self-description result: every key's current/default/range/description, plus provenance. */
export interface CoachParametersDescription {
  params: Record<keyof CoachParameters, CoachParameterDescriptionEntry>;
  source: 'server' | 'defaults';
  note: string;
}

const UNCALIBRATED_NOTE =
  'These seven starting values are uncalibrated defaults, not measured quantities. Consider setting ' +
  'them deliberately after an initial conversation with the athlete about their training rhythm and ' +
  'how strict a session-to-plan match should be.';

/** Build the D-09 self-description for the current parameter state. */
export function describeCoachParameters(
  current: CoachParameters,
  source: 'server' | 'defaults',
): CoachParametersDescription {
  const params = {} as Record<keyof CoachParameters, CoachParameterDescriptionEntry>;
  for (const key of Object.keys(COACH_PARAMETER_DEFAULTS) as (keyof CoachParameters)[]) {
    const range = COACH_PARAMETER_RANGES[key];
    params[key] = {
      value: current[key],
      default: COACH_PARAMETER_DEFAULTS[key],
      min: range.min,
      max: range.max,
      integer: range.integer,
      description: range.description,
    };
  }
  return { params, source, note: UNCALIBRATED_NOTE };
}

// ---------------------------------------------------------------------------
// Load — fetch-or-default, visible fallback (T-137-20)
// ---------------------------------------------------------------------------

/**
 * Load the calling PAT's coach parameters, merged over the defaults.
 *
 * A network failure or a `null` response (no row stored yet) falls back to
 * `{ params: COACH_PARAMETER_DEFAULTS, source: 'defaults' }` — the failure is
 * never swallowed silently, it is visible as `source`. No `console.*` call.
 */
export async function loadCoachParameters(cfg: {
  pat: string;
  serverUrl: string;
}): Promise<{ params: CoachParameters; source: 'server' | 'defaults' }> {
  try {
    const fetched = await fetchCoachParameters(cfg);
    if (fetched === null) {
      return { params: { ...COACH_PARAMETER_DEFAULTS }, source: 'defaults' };
    }
    return { params: mergeCoachParameters(fetched.params), source: 'server' };
  } catch {
    return { params: { ...COACH_PARAMETER_DEFAULTS }, source: 'defaults' };
  }
}
