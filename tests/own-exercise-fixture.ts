/**
 * Test fixture for own exercises, encrypted (Phase 164, CRYPT-01, D-25; protocol 1.45 §1.9).
 *
 * Builds pairs of rows as `GET /api/mcp/data/pull` sends them: a PLAINTEXT row (an account no
 * 4.5 app has migrated yet, or a server before 1.45) and its ENCRYPTED twin (placeholders in
 * the content fields, the content inside `encryptedPayload`). The seam `decryptMerge` must turn
 * the encrypted twin into exactly the plaintext row, so every tool names the exercise byte for
 * byte as before (O-6).
 *
 * The key is the corpus test key (bytes 0x00..0x1F, `docs/coach-planning-vectors.json`) —
 * never a real key. The ciphertext is a real AES-256-GCM envelope `{"iv","ct"}` with the
 * 16-byte tag appended to `ct`, exactly the app's `EncryptionManager` form, so the REAL
 * `decrypt()` reads it.
 */

import { createCipheriv } from 'node:crypto';
import type { SyncExerciseDto, SyncExerciseTranslationDto } from '../src/types.js';

/** The corpus test key, bytes 0x00..0x1F. Never a real key. */
export const OWN_TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

let ivCounter = 0;

/** Encrypt `plaintext` into the app's envelope; a fresh IV per call (test-only, deterministic). */
export function encryptForTest(plaintext: string, keyB64: string = OWN_TEST_KEY_B64): string {
  ivCounter += 1;
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(ivCounter, 8);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ iv: iv.toString('base64'), ct: ct.toString('base64') });
}

/** The content of an own exercise (§1.9 plaintext form without `v`). */
export interface OwnExerciseContent {
  id: string;
  name: string;
  mode: 'REPS' | 'TIME' | 'MAX';
  usesWeight: boolean;
  description: string | null;
  muscleGroups?: Array<{ id: string; level: string | null }>;
  equipment?: Array<{ id: string; optional: boolean }>;
  capabilities?: Array<{ id: string; level: string | null }>;
}

/** The plaintext routing fields of a row (stay plaintext on the server, §1.9). */
export interface RowTimes {
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** The §1.9 plaintext of an own exercise, in the binding key order. */
export function ownExercisePlaintext(content: OwnExerciseContent, updatedAt: number): string {
  return JSON.stringify({
    v: 1,
    id: content.id,
    name: content.name,
    mode: content.mode,
    usesWeight: content.usesWeight,
    description: content.description,
    updatedAt,
    muscleGroups: content.muscleGroups ?? [],
    equipment: content.equipment ?? [],
    capabilities: content.capabilities ?? [],
  });
}

/** A plaintext exercise row and its encrypted twin, both in the server's wire key order. */
export function ownExercisePair(
  content: OwnExerciseContent,
  times: RowTimes,
  keyB64: string = OWN_TEST_KEY_B64,
): { plaintext: SyncExerciseDto; encrypted: SyncExerciseDto } {
  const plaintext: SyncExerciseDto = {
    id: content.id,
    name: content.name,
    mode: content.mode,
    usesWeight: content.usesWeight,
    ...(content.description !== null ? { description: content.description } : {}),
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
    ...(times.deletedAt !== undefined ? { deletedAt: times.deletedAt } : {}),
  };
  const encrypted: SyncExerciseDto = {
    id: content.id,
    // §1.9 "Storage and placeholders": the server sends these for every row with ciphertext.
    name: '',
    mode: 'REPS',
    usesWeight: false,
    encryptedPayload: encryptForTest(ownExercisePlaintext(content, times.updatedAt), keyB64),
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
    ...(times.deletedAt !== undefined ? { deletedAt: times.deletedAt } : {}),
  };
  return { plaintext, encrypted };
}

/** The content of a translation of an own exercise (§1.9). */
export interface OwnExerciseTranslationContent {
  id: string;
  exerciseId: string;
  languageCode: string;
  name: string;
  description: string | null;
}

/** A plaintext translation row and its encrypted twin, both in the server's wire key order. */
export function ownTranslationPair(
  content: OwnExerciseTranslationContent,
  times: { createdAt: number; updatedAt: number },
  keyB64: string = OWN_TEST_KEY_B64,
): { plaintext: SyncExerciseTranslationDto; encrypted: SyncExerciseTranslationDto } {
  const plaintext: SyncExerciseTranslationDto = {
    id: content.id,
    exerciseId: content.exerciseId,
    languageCode: content.languageCode,
    name: content.name,
    ...(content.description !== null ? { description: content.description } : {}),
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
  };
  const encrypted: SyncExerciseTranslationDto = {
    id: content.id,
    exerciseId: content.exerciseId,
    languageCode: content.languageCode,
    name: '',
    encryptedPayload: encryptForTest(
      JSON.stringify({
        v: 1,
        id: content.id,
        exerciseId: content.exerciseId,
        languageCode: content.languageCode,
        name: content.name,
        description: content.description,
      }),
      keyB64,
    ),
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
  };
  return { plaintext, encrypted };
}
