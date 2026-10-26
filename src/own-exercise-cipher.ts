/**
 * Own exercises, encrypted (Phase 164, CRYPT-01, D-25; protocol 1.45 §1.9).
 *
 * RED stub (plan 164-19, task 1): only the exported signatures, so the parity tests in
 * `tests/shared-vectors.test.ts` type-check and import. The decoder follows in the GREEN commit.
 */

/** A muscle-group link of an own exercise (§1.9, level nullable as in the app's schema). */
export interface OwnExerciseMuscleLink {
  id: string;
  level: 'PRIMARY' | 'SECONDARY' | 'STABILIZER' | null;
}

/** An equipment link of an own exercise (§1.9). */
export interface OwnExerciseEquipmentLink {
  id: string;
  optional: boolean;
}

/** A capability link of an own exercise (§1.9, level nullable as in the app's schema). */
export interface OwnExerciseCapabilityLink {
  id: string;
  level: 'HAUPTREIZ' | 'MITTRAINIERT' | 'GERING' | null;
}

/** The §1.9 normal form of a decoded own exercise — the plaintext without `v`, same key order. */
export interface DecodedOwnExercise {
  id: string;
  name: string;
  mode: 'REPS' | 'TIME' | 'MAX';
  usesWeight: boolean;
  description: string | null;
  updatedAt: number;
  muscleGroups: OwnExerciseMuscleLink[];
  equipment: OwnExerciseEquipmentLink[];
  capabilities: OwnExerciseCapabilityLink[];
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

export function decodeOwnExercisePlaintext(_plaintextJson: string, _rowId: string): DecodedOwnExercise {
  throw new Error('not implemented');
}

export function decodeOwnExerciseTranslationPlaintext(
  _plaintextJson: string,
  _row: Pick<OwnExerciseTranslationCipherRow, 'id' | 'exerciseId' | 'languageCode'>,
): DecodedOwnExerciseTranslation {
  throw new Error('not implemented');
}

export function decryptOwnExercise(_row: OwnExerciseCipherRow, _keyB64: string): DecodedOwnExercise {
  throw new Error('not implemented');
}

export function decryptOwnExerciseTranslation(
  _row: OwnExerciseTranslationCipherRow,
  _keyB64: string,
): DecodedOwnExerciseTranslation {
  throw new Error('not implemented');
}
