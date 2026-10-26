/**
 * Own exercises, encrypted (Phase 164, CRYPT-01, D-25; protocol 1.45 §1.9).
 *
 * From version 1.45 on the server holds the name, mode, weight flag and description of an own
 * exercise (`user_exercises`), its translations and its muscle-group, equipment and capability
 * links only as ciphertext (`encryptedPayload`, the app's `EncryptionManager` envelope). The
 * MCP asks for those rows with `GET /api/mcp/data/pull?exerciseCipher=1` and turns them back
 * into the §1.9 normal form here; `cache.ts`'s `decryptMerge` maps the normal form onto the
 * plaintext row shape the tools already read, so the coach keeps naming own exercises byte for
 * byte as before (O-6).
 *
 * The decoding rules of §1.9 "Decoded rows", checked in this order; the first failing rule
 * names the reason:
 *   1. an empty payload → `malformed_payload`;
 *   2. the envelope cannot be parsed or the GCM tag does not verify → `decrypt_failed`;
 *   3. a plaintext that is not a JSON object → `malformed_payload`;
 *   4. `v` missing, not an integer or not `1` → `unknown_version`;
 *   5. a missing field, a wrong type, an id that is not a canonical lower-case UUID or not the
 *      row's own, a blank or too long name, a too long description, an unknown mode, a broken
 *      link list → `malformed_payload`.
 * A readable row: unknown keys ignored (top level and inside a list entry), a blank description
 * reads as `null`, nothing is trimmed, cut or reordered.
 *
 * Never logs. Every violation throws a `RowDecodeError` whose message names only the entity,
 * the row id and the cause — never the name, the description, a link, `v`, the ciphertext or
 * the key (T-164-57, threat entry T-164-PAT).
 */

import { decrypt } from './crypto.js';
import { CANONICAL_LOWER_UUID, RowDecodeError, isBlankOverrideText, requiredString } from './row-decode.js';

/** §1.9: `NAME_MAX` in UTF-16 code units, the width of `user_exercises.name`. */
export const OWN_EXERCISE_NAME_MAX = 255;
/** §1.9: `DESCRIPTION_MAX` in UTF-16 code units, the width of `user_exercises.description`. */
export const OWN_EXERCISE_DESCRIPTION_MAX = 1000;

const MODES = ['REPS', 'TIME', 'MAX'] as const;
const MUSCLE_LEVELS = ['PRIMARY', 'SECONDARY', 'STABILIZER'] as const;
const CAPABILITY_LEVELS = ['HAUPTREIZ', 'MITTRAINIERT', 'GERING'] as const;

/** A muscle-group link of an own exercise (§1.9, level nullable as in the app's schema). */
export interface OwnExerciseMuscleLink {
  id: string;
  level: (typeof MUSCLE_LEVELS)[number] | null;
}

/** An equipment link of an own exercise (§1.9). */
export interface OwnExerciseEquipmentLink {
  id: string;
  optional: boolean;
}

/** A capability link of an own exercise (§1.9, level nullable as in the app's schema). */
export interface OwnExerciseCapabilityLink {
  id: string;
  level: (typeof CAPABILITY_LEVELS)[number] | null;
}

/** The three link lists of an own exercise, as they ride in its payload (D-25). */
export interface OwnExerciseLinks {
  muscleGroups: OwnExerciseMuscleLink[];
  equipment: OwnExerciseEquipmentLink[];
  capabilities: OwnExerciseCapabilityLink[];
}

/** The §1.9 normal form of a decoded own exercise — the plaintext without `v`, same key order. */
export interface DecodedOwnExercise extends OwnExerciseLinks {
  id: string;
  name: string;
  mode: (typeof MODES)[number];
  usesWeight: boolean;
  description: string | null;
  updatedAt: number;
}

/** The §1.9 normal form of a decoded translation of an own exercise. */
export interface DecodedOwnExerciseTranslation {
  id: string;
  exerciseId: string;
  languageCode: string;
  name: string;
  description: string | null;
}

/** The plaintext routing fields of an own-exercise row the decoder checks against. */
export interface OwnExerciseCipherRow {
  id: string;
  encryptedPayload?: string | null;
}

/** The plaintext routing fields of a translation row the decoder checks against. */
export interface OwnExerciseTranslationCipherRow {
  id?: string;
  exerciseId: string;
  languageCode: string;
  encryptedPayload?: string | null;
}

/** The wire kind in an error message: entity and row id, never content. */
type WireKind = 'exercise' | 'exercise_translation';

