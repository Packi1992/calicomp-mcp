/**
 * Personal lists of catalog exercise links, encrypted (Phase 168.1, D-01, D-02; protocol 1.57 §1.12).
 *
 * The coach may give a catalog exercise a personal list of muscles or capabilities for this one athlete. The accepted
 * list rests as a `user_misc_data` row of kind `exercise_link_override`, `clientLocalId` = the exercise id, and comes to
 * the MCP as ciphertext in the read field `exerciseLinkOverrides`. This module turns such a row into the §1.12 normal
 * form `{ exerciseId, muscleGroups, capabilities, updatedAt }`.
 *
 * The rules of §1.12 "Decoding a personal list", checked in this order; the first failing rule names the reason:
 *   1. an empty payload → `malformed_payload`;
 *   2. the envelope cannot be parsed or the GCM tag does not verify → `decrypt_failed`;
 *   3. a plaintext that is not a JSON object → `malformed_payload`;
 *   4. `v` missing, not an integer or not `1` → `unknown_version`;
 *   5. → `malformed_payload`: a key outside the five fields, at the top level or in a list entry; `exerciseId` not a
 *      canonical lower-case UUID or not the row's `clientLocalId`; `updatedAt` missing, not an integer or outside
 *      ±(2^53 - 1); a list missing, neither an array nor `null`, or empty; both lists `null`; an entry not an object, its
 *      `id` missing or not a canonical lower-case UUID, the same `id` twice in one list; a muscle `level` missing or not
 *      one of its values or `null`; a capability `level` missing, `null` or not one of its values.
 *
 * Unknown keys are rejected here, unlike §1.7 and §1.9: a list a reader understands only in part would silently move
 * every evaluation of the exercise. A readable list keeps its order. Never logs; a `RowDecodeError` names only the row
 * id and the cause, never a list, an id from inside the payload, the ciphertext or the key (T-168.1-11).
 */

import { decrypt } from './crypto.js';
import { CANONICAL_LOWER_UUID, RowDecodeError } from './row-decode.js';
import type { DecryptedExerciseLinkOverride, MiscSyncRow } from './types.js';

type MuscleLevel = NonNullable<DecryptedExerciseLinkOverride['muscleGroups']>[number]['level'];
type CapabilityLevel = NonNullable<DecryptedExerciseLinkOverride['capabilities']>[number]['level'];

const MUSCLE_LEVELS: readonly string[] = ['PRIMARY', 'SECONDARY', 'STABILIZER'];
const CAPABILITY_LEVELS: readonly string[] = ['HAUPTREIZ', 'MITTRAINIERT', 'GERING'];
const ROW_KEYS: ReadonlySet<string> = new Set(['v', 'exerciseId', 'muscleGroups', 'capabilities', 'updatedAt']);
const ENTRY_KEYS: ReadonlySet<string> = new Set(['id', 'level']);

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** A plain JSON object (not `null`, not an array), else `undefined`. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function onlyKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(o).every((key) => allowed.has(key));
}

/**
 * One list of a row: `null`, or a non-empty array of `{ id, level }` whose ids are canonical and unique. `readLevel`
 * returns the entry's level, or `undefined` for a violation. Returns `undefined` for any violation; order kept.
 */
function readList<L>(
  value: unknown,
  readLevel: (entry: Record<string, unknown>) => L | undefined,
): { id: string; level: L }[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  const out: { id: string; level: L }[] = [];
  for (const raw of value) {
    const entry = asObject(raw);
    if (entry === undefined || !onlyKeys(entry, ENTRY_KEYS)) return undefined;
    const id = entry.id;
    if (typeof id !== 'string' || !CANONICAL_LOWER_UUID.test(id) || seen.has(id)) return undefined;
    const level = readLevel(entry);
    if (level === undefined) return undefined;
    seen.add(id);
    out.push({ id, level });
  }
  return out;
}

function muscleLevel(entry: Record<string, unknown>): MuscleLevel | undefined {
  if (!hasOwn(entry, 'level')) return undefined;
  const level = entry.level;
  if (level === null) return null;
  return typeof level === 'string' && MUSCLE_LEVELS.includes(level)
    ? (level as MuscleLevel)
    : undefined;
}

function capabilityLevel(entry: Record<string, unknown>): CapabilityLevel | undefined {
  const level = entry.level;
  return typeof level === 'string' && CAPABILITY_LEVELS.includes(level)
    ? (level as CapabilityLevel)
    : undefined;
}

/**
 * Decode the decrypted plaintext of one row into its §1.12 normal form (rules 3 to 5). Pure and exported: the corpus
 * section `exerciseLinkOverrideDecode` replays every vector through exactly this function, and the app's decoder replays
 * the same vectors. Never logs.
 */
export function decodeExerciseLinkOverridePlaintext(
  plaintextJson: string,
  row: Pick<MiscSyncRow, 'id' | 'clientLocalId'>,
): DecryptedExerciseLinkOverride {
  const malformed = (): RowDecodeError =>
    new RowDecodeError(`exercise_link_override row ${row.id} has a malformed payload`, 'malformed_payload');

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintextJson);
  } catch {
    throw malformed();
  }
  const p = asObject(parsed);
  if (p === undefined) throw malformed();

  // The string "1", 1.5, null and a missing v are not version 1.
  if (p.v !== 1) {
    throw new RowDecodeError(`exercise_link_override row ${row.id} has an unknown schema version`, 'unknown_version');
  }

  if (!onlyKeys(p, ROW_KEYS)) throw malformed();
  const exerciseId = p.exerciseId;
  if (typeof exerciseId !== 'string' || !CANONICAL_LOWER_UUID.test(exerciseId) || exerciseId !== row.clientLocalId) {
    throw malformed();
  }
  const updatedAt = p.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt)) throw malformed();
  const muscleGroups = readList(p.muscleGroups, muscleLevel);
  const capabilities = readList(p.capabilities, capabilityLevel);
  if (muscleGroups === undefined || capabilities === undefined) throw malformed();
  if (muscleGroups === null && capabilities === null) throw malformed();

  return { exerciseId, muscleGroups, capabilities, updatedAt };
}

/**
 * Decrypt one row into its §1.12 normal form: rules 1 and 2 here (`decrypt` verifies the GCM tag, the last 16 bytes of
 * `ct`), rules 3 to 5 in `decodeExerciseLinkOverridePlaintext`. Exported and throwing so the corpus replay of
 * `exerciseLinkOverrideCipher` runs through the exact function `decryptMerge` uses. Never logs.
 */
export function decryptExerciseLinkOverride(
  row: Pick<MiscSyncRow, 'id' | 'clientLocalId' | 'encryptedPayload'>,
  keyB64: string,
): DecryptedExerciseLinkOverride {
  if (!row.encryptedPayload) {
    throw new RowDecodeError(`exercise_link_override row ${row.id} arrived with an empty encryptedPayload`, 'malformed_payload');
  }
  let plaintext: string;
  try {
    plaintext = decrypt(row.encryptedPayload, keyB64);
  } catch {
    throw new RowDecodeError(`exercise_link_override row ${row.id} could not be decrypted`, 'decrypt_failed');
  }
  return decodeExerciseLinkOverridePlaintext(plaintext, row);
}
