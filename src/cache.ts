/**
 * In-memory snapshot cache with decrypt-merge, 60-second TTL, and singleton
 * inflight-promise coalescing.
 *
 * Design (RESEARCH.md Pattern 4 + Pattern 5):
 *   - Module-level `cached` stores the last resolved SnapshotCache.
 *   - Module-level `inflightPromise` coalesces concurrent first-calls so that
 *     N simultaneous tool calls in one LLM turn trigger exactly ONE server
 *     round-trip (T-120-15 fetch-stampede mitigation).
 *   - TTL_MS = 60 000 ms — matches the 60–120 s window from D-02.
 *
 * Decrypt-merge invariant (BackupSyncService.kt lines 684–695, 777–790):
 *   When the Android client has an encryption key it ZEROES plaintext metric
 *   fields before upload and stores the real values only in encryptedPayload.
 *   Both paths are handled:
 *     encryptedPayload present → decrypt() + map short keys to resolved fields
 *     encryptedPayload absent  → use plaintext DTO fields unchanged (pre-encryption data)
 *
 *   plannedWorkouts (Phase 135, D-14) — no dual path: a `planned_workout` row is
 *   always encrypted (no plaintext fallback branch). As of Phase 150 (D-08/D-09) a
 *   decrypt failure, an empty `encryptedPayload` (tombstone shape), or an unknown
 *   payload `v` no longer aborts `decryptMerge` — it is collected as an `UnreadableRow`
 *   on the `DecodeReport` returned beside the snapshot, and the row is left out of
 *   `snapshot.plannedWorkouts`. The ALL-OR-NOTHING rule Phase 135 established is still
 *   enforced, but at the CALENDAR TOOLS' boundary (`get_planned_workouts`,
 *   `get_adherence`, `propose_planned_update` — `read-guard.ts`'s
 *   `assertCalendarReadable`), not for the whole snapshot: a corrupt or tombstoned row
 *   can still never yield a partial calendar to THOSE three tools, but a tool that
 *   never reads the calendar (`get_history`, `get_stats`, …) is no longer taken down
 *   by a planned-workout row it never asked for.
 *
 * Foreign sport (Phase 155, FA-08, E-8/E-9):
 *   The three foreign sport kinds (`foreignActivityTypes`, `foreignActivities`,
 *   `plannedForeignActivities`) are always encrypted and decode per row exactly like
 *   planned workouts. Two differences: a wire field the server did not send leaves the
 *   snapshot key OUT (a server older than Phase 155), never an empty list; and the
 *   strictness lives in `read-guard.ts`'s `foreignSportAvailability`, which only ever
 *   degrades the foreign block — no existing tool fails because of a foreign row.
 *
 * Own names of catalog exercises (Phase 156, REN-01, D-10/D-11):
 *   `exerciseNameOverrides` (kind `exercise_name_override`, protocol §1.7) is always
 *   encrypted and decodes per row through the same front half as the foreign sport kinds
 *   (`decryptForeignPayload`). A missing wire field leaves the snapshot key OUT (a server
 *   older than Phase 156). An unreadable override row is counted in the `DecodeReport`
 *   under `exerciseNameOverride` and belongs to no readability check: it only takes away
 *   the own name of its one exercise in its one language, never a tool.
 *
 * Per-row decode fault tolerance (Phase 150, D-08/D-10/D-11/D-12):
 *   Sessions, set-logs, HR samples, planned workouts and settings ALL decode per row —
 *   a single bad row (`RowDecodeError` below) never aborts `decryptMerge`. Failures land
 *   in the `DecodeReport` returned alongside the snapshot (`decodeReport`, never inside
 *   `DecryptedSnapshot` itself), and `read-guard.ts` is where a tool decides how strict
 *   it needs to be about a given entity kind.
 *
 * Secrets discipline (T-120-16/T-120-17):
 *   No console.* calls — callers surface errors; this module never logs. No
 *   `RowDecodeError` message or `UnreadableRow` field ever carries plaintext, ciphertext
 *   or key material — only entity, row id, cause and the wire DTO's own plaintext
 *   routing fields.
 */

import { decrypt } from './crypto.js';
import { fetchSnapshot, fetchProfile, fetchCatalog } from './http.js';
import { classifySession } from './session-kind.js';
import type {
  SyncPullResponse,
  SyncSessionDto,
  SyncSetLogDto,
  SyncHrSampleDto,
  SyncBlockDto,
  SyncTemplateExerciseDto,
  SyncExerciseDto,
  SyncExerciseTranslationDto,
  MiscSyncRow,
  DecryptedSnapshot,
  DecryptedSession,
  DecryptedSetLog,
  DecryptedHrSample,
  DecryptedPlannedWorkout,
  DecryptedSetting,
  DecryptedForeignActivity,
  DecryptedForeignActivityType,
  DecryptedPlannedForeignActivity,
  DecryptedExerciseNameOverride,
  NormalizedBlock,
  NormalizedTemplateExercise,
  CatalogExercise,
  CatalogExerciseWire,
  CatalogTranslation,
  UserProfileResponse,
  DecodeReport,
  UnreadableReason,
  SessionFeedback,
  SessionFeedbackStateWire,
  SessionScaleFeedback,
  SessionComment,
  SessionGoal,
  SessionGoalRoundTarget,
} from './types.js';

// ---------------------------------------------------------------------------
// Cache shape
// ---------------------------------------------------------------------------

export type SnapshotCache = {
  snapshot: DecryptedSnapshot;
  catalog:  CatalogExercise[];
  profile:  UserProfileResponse;
  /** Epoch ms when this entry was populated — used for TTL check. */
  fetchedAt: number;
  /**
   * Per-row decode failures collected by `decryptMerge` (Phase 150, D-08/D-10), carried
   * BESIDE the snapshot rather than inside `DecryptedSnapshot` — every existing
   * `SnapshotCache` test-mock that predates this field (11 at last count) stays valid,
   * and every pure metric function that only ever reads `.snapshot` stays byte-identical.
   * Optional at the type level for that reason; `doFetch` below always sets it. Read it
   * via `read-guard.ts`'s `decodeReportOf()`, which supplies the empty report for a mock
   * that omits this field.
   */
  decodeReport?: DecodeReport;
};

// ---------------------------------------------------------------------------
// Per-row decode fault tolerance (Phase 150, D-08/D-09/D-10/D-11/D-12)
// ---------------------------------------------------------------------------

/**
 * Thrown by a `decrypt*` helper for exactly one row instead of aborting the whole
 * `decryptMerge` call. Carries the classification `read-guard.ts` and `decryptMerge`
 * need — never plaintext, ciphertext or key material (T-120-17); the `message` names
 * only the entity, the row id and the cause.
 */
export class RowDecodeError extends Error {
  constructor(message: string, public readonly reason: UnreadableReason) {
    super(message);
    this.name = 'RowDecodeError';
  }
}

