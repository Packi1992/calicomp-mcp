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
 *   plannedWorkouts (Phase 135, D-14) — ALL-OR-NOTHING, no dual path: a
 *   `planned_workout` row is always encrypted (no plaintext fallback branch), and a
 *   decrypt failure, an empty `encryptedPayload` (tombstone shape), or an unknown
 *   payload `v` THROWS — propagating out of decryptMerge and failing the whole
 *   getSnapshot() call. There is no skip-and-count path: a corrupt or tombstoned row
 *   can never yield a partial calendar the coach reasons from.
 *
 * Secrets discipline (T-120-16):
 *   No console.* calls — callers surface errors; this module never logs.
 */

import { decrypt } from './crypto.js';
import { fetchSnapshot, fetchProfile, fetchCatalog } from './http.js';
import type {
  SyncPullResponse,
  SyncSessionDto,
  SyncSetLogDto,
  SyncHrSampleDto,
  SyncBlockDto,
  SyncTemplateExerciseDto,
  MiscSyncRow,
  DecryptedSnapshot,
  DecryptedSession,
  DecryptedSetLog,
  DecryptedHrSample,
  DecryptedPlannedWorkout,
  DecryptedSetting,
  NormalizedBlock,
  NormalizedTemplateExercise,
  CatalogExercise,
  CatalogExerciseWire,
  UserProfileResponse,
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
};

// ---------------------------------------------------------------------------
// Module-level cache state
// ---------------------------------------------------------------------------

const TTL_MS = 60_000; // 60 seconds (D-02: 60–120 s window)

let cached:          SnapshotCache | null        = null;
let inflightPromise: Promise<SnapshotCache> | null = null;

// ---------------------------------------------------------------------------
// Decrypt-merge helpers (both paths per BackupSyncService.kt invariant)
// ---------------------------------------------------------------------------

/**
 * Decrypt-merge a single session.
 *
 * Encrypted path (encryptedPayload present, plaintext startTime=0):
 *   Decrypt payload → parse {"st":<epoch>,"et":<epoch>} → use resolved values.
 *   et <= 0 means the session is still ongoing → endTime = undefined.
 *
 * Plaintext path (no encryptedPayload):
 *   Use plaintext startTime / endTime unchanged (pre-encryption row).
 */
function decryptSession(s: SyncSessionDto, keyB64: string): DecryptedSession {
  const { encryptedPayload, startTime, endTime, ...rest } = s;
  if (encryptedPayload) {
    const d = JSON.parse(decrypt(encryptedPayload, keyB64)) as {
      st: number;
      et: number;
    };
    return {
      ...rest,
      startTime: d.st,
      endTime: d.et > 0 ? d.et : undefined,
    };
  }
  return { ...rest, startTime, endTime };
}

/**
 * Decrypt-merge a single set-log.
 *
 * Encrypted path (encryptedPayload present, all metric fields null/absent):
 *   Decrypt payload → parse {"r"?,"t"?,"w"?,"sa"?,"mt"?} → use resolved values.
 *   Keys absent in payload → null (not undefined) per DecryptedSetLog contract.
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
    const d = JSON.parse(decrypt(encryptedPayload, keyB64)) as {
      r?: number;
      t?: number;
      w?: number;
      sa?: number;
      mt?: number;
    };
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
 * Decrypt-merge a single HR sample.
 *
 * Encrypted path: decrypt → parse {"ts":<ms>,"bpm":<bpm>}.
 * Plaintext path: use dto fields unchanged.
 */
function decryptHrSample(hr: SyncHrSampleDto, keyB64: string): DecryptedHrSample {
  const { encryptedPayload, timestampMs, bpm, ...rest } = hr;
  if (encryptedPayload) {
    const d = JSON.parse(decrypt(encryptedPayload, keyB64)) as {
      ts:  number;
      bpm: number;
    };
    return { ...rest, timestampMs: d.ts, bpm: d.bpm };
  }
  return { ...rest, timestampMs, bpm };
}

