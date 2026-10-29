/**
 * suspect-sets.ts unit tests (Phase 166, plan 166-06; protocol 1.48 §1.11 "Suspect sets",
 * D-05, D-17, STAT-05). Every fixture is invented; the expected marks are derived by hand from
 * the protocol table. The marks are read only: no function under test changes the snapshot.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SUSPECT_REASONS,
  computeDataQuality,
  suspectMarksFor,
  type SuspectMark,
} from '../../src/training-state/suspect-sets.js';
import { getTrainingState } from '../../src/tools/get_training_state.js';
import {
  CHAR166_NOW_MS,
  CHAR166_TRAINING_STATE_ARGS,
  CHAR166_TRAINING_STATE_DATA,
  CHAR166_SNAPSHOT,
  CHAR166_CATALOG,
} from '../characterization-166-fixture.js';
import type {
  CatalogExercise,
  DecryptedSession,
  DecryptedSetLog,
  DecryptedSnapshot,
  NormalizedTemplateExercise,
} from '../../src/types.js';

const T = (iso: string): number => Date.parse(iso);
const MIN = 60 * 1000;

function exercise(id: string, mode: 'REPS' | 'TIME', nameEn: string): CatalogExercise {
  return {
    id,
    key: id.replace(/-/g, '_'),
    nameEn,
    mode,
    usesWeight: false,
    lastModifiedAt: T('2026-01-01T00:00:00Z'),
    translations: [],
    muscleGroups: [],
    equipment: [],
    capabilities: [],
    origin: 'CATALOG',
  };
}

function templateExercise(
  id: string,
  exerciseId: string,
  mode: string,
  targets: { targetReps?: number; targetTimeSeconds?: number } = {},
): NormalizedTemplateExercise {
  return {
    id,
    templateId: 'ss-tpl',
    exerciseId,
    exerciseSource: 'CATALOG',
    mode,
    ...targets,
    restTimeSeconds: 60,
    sets: 3,
    orderIndex: 0,
    createdAt: T('2026-01-01T00:00:00Z'),
    updatedAt: T('2026-01-01T00:00:00Z'),
  };
}

function session(
  id: string,
  startIso: string,
  extra: { finished?: boolean; deletedAt?: number; isManual?: boolean; isQuickChallenge?: boolean } = {},
): DecryptedSession {
  const startTime = T(startIso);
  return {
    id,
    startTime,
    ...(extra.finished === false ? {} : { endTime: startTime + 60 * MIN }),
    ...(extra.deletedAt !== undefined ? { deletedAt: extra.deletedAt } : {}),
    isManual: extra.isManual ?? false,
    isCorrected: false,
    isQuickChallenge: extra.isQuickChallenge ?? false,
    createdAt: startTime,
    updatedAt: startTime,
  };
}

function set(
  id: string,
  sessionId: string,
  createdAt: number,
  values: Partial<DecryptedSetLog>,
): DecryptedSetLog {
  return {
    id,
    sessionId,
    exerciseSource: 'CATALOG',
    completedReps: null,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: createdAt,
    measuredTimeSeconds: null,
    createdAt,
    updatedAt: createdAt,
    ...values,
  };
}

function snapshot(parts: Partial<DecryptedSnapshot>): DecryptedSnapshot {
  return {
    syncedAt: T('2026-06-01T00:00:00Z'),
    exercises: [],
    exerciseTranslations: [],
    templates: [{ id: 'ss-tpl', name: 'SS Invented Template', createdAt: 0, updatedAt: 0, isFavoriteForWatch: false }],
    blocks: [],
    templateExercises: [],
    sessions: [],
    setLogs: [],
    hrSamples: [],
    plannedWorkouts: [],
    settings: [{ key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' }],
    ...parts,
  };
}

const EX_REPS = exercise('ss-ex-reps', 'REPS', 'SS Invented Reps Exercise');
const EX_HOLD = exercise('ss-ex-hold', 'TIME', 'SS Invented Hold Exercise');
const EX_HOLD2 = exercise('ss-ex-hold2', 'TIME', 'SS Invented Second Hold');
const CATALOG = [EX_REPS, EX_HOLD, EX_HOLD2];

const reasonsOf = (marks: Map<string, SuspectMark[]>, id: string) => marks.get(id)?.map((m) => m.reason);

/** The explanation table of protocol §1.11 "Suspect sets", read verbatim. */
function protocolExplanations(): Record<string, string> {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'COACH-PLANNING-PROTOCOL.md');
  const text = readFileSync(path, 'utf-8');
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\| `(reps_on_time_station|zero_set|measured_time_missing)` \| `(This [^`]+)` \|$/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe('suspect marks (protocol §1.11, STAT-05)', () => {
  it('P166 a reps value on a time station is marked reps_on_time_station unless the template exercise has targetReps', () => {
    const s1 = session('ss-s1', '2026-05-01T08:00:00Z');
    const te = [
      templateExercise('ss-te-time', EX_REPS.id, 'TIME', { targetTimeSeconds: 30 }),
      templateExercise('ss-te-time-reps', EX_REPS.id, 'TIME', { targetReps: 8 }),
      templateExercise('ss-te-max-hold', EX_HOLD.id, 'MAX'),
    ];
    const t0 = s1.startTime;
    const marks = suspectMarksFor(
      snapshot({
        templateExercises: te,
        sessions: [s1],
        setLogs: [
          set('ss-a', s1.id, t0 + 1, { workoutExerciseId: 'ss-te-time', exerciseId: EX_REPS.id, completedReps: 10, completedTimeSeconds: 30 }),
          set('ss-b', s1.id, t0 + 2, { workoutExerciseId: 'ss-te-time-reps', exerciseId: EX_REPS.id, completedReps: 8, completedTimeSeconds: 30 }),
          set('ss-c', s1.id, t0 + 3, { workoutExerciseId: 'ss-te-max-hold', exerciseId: EX_HOLD.id, completedReps: 5, completedTimeSeconds: 40 }),
          set('ss-d', s1.id, t0 + 4, { exerciseId: EX_HOLD.id, completedReps: 3, completedTimeSeconds: 20 }),
          set('ss-e', s1.id, t0 + 5, { exerciseId: EX_REPS.id, completedReps: 10 }),
          set('ss-f', s1.id, t0 + 6, { workoutExerciseId: 'ss-te-time', exerciseId: EX_REPS.id, completedReps: 0, completedTimeSeconds: 30 }),
        ],
      }),
      CATALOG,
    );
    // a: TIME station on a REPS exercise; c: MAX on a TIME exercise; d: no workout exercise,
    // catalog TIME. b is excepted (targetReps 8), e records repetitions, f has no repetitions.
    expect(reasonsOf(marks, 'ss-a')).toEqual(['reps_on_time_station']);
    expect(reasonsOf(marks, 'ss-c')).toEqual(['reps_on_time_station']);
    expect(reasonsOf(marks, 'ss-d')).toEqual(['reps_on_time_station']);
    for (const id of ['ss-b', 'ss-e', 'ss-f']) expect(marks.has(id), id).toBe(false);
  });

  it('P166 a zero set is marked zero_set', () => {
    const s1 = session('ss-s1', '2026-05-01T08:00:00Z');
    // The pattern of zero sets an athlete keeps on purpose (D-17): one zero set alone in a
    // session that was never finished. It is marked, nothing else happens to it.
    const kb = session('ss-kb', '2026-05-02T08:00:00Z', { finished: false });
    const del = session('ss-del', '2026-05-03T08:00:00Z', { deletedAt: T('2026-05-03T12:00:00Z') });
    const t0 = s1.startTime;
    const snap = snapshot({
      sessions: [s1, kb, del],
      setLogs: [
        set('ss-z-reps', s1.id, t0 + 1, { exerciseId: EX_REPS.id, completedReps: 0 }),
        set('ss-z-time', s1.id, t0 + 2, { exerciseId: EX_HOLD.id, completedTimeSeconds: 0 }),
        set('ss-null-reps', s1.id, t0 + 3, { exerciseId: EX_REPS.id }),
        set('ss-null-time', s1.id, t0 + 4, { exerciseId: EX_HOLD.id }),
        set('ss-reps-zero-time', s1.id, t0 + 5, { exerciseId: EX_REPS.id, completedReps: 5, completedTimeSeconds: 0 }),
        set('ss-kb-zero', kb.id, kb.startTime + 1, { exerciseId: EX_REPS.id, completedReps: 0 }),
        set('ss-z-deleted', s1.id, t0 + 6, { exerciseId: EX_REPS.id, completedReps: 0, deletedAt: t0 + 10 }),
        set('ss-z-in-deleted', del.id, del.startTime + 1, { exerciseId: EX_REPS.id, completedReps: 0 }),
      ],
    });
    const before = structuredClone(snap);
    const marks = suspectMarksFor(snap, CATALOG);
    expect(reasonsOf(marks, 'ss-z-reps')).toEqual(['zero_set']);
    expect(reasonsOf(marks, 'ss-z-time')).toEqual(['zero_set']);
    expect(reasonsOf(marks, 'ss-kb-zero')).toEqual(['zero_set']);
    for (const id of ['ss-null-reps', 'ss-null-time', 'ss-reps-zero-time', 'ss-z-deleted', 'ss-z-in-deleted']) {
      expect(marks.has(id), id).toBe(false);
    }
    expect([...marks.keys()].sort()).toEqual(['ss-kb-zero', 'ss-z-reps', 'ss-z-time']);
    // Read only: the snapshot is untouched.
    expect(snap).toEqual(before);
  });

  it('P166 a missing measured time after measurements began is marked measured_time_missing', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session(`ss-m${i}`, `2026-05-0${i + 1}T08:00:00Z`));
    const at = (i: number) => sessions[i].startTime + 1;
    const timed = (id: string, i: number, exerciseId: string, measured: number | null) =>
      set(id, sessions[i].id, at(i), { exerciseId, completedTimeSeconds: 30, measuredTimeSeconds: measured });
    const marks = suspectMarksFor(
      snapshot({
        sessions,
        setLogs: [
          // EX_HOLD: unmeasured before the first measured set, then 4 of 5 later sets measured.
          timed('ss-h0', 0, EX_HOLD.id, null),
          timed('ss-h1', 1, EX_HOLD.id, 31),
          timed('ss-h2', 2, EX_HOLD.id, 30),
          timed('ss-h3', 3, EX_HOLD.id, 29),
          timed('ss-h4', 4, EX_HOLD.id, 30),
          timed('ss-h5', 5, EX_HOLD.id, 32),
          timed('ss-h6', 6, EX_HOLD.id, null),
          // EX_HOLD2: after the first measured set only 1 of 2 later sets measured (50 %).
          timed('ss-k1', 1, EX_HOLD2.id, 30),
          timed('ss-k2', 2, EX_HOLD2.id, 30),
          timed('ss-k3', 3, EX_HOLD2.id, null),
        ],
      }),
      CATALOG,
    );
    expect(reasonsOf(marks, 'ss-h6')).toEqual(['measured_time_missing']);
    // Before measurements began, never; below the share, never.
    expect(marks.has('ss-h0')).toBe(false);
    expect(marks.has('ss-k3')).toBe(false);
    expect([...marks.keys()]).toEqual(['ss-h6']);
  });

  it('P166 manual sessions and quick challenges are never marked measured_time_missing', () => {
    const normal = Array.from({ length: 7 }, (_, i) => session(`ss-n${i}`, `2026-05-0${i + 1}T08:00:00Z`));
    const manual = session('ss-manual', '2026-05-02T12:00:00Z', { isManual: true });
    const quick = session('ss-quick', '2026-04-30T12:00:00Z', { isQuickChallenge: true });
    const at = (s: DecryptedSession, k = 1) => s.startTime + k;
    const timed = (id: string, s: DecryptedSession, measured: number | null, k = 1) =>
      set(id, s.id, at(s, k), { exerciseId: EX_HOLD.id, completedTimeSeconds: 30, measuredTimeSeconds: measured });
    const marks = suspectMarksFor(
      snapshot({
        sessions: [...normal, manual, quick],
        setLogs: [
          // A quick challenge with a measured time BEFORE every normal set: it takes no part in
          // the first measured set (else ss-n0 would count after it and the share would drop).
          timed('ss-q-measured', quick, 30),
          timed('ss-q-unmeasured', quick, null, 2),
          timed('ss-n0', normal[0], null),
          timed('ss-n1', normal[1], 31),
          // Three unmeasured manual sets after the first measured set: they take no part in the
          // share (else 4 of 8 = 50 % and ss-n6 would not be marked) and are never marked.
          timed('ss-manual-1', manual, null, 1),
          timed('ss-manual-2', manual, null, 2),
          timed('ss-manual-3', manual, null, 3),
          timed('ss-n2', normal[2], 30),
          timed('ss-n3', normal[3], 30),
          timed('ss-n4', normal[4], 30),
          timed('ss-n5', normal[5], 30),
          timed('ss-n6', normal[6], null),
        ],
      }),
      CATALOG,
    );
    expect(reasonsOf(marks, 'ss-n6')).toEqual(['measured_time_missing']);
    for (const id of ['ss-manual-1', 'ss-manual-2', 'ss-manual-3', 'ss-q-unmeasured', 'ss-n0']) {
      expect(marks.has(id), id).toBe(false);
    }
  });

  it('P166 every suspect mark names its reason and an explanation without exercise names', () => {
    const explanations = protocolExplanations();
    expect(Object.keys(explanations).sort()).toEqual([...SUSPECT_REASONS].sort());
    const s1 = session('ss-s1', '2026-05-01T08:00:00Z');
    const sessions = [s1, ...Array.from({ length: 6 }, (_, i) => session(`ss-x${i}`, `2026-05-0${i + 2}T08:00:00Z`))];
    const te = [templateExercise('ss-te-time', EX_REPS.id, 'TIME', { targetTimeSeconds: 30 })];
    const marks = suspectMarksFor(
      snapshot({
        templateExercises: te,
        sessions,
        setLogs: [
          // Two reasons on one set: repetitions on a time station and a zero time.
          set('ss-two', s1.id, s1.startTime + 1, { workoutExerciseId: 'ss-te-time', exerciseId: EX_REPS.id, completedReps: 6, completedTimeSeconds: 0 }),
          ...sessions.slice(1, 6).map((s, i) =>
            set(`ss-meas-${i}`, s.id, s.startTime + 1, { exerciseId: EX_HOLD.id, completedTimeSeconds: 30, measuredTimeSeconds: 30 }),
          ),
          set('ss-unmeasured', sessions[6].id, sessions[6].startTime + 1, { exerciseId: EX_HOLD.id, completedTimeSeconds: 30 }),
        ],
      }),
      CATALOG,
    );
    expect(reasonsOf(marks, 'ss-two')).toEqual(['reps_on_time_station', 'zero_set']);
    expect(reasonsOf(marks, 'ss-unmeasured')).toEqual(['measured_time_missing']);
    const all = [...marks.values()].flat();
    expect(new Set(all.map((m) => m.reason))).toEqual(new Set(SUSPECT_REASONS));
    const forbidden = [
      ...CATALOG.flatMap((e) => [e.nameEn, e.key, e.id]),
      'SS Invented Template',
      'ss-tpl',
    ];
    for (const mark of all) {
      expect(Object.keys(mark)).toEqual(['reason', 'explanation']);
      expect(mark.explanation).toBe(explanations[mark.reason]);
      for (const name of forbidden) expect(mark.explanation.includes(name), `${mark.reason} names ${name}`).toBe(false);
    }
  });

  it('P166 dataQuality counts by reason and lists at most twenty newest', () => {
    // 25 zero sets, one per day; two of them also carry reps_on_time_station; one more is
    // created at 23:30 UTC, already the next day in Europe/Berlin; two share a creation time.
    const sessions: DecryptedSession[] = [];
    const setLogs: DecryptedSetLog[] = [];
    const te = [templateExercise('ss-te-time', EX_REPS.id, 'TIME', { targetTimeSeconds: 30 })];
    for (let i = 0; i < 25; i++) {
      const day = String(i + 1).padStart(2, '0');
      const s = session(`ss-d${day}`, `2026-03-${day}T08:00:00Z`);
      sessions.push(s);
      const id = `ss-z${day}`;
      if (i === 23 || i === 24) {
        setLogs.push(set(id, s.id, s.startTime + MIN, { workoutExerciseId: 'ss-te-time', exerciseId: EX_REPS.id, completedReps: 4, completedTimeSeconds: 0 }));
      } else {
        setLogs.push(set(id, s.id, s.startTime + MIN, { exerciseId: EX_REPS.id, completedReps: 0 }));
      }
    }
    // Same creation time as ss-z22: ties order by setLogId ascending.
    setLogs.push(set('ss-z22-twin', sessions[21].id, sessions[21].startTime + MIN, { exerciseId: EX_REPS.id, completedReps: 0 }));
    // 23:30 UTC on 2026-03-28 is 00:30 on 2026-03-29 in Berlin (CET, before the switch to CEST).
    const late = session('ss-late', '2026-03-28T23:00:00Z');
    sessions.push(late);
    setLogs.push(set('ss-late-zero', late.id, T('2026-03-28T23:30:00Z'), { exerciseId: EX_REPS.id, completedReps: 0 }));

    const dq = computeDataQuality(snapshot({ templateExercises: te, sessions, setLogs }), CATALOG, 'Europe/Berlin');
    expect(dq.suspectSetCount).toBe(27);
    expect(dq.byReason).toEqual({ reps_on_time_station: 2, zero_set: 27, measured_time_missing: 0 });
    expect(dq.newest).toHaveLength(20);
    expect(dq.newest[0]).toEqual({ setLogId: 'ss-late-zero', date: '2026-03-29', reasons: ['zero_set'] });
    expect(dq.newest[1]).toEqual({ setLogId: 'ss-z25', date: '2026-03-25', reasons: ['reps_on_time_station', 'zero_set'] });
    const ids = dq.newest.map((e) => e.setLogId);
    expect(ids.indexOf('ss-z22')).toBe(ids.indexOf('ss-z22-twin') - 1);
    expect(ids[ids.length - 1]).toBe('ss-z08');
    for (const e of dq.newest) expect(Object.keys(e)).toEqual(['setLogId', 'date', 'reasons']);

    // In get_training_state: the last key, the same summary; on the fixture of 166 the
    // time-station set and the MAX-hold set carry repetitions, one push set is a zero set.
    const state = getTrainingState(CHAR166_TRAINING_STATE_ARGS, CHAR166_TRAINING_STATE_DATA, CHAR166_NOW_MS);
    const keys = Object.keys(state);
    expect(keys[keys.length - 1]).toBe('dataQuality');
    const { dataQuality } = state as unknown as { dataQuality: unknown };
    expect(dataQuality).toEqual(computeDataQuality(CHAR166_SNAPSHOT, CHAR166_CATALOG, 'Europe/Berlin'));
    expect(dataQuality).toEqual({
      suspectSetCount: 3,
      byReason: { reps_on_time_station: 2, zero_set: 1, measured_time_missing: 0 },
      newest: [
        { setLogId: 'char166-sl-hold-max', date: '2026-03-06', reasons: ['reps_on_time_station'] },
        { setLogId: 'char166-sl-push-zero', date: '2026-03-06', reasons: ['zero_set'] },
        { setLogId: 'char166-sl-push-time-station', date: '2026-03-06', reasons: ['reps_on_time_station'] },
      ],
    });
  });
});