/** A fresh `DecodeReport` with every entity's counters at zero and no unreadable rows. */
function newDecodeReport(): DecodeReport {
  return {
    unreadable: [],
    encryptedCount: {
      session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0,
      foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0,
      exerciseNameOverride: 0,
    },
    failedCount: {
      session: 0, setLog: 0, hrSample: 0, plannedWorkout: 0, setting: 0,
      foreignActivityType: 0, foreignActivity: 0, plannedForeignActivity: 0,
      exerciseNameOverride: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level cache state
// ---------------------------------------------------------------------------

const TTL_MS = 60_000; // 60 seconds (D-02: 60–120 s window)

let cached:          SnapshotCache | null        = null;
let inflightPromise: Promise<SnapshotCache> | null = null;

// ---------------------------------------------------------------------------
// Decrypt-merge helpers (both paths per BackupSyncService.kt invariant)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session feedback and goal-snapshot decoding (Phase 151, FB-03/FB-09/FB-11/D-28)
//
// Source: docs/COACH-PLANNING-PROTOCOL.md §1.3 "The session payload" / "Read rules".
// Every helper below is fully tolerant — a malformed or unrecognized field is
// dropped on its own, and `st`/`et` remain the ONLY payload keys that can make a
// session row `malformed_payload` (T-151-45). No `console.*` call ever appears here
// (T-151-46) — nothing in this section logs, and none of these functions surface raw
// plaintext in an error message.
// ---------------------------------------------------------------------------

const SESSION_FEEDBACK_STATE_WORDS: readonly string[] = [
  'not_offered', 'disabled', 'skipped', 'timeout', 'answered', 'confirmed', 'changed',
];
const SESSION_FEEDBACK_ANSWER_STATES: readonly SessionFeedbackStateWire[] = [
  'answered', 'confirmed', 'changed',
];

/** The empty feedback both scales read when nothing was ever asked (FB-03) — a
 *  legacy row, a plaintext pre-encryption row, or any row missing all eight keys. */
function emptySessionFeedback(): SessionFeedback {
  return {
    execution: { value: null, state: 'never_asked', setLaterAt: null },
    feel: { value: null, state: 'never_asked', setLaterAt: null },
    comment: null,
  };
}

/**
 * Decode one feedback scale (execution or feel) from its three wire fields.
 * Read rules (protocol §1.3, FB-03):
 *   - Missing or unrecognized `state` → `never_asked`/null/null, full stop — the
 *     accompanying `value`/`laterAt` are never read in that case.
 *   - `value` is kept only when `state` is `answered`/`confirmed`/`changed` AND the
 *     wire value is an integer `1..5`; every other combination discards it alone.
 *   - `setLaterAt` is read whenever `state` is recognized (regardless of whether it
 *     is an answer state — `skipped` legitimately carries one, protocol §1.3).
 */
function decodeScale(value: unknown, state: unknown, laterAt: unknown): SessionScaleFeedback {
  if (typeof state !== 'string' || !SESSION_FEEDBACK_STATE_WORDS.includes(state)) {
    return { value: null, state: 'never_asked', setLaterAt: null };
  }
  const stateWire = state as SessionFeedbackStateWire;
  const isAnswer = SESSION_FEEDBACK_ANSWER_STATES.includes(stateWire);
  const resolvedValue =
    isAnswer && typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
      ? value
      : null;
  const setLaterAt = typeof laterAt === 'number' ? new Date(laterAt).toISOString() : null;
  return { value: resolvedValue, state: stateWire, setLaterAt };
}

/** Decode the athlete's comment (`fc`). Never written empty/whitespace-only per the
 *  app's own write rule, but a defensive empty-string check costs nothing here. */
function decodeComment(fc: unknown): SessionComment | null {
  if (typeof fc !== 'string' || fc.length === 0) return null;
  return { text: fc, source: 'athlete_free_text', treatAs: 'data_not_instructions' };
}

/** Decode both feedback scales and the comment from the parsed payload object. */
function decodeFeedback(d: Record<string, unknown>): SessionFeedback {
  return {
    execution: decodeScale(d.fe, d.fes, d.fel),
    feel: decodeScale(d.ff, d.ffs, d.ffl),
    comment: decodeComment(d.fc),
  };
}

/** Decode one `tg[].roundTargets[]` entry. `round` is the only required field. */
function decodeGoalRoundTarget(entry: unknown): SessionGoalRoundTarget | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.round !== 'number') return null;
  const rt: SessionGoalRoundTarget = { round: e.round };
  if (typeof e.targetReps === 'number') rt.targetReps = e.targetReps;
  if (typeof e.targetTimeSeconds === 'number') rt.targetTimeSeconds = e.targetTimeSeconds;
  if (typeof e.targetWeight === 'number') rt.targetWeight = e.targetWeight;
  return rt;
}

/**
 * Decode one `tg[]` entry (D-28). `workoutExerciseId`/`exerciseId`/`mode`/`sets` are
 * required — an entry missing or mistyping any of them is dropped entirely (never
 * makes the row unreadable); every other field is additive.
 */
function decodeGoalEntry(entry: unknown): SessionGoal | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (
    typeof e.workoutExerciseId !== 'string' ||
    typeof e.exerciseId !== 'string' ||
    typeof e.mode !== 'string' ||
    typeof e.sets !== 'number'
  ) {
    return null;
  }
  const goal: SessionGoal = {
    workoutExerciseId: e.workoutExerciseId,
    exerciseId: e.exerciseId,
    mode: e.mode,
    sets: e.sets,
  };
  if (typeof e.targetReps === 'number') goal.targetReps = e.targetReps;
  if (typeof e.targetTimeSeconds === 'number') goal.targetTimeSeconds = e.targetTimeSeconds;
  if (typeof e.targetWeight === 'number') goal.targetWeight = e.targetWeight;
  if (Array.isArray(e.roundTargets)) {
    const rounds = e.roundTargets
      .map(decodeGoalRoundTarget)
      .filter((r): r is SessionGoalRoundTarget => r !== null);
    if (rounds.length > 0) goal.roundTargets = rounds;
  }
  return goal;
}

/**
 * Decode the goal snapshot (`tg`, D-28). `null` when `tg` is absent or not an array
 * (legacy row, or a free/group/QuickChallenge session that never had a template to
 * snapshot) — an array (possibly empty after dropping malformed entries) otherwise.
 */
function decodeGoals(tg: unknown): SessionGoal[] | null {
  if (!Array.isArray(tg)) return null;
  const result: SessionGoal[] = [];
  for (const entry of tg) {
    const goal = decodeGoalEntry(entry);
    if (goal !== null) result.push(goal);
  }
  return result;
}

/**
 * Decrypt-merge a single session.
 *
 * Encrypted path (encryptedPayload present, plaintext startTime=0):
 *   Decrypt payload → parse {"st":<epoch>,"et":<epoch>,...} → use resolved values.
 *   et <= 0 means the session is still ongoing → endTime = undefined.
 *   Phase 151 (FB-03/FB-09/D-28): additionally decode `feedback` (tolerant, field by
 *   field) and `goalSnapshot` — `st`/`et` remain the ONLY hard check (T-151-45).
 *
 * Plaintext path (no encryptedPayload):
 *   Use plaintext startTime / endTime unchanged (pre-encryption row). A plaintext row
 *   predates this payload's feedback keys entirely — both scales read `never_asked`,
 *   comment and goalSnapshot are `null`.
 */
