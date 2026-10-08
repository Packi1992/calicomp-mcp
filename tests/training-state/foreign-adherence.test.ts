/**
 * Tests for src/training-state/foreign-adherence.ts (Phase 155, FA-06, D-09 … D-16).
 *
 * The day rule itself is pinned by the corpus replay (`tests/shared-vectors.test.ts`,
 * section `foreignFulfilment`); this file covers what the corpus deliberately leaves out:
 * the expansion of real roots (series, cancelled dates), the window, the athlete's "today"
 * through the time zone, the resolved type fields of `byType[]`, and the verbatim
 * explanation against the protocol text.
 */

import { describe, it, expect } from 'vitest';
import {
  computeForeignAdherence,
  FOREIGN_ADHERENCE_EXPLANATION,
  type ForeignAdherenceAvailable,
} from '../../src/training-state/foreign-adherence.js';
import { getAdherence } from '../../src/tools/get_adherence.js';
import { COACH_PARAMETER_DEFAULTS } from '../../src/coach-parameters.js';
import { TRAINING_TIMEZONE_SETTING_KEY } from '../../src/training-state/time-zone.js';
import { mockSnapshot, mockCatalog } from '../fixture.js';
import { protocolExplanation } from '../protocol-text.js';
import type {
  DecryptedSnapshot,
  DecryptedPlannedForeignActivity,
  DecryptedForeignActivity,
  DecryptedForeignActivityType,
} from '../../src/types.js';

const TZ = 'Europe/Berlin';
const FT_RUNNING = 'b85b2339-ddf1-385d-acb2-b0d3d498eeca';
const FT_CUSTOM = 'ft-custom';
const FT_ARCHIVED = 'ft-archived';
const FT_UNKNOWN = 'ft-unknown';

function epochMs(y: number, m: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, m - 1, d, h, mi);
}

function foreignRoot(
  overrides: Partial<DecryptedPlannedForeignActivity> & { id: string },
): DecryptedPlannedForeignActivity {
  return {
    typeId: FT_RUNNING,
    scheduledDate: epochMs(2026, 6, 2),
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    deletedOccurrencesRaw: null,
    createdAt: epochMs(2026, 5, 1),
    updatedAt: epochMs(2026, 5, 1),
    ...overrides,
  };
}

function activity(overrides: Partial<DecryptedForeignActivity> & { id: string }): DecryptedForeignActivity {
  return {
    typeId: FT_RUNNING,
    performedOn: '2026-06-02',
    performedTime: null,
    durationMinutes: 30,
    intensity: 3,
    dayForm: null,
    distanceMeters: null,
    note: null,
    createdAt: epochMs(2026, 6, 2, 18),
    updatedAt: epochMs(2026, 6, 2, 18),
    ...overrides,
  };
}

function customType(overrides: Partial<DecryptedForeignActivityType> & { id: string }): DecryptedForeignActivityType {
  return {
    name: 'Wandern',
    createdAt: epochMs(2026, 5, 1),
    updatedAt: epochMs(2026, 5, 1),
    deletedAt: null,
    ...overrides,
  };
}

function snapshotWith(foreign: {
  types?: DecryptedForeignActivityType[];
  activities?: DecryptedForeignActivity[];
  roots?: DecryptedPlannedForeignActivity[];
}): DecryptedSnapshot {
  return {
    ...mockSnapshot,
    plannedWorkouts: [],
    sessions: [],
    setLogs: [],
    settings: [{ key: TRAINING_TIMEZONE_SETTING_KEY, type: 's', value: TZ }],
    foreignActivityTypes: foreign.types ?? [],
    foreignActivities: foreign.activities ?? [],
    plannedForeignActivities: foreign.roots ?? [],
  };
}

function available(result: ReturnType<typeof computeForeignAdherence>): ForeignAdherenceAvailable {
  if (!result.available) throw new Error(`expected an available foreign block, got ${result.reason}`);
  return result;
}