/**
 * Decrypt-merge a single `planned_workout` row (Phase 135, D-14). Unlike
 * `decryptSession`/`decryptSetLog`/`decryptHrSample` there is NO plaintext fallback
 * branch — a `planned_workout` row is always encrypted. Two explicit guards, each
 * throwing an `Error` that names the row's `id` and the cause but NEVER the key or the
 * PAT (T-120-17):
 *   (a) an empty `encryptedPayload` — the tombstone shape the server already filters
 *       out (133 D-03); its arrival means the pull contract changed, so the message
 *       says that rather than skipping the row;
 *   (b) a decrypted payload whose `v` is not `1`.
 * Parsed with a type assertion, not Zod — matching decryptSession/decryptSetLog: Zod
 * in this codebase guards LLM-supplied tool input, not internally decrypted payloads.
 * `calendarEventId` and `createdAt` are deliberately NOT copied onto
 * `DecryptedPlannedWorkout` (D-06) — the type has no field for them.
 *
 * Exported — like `normalizeWireBlock` above — not for convenience but because the
 * shared corpus's `plannedWorkoutCipher` vector (D-12) must run through this EXACT
 * function, not a test-local copy of it, so the parity proof covers the real decode
 * boundary rather than a re-implementation of it (`tests/shared-vectors.test.ts`).
 */
export function decryptPlannedWorkout(row: MiscSyncRow, keyB64: string): DecryptedPlannedWorkout {
  if (!row.encryptedPayload) {
    throw new Error(
      `planned_workout row ${row.id} arrived with an empty encryptedPayload — this is the ` +
        'tombstone shape the server should already filter out of plannedWorkouts (133 D-03); ' +
        'the pull contract may have changed',
    );
  }
  const plaintext = JSON.parse(decrypt(row.encryptedPayload, keyB64)) as {
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
  if (plaintext.v !== 1) {
    throw new Error(`planned_workout row ${row.id} has unknown schema version v=${plaintext.v}`);
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

/**
 * Decrypt-merge a single `settings` row (Phase 137, D-03). Like `decryptPlannedWorkout`
 * there is NO plaintext fallback branch — a `settings` row is always encrypted — and the
 * same all-or-nothing discipline applies: a tombstone-shaped empty `encryptedPayload`, an
 * unparseable payload, an unknown schema version `v`, or a missing type tag `t` all THROW,
 * propagating out of decryptMerge and failing the whole getSnapshot() call rather than
 * silently dropping one setting out of many. Parsed with a type assertion, not Zod —
 * matching decryptSession/decryptSetLog/decryptPlannedWorkout: Zod in this codebase guards
 * LLM-supplied tool input, not internally decrypted payloads.
 *
 * Never logs the decrypted `value` or the row's own fields into an error message (T-120-17).
 */
export function decryptSetting(row: MiscSyncRow, keyB64: string): DecryptedSetting {
  if (!row.encryptedPayload) {
    throw new Error(
      `settings row ${row.id} (key "${row.clientLocalId}") arrived with an empty encryptedPayload — ` +
        'this is the tombstone shape the server should already filter out of settings; the pull ' +
        'contract may have changed',
    );
  }
  const plaintext = JSON.parse(decrypt(row.encryptedPayload, keyB64)) as {
    v: number;
    t: string;
    value: string;
  };
  if (plaintext.v !== 1) {
    throw new Error(`settings row ${row.id} (key "${row.clientLocalId}") has unknown schema version v=${plaintext.v}`);
  }
  if (!plaintext.t) {
    throw new Error(`settings row ${row.id} (key "${row.clientLocalId}") is missing its type tag`);
  }
  return { key: row.clientLocalId, type: plaintext.t, value: plaintext.value };
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

/** Apply decrypt-merge to every encrypted entity in the raw snapshot. */
function decryptMerge(raw: SyncPullResponse, keyB64: string): DecryptedSnapshot {
  return {
    syncedAt:             raw.syncedAt,
    exercises:            raw.exercises,
    exerciseTranslations: raw.exerciseTranslations,
    templates:            raw.templates,
    blocks:               raw.blocks.map(normalizeWireBlock),
    templateExercises:    raw.templateExercises.map(normalizeWireTemplateExercise),
    sessions:  raw.sessions.map(s  => decryptSession(s,  keyB64)),
    setLogs:   raw.setLogs.map(sl  => decryptSetLog(sl,  keyB64)),
    hrSamples: raw.hrSamples.map(hr => decryptHrSample(hr, keyB64)),
    // `?? []` is what makes the optional wire key (SyncPullResponse.plannedWorkouts)
    // safe for a user with no planned workouts — see that field's own doc in types.ts.
    plannedWorkouts: (raw.plannedWorkouts ?? []).map(pw => decryptPlannedWorkout(pw, keyB64)),
    // `?? []` — same reasoning as plannedWorkouts above, for a user with no synced settings.
    settings: (raw.settings ?? []).map(s => decryptSetting(s, keyB64)),
  };
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
  }));
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

  const snapshot = decryptMerge(rawSnapshot, keyB64);
  const catalog  = normalizeCatalog(rawCatalog);
  return { snapshot, catalog, profile, fetchedAt: Date.now() };
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