export function decryptSession(s: SyncSessionDto, keyB64: string): DecryptedSession {
  const { encryptedPayload, startTime, endTime, ...rest } = s;
  if (encryptedPayload) {
    let plaintext: string;
    try {
      plaintext = decrypt(encryptedPayload, keyB64);
    } catch {
      throw new RowDecodeError(`session row ${s.id} could not be decrypted`, 'decrypt_failed');
    }
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      throw new RowDecodeError(`session row ${s.id} has a malformed payload`, 'malformed_payload');
    }
    if (typeof d.st !== 'number' || typeof d.et !== 'number') {
      throw new RowDecodeError(`session row ${s.id} has a malformed payload`, 'malformed_payload');
    }
    return {
      ...rest,
      startTime: d.st,
      endTime: d.et > 0 ? d.et : undefined,
      feedback: decodeFeedback(d),
      goalSnapshot: decodeGoals(d.tg),
    };
  }
  return { ...rest, startTime, endTime, feedback: emptySessionFeedback(), goalSnapshot: null };
}

/**
 * Decode every session row, tolerating a per-row failure (Phase 150, D-08/D-10/D-12):
 * a `RowDecodeError` from `decryptSession` above is turned into an `UnreadableRow` on
 * `report` and the row is left out of the returned array; any other thrown error counts
 * as `decrypt_failed` (`decryptSession` above never throws anything else, but a defensive
 * default here is cheap and correct). `encryptedCount.session` counts only rows that
 * actually carry `encryptedPayload` — a plaintext, pre-encryption row can never trip the
 * D-11 100%-failure guard.
 */
function decodeSessions(rows: SyncSessionDto[], keyB64: string, report: DecodeReport): DecryptedSession[] {
  const decoded: DecryptedSession[] = [];
  for (const row of rows) {
    if (row.encryptedPayload) {
      report.encryptedCount.session += 1;
    }
    try {
      decoded.push(decryptSession(row, keyB64));
    } catch (err) {
      const reason: UnreadableReason = err instanceof RowDecodeError ? err.reason : 'decrypt_failed';
      report.failedCount.session += 1;
      report.unreadable.push({
        entity: 'session',
        id: row.id,
        reason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        templateId: row.templateId,
        isQuickChallenge: row.isQuickChallenge,
        sessionKind: classifySession(row).sessionKind,
      });
    }
  }
  return decoded;
}

/**
 * Decrypt-merge a single set-log.
 *
 * Encrypted path (encryptedPayload present, all metric fields null/absent):
 *   Decrypt payload → parse {"r"?,"t"?,"w"?,"sa"?,"mt"?} → use resolved values.
 *   Keys absent in payload → null (not undefined) per DecryptedSetLog contract.
 *   Decrypt failure → `RowDecodeError('decrypt_failed')`; a plaintext that is not a
 *   JSON object → `RowDecodeError('malformed_payload')` (Phase 150, D-08/D-12).
 *
 * Plaintext path (no encryptedPayload):
 *   Convert optional metric fields to null if absent (undefined → null).
 */
function decryptSetLog(sl: SyncSetLogDto, keyB64: string): DecryptedSetLog {
  const {
    encryptedPayload,
    completedReps,
    completedTimeSeconds,
    weightUsed,
    startedAt,
    measuredTimeSeconds,
    ...rest
  } = sl;

  if (encryptedPayload) {
    let plaintext: string;
    try {
      plaintext = decrypt(encryptedPayload, keyB64);
    } catch {
      throw new RowDecodeError(`set-log row ${sl.id} could not be decrypted`, 'decrypt_failed');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new RowDecodeError(`set-log row ${sl.id} has a malformed payload`, 'malformed_payload');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new RowDecodeError(`set-log row ${sl.id} has a malformed payload`, 'malformed_payload');
    }
    const d = parsed as { r?: number; t?: number; w?: number; sa?: number; mt?: number };
    return {
      ...rest,
      completedReps:        d.r  ?? null,
      completedTimeSeconds: d.t  ?? null,
      weightUsed:           d.w  ?? null,
      startedAt:            d.sa ?? null,
      measuredTimeSeconds:  d.mt ?? null,
    };
  }

  // Plaintext path: optional fields → null if absent
  return {
    ...rest,
    completedReps:        completedReps        ?? null,
    completedTimeSeconds: completedTimeSeconds ?? null,
    weightUsed:           weightUsed           ?? null,
    startedAt:            startedAt            ?? null,
    measuredTimeSeconds:  measuredTimeSeconds  ?? null,
  };
}

/**
 * Decode every set-log row, tolerating a per-row failure (Phase 150, D-08/D-10/D-12) —
 * same shape as `decodeSessions` above. Does NOT yet know which sessions are unreadable;
 * `decryptMerge` removes set-logs of an unreadable session in a second pass (D-10).
 */
