/**
 * AES-256-GCM decrypt and encrypt — TypeScript port of Android EncryptionManager.kt.
 *
 * Wire format (source: EncryptionManager.kt lines 51–59):
 *   {"iv":"<standard-base64, 12 bytes>","ct":"<standard-base64, ciphertext+16-byte tag>"}
 *
 * CRITICAL — Java/Kotlin vs Node.js GCM tag handling:
 *   Java Cipher.doFinal("AES/GCM/NoPadding") APPENDS the 16-byte GCM auth tag
 *   to the ciphertext buffer. Node.js requires it to be manually split off:
 *     decipher.setAuthTag(ctBuf.subarray(-16))   ← trailing 16 bytes = GCM tag
 *     decipher.update(ctBuf.subarray(0, -16))    ← actual ciphertext (sans tag)
 *   Getting this wrong produces auth-tag mismatch errors or (worse) silently wrong output.
 *
 * Base64 flavor: Android Base64.NO_WRAP = standard RFC 4648 (NOT URL-safe).
 * Always decode with Buffer.from(b64, 'base64'), never 'base64url'.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Decrypts a payload produced by Android EncryptionManager.encryptToString().
 *
 * @param encryptedJson - Wire-format JSON string: `{"iv":"<b64>","ct":"<b64>"}`
 * @param keyBase64 - Raw 32-byte AES-256 key, standard base64-encoded (CALICOMP_KEY env)
 * @returns Decrypted UTF-8 plaintext string
 * @throws If the ciphertext is invalid or the GCM auth tag does not verify
 */
export function decrypt(encryptedJson: string, keyBase64: string): string {
  const { iv: ivB64, ct: ctB64 } = JSON.parse(encryptedJson) as { iv: string; ct: string };
  const key   = Buffer.from(keyBase64, 'base64'); // 32 bytes (AES-256)
  const iv    = Buffer.from(ivB64,    'base64'); // 12 bytes (GCM IV)
  const ctBuf = Buffer.from(ctB64,    'base64'); // ciphertext WITH 16-byte GCM auth tag appended

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  // Split off the trailing 16-byte GCM auth tag before decryption.
  // Node.js does NOT auto-detect the tag — must be provided explicitly.
  decipher.setAuthTag(ctBuf.subarray(-16));

  const plaintext = Buffer.concat([
    decipher.update(ctBuf.subarray(0, -16)), // actual ciphertext (without tag)
    decipher.final(),                         // throws on GCM auth failure
  ]);

  return plaintext.toString('utf8');
}

/**
 * Encrypts a plaintext into the wire format of Android `EncryptionManager.encryptToString()`, the counterpart of
 * [decrypt] (Phase 168, plan 168-05, protocol 1.56 §2.8, the payload of `history_correction`).
 *
 * Format: `{"iv":"<standard-base64, 12 bytes>","ct":"<standard-base64, ciphertext + 16-byte GCM tag>"}`, keys in
 * this order, the tag appended to `ct` exactly as Java's `Cipher.doFinal` appends it. Crypto parity: with the IV of
 * the corpus vector `historyCorrection.cipher[0]` the result equals its ciphertext byte for byte
 * (`tests/crypto.test.ts`), and the app decrypts the same vector (plan 168-12).
 *
 * @param plaintext - UTF-8 plaintext
 * @param keyBase64 - Raw 32-byte AES-256 key, standard base64-encoded (CALICOMP_KEY env)
 * @param iv - 12-byte GCM IV; random by default. A fixed IV exists only for the parity test, never reuse one with
 *   the same key in production
 * @returns Wire-format JSON string `{"iv":"<b64>","ct":"<b64>"}`
 */
export function encrypt(plaintext: string, keyBase64: string, iv: Buffer = randomBytes(12)): string {
  const key = Buffer.from(keyBase64, 'base64'); // 32 bytes (AES-256)
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ iv: iv.toString('base64'), ct: ct.toString('base64') });
}
