/**
 * set-population.ts and strength-selection.ts unit tests (Phase 166, plan 166-04; protocol
 * §1.11 Rules P, S and M; D-01, D-02, D-03).
 *
 * The shared corpus (`strengthHeatmapSelection`, `personalRecordsByTrainingMode`,
 * tests/shared-vectors.test.ts) proves parity with the app; these cases pin the unit behavior
 * of the one population every §1.11 count reads: each live set once, the exercise resolved over
 * `exerciseId` or the workout exercise (also a soft-deleted one), the session resolved, deletion
 * marks with `null` and an absent key treated alike, the finished-session requirement as an
 * option, the window cut on the set's `createdAt`, and the mode the set was trained in.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSetPopulation,
  trainingModeOf,
  recordsTime,
  isMarkedDeleted,
} from '../../src/training-state/set-population.js';
import { isStretchOnly, STRETCH_AXIS_KEYS } from '../../src/training-state/strength-selection.js';
import { corpusCatalog } from '../shared-vectors.js';
import type {
  CatalogExercise,
  DecryptedSession,
  DecryptedSetLog,
  DecryptedSnapshot,
  NormalizedTemplateExercise,
} from '../../src/types.js';

function exercise(id: string, mode: string, capabilities: { key: string }[] = []): CatalogExercise {
  return {
    id,
    key: id,
    nameEn: id,
    mode,
    usesWeight: false,
    lastModifiedAt: 0,
    translations: [],
    muscleGroups: [{ id: `mg-${id}`, key: 'chest', translations: [], involvementLevel: 'PRIMARY' }],
    equipment: [],
    capabilities: capabilities.map((c) => ({ id: `ax-${c.key}`, key: c.key, translations: [], capabilityLevel: 'HAUPTREIZ' as const })),
    origin: 'CATALOG',
  };
}

function session(id: string, extra: Partial<DecryptedSession> = {}): DecryptedSession {
  return {
    id,
    startTime: 1_000,
    endTime: 2_000,
    isManual: false,
    isCorrected: false,
    isQuickChallenge: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
}

function setLog(id: string, sessionId: string, extra: Partial<DecryptedSetLog> = {}): DecryptedSetLog {
  return {
    id,
    sessionId,
    exerciseId: 'ex-reps',
    exerciseSource: 'CATALOG',
    completedReps: 10,
    completedTimeSeconds: null,
    weightUsed: null,
    startedAt: null,
    measuredTimeSeconds: null,
    createdAt: 1_500,
    updatedAt: 1_500,
    ...extra,
  };
}

function templateExercise(id: string, exerciseId: string, mode: string, extra: Partial<NormalizedTemplateExercise> = {}): NormalizedTemplateExercise {
  return {
    id,
    templateId: 'tpl',
    exerciseId,
    exerciseSource: 'CATALOG',
    mode,
    restTimeSeconds: 0,
    sets: 1,
    orderIndex: 0,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

function snapshot(parts: Partial<DecryptedSnapshot>): DecryptedSnapshot {
  return {
    syncedAt: 0,
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
    ...parts,
  };
}

const CATALOG = [exercise('ex-reps', 'REPS'), exercise('ex-time', 'TIME'), exercise('ex-max', 'MAX')];
const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));
const ids = (snap: DecryptedSnapshot, requireFinishedSession: boolean, sinceMs?: number): string[] =>
  resolveSetPopulation(snap, BY_ID, { requireFinishedSession, sinceMs }).map((p) => p.setLog.id);

describe('strength-selection (Rule S)', () => {
  it('P166 isStretchOnly ignores unrated links and keeps mixed exercises', () => {
    expect([...STRETCH_AXIS_KEYS]).toEqual(['mobility', 'flexibility']);
    expect(isStretchOnly(exercise('a', 'REPS', [{ key: 'mobility' }, { key: 'flexibility' }]))).toBe(true);
    expect(isStretchOnly(exercise('b', 'REPS', [{ key: 'flexibility' }]))).toBe(true);
    // Mixed: a stretch axis plus another rated axis stays.
    expect(isStretchOnly(exercise('c', 'REPS', [{ key: 'mobility' }, { key: 'power' }]))).toBe(false);
    // No axis at all stays.
    expect(isStretchOnly(exercise('d', 'REPS'))).toBe(false);
    // Unrated links take no part: the catalog projection drops them (cache.ts), so an unrated
    // power link does not make a rated mobility exercise mixed, and an exercise whose only
    // links are unrated stays in.
    const [unratedPower, onlyUnrated] = corpusCatalog({
      exercises: [
        { id: 'e', defaultMode: 'REPS', capabilities: [
          { capabilityAxisKey: 'power', capabilityLevel: null },
          { capabilityAxisKey: 'mobility', capabilityLevel: 'HAUPTREIZ' },
        ] },
        { id: 'f', defaultMode: 'REPS', capabilities: [{ capabilityAxisKey: 'mobility', capabilityLevel: null }] },
      ],
      templateExercises: [],
      sessions: [],
      setLogs: [],
    });
    expect(isStretchOnly(unratedPower)).toBe(true);
    expect(isStretchOnly(onlyUnrated)).toBe(false);
  });
});

describe('set-population (Rule P)', () => {
  it('P166 resolveSetPopulation keeps each live set once and drops deleted sets and sessions', () => {
    const snap = snapshot({
      sessions: [
        session('s-live'),
        session('s-null-deleted', { deletedAt: null as unknown as undefined }),
        session('s-deleted', { deletedAt: 3_000 }),
      ],
      setLogs: [
        setLog('live', 's-live'),
        setLog('null-deleted', 's-live', { deletedAt: null as unknown as undefined }),
        setLog('deleted', 's-live', { deletedAt: 3_000 }),
        setLog('in-null-deleted-session', 's-null-deleted'),
        setLog('in-deleted-session', 's-deleted'),
        setLog('no-session', 's-missing'),
      ],
    });
    expect(ids(snap, true)).toEqual(['live', 'null-deleted', 'in-null-deleted-session']);
    expect(isMarkedDeleted({ deletedAt: null })).toBe(false);
    expect(isMarkedDeleted({})).toBe(false);
    expect(isMarkedDeleted({ deletedAt: 0 })).toBe(true);
  });

  it('P166 resolveSetPopulation requires a finished session only when asked', () => {
    const snap = snapshot({
      sessions: [session('s-finished'), session('s-running', { endTime: undefined })],
      setLogs: [setLog('finished', 's-finished'), setLog('running', 's-running')],
    });
    expect(ids(snap, true)).toEqual(['finished']);
    expect(ids(snap, false)).toEqual(['finished', 'running']);
  });

  it('P166 resolveSetPopulation resolves the exercise over the workout exercise, also a soft-deleted one', () => {
    const snap = snapshot({
      templateExercises: [
        templateExercise('te-live', 'ex-reps', 'REPS'),
        templateExercise('te-deleted', 'ex-time', 'TIME', { deletedAt: 500 }),
      ],
      sessions: [session('s')],
      setLogs: [
        setLog('via-live', 's', { exerciseId: undefined, workoutExerciseId: 'te-live' }),
        setLog('via-deleted', 's', { exerciseId: undefined, workoutExerciseId: 'te-deleted' }),
        setLog('via-missing', 's', { exerciseId: undefined, workoutExerciseId: 'te-missing' }),
        setLog('own-id-wins', 's', { exerciseId: 'ex-max', workoutExerciseId: 'te-live' }),
      ],
    });
    const population = resolveSetPopulation(snap, BY_ID, { requireFinishedSession: true });
    expect(population.map((p) => [p.setLog.id, p.exerciseId])).toEqual([
      ['via-live', 'ex-reps'],
      ['via-deleted', 'ex-time'],
      ['own-id-wins', 'ex-max'],
    ]);
  });

  it('P166 resolveSetPopulation drops a set whose exercise is not a live catalog exercise', () => {
    const snap = snapshot({
      sessions: [session('s')],
      setLogs: [setLog('known', 's'), setLog('unknown', 's', { exerciseId: 'ex-gone' })],
    });
    expect(ids(snap, true)).toEqual(['known']);
  });

  it('P166 resolveSetPopulation cuts the window on the set createdAt, never on the session', () => {
    const snap = snapshot({
      sessions: [session('s', { startTime: 100, createdAt: 100 })],
      setLogs: [setLog('before', 's', { createdAt: 999 }), setLog('at', 's', { createdAt: 1_000 }), setLog('after', 's', { createdAt: 1_001 })],
    });
    expect(ids(snap, true, 1_000)).toEqual(['at', 'after']);
    expect(ids(snap, true)).toEqual(['before', 'at', 'after']);
  });

  it('P166 trainingModeOf takes the workout exercise mode, the catalog mode only as a fallback', () => {
    const teById = new Map([
      ['te-time', templateExercise('te-time', 'ex-reps', 'TIME')],
      ['te-deleted-max', templateExercise('te-deleted-max', 'ex-time', 'MAX', { deletedAt: 1 })],
    ]);
    expect(trainingModeOf(setLog('a', 's', { workoutExerciseId: 'te-time' }), teById, 'REPS')).toBe('TIME');
    expect(trainingModeOf(setLog('b', 's', { workoutExerciseId: 'te-deleted-max' }), teById, 'TIME')).toBe('MAX');
    expect(trainingModeOf(setLog('c', 's', { workoutExerciseId: 'te-missing' }), teById, 'TIME')).toBe('TIME');
    expect(trainingModeOf(setLog('d', 's'), teById, 'REPS')).toBe('REPS');
    const snap = snapshot({
      templateExercises: [templateExercise('te-time', 'ex-reps', 'TIME')],
      sessions: [session('s')],
      setLogs: [setLog('station', 's', { workoutExerciseId: 'te-time' }), setLog('plain', 's')],
    });
    const population = resolveSetPopulation(snap, BY_ID, { requireFinishedSession: true });
    expect(population.map((p) => [p.setLog.id, p.trainingMode, p.recordsTime])).toEqual([
      ['station', 'TIME', true],
      ['plain', 'REPS', false],
    ]);
    expect(recordsTime('TIME', 'REPS')).toBe(true);
  });
});