function decodeSetLogs(rows: SyncSetLogDto[], keyB64: string, report: DecodeReport): DecryptedSetLog[] {
  const decoded: DecryptedSetLog[] = [];
  for (const row of rows) {
    if (row.encryptedPayload) {
      report.encryptedCount.setLog += 1;
    }
    try {
      decoded.push(decryptSetLog(row, keyB64));
    } catch (err) {
      const reason: UnreadableReason = err instanceof RowDecodeError ? err.reason : 'decrypt_failed';
      report.failedCount.setLog += 1;
      report.unreadable.push({
        entity: 'setLog',
        id: row.id,
        reason,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  }
  return decoded;
}

/**
 * Decrypt-merge a single HR sample.
 *
 * Encrypted path: decrypt → parse {"ts":<ms>,"bpm":<bpm>}. Decrypt failure →
 * `RowDecodeError('decrypt_failed')`; `ts`/`bpm` not both numbers →
 * `RowDecodeError('malformed_payload')` (Phase 150, D-08/D-12).
 * Plaintext path: use dto fields unchanged.
 */
function decryptHrSample(hr: SyncHrSampleDto, keyB64: string): DecryptedHrSample {
  const { encryptedPayload, timestampMs, bpm, ...rest } = hr;
  if (encryptedPayload) {
    let plaintext: string;
    try {
      plaintext = decrypt(encryptedPayload, keyB64);
    } catch {
      throw new RowDecodeError(`hr-sample row ${hr.id} could not be decrypted`, 'decrypt_failed');
    }
    let d: { ts: unknown; bpm: unknown };
    try {
      d = JSON.parse(plaintext) as { ts: unknown; bpm: unknown };
    } catch {
      throw new RowDecodeError(`hr-sample row ${hr.id} has a malformed payload`, 'malformed_payload');
    }
    if (typeof d.ts !== 'number' || typeof d.bpm !== 'number') {
      throw new RowDecodeError(`hr-sample row ${hr.id} has a malformed payload`, 'malformed_payload');
    }
    return { ...rest, timestampMs: d.ts, bpm: d.bpm };
  }
  return { ...rest, timestampMs, bpm };
}

/**
 * Decode every HR-sample row, tolerating a per-row failure — same shape as
 * `decodeSetLogs` above, including the second-pass removal for an unreadable session
 * (D-10). HR samples carry no `createdAt`/`updatedAt` on the wire (`SyncHrSampleDto`).
 */
function decodeHrSamples(rows: SyncHrSampleDto[], keyB64: string, report: DecodeReport): DecryptedHrSample[] {
  const decoded: DecryptedHrSample[] = [];
  for (const row of rows) {
    if (row.encryptedPayload) {
      report.encryptedCount.hrSample += 1;
    }
    try {
      decoded.push(decryptHrSample(row, keyB64));
    } catch (err) {
      const reason: UnreadableReason = err instanceof RowDecodeError ? err.reason : 'decrypt_failed';
      report.failedCount.hrSample += 1;
      report.unreadable.push({
        entity: 'hrSample',
        id: row.id,
        reason,
        sessionId: row.sessionId,
      });
    }
  }
  return decoded;
}

/**
 * Decrypt-merge a single `planned_workout` row (Phase 135, D-14; Phase 150, D-08/D-09).
 * Unlike `decryptSession`/`decryptSetLog`/`decryptHrSample` there is NO plaintext
 * fallback branch — a `planned_workout` row is always encrypted. Four explicit guards,
 * each throwing a `RowDecodeError` that names the row's `id` and the cause but NEVER
 * the key or the PAT (T-120-17):
 *   (a) an empty `encryptedPayload` — the tombstone shape the server already filters
 *       out (133 D-03); its arrival means the pull contract changed, so the message
 *       says that rather than skipping the row (`malformed_payload`);
 *   (b) a decrypt failure (`decrypt_failed`);
 *   (c) a decrypted payload whose `v` is not `1` (`unknown_version` — this entity DOES
 *       carry a schema version, unlike session/setLog/hrSample);
 *   (d) a decrypted payload missing one of the required `id`/`templateId`/
 *       `scheduledDate` fields (`malformed_payload`).
 * Parsed with a type assertion, not Zod — matching decryptSession/decryptSetLog: Zod
 * in this codebase guards LLM-supplied tool input, not internally decrypted payloads.
 * `calendarEventId` and `createdAt` are deliberately NOT copied onto
 * `DecryptedPlannedWorkout` (D-06) — the type has no field for them.
 *
 * STILL exported and STILL throws (never caught internally) — like `normalizeWireBlock`
 * above — not for convenience but because the shared corpus's `plannedWorkoutCipher`
 * vector (D-12) and `decodePlannedWorkouts` below both must run through this EXACT
 * function, not a test-local copy of it, so the parity proof covers the real decode
 * boundary rather than a re-implementation of it (`tests/shared-vectors.test.ts`). Only
 * `decryptMerge` catches what this function throws — a direct caller (the corpus test)
 * still sees the `RowDecodeError` propagate.
 */
export function decryptPlannedWorkout(row: MiscSyncRow, keyB64: string): DecryptedPlannedWorkout {
  if (!row.encryptedPayload) {
    throw new RowDecodeError(
      `planned_workout row ${row.id} arrived with an empty encryptedPayload — this is the ` +
        'tombstone shape the server should already filter out of plannedWorkouts (133 D-03); ' +
        'the pull contract may have changed',
      'malformed_payload',
    );
  }
  let plaintextJson: string;
  try {
    plaintextJson = decrypt(row.encryptedPayload, keyB64);
  } catch {
    throw new RowDecodeError(`planned_workout row ${row.id} could not be decrypted`, 'decrypt_failed');
  }
  let plaintext: {
    v: number;
    id: string;
    templateId: string;
    scheduledDate: number;
    scheduledTime?: string | null;
    note?: string | null;
    recurrenceRule?: string | null;
    recurrenceGroupId?: string | null;
    deletedOccurrences?: string | null;
    completedSessionId?: string | null;
  };
  try {
    plaintext = JSON.parse(plaintextJson) as typeof plaintext;
  } catch {
    throw new RowDecodeError(`planned_workout row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  if (plaintext.v !== 1) {
    throw new RowDecodeError(`planned_workout row ${row.id} has unknown schema version v=${plaintext.v}`, 'unknown_version');
  }
  if (typeof plaintext.id !== 'string' || typeof plaintext.templateId !== 'string' || typeof plaintext.scheduledDate !== 'number') {
    throw new RowDecodeError(`planned_workout row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  return {
    id: plaintext.id,
    templateId: plaintext.templateId,
    scheduledDate: plaintext.scheduledDate,
    scheduledTime: plaintext.scheduledTime ?? null,
    note: plaintext.note ?? null,
    recurrenceRule: plaintext.recurrenceRule ?? null,
    recurrenceGroupId: plaintext.recurrenceGroupId ?? null,
    deletedOccurrencesRaw: plaintext.deletedOccurrences ?? null,
    completedSessionId: plaintext.completedSessionId ?? null,
    // calendarEventId, createdAt: D-06 — deliberately not copied; the type has no
    // field to carry them.
  };
}

// ---------------------------------------------------------------------------
// Foreign sport decoders (Phase 155, FA-08; protocol §1.6 "Decoded rows")
// ---------------------------------------------------------------------------

/** `yyyy-MM-dd` — the shape of `performedOn` (the athlete's local calendar day). */
const FOREIGN_LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The common front half of the three foreign sport decoders (and, since Phase 156, of
 * `decryptExerciseNameOverride`): tombstone-shaped empty
 * payload, decrypt failure, plaintext that is not a JSON object, `v` not one of
 * `allowedVersions` (default `[1]`; the foreign sport decoders keep it, the own names of
 * catalog exercises read versions 1 and 2 since the gap round of Phase 156, D-22). Every
 * guard throws a `RowDecodeError` naming only the wire kind, the row id and the cause —
 * never plaintext, ciphertext or key material (T-120-17, T-155-24); the `v` that does not
 * match is not echoed either, because it comes from inside the decrypted payload.
 */
function decryptForeignPayload(
  row: MiscSyncRow,
  keyB64: string,
  wireKind: string,
  allowedVersions: readonly number[] = [1],
): Record<string, unknown> {
  if (!row.encryptedPayload) {
    throw new RowDecodeError(
      `${wireKind} row ${row.id} arrived with an empty encryptedPayload — this is the tombstone ` +
        'shape the server should already filter out (Plans 155-03, 156-04); the pull contract may have changed',
      'malformed_payload',
    );
  }
  let plaintextJson: string;
  try {
    plaintextJson = decrypt(row.encryptedPayload, keyB64);
  } catch {
    throw new RowDecodeError(`${wireKind} row ${row.id} could not be decrypted`, 'decrypt_failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintextJson);
  } catch {
    throw new RowDecodeError(`${wireKind} row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RowDecodeError(`${wireKind} row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  const plaintext = parsed as Record<string, unknown>;
  if (typeof plaintext.v !== 'number' || !allowedVersions.includes(plaintext.v)) {
    throw new RowDecodeError(`${wireKind} row ${row.id} has an unknown schema version`, 'unknown_version');
  }
  return plaintext;
}

/** A non-empty string, else `undefined` — the test for a required id field. */
function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A string optional: the string itself, anything else (missing, `null`, a number) `null`. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An integer in `min..max`, anything else `null` (D-16: "not measured", never 0). */
function optionalIntInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** The payload's own timestamp, else the routing timestamp of the wire row. */
function timestampOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Decrypt one `foreign_activity` row into its §1.6 normal form (Phase 155, FA-08).
 *
 * Unreadable (throws `RowDecodeError`): empty payload, decrypt failure, plaintext that is
 * not a JSON object, `v !== 1` (`unknown_version`), and a missing or malformed required
 * field — `id`, `typeId`, `performedOn` matching `yyyy-MM-dd`, `durationMinutes` an
 * integer greater than 0 (`malformed_payload`).
 *
 * Readable with a value dropped (D-16): `intensity` and `dayForm` only as integers 1..5,
 * `distanceMeters` only as an integer greater than 0 (protocol §1.6 and the app's own
 * `ForeignActivityValidation`, 1..max) — anything else becomes `null` and the row stays
 * readable. Missing optionals become `null`; `v` is dropped.
 *
 * Exported and throwing for the same reason as `decryptPlannedWorkout`: the corpus replay
 * (`tests/shared-vectors.test.ts`) must run through this exact function. Never logs —
 * `note` is athlete free text.
 */
export function decryptForeignActivity(row: MiscSyncRow, keyB64: string): DecryptedForeignActivity {
  const p = decryptForeignPayload(row, keyB64, 'foreign_activity');
  const id = requiredString(p.id);
  const typeId = requiredString(p.typeId);
  const performedOn = typeof p.performedOn === 'string' && FOREIGN_LOCAL_DATE.test(p.performedOn) ? p.performedOn : undefined;
  const durationMinutes =
    typeof p.durationMinutes === 'number' && Number.isInteger(p.durationMinutes) && p.durationMinutes > 0
      ? p.durationMinutes
      : undefined;
  if (id === undefined || typeId === undefined || performedOn === undefined || durationMinutes === undefined) {
    throw new RowDecodeError(`foreign_activity row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  return {
    id,
    typeId,
    performedOn,
    performedTime: optionalString(p.performedTime),
    durationMinutes,
    intensity: optionalIntInRange(p.intensity, 1, 5),
    dayForm: optionalIntInRange(p.dayForm, 1, 5),
    distanceMeters: optionalIntInRange(p.distanceMeters, 1, Number.MAX_SAFE_INTEGER),
    note: optionalString(p.note),
    createdAt: timestampOr(p.createdAt, row.createdAt),
    updatedAt: timestampOr(p.updatedAt, row.updatedAt),
  };
}

/**
 * Decrypt one `foreign_activity_type` row (an own type, Phase 155, FA-08) into its §1.6
 * normal form `{ id, name, createdAt, updatedAt, deletedAt }`. Unreadable (throws
 * `RowDecodeError`): the front-half guards of `decryptForeignPayload`, and a missing or
 * empty `id`/`name` (`malformed_payload`). `deletedAt` is a number for an archived own
 * type (154 D-10) and `null` otherwise. `name` is athlete free text — never logged, and
 * wrapped before it reaches any tool output (`foreign-types.ts`).
 */
export function decryptForeignActivityType(row: MiscSyncRow, keyB64: string): DecryptedForeignActivityType {
  const p = decryptForeignPayload(row, keyB64, 'foreign_activity_type');
  const id = requiredString(p.id);
  const name = requiredString(p.name);
  if (id === undefined || name === undefined) {
    throw new RowDecodeError(`foreign_activity_type row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  return {
    id,
    name,
    createdAt: timestampOr(p.createdAt, row.createdAt),
    updatedAt: timestampOr(p.updatedAt, row.updatedAt),
    deletedAt: typeof p.deletedAt === 'number' && Number.isFinite(p.deletedAt) ? p.deletedAt : null,
  };
}

/**
 * Decrypt one `planned_foreign_activity` row (an appointment root, Phase 155, FA-08) into
 * its §1.6 normal form. Unreadable (throws `RowDecodeError`): the front-half guards of
 * `decryptForeignPayload`, and a missing `id`/`typeId` or a non-numeric `scheduledDate`
 * (`malformed_payload`). `deletedOccurrences` is carried as the raw stored string in
 * `deletedOccurrencesRaw`, never parsed here — exactly like `decryptPlannedWorkout`.
 */
export function decryptPlannedForeignActivity(row: MiscSyncRow, keyB64: string): DecryptedPlannedForeignActivity {
  const p = decryptForeignPayload(row, keyB64, 'planned_foreign_activity');
  const id = requiredString(p.id);
  const typeId = requiredString(p.typeId);
  const scheduledDate =
    typeof p.scheduledDate === 'number' && Number.isFinite(p.scheduledDate) ? p.scheduledDate : undefined;
  if (id === undefined || typeId === undefined || scheduledDate === undefined) {
    throw new RowDecodeError(`planned_foreign_activity row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  return {
    id,
    typeId,
    scheduledDate,
    scheduledTime: optionalString(p.scheduledTime),
    note: optionalString(p.note),
    recurrenceRule: optionalString(p.recurrenceRule),
    deletedOccurrencesRaw: optionalString(p.deletedOccurrences),
    createdAt: timestampOr(p.createdAt, row.createdAt),
    updatedAt: timestampOr(p.updatedAt, row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Own names of catalog exercises (Phase 156, REN-01; protocol §1.7 "Decoded rows")
// ---------------------------------------------------------------------------

/**
 * Decrypt one `exercise_name_override` row into its §1.7 normal form
 * `{ exerciseId, languageCode, name, description, updatedAt }` (Phase 156, REN-01, D-11).
 *
 * Unreadable (throws `RowDecodeError`): the front-half guards of `decryptForeignPayload` —
 * empty payload (`malformed_payload`), decrypt failure (`decrypt_failed`), plaintext that
 * is not a JSON object (`malformed_payload`), `v` neither 1 nor 2 (`unknown_version`) —
 * and a missing or empty `exerciseId`, `languageCode` or `name` (`malformed_payload`);
 * only version 2 may carry `name: null` (name not overridden, D-22).
 *
 * `description` is a string or `null`; an empty string decodes as `null` (D-01: never the
 * empty string). A decoder neither cuts nor rejects a value because of its length — the
 * corpus pins a name at `NAME_MAX` and a description at `DESCRIPTION_MAX` byte for byte.
 * `updatedAt` is the edit time inside the payload, else the wire row's routing timestamp.
 *
 * Exported and throwing for the same reason as `decryptPlannedWorkout`: the corpus replay
 * (`tests/shared-vectors.test.ts`) must run through this exact function. Never logs —
 * `name` and `description` are athlete free text, and no error message carries them.
 */
export function decryptExerciseNameOverride(row: MiscSyncRow, keyB64: string): DecryptedExerciseNameOverride {
  const p = decryptForeignPayload(row, keyB64, 'exercise_name_override', [1, 2]);
  const exerciseId = requiredString(p.exerciseId);
  const languageCode = requiredString(p.languageCode);
  // Version 2 (D-22): `name: null` = the name is not overridden and stays the catalog name.
  const name: string | null | undefined = p.v === 2 && p.name === null ? null : requiredString(p.name);
  if (exerciseId === undefined || languageCode === undefined || name === undefined) {
    throw new RowDecodeError(`exercise_name_override row ${row.id} has a malformed payload`, 'malformed_payload');
  }
  const description = optionalString(p.description);
  return {
    exerciseId,
    languageCode,
    name,
    description: description === '' ? null : description,
    updatedAt: timestampOr(p.updatedAt, row.updatedAt),
  };
}

/**
 * Decode every planned-workout row, tolerating a per-row failure (Phase 150,
 * D-08/D-09/D-10/D-12) — same shape as `decodeSessions` above, calling the exported
 * `decryptPlannedWorkout` (which still throws) per row.
 */
function decodePlannedWorkouts(rows: MiscSyncRow[], keyB64: string, report: DecodeReport): DecryptedPlannedWorkout[] {
  const decoded: DecryptedPlannedWorkout[] = [];
  for (const row of rows) {
    if (row.encryptedPayload) {
      report.encryptedCount.plannedWorkout += 1;
    }
    try {
      decoded.push(decryptPlannedWorkout(row, keyB64));
    } catch (err) {
      const reason: UnreadableReason = err instanceof RowDecodeError ? err.reason : 'decrypt_failed';
      report.failedCount.plannedWorkout += 1;
      report.unreadable.push({
        entity: 'plannedWorkout',
        id: row.id,
        reason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  }
  return decoded;
}

/**
 * Decrypt-merge a single `settings` row (Phase 137, D-03; Phase 150, D-08/D-12). Like
 * `decryptPlannedWorkout` there is NO plaintext fallback branch — a `settings` row is
 * always encrypted. Four explicit guards, each throwing a `RowDecodeError` — a
 * tombstone-shaped empty `encryptedPayload`, a decrypt failure, an unknown schema
 * version `v`, or a missing type tag `t` (all four detailed below) — instead of
 * aborting the whole `decryptMerge` call: the row is left out of `snapshot.settings`
 * and reported on `decodeReport` instead (Plan 150-02 Task 2 moved this off the old
 * all-or-nothing path; the read-guard boundary that still needs "this account's time
 * zone is unreadable" strictness is `read-guard.ts`'s `assertTimeZoneReadable`).
 * Parsed with a type assertion, not Zod — matching decryptSession/decryptSetLog/
 * decryptPlannedWorkout: Zod in this codebase guards LLM-supplied tool input, not
 * internally decrypted payloads.
 *
 * Never logs the decrypted `value` or the row's own fields into an error message (T-120-17).
 */
export function decryptSetting(row: MiscSyncRow, keyB64: string): DecryptedSetting {
  if (!row.encryptedPayload) {
    throw new RowDecodeError(
      `settings row ${row.id} (key "${row.clientLocalId}") arrived with an empty encryptedPayload — ` +
        'this is the tombstone shape the server should already filter out of settings; the pull ' +
        'contract may have changed',
      'malformed_payload',
    );
  }
  let plaintextJson: string;
  try {
    plaintextJson = decrypt(row.encryptedPayload, keyB64);
  } catch {
    throw new RowDecodeError(`settings row ${row.id} (key "${row.clientLocalId}") could not be decrypted`, 'decrypt_failed');
  }
  let plaintext: { v: number; t: string; value: string };
  try {
    plaintext = JSON.parse(plaintextJson) as { v: number; t: string; value: string };
  } catch {
    throw new RowDecodeError(`settings row ${row.id} (key "${row.clientLocalId}") has a malformed payload`, 'malformed_payload');
  }
  if (plaintext.v !== 1) {
    throw new RowDecodeError(`settings row ${row.id} (key "${row.clientLocalId}") has unknown schema version v=${plaintext.v}`, 'unknown_version');
  }
  if (!plaintext.t) {
    throw new RowDecodeError(`settings row ${row.id} (key "${row.clientLocalId}") is missing its type tag`, 'malformed_payload');
  }
  return { key: row.clientLocalId, type: plaintext.t, value: plaintext.value };
}

/**
 * Decode every settings row, tolerating a per-row failure — same shape as
 * `decodeSessions` above, calling the exported `decryptSetting` (which still throws)
 * per row. `key` on the `UnreadableRow` is `row.clientLocalId` — the settings key name,
 * never the decrypted `value` (T-120-17).
 */
function decodeSettings(rows: MiscSyncRow[], keyB64: string, report: DecodeReport): DecryptedSetting[] {
  const decoded: DecryptedSetting[] = [];
  for (const row of rows) {
    if (row.encryptedPayload) {
      report.encryptedCount.setting += 1;
    }
    try {
      decoded.push(decryptSetting(row, keyB64));
    } catch (err) {
      const reason: UnreadableReason = err instanceof RowDecodeError ? err.reason : 'decrypt_failed';
      report.failedCount.setting += 1;
      report.unreadable.push({
        entity: 'setting',
        id: row.id,
        reason,
        key: row.clientLocalId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  }
  return decoded;
}

/**
 * Decode every row of one foreign sport kind, tolerating a per-row failure (Phase 155,
 * E-8) — same shape as `decodePlannedWorkouts`, generic over the three exported decoders.
 * An unreadable row is reported by entity, id, reason and routing timestamps only, never
 * with content; it makes the foreign block unavailable (`read-guard.ts`'s
 * `foreignSportAvailability`) and touches nothing else.
 *
 * Since Phase 156 (D-10) the same loop decodes the own names of catalog exercises
 * (`exerciseNameOverride`): an unreadable override is reported the same way and takes
 * away only its own exercise's own name — no availability rule reads it.
 */
function decodeForeignRows<T>(
  rows: MiscSyncRow[],
  keyB64: string,
  report: DecodeReport,
  entity: 'foreignActivityType' | 'foreignActivity' | 'plannedForeignActivity' | 'exerciseNameOverride',
  decryptRow: (row: MiscSyncRow, keyB64: string) => T,
): T[] {
  const decoded: T[] = [];
  for (const row of rows) {
    if (row.encryptedPayload) {
      report.encryptedCount[entity] += 1;
    }
    try {
      decoded.push(decryptRow(row, keyB64));
    } catch (err) {
      const reason: UnreadableReason = err instanceof RowDecodeError ? err.reason : 'decrypt_failed';
      report.failedCount[entity] += 1;
      report.unreadable.push({
        entity,
        id: row.id,
        reason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  }
  return decoded;
}

/**
 * Re-insert the Kotlin-default wire value for a block whose `rounds` key the wire omitted
 * (G-134-37, planhash-wire-defaults-parity.md). Exported — NOT file-private — for two
 * reasons: (1) `tests/hash.test.ts`'s regression vector must run through this exact function,
 * not a test-local copy that would only prove a fixture contains the values it was given, and
 * (2) it stands beside `decrypt*` above as the same kind of pure per-entity transform. This is
 * the ONLY decode boundary in the MCP (`decryptMerge` below) — normalizing here heals every
 * reader of `rounds` at once (`hash.ts` and `get_template.ts`).
 *
 * Ergänzt nur einen fehlenden Schlüssel — ein vorhandener Wert (auch `0`, falls das je gültig
 * würde) bleibt unangetastet, weil `??` ausschließlich auf `null`/`undefined` reagiert.
 */
export function normalizeWireBlock(b: SyncBlockDto): NormalizedBlock {
  return { ...b, rounds: b.rounds ?? 1 };
}

/**
 * Re-insert the Kotlin-default wire values for a template-exercise whose `sets` and/or
 * `exerciseSource` keys the wire omitted (G-134-37). Exported for the same two reasons as
 * `normalizeWireBlock` above.
 */
export function normalizeWireTemplateExercise(te: SyncTemplateExerciseDto): NormalizedTemplateExercise {
  return { ...te, sets: te.sets ?? 1, exerciseSource: te.exerciseSource ?? 'CATALOG' };
}

/**
 * Remove every row of `rows` whose `sessionId` points at a session that ended up
 * unreadable, counting each removal on that session's own `UnreadableRow` entry via
 * `countField` (Phase 150, D-10). A row whose `sessionId` matches NO session at all
 * (readable or unreadable — an orphan, already possible before this plan) is left
 * completely untouched, so a clean dataset with no unreadable rows stays byte-identical.
 */
function removeRowsOfUnreadableSessions<T extends { sessionId: string }>(
  rows: T[],
  unreadableSessionIds: ReadonlySet<string>,
  report: DecodeReport,
  countField: 'affectedSetLogCount' | 'affectedHrSampleCount',
): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    if (unreadableSessionIds.has(row.sessionId)) {
      const sessionRow = report.unreadable.find((r) => r.entity === 'session' && r.id === row.sessionId);
      if (sessionRow) {
        sessionRow[countField] = (sessionRow[countField] ?? 0) + 1;
      }
    } else {
      kept.push(row);
    }
  }
  return kept;
}

/**
 * Apply decrypt-merge to every encrypted entity in the raw snapshot. Every entity now
 * decodes per row (Phase 150, D-08) and never aborts the whole call — a failure is
 * collected on the returned `decodeReport` instead of thrown out of this function.
 *
 * Set-logs and HR samples get a second pass (D-10): any row whose `sessionId` points at
 * a session that itself ended up unreadable is removed from the snapshot and counted on
 * that session's own `UnreadableRow` (`affectedSetLogCount`/`affectedHrSampleCount`)
 * instead of appearing as its own entry — its own decode already succeeded, it is the
 * session context that is gone. A set-log/HR row that fails to decode ON ITS OWN merit
 * still gets its own `UnreadableRow` via `decodeSetLogs`/`decodeHrSamples` above,
 * regardless of whether its session is readable.
 */
function decryptMerge(raw: SyncPullResponse, keyB64: string): { snapshot: DecryptedSnapshot; decodeReport: DecodeReport } {
  const decodeReport = newDecodeReport();

  // EVERY list below carries `?? []`, not just the two that used to. `McpDataPullResponse`
  // declares all of them `= emptyList()` and the server serializes with
  // `encodeDefaults = false`, so ANY of them can be absent from the wire the moment it is
  // empty — see the block comment on `SyncPullResponse` in types.ts for the measurement that
  // made this concrete. An unguarded assignment here does not fail here: it puts `undefined`
  // into the snapshot and fails much later, at whatever `.filter` touches it first, with a
  // message that names neither the field nor this function.
  const sessions = decodeSessions(raw.sessions ?? [], keyB64, decodeReport);
  const unreadableSessionIds = new Set(
    decodeReport.unreadable.filter((r) => r.entity === 'session').map((r) => r.id),
  );

  let setLogs = decodeSetLogs(raw.setLogs ?? [], keyB64, decodeReport);
  let hrSamples = decodeHrSamples(raw.hrSamples ?? [], keyB64, decodeReport);

  if (unreadableSessionIds.size > 0) {
    setLogs = removeRowsOfUnreadableSessions(setLogs, unreadableSessionIds, decodeReport, 'affectedSetLogCount');
    hrSamples = removeRowsOfUnreadableSessions(hrSamples, unreadableSessionIds, decodeReport, 'affectedHrSampleCount');
  }

  const snapshot: DecryptedSnapshot = {
    syncedAt:             raw.syncedAt,
    exercises:            raw.exercises ?? [],
    exerciseTranslations: raw.exerciseTranslations ?? [],
    templates:            raw.templates ?? [],
    blocks:               (raw.blocks ?? []).map(normalizeWireBlock),
    templateExercises:    (raw.templateExercises ?? []).map(normalizeWireTemplateExercise),
    sessions,
    setLogs,
    hrSamples,
    plannedWorkouts: decodePlannedWorkouts(raw.plannedWorkouts ?? [], keyB64, decodeReport),
    settings: decodeSettings(raw.settings ?? [], keyB64, decodeReport),
    // Phase 155 (E-9): deliberately NO `?? []` here, unlike every list above. The server
    // sends these fields always (Plan 155-03); a missing one means a server older than
    // Phase 155, and the snapshot key is then left out so `foreignSportAvailability`
    // can say so instead of reporting "no foreign sport".
    // `!= null` rather than `!== undefined`: an explicit JSON `null` (never sent by the
    // Kotlin DTO, but cheap to survive) reads as "field absent" instead of crashing the loop.
    ...(raw.foreignActivityTypes != null
      ? {
          foreignActivityTypes: decodeForeignRows(
            raw.foreignActivityTypes, keyB64, decodeReport, 'foreignActivityType', decryptForeignActivityType,
          ),
        }
      : {}),
    ...(raw.foreignActivities != null
      ? {
          foreignActivities: decodeForeignRows(
            raw.foreignActivities, keyB64, decodeReport, 'foreignActivity', decryptForeignActivity,
          ),
        }
      : {}),
    ...(raw.plannedForeignActivities != null
      ? {
          plannedForeignActivities: decodeForeignRows(
            raw.plannedForeignActivities, keyB64, decodeReport, 'plannedForeignActivity', decryptPlannedForeignActivity,
          ),
        }
      : {}),
    // Phase 156 (D-11): same rule as the foreign fields — the server sends the field
    // always (Plan 156-04); a missing one means a server older than Phase 156, and the
    // snapshot key is then left out rather than reported as "no own names".
    ...(raw.exerciseNameOverrides != null
      ? {
          exerciseNameOverrides: decodeForeignRows(
            raw.exerciseNameOverrides, keyB64, decodeReport, 'exerciseNameOverride', decryptExerciseNameOverride,
          ),
        }
      : {}),
  };

  return { snapshot, decodeReport };
}

/**
 * Turn the raw wire catalog (`CatalogExerciseWire[]`, whatever `GET /api/exercises` actually
 * sent) into the normalized, always-safe-to-read `CatalogExercise[]` every tool and
 * training-state module in this codebase assumes.
 *
 * THIS IS THE ONE SEAM (CAP-05 gap-closure, 2026-09-06). `capabilities`, `equipment`, and
 * `isSkill` are the three `Dtos.kt` fields with a Kotlin-side default (`= emptyList()` /
 * `= false`), so kotlinx.serialization's `encodeDefaults = false` omits each of them from the
 * JSON whenever an exercise carries only the default value — measured directly against the
 * live production catalog, 75/189 exercises omit `capabilities` and 164/189 omit `isSkill`.
 * Before this function existed, three separate consumers (`get_stats.ts`'s
 * `getStatsByCapabilities`, `training-state/adherence.ts`'s `buildCombinedVector` call, and the
 * latent `training-state/capability-balance.ts`'s `capabilitySetCountsInPeriod`) each assumed
 * `ex.capabilities` was always a real array and threw `TypeError` on the omitted-field case —
 * that is exactly the bug this function exists to close, once, for every current AND future
 * consumer. Never let a second call site read `fetchCatalog()`'s result directly — always
 * route it through here.
 */
export function normalizeCatalog(wireCatalog: CatalogExerciseWire[]): CatalogExercise[] {
  return wireCatalog.map((ex) => ({
    ...ex,
    capabilities: ex.capabilities ?? [],
    equipment:    ex.equipment ?? [],
    isSkill:      ex.isSkill ?? false,
    origin:       'CATALOG' as const,
  }));
}

/**
 * Project a single user-created exercise (`snapshot.exercises`, `isPredefined = 0` server-side)
 * onto the same `CatalogExercise` shape the curated catalog uses, so every existing and future
 * reader of `data.catalog` resolves it without a second lookup path (141-18, G-141-2-SCOPE).
 *
 * Exported — like `normalizeCatalog` above — because it is tested directly, and because it
 * belongs beside `normalizeCatalog` as part of the one seam: this is the only place in the
 * codebase allowed to turn a `SyncExerciseDto` into a `CatalogExercise`.
 *
 * Deliberately NOT a decode boundary for muscle/equipment/capability data: a user exercise
 * carries none of that server-side, so `muscleGroups`/`equipment`/`capabilities` are always `[]`
 * and `isSkill` is always `false` here — an empty list is the truth (unrated), never a
 * placeholder standing in for data this function forgot to fetch. Inventing a muscle group,
 * equipment link or capability axis for a user exercise would poison every weighted evaluation
 * downstream (T-141-80) and is prohibited even implicitly.
 *
 * `key` uses a `user_exercise:<id>` prefix, deliberately carrying a colon — every curated
 * catalog key is lowercase-with-underscore and never contains one (see `data/exercises.sql`),
 * so this key can never collide with a catalog key and is recognizable as a user exercise on
 * sight, independently of the `origin` field.
 *
 * `lastModifiedAt` is the user exercise's own `updatedAt` — there is no separate "catalog last
 * touched" timestamp to fall back to for a row the catalog never curated.
 */
export function projectUserExerciseToCatalog(
  ex: SyncExerciseDto,
  allTranslations: SyncExerciseTranslationDto[],
): CatalogExercise {
  const translations: CatalogTranslation[] = allTranslations
    .filter((t) => t.exerciseId === ex.id)
    .map((t) => ({
      languageCode: t.languageCode,
      name:         t.name,
      description:  t.description,
    }));

  return {
    id:             ex.id,
    key:            `user_exercise:${ex.id}`,
    nameEn:         ex.name,
    mode:           ex.mode,
    usesWeight:     ex.usesWeight,
    description:    ex.description,
    lastModifiedAt: ex.updatedAt,
    translations,
    // Never invented — an unrated exercise contributes nothing to a weighted evaluation, and a
    // fabricated non-empty value here would look like a real measurement (T-141-80).
    muscleGroups: [],
    equipment:    [],
    isSkill:      false,
    capabilities: [],
    origin:       'CUSTOM',
  };
}

// ---------------------------------------------------------------------------
// Fetch + populate
// ---------------------------------------------------------------------------

async function doFetch(
  pat:       string,
  keyB64:    string,
  serverUrl: string,
): Promise<SnapshotCache> {
  // Fetch all three endpoints in parallel (one round-trip per tool call burst)
  const [rawSnapshot, profile, rawCatalog] = await Promise.all([
    fetchSnapshot(pat, serverUrl),
    fetchProfile(pat,  serverUrl),
    fetchCatalog(serverUrl),
  ]);

  const { snapshot, decodeReport } = decryptMerge(rawSnapshot, keyB64);
  const curatedCatalog = normalizeCatalog(rawCatalog);

  // 141-18 (G-141-2-SCOPE): the one seam where snapshot and catalog are both in hand for the
  // first time. Curated entries go first and a user exercise whose id the catalog already
  // knows is dropped — the curated catalog carries the ratings, so on an id collision it wins
  // (T-141-82). A soft-deleted user exercise (`deletedAt` set) is dropped too (T-141-83).
  const curatedIds = new Set(curatedCatalog.map((ex) => ex.id));
  const projectedUserExercises = snapshot.exercises
    .filter((ex) => !ex.deletedAt && !curatedIds.has(ex.id))
    .map((ex) => projectUserExerciseToCatalog(ex, snapshot.exerciseTranslations));
  const catalog = [...curatedCatalog, ...projectedUserExercises];

  return { snapshot, catalog, profile, fetchedAt: Date.now(), decodeReport };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the fully-decrypted snapshot (with catalog + profile) for one LLM turn.
 *
 * - Cache hit (within TTL_MS): returns cached data immediately.
 * - Inflight request: returns the same Promise (coalesces concurrent callers).
 * - Cache miss / expired: starts a new fetch, caches the result, returns it.
 *
 * @param pat       CALICOMP_PAT bearer token
 * @param keyB64    CALICOMP_KEY raw base64-encoded AES-256 key
 * @param serverUrl Base URL for CalisthenicsServer
 */
export async function getSnapshot(
  pat:       string,
  keyB64:    string,
  serverUrl: string,
): Promise<SnapshotCache> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) return cached;
  if (inflightPromise) return inflightPromise;

  inflightPromise = doFetch(pat, keyB64, serverUrl).finally(() => {
    inflightPromise = null;
  });
  cached = await inflightPromise;
  return cached;
}

// ---------------------------------------------------------------------------
// Test-only helpers (not for production use)
// ---------------------------------------------------------------------------

/**
 * Reset all module-level cache state.
 * Exported for test isolation — do NOT call from production code.
 */
export function __resetCache(): void {
  cached          = null;
  inflightPromise = null;
}