function malformed(kind: WireKind, rowId: string | undefined): RowDecodeError {
  return new RowDecodeError(`${kind} row ${rowId ?? '(no id)'} has a malformed payload`, 'malformed_payload');
}

function hasKey(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** A plain JSON object (not `null`, not an array), else `undefined`. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A canonical lower-case UUID string, else `undefined`. */
function canonicalId(value: unknown): string | undefined {
  return typeof value === 'string' && CANONICAL_LOWER_UUID.test(value) ? value : undefined;
}

/** Rules 3 and 4: a JSON object with `v === 1`. */
function parseVersionOne(plaintextJson: string, kind: WireKind, rowId: string | undefined): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintextJson);
  } catch {
    throw malformed(kind, rowId);
  }
  const p = asObject(parsed);
  if (p === undefined) throw malformed(kind, rowId);
  // The string "1", 1.5, null and a missing v are not version 1.
  if (p.v !== 1) {
    throw new RowDecodeError(`${kind} row ${rowId ?? '(no id)'} has an unknown schema version`, 'unknown_version');
  }
  return p;
}

/** `name`: a string, not blank by the set W, at most `NAME_MAX` code units; never trimmed. */
function readName(p: Record<string, unknown>): string | undefined {
  const name = p.name;
  if (typeof name !== 'string' || isBlankOverrideText(name) || name.length > OWN_EXERCISE_NAME_MAX) return undefined;
  return name;
}

/**
 * `description`: `null` or a string of at most `DESCRIPTION_MAX` code units; a blank one reads
 * as `null`. Returns `undefined` for a violation (the key must be present, checked by the caller).
 */
function readDescription(p: Record<string, unknown>): string | null | undefined {
  const description = p.description;
  if (description === null) return null;
  if (typeof description !== 'string' || description.length > OWN_EXERCISE_DESCRIPTION_MAX) return undefined;
  return isBlankOverrideText(description) ? null : description;
}

/**
 * One link list of §1.9: an array of objects, each with a canonical `id` (no id twice in the
 * list) and the list's own second field, read by `build` (`undefined` = violation). Order
 * kept, unknown keys dropped. Returns `undefined` for any violation.
 */
function readLinkList<T>(
  value: unknown,
  build: (entry: Record<string, unknown>, id: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const rawEntry of value) {
    const entry = asObject(rawEntry);
    if (entry === undefined) return undefined;
    const id = canonicalId(entry.id);
    if (id === undefined || seen.has(id)) return undefined;
    const link = build(entry, id);
    if (link === undefined) return undefined;
    seen.add(id);
    out.push(link);
  }
  return out;
}

/** A present `level` of one axis or `null`; a value of the other axis is as unknown as any string. */
function levelOf<L extends string>(entry: Record<string, unknown>, levels: readonly L[]): L | null | undefined {
  if (!hasKey(entry, 'level')) return undefined;
  const raw = entry.level;
  if (raw === null) return null;
  return typeof raw === 'string' && (levels as readonly string[]).includes(raw) ? (raw as L) : undefined;
}

function muscleLink(entry: Record<string, unknown>, id: string): OwnExerciseMuscleLink | undefined {
  const level = levelOf(entry, MUSCLE_LEVELS);
  return level === undefined ? undefined : { id, level };
}

function equipmentLink(entry: Record<string, unknown>, id: string): OwnExerciseEquipmentLink | undefined {
  return typeof entry.optional === 'boolean' ? { id, optional: entry.optional } : undefined;
}

function capabilityLink(entry: Record<string, unknown>, id: string): OwnExerciseCapabilityLink | undefined {
  const level = levelOf(entry, CAPABILITY_LEVELS);
  return level === undefined ? undefined : { id, level };
}

const EXERCISE_FIELDS = [
  'id', 'name', 'mode', 'usesWeight', 'description', 'updatedAt', 'muscleGroups', 'equipment', 'capabilities',
] as const;
const TRANSLATION_FIELDS = ['id', 'exerciseId', 'languageCode', 'name', 'description'] as const;

/**
 * Decode the decrypted plaintext of one own exercise into its §1.9 normal form (rules 3 to 5).
 * Pure and exported: the corpus section `ownExerciseDecode` replays every vector of kind
 * `exercise` through exactly this function (`tests/shared-vectors.test.ts`), and the app's
 * decoder replays the same vectors. Never logs.
 */