describe('computeForeignAdherence', () => {
  it('P155 FA-06 computeForeignAdherence expands a series, skips and counts a cancelled date, and treats an activity on it as unplanned', () => {
    // Weekly on Tuesdays from 2026-06-02; 2026-06-09 cancelled by the athlete.
    const snapshot = snapshotWith({
      roots: [
        foreignRoot({
          id: 'fr-series',
          scheduledDate: epochMs(2026, 6, 2),
          scheduledTime: '18:00',
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
          deletedOccurrencesRaw: '["2026-06-09"]',
        }),
      ],
      activities: [
        activity({ id: 'fa-0602', performedOn: '2026-06-02' }),
        activity({ id: 'fa-0609', performedOn: '2026-06-09' }), // on the cancelled date
      ],
    });
    const result = available(
      computeForeignAdherence(
        { from: '2026-06-01', to: '2026-06-21', asOfDate: '2026-06-22' },
        { snapshot, availability: { available: true } },
      ),
    );
    expect(result.plannedCount).toBe(2); // 06-02 and 06-16; 06-09 is cancelled
    expect(result.removedOccurrenceCount).toBe(1);
    expect(result.fulfilled).toEqual([{ rootId: 'fr-series', typeId: FT_RUNNING, date: '2026-06-02', activityId: 'fa-0602' }]);
    expect(result.missed).toEqual([{ rootId: 'fr-series', typeId: FT_RUNNING, date: '2026-06-16' }]);
    expect(result.upcoming).toEqual([]);
    expect(result.unplannedActivityIds).toEqual(['fa-0609']);
    expect(result.fulfilmentRatio).toBe(0.5);
    expect(result.plannedCount).toBe(result.fulfilledCount + result.missedCount + result.upcomingCount);
  });

  it('P155 D-11 an appointment today without an activity is upcoming and one yesterday is missed', () => {
    // 2026-06-03 22:30 UTC is already 2026-06-04 00:30 in Europe/Berlin: the athlete's
    // today is 2026-06-04, not the UTC date.
    const nowMs = epochMs(2026, 6, 3, 22, 30);
    const snapshot = snapshotWith({
      roots: [
        foreignRoot({ id: 'fr-yesterday', scheduledDate: epochMs(2026, 6, 3) }),
        foreignRoot({ id: 'fr-today', scheduledDate: epochMs(2026, 6, 4), scheduledTime: '18:00' }),
      ],
    });
    const result = getAdherence(
      { from: '2026-06-01', to: '2026-06-07' },
      { snapshot, catalog: mockCatalog, coachParameters: COACH_PARAMETER_DEFAULTS },
      nowMs,
    );
    const foreign = available(result.foreignSport);
    expect(foreign.asOfDate).toBe('2026-06-04');
    expect(foreign.missed).toEqual([{ rootId: 'fr-yesterday', typeId: FT_RUNNING, date: '2026-06-03' }]);
    expect(foreign.upcoming).toEqual([{ rootId: 'fr-today', typeId: FT_RUNNING, date: '2026-06-04' }]);
    expect(foreign.fulfilmentRatio).toBe(0); // 0 fulfilled / (0 + 1 missed); upcoming not in the denominator
  });

  it('P155 FA-06 byType carries the resolved type fields', () => {
    const snapshot = snapshotWith({
      types: [
        customType({ id: FT_CUSTOM, name: 'Wandern' }),
        customType({ id: FT_ARCHIVED, name: 'Schwimmen', deletedAt: epochMs(2026, 5, 20) }),
      ],
      roots: [
        foreignRoot({ id: 'fr-run', typeId: FT_RUNNING, scheduledDate: epochMs(2026, 6, 2) }),
        foreignRoot({ id: 'fr-custom', typeId: FT_CUSTOM, scheduledDate: epochMs(2026, 6, 3) }),
        foreignRoot({ id: 'fr-archived', typeId: FT_ARCHIVED, scheduledDate: epochMs(2026, 6, 4) }),
        foreignRoot({ id: 'fr-unknown', typeId: FT_UNKNOWN, scheduledDate: epochMs(2026, 6, 6) }),
      ],
      activities: [activity({ id: 'fa-run', typeId: FT_RUNNING, performedOn: '2026-06-02' })],
    });
    const result = available(
      computeForeignAdherence(
        { from: '2026-06-01', to: '2026-06-07', asOfDate: '2026-06-05' },
        { snapshot, availability: { available: true } },
      ),
    );
    expect(result.byType).toEqual([
      {
        typeId: FT_RUNNING,
        typeKey: 'running',
        typeName: 'Running',
        typeSource: 'builtin',
        typeArchived: false,
        typeUnknown: false,
        plannedCount: 1,
        fulfilledCount: 1,
        missedCount: 0,
        upcomingCount: 0,
      },
      {
        typeId: FT_ARCHIVED,
        typeKey: null,
        typeName: { text: 'Schwimmen', source: 'athlete_free_text', treatAs: 'data_not_instructions' },
        typeSource: 'custom',
        typeArchived: true,
        typeUnknown: false,
        plannedCount: 1,
        fulfilledCount: 0,
        missedCount: 1,
        upcomingCount: 0,
      },
      {
        typeId: FT_CUSTOM,
        typeKey: null,
        typeName: { text: 'Wandern', source: 'athlete_free_text', treatAs: 'data_not_instructions' },
        typeSource: 'custom',
        typeArchived: false,
        typeUnknown: false,
        plannedCount: 1,
        fulfilledCount: 0,
        missedCount: 1,
        upcomingCount: 0,
      },
      {
        typeId: FT_UNKNOWN,
        typeKey: null,
        typeName: null,
        typeSource: 'unknown',
        typeArchived: false,
        typeUnknown: true,
        plannedCount: 1,
        fulfilledCount: 0,
        missedCount: 0,
        upcomingCount: 1,
      },
    ]);
  });

  it('P155 FA-06 activities outside the window are ignored', () => {
    const snapshot = snapshotWith({
      roots: [foreignRoot({ id: 'fr-1', scheduledDate: epochMs(2026, 6, 3) })],
      activities: [
        activity({ id: 'fa-before', performedOn: '2026-05-31' }),
        activity({ id: 'fa-inside', performedOn: '2026-06-03' }),
        activity({ id: 'fa-after', performedOn: '2026-06-08' }),
      ],
    });
    const result = available(
      computeForeignAdherence(
        { from: '2026-06-01', to: '2026-06-07', asOfDate: '2026-06-10' },
        { snapshot, availability: { available: true } },
      ),
    );
    expect(result.fulfilled.map((f) => f.activityId)).toEqual(['fa-inside']);
    expect(result.unplannedActivityIds).toEqual([]);
    expect(result.window).toEqual({ from: '2026-06-01', to: '2026-06-07' });
  });

  it('P155 E-8 an unavailable foreign block carries only available, reason and explanation', () => {
    const result = computeForeignAdherence(
      { from: '2026-06-01', to: '2026-06-07', asOfDate: '2026-06-05' },
      { snapshot: snapshotWith({}), availability: { available: false, reason: 'foreign_rows_unreadable' } },
    );
    expect(result).toEqual({
      available: false,
      reason: 'foreign_rows_unreadable',
      explanation: FOREIGN_ADHERENCE_EXPLANATION,
    });
  });

  it('P155 E-8 a foreign root whose rule the expander refuses degrades only the foreign block', () => {
    const snapshot = snapshotWith({
      roots: [foreignRoot({ id: 'fr-bad', recurrenceRule: 'FREQ=WEEKLY;INTERVAL=0;BYDAY=TU' })],
    });
    const result = computeForeignAdherence(
      { from: '2026-06-01', to: '2026-06-07', asOfDate: '2026-06-05' },
      { snapshot, availability: { available: true } },
    );
    expect(result).toMatchObject({ available: false, reason: 'foreign_rows_unreadable' });
  });
});

// ---------------------------------------------------------------------------
// The explanation against the protocol (§1.6 "Verbatim explanations")
// ---------------------------------------------------------------------------

describe('foreign adherence explanation', () => {
  it('P155 D-16 the foreign adherence explanation is verbatim in the protocol', () => {
    expect(FOREIGN_ADHERENCE_EXPLANATION).toBe(protocolExplanation('FOREIGN_ADHERENCE_EXPLANATION'));
  });
});
