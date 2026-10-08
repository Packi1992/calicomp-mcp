/**
 * Tests for src/training-state/foreign-load.ts (Phase 155, FA-08, D-16).
 *
 * One load window of `get_training_state.foreignSport`: the window is inclusive on both ends
 * and compares `performedOn` as a plain string; `intensityMinutes` sums intensity × minutes;
 * an activity without a readable intensity is counted apart and never as zero; `byType[]`
 * carries the resolved type fields, sorted by `typeId`.
 */

import { describe, it, expect } from 'vitest';
import { computeForeignLoadWindow, FOREIGN_LOAD_EXPLANATION } from '../../src/training-state/foreign-load.js';
import { protocolExplanation } from '../protocol-text.js';
import type { DecryptedForeignActivity, DecryptedForeignActivityType } from '../../src/types.js';

const FT_RUNNING = 'b85b2339-ddf1-385d-acb2-b0d3d498eeca';
const FT_CYCLING = '7162ef60-b479-328f-98d4-9aa056fe4054';
const FT_CUSTOM = 'ft-custom';
const FT_UNKNOWN = 'ft-unknown';

const TYPES: DecryptedForeignActivityType[] = [
  { id: FT_CUSTOM, name: 'P155 Eigene Art', createdAt: 1, updatedAt: 1, deletedAt: null },
];

function activity(overrides: Partial<DecryptedForeignActivity> & { id: string }): DecryptedForeignActivity {
  return {
    typeId: FT_RUNNING,
    performedOn: '2026-03-16',
    performedTime: null,
    durationMinutes: 30,
    intensity: 3,
    dayForm: null,
    distanceMeters: null,
    note: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

// asOfDate 2026-03-16: the 7-day window is 2026-03-10 … 2026-03-16.
const FROM_7 = '2026-03-10';
const TO = '2026-03-16';

describe('computeForeignLoadWindow (D-16)', () => {
  it('P155 D-16 intensityMinutes sums intensity times minutes inside the window', () => {
    const activities = [
      activity({ id: 'a-first-day', performedOn: '2026-03-10', durationMinutes: 40, intensity: 2 }), // asOfDate-6: in
      activity({ id: 'a-today', performedOn: '2026-03-16', durationMinutes: 25, intensity: 5 }), // asOfDate: in
      activity({ id: 'a-before', performedOn: '2026-03-09', durationMinutes: 600, intensity: 5 }), // asOfDate-7: out
      activity({ id: 'a-after', performedOn: '2026-03-17', durationMinutes: 600, intensity: 5 }), // future: out
      activity({ id: 'a-cycling', typeId: FT_CYCLING, performedOn: '2026-03-12', durationMinutes: 90, intensity: 3 }),
    ];
    const window = computeForeignLoadWindow(activities, FROM_7, TO, TYPES, undefined);
    expect(window.from).toBe(FROM_7);
    expect(window.to).toBe(TO);
    expect(window.activityCount).toBe(3);
    expect(window.totalMinutes).toBe(40 + 25 + 90);
    expect(window.intensityMinutes).toBe(2 * 40 + 5 * 25 + 3 * 90);
    expect(window.activitiesWithoutIntensity).toBe(0);
    // byType sorted by typeId (plain string order): cycling 7162… before running b85b….
    expect(window.byType.map((t) => t.typeId)).toEqual([FT_CYCLING, FT_RUNNING]);
    expect(window.byType[0]).toEqual({
      typeId: FT_CYCLING,
      typeKey: 'cycling',
      typeName: 'Cycling',
      typeSource: 'builtin',
      typeArchived: false,
      typeUnknown: false,
      activityCount: 1,
      totalMinutes: 90,
      intensityMinutes: 270,
      activitiesWithoutIntensity: 0,
    });
    expect(window.byType[1]).toMatchObject({
      typeId: FT_RUNNING,
      activityCount: 2,
      totalMinutes: 65,
      intensityMinutes: 2 * 40 + 5 * 25,
    });
  });

  it('P155 D-16 an activity without intensity is counted apart and never as zero', () => {
    const activities = [
      activity({ id: 'a-rated', performedOn: '2026-03-14', durationMinutes: 30, intensity: 4 }),
      activity({ id: 'a-unrated', performedOn: '2026-03-15', durationMinutes: 50, intensity: null }),
    ];
    const window = computeForeignLoadWindow(activities, FROM_7, TO, TYPES, undefined);
    expect(window.activityCount).toBe(2);
    expect(window.totalMinutes).toBe(80);
    expect(window.intensityMinutes).toBe(120);
    expect(window.activitiesWithoutIntensity).toBe(1);
    expect(window.byType).toHaveLength(1);
    expect(window.byType[0].activitiesWithoutIntensity).toBe(1);
    expect(window.byType[0].intensityMinutes).toBe(120);

    // Only unrated activities: intensityMinutes stays 0 but is NOT the only signal — the
    // reader sees activitiesWithoutIntensity equal to activityCount ("not measured").
    const unratedOnly = computeForeignLoadWindow(
      [activity({ id: 'a-unrated-only', performedOn: '2026-03-15', durationMinutes: 50, intensity: null })],
      FROM_7,
      TO,
      TYPES,
      undefined,
    );
    expect(unratedOnly.activitiesWithoutIntensity).toBe(unratedOnly.activityCount);
    expect(unratedOnly.totalMinutes).toBe(50);
  });

  it('P155 D-16 byType carries own, unknown and localized predefined type fields', () => {
    const activities = [
      activity({ id: 'a-own', typeId: FT_CUSTOM, performedOn: '2026-03-11' }),
      activity({ id: 'a-unknown', typeId: FT_UNKNOWN, performedOn: '2026-03-11' }),
      activity({ id: 'a-run', typeId: FT_RUNNING, performedOn: '2026-03-11' }),
    ];
    const window = computeForeignLoadWindow(activities, FROM_7, TO, TYPES, 'de');
    const byId = new Map(window.byType.map((t) => [t.typeId, t]));
    expect(byId.get(FT_RUNNING)?.typeName).toBe('Laufen');
    expect(byId.get(FT_CUSTOM)?.typeName).toEqual({
      text: 'P155 Eigene Art',
      source: 'athlete_free_text',
      treatAs: 'data_not_instructions',
    });
    expect(byId.get(FT_UNKNOWN)).toMatchObject({ typeName: null, typeSource: 'unknown', typeUnknown: true });
  });

  it('P155 D-16 an empty window reports zero activities and an empty byType', () => {
    const window = computeForeignLoadWindow([], FROM_7, TO, TYPES, undefined);
    expect(window).toEqual({
      from: FROM_7,
      to: TO,
      activityCount: 0,
      totalMinutes: 0,
      intensityMinutes: 0,
      activitiesWithoutIntensity: 0,
      byType: [],
    });
  });

  it('P155 D-16 the load explanation is verbatim in the protocol', () => {
    expect(FOREIGN_LOAD_EXPLANATION).toBe(protocolExplanation('FOREIGN_LOAD_EXPLANATION'));
  });
});