export function decodeOwnExercisePlaintext(plaintextJson: string, rowId: string): DecodedOwnExercise {
  const p = parseVersionOne(plaintextJson, 'exercise', rowId);
  const bad = (): RowDecodeError => malformed('exercise', rowId);

  if (!EXERCISE_FIELDS.every((field) => hasKey(p, field))) throw bad();

  const id = canonicalId(p.id);
  if (id === undefined || id !== rowId) throw bad();
  const name = readName(p);
  if (name === undefined) throw bad();
  const mode = p.mode;
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) throw bad();
  if (typeof p.usesWeight !== 'boolean') throw bad();
  const description = readDescription(p);
  if (description === undefined) throw bad();
  const updatedAt = p.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isInteger(updatedAt)) throw bad();

  const muscleGroups = readLinkList(p.muscleGroups, muscleLink);
  const equipment = readLinkList(p.equipment, equipmentLink);
  const capabilities = readLinkList(p.capabilities, capabilityLink);
  if (muscleGroups === undefined || equipment === undefined || capabilities === undefined) throw bad();

  return {
    id,
    name,
    mode: mode as DecodedOwnExercise['mode'],
    usesWeight: p.usesWeight,
    description,
    updatedAt,
    muscleGroups,
    equipment,
    capabilities,
  };
}

/**
 * Decode the decrypted plaintext of one translation of an own exercise into its §1.9 normal
 * form (rules 3 to 5). `id`, `exerciseId` and `languageCode` must equal the row's own plaintext
 * fields. Pure and exported for the corpus replay of `ownExerciseDecode` (kind `translation`).
 * Never logs.
 */
export function decodeOwnExerciseTranslationPlaintext(
  plaintextJson: string,
  row: Pick<OwnExerciseTranslationCipherRow, 'id' | 'exerciseId' | 'languageCode'>,
): DecodedOwnExerciseTranslation {
  const p = parseVersionOne(plaintextJson, 'exercise_translation', row.id);
  const bad = (): RowDecodeError => malformed('exercise_translation', row.id);

  if (!TRANSLATION_FIELDS.every((field) => hasKey(p, field))) throw bad();

  const id = canonicalId(p.id);
  if (id === undefined || id !== row.id) throw bad();
  const exerciseId = canonicalId(p.exerciseId);
  if (exerciseId === undefined || exerciseId !== row.exerciseId) throw bad();
  const languageCode = requiredString(p.languageCode);
  if (languageCode === undefined || languageCode !== row.languageCode) throw bad();
  const name = readName(p);
  if (name === undefined) throw bad();
  const description = readDescription(p);
  if (description === undefined) throw bad();

  return { id, exerciseId, languageCode, name, description };
}

/** Rules 1 and 2: a non-empty payload that decrypts under the key. */
function decryptPayload(encryptedPayload: string | null | undefined, keyB64: string, kind: WireKind, rowId: string | undefined): string {
  if (!encryptedPayload) {
    throw new RowDecodeError(`${kind} row ${rowId ?? '(no id)'} arrived with an empty encryptedPayload`, 'malformed_payload');
  }
  try {
    return decrypt(encryptedPayload, keyB64);
  } catch {
    throw new RowDecodeError(`${kind} row ${rowId ?? '(no id)'} could not be decrypted`, 'decrypt_failed');
  }
}

/**
 * Decrypt one own-exercise row (`encryptedPayload` present) into its §1.9 normal form: rules 1
 * and 2 here, rules 3 to 5 in `decodeOwnExercisePlaintext`. Exported and throwing so the corpus
 * replay of `ownExerciseCipher` runs through the exact function `decryptMerge` uses. The
 * placeholders in the row's content fields are never read. Never logs.
 */
export function decryptOwnExercise(row: OwnExerciseCipherRow, keyB64: string): DecodedOwnExercise {
  return decodeOwnExercisePlaintext(decryptPayload(row.encryptedPayload, keyB64, 'exercise', row.id), row.id);
}

/**
 * Decrypt one translation row of an own exercise into its §1.9 normal form (rules 1 and 2 here,
 * 3 to 5 in `decodeOwnExerciseTranslationPlaintext`). Exported for the corpus replay of
 * `ownExerciseTranslationCipher`. Never logs.
 */
export function decryptOwnExerciseTranslation(
  row: OwnExerciseTranslationCipherRow,
  keyB64: string,
): DecodedOwnExerciseTranslation {
  return decodeOwnExerciseTranslationPlaintext(
    decryptPayload(row.encryptedPayload, keyB64, 'exercise_translation', row.id),
    row,
  );
}
