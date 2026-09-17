/**
 * Tests for src/tools/get_planned_workouts.ts
 *
 * Coverage:
 *   - Weekly BYDAY series expanding to the right dates inside a window
 *   - A cancelled date excluded
 *   - A single-occurrence root inside and outside the window
 *   - A root whose templateId matches no template → templateName null
 *   - A root with no occurrence in the window is absent from `roots`
 *   - D-04 sort: two roots sharing a date with differing scheduledTime, null last
 *   - Identical-output property (two calls over the same snapshot deep-equal)
 *   - The emitted root object has no calendarEventId / createdAt key
 *
 * All tests operate on `{ ...mockSnapshot, plannedWorkouts: [...] }` — the shared
 * fixture (tests/fixture.ts) stays untouched.
 */

import { describe, it, expect } from 'vitest';
import { getPlannedWorkouts } from '../../src/tools/get_planned_workouts.js';
import { mockSnapshot, TEMPLATE_ID_PUSH } from '../fixture.js';
import type { DecryptedSnapshot, DecryptedPlannedWorkout } from '../../src/types.js';

function epochMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function root(overrides: Partial<DecryptedPlannedWorkout> & { id: string }): DecryptedPlannedWorkout {
  return {
    templateId: TEMPLATE_ID_PUSH,
    scheduledDate: epochMs(2026, 6, 4),
    scheduledTime: null,
    note: null,
    recurrenceRule: null,
    recurrenceGroupId: null,
    deletedOccurrencesRaw: null,
    completedSessionId: null,
    ...overrides,
  };
}

function snapshotWith(plannedWorkouts: DecryptedPlannedWorkout[]): DecryptedSnapshot {
  return { ...mockSnapshot, plannedWorkouts };
}

