/**
 * CRYPTO-PARITY ENTRY GATE — Phase 120, Plan 02 (MCPR-01)
 *
 * This test MUST remain green before any file under src/tools/ is created.
 * It proves that a ciphertext produced by Android EncryptionManager.kt
 * (AES/GCM/NoPadding, 12-byte IV, 16-byte GCM auth tag appended by doFinal)
 * decrypts byte-identically in TypeScript via node:crypto.
 *
 * The committed static test vector (tests/vectors/parity-vector.ts) was generated
 * by a throwaway Java program using javax.crypto.Cipher — the same JVM stack as
 * Kotlin/Android — with key bytes 0x00..0x1F and plaintext "calicomp-parity-v1".
 * See parity-vector.ts for full provenance and regeneration instructions.
 */

import { describe, it, expect } from 'vitest';
import { decrypt } from '../src/crypto.js';
import {
  VECTOR_KEY_B64,
  VECTOR_PLAINTEXT,
  VECTOR_CIPHERTEXT_JSON,
} from './vectors/parity-vector.js';

describe('AES-256-GCM parity with Kotlin EncryptionManager', () => {
  it('decrypts the committed Kotlin-format ciphertext to the expected plaintext (byte-identical)', () => {
    const result = decrypt(VECTOR_CIPHERTEXT_JSON, VECTOR_KEY_B64);
    expect(result).toBe(VECTOR_PLAINTEXT);
  });

  it('throws on tampered auth tag — proves GCM integrity is enforced, not silently ignored', () => {
    const parsed = JSON.parse(VECTOR_CIPHERTEXT_JSON) as { iv: string; ct: string };
    const ctBuf = Buffer.from(parsed.ct, 'base64');
    // Flip the last byte (last byte of the 16-byte GCM auth tag)
    ctBuf[ctBuf.length - 1] ^= 0xff;
    const tampered = JSON.stringify({ iv: parsed.iv, ct: ctBuf.toString('base64') });
    expect(() => decrypt(tampered, VECTOR_KEY_B64)).toThrow();
  });
});