describe('get_planned_workouts — transform', () => {
  it('expands a weekly BYDAY series (FR,MO) to the right dates inside the window', () => {
    const snapshot = snapshotWith([
      root({
        id: 'root-weekly',
        scheduledDate: epochMs(2026, 6, 4), // DTSTART Thursday 2026-06-04
        recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,MO',
      }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.occurrences.map((o) => o.date)).toEqual(['2026-06-05', '2026-06-08', '2026-06-12']);
    for (const occ of result.occurrences) {
      expect(occ.rootId).toBe('root-weekly');
      expect(occ.templateId).toBe(TEMPLATE_ID_PUSH);
      expect(occ.isRecurring).toBe(true);
    }
  });

  it('excludes a cancelled date and returns a sorted, deduplicated deletedOccurrences array on the root', () => {
    const snapshot = snapshotWith([
      root({
        id: 'root-cancelled',
        scheduledDate: epochMs(2026, 6, 2), // DTSTART Tuesday 2026-06-02
        recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
        deletedOccurrencesRaw: '["2026-06-09","2026-06-09","2026-06-16"]',
      }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-30' }, snapshot);

    expect(result.occurrences.map((o) => o.date)).toEqual(['2026-06-02', '2026-06-23', '2026-06-30']);
    const emittedRoot = result.roots.find((r) => r.id === 'root-cancelled');
    expect(emittedRoot?.deletedOccurrences).toEqual(['2026-06-09', '2026-06-16']);
  });

  it('a single-occurrence root (no rule) inside the window produces one occurrence; outside produces none', () => {
    const snapshot = snapshotWith([
      root({ id: 'root-inside', scheduledDate: epochMs(2026, 6, 10), recurrenceRule: null }),
      root({ id: 'root-outside', scheduledDate: epochMs(2026, 7, 10), recurrenceRule: null }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].rootId).toBe('root-inside');
    expect(result.occurrences[0].isRecurring).toBe(false);
  });

  it('a root with no occurrence in the window is absent from `roots`, and every occurrence\'s rootId resolves to an emitted root', () => {
    const snapshot = snapshotWith([
      root({ id: 'root-inside', scheduledDate: epochMs(2026, 6, 10), recurrenceRule: null }),
      root({ id: 'root-outside', scheduledDate: epochMs(2026, 7, 10), recurrenceRule: null }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    const rootIds = new Set(result.roots.map((r) => r.id));
    expect(rootIds.has('root-outside')).toBe(false);
    expect(rootIds.has('root-inside')).toBe(true);
    for (const occ of result.occurrences) {
      expect(rootIds.has(occ.rootId)).toBe(true);
    }
  });

  it('resolves templateName to null when templateId matches no snapshot template, never the raw id', () => {
    const UNKNOWN_TEMPLATE_ID = 'ffffffff-ffff-4fff-afff-ffffffffffff';
    const snapshot = snapshotWith([
      root({ id: 'root-unknown-template', templateId: UNKNOWN_TEMPLATE_ID, scheduledDate: epochMs(2026, 6, 10) }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].templateName).toBeNull();
    expect(result.occurrences[0].templateName).not.toBe(UNKNOWN_TEMPLATE_ID);
  });

  it('resolves templateName from a matching live template', () => {
    const snapshot = snapshotWith([root({ id: 'root-named', scheduledDate: epochMs(2026, 6, 10) })]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.occurrences[0].templateName).toBe('Push Day');
  });

  it('D-04: sorts occurrences by date, then scheduledTime ascending with null last, then rootId', () => {
    const snapshot = snapshotWith([
      root({ id: 'root-z-null-time', scheduledDate: epochMs(2026, 6, 10), scheduledTime: null }),
      root({ id: 'root-a-evening', scheduledDate: epochMs(2026, 6, 10), scheduledTime: '18:00' }),
      root({ id: 'root-b-morning', scheduledDate: epochMs(2026, 6, 10), scheduledTime: '09:00' }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.occurrences.map((o) => o.rootId)).toEqual(['root-b-morning', 'root-a-evening', 'root-z-null-time']);
  });

  it('two consecutive calls over the same snapshot return deep-equal results (D-04 determinism)', () => {
    const snapshot = snapshotWith([
      root({
        id: 'root-weekly',
        scheduledDate: epochMs(2026, 6, 4),
        recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,MO',
      }),
      root({ id: 'root-single', scheduledDate: epochMs(2026, 6, 10), recurrenceRule: null }),
    ]);

    const args = { from: '2026-06-01', to: '2026-06-14' };
    const first = getPlannedWorkouts(args, snapshot);
    const second = getPlannedWorkouts(args, snapshot);

    expect(first).toEqual(second);
  });

  it('never emits a calendarEventId or createdAt key on a root object', () => {
    const snapshot = snapshotWith([root({ id: 'root-inside', scheduledDate: epochMs(2026, 6, 10) })]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]).not.toHaveProperty('calendarEventId');
    expect(result.roots[0]).not.toHaveProperty('createdAt');
  });

  it('passes completedSessionId through onto the root object (D-06)', () => {
    const snapshot = snapshotWith([
      root({ id: 'root-completed', scheduledDate: epochMs(2026, 6, 10), completedSessionId: 'session-xyz' }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.roots[0].completedSessionId).toBe('session-xyz');
  });

  it('a snapshot with no planned-workout rows returns empty occurrences and empty roots', () => {
    const snapshot = snapshotWith([]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.occurrences).toEqual([]);
    expect(result.roots).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Series fields (phase 135-03, SCHED-02, D-07/D-08)
  // -----------------------------------------------------------------------

  it('D-07: weekOffset is computed over the WHOLE snapshot — a surviving root reports the same offset whether or not its group-mate is inside the window', () => {
    const GROUP = 'group-window-independence';
    const snapshot = snapshotWith([
      root({
        id: 'root-earlier',
        scheduledDate: epochMs(2026, 5, 25), // Monday — earliest root, sets the reference Monday
        recurrenceRule: null,
        recurrenceGroupId: GROUP,
      }),
      root({
        id: 'root-later',
        scheduledDate: epochMs(2026, 6, 1), // Monday, one week after root-earlier
        recurrenceRule: null,
        recurrenceGroupId: GROUP,
      }),
    ]);

    // Narrow window: only root-later has an occurrence; root-earlier is excluded entirely.
    const narrow = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-01' }, snapshot);
    expect(narrow.roots.map((r) => r.id)).toEqual(['root-later']);

    // Wide window: both roots have an occurrence.
    const wide = getPlannedWorkouts({ from: '2026-05-01', to: '2026-06-30' }, snapshot);
    const wideLater = wide.roots.find((r) => r.id === 'root-later');

    expect(narrow.roots[0].weekOffset).toBe(1);
    expect(wideLater?.weekOffset).toBe(1);
    expect(narrow.roots[0].weekOffset).toBe(wideLater?.weekOffset);
  });

  it('a root with no recurrenceGroupId reports weekOffset 0', () => {
    const snapshot = snapshotWith([
      root({ id: 'root-no-group', scheduledDate: epochMs(2026, 6, 10), recurrenceGroupId: null }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.roots[0].weekOffset).toBe(0);
  });

  it('a root with a null recurrenceRule reports freq WEEKLY, interval 1, empty byDay and null until', () => {
    const snapshot = snapshotWith([
      root({ id: 'root-no-rule', scheduledDate: epochMs(2026, 6, 10), recurrenceRule: null }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    expect(result.roots[0].freq).toBe('WEEKLY');
    expect(result.roots[0].interval).toBe(1);
    expect(result.roots[0].byDay).toEqual([]);
    expect(result.roots[0].until).toBeNull();
  });

  it('a root stored with weekday tokens out of order reports byDay Monday-first while recurrenceRule stays the stored string verbatim', () => {
    const storedRule = 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,WE,MO';
    const snapshot = snapshotWith([
      root({ id: 'root-unordered-byday', scheduledDate: epochMs(2026, 6, 3), recurrenceRule: storedRule }),
    ]);

    const result = getPlannedWorkouts({ from: '2026-06-01', to: '2026-06-14' }, snapshot);

    const emitted = result.roots.find((r) => r.id === 'root-unordered-byday');
    expect(emitted?.byDay).toEqual(['MO', 'WE', 'SU']);
    expect(emitted?.recurrenceRule).toBe(storedRule);
  });
});
