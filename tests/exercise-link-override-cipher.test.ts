/**
 * The decoder of a personal list of catalog exercise links (Phase 168.1, plan 168.1-03, D-01, D-02; protocol 1.57 §1.12
 * "Decoding a personal list"). Every vector of the corpus sections `exerciseLinkOverrideCipher` and
 * `exerciseLinkOverrideDecode` runs through the function `decryptMerge` uses; the app's decoder replays the same vectors
 * (crypto parity). The rules the corpus does not name one by one stand in the table below.
 */

import { describe, it, expect } from 'vitest';
import { decrypt } from '../src/crypto.js';
import { RowDecodeError } from '../src/row-decode.js';
import { decodeExerciseLinkOverridePlaintext, decryptExerciseLinkOverride } from '../src/exercise-link-override-cipher.js';
import { OWN_TEST_KEY_B64, encryptForTest } from './own-exercise-fixture.js';
import { loadCoachPlanningVectors } from './shared-vectors.js';

const CORPUS = loadCoachPlanningVectors();
const REASON_OF = { malformed: 'malformed_payload', unknown_version: 'unknown_version' } as const;

const EX = '16811000-0000-4000-8000-000000000001';
const MG = '16811000-0000-4000-8000-000000000101';
const MG_2 = '16811000-0000-4000-8000-000000000102';
const CAP = '16811000-0000-4000-8000-000000000301';
const ROW = { id: 'row-1', clientLocalId: EX };

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    if (err instanceof RowDecodeError) return err.reason;
    throw err;
  }
  throw new Error('the row was read');
}

function plaintext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    exerciseId: EX,
    muscleGroups: [{ id: MG, level: 'PRIMARY' }],
    capabilities: null,
    updatedAt: 1_793_000_000_000,
    ...overrides,
  };
}

function withoutKey(key: string): Record<string, unknown> {
  const out = plaintext();
  delete out[key];
  return out;
}

describe('decoding a personal list', () => {
  it.each(CORPUS.exerciseLinkOverrideCipher.map((v) => [v.name, v] as const))('decodes the corpus vector %s', (_name, vector) => {
    const decoded = decryptExerciseLinkOverride(
      { id: 'row-1', clientLocalId: String(vector.expectedDecoded.exerciseId), encryptedPayload: vector.ciphertextJson },
      vector.keyB64,
    );

    expect(decoded).toStrictEqual(vector.expectedDecoded);
    expect(decrypt(vector.ciphertextJson, vector.keyB64)).toBe(vector.expectedPlaintextString);
    expect(vector.byteRoundTrip).toBe(true);
    expect(JSON.stringify(vector.expectedPlaintext)).toBe(vector.expectedPlaintextString);
  });

  it.each(CORPUS.exerciseLinkOverrideDecode.map((v) => [v.name, v] as const))('decodes the corpus vector %s', (_name, vector) => {
    const row = { id: 'row-1', clientLocalId: vector.clientLocalId };
    if (vector.expect === 'ok') {
      expect(decodeExerciseLinkOverridePlaintext(vector.plaintext, row)).toStrictEqual(vector.decoded);
    } else {
      expect(reasonOf(() => decodeExerciseLinkOverridePlaintext(vector.plaintext, row))).toBe(REASON_OF[vector.expect]);
    }
  });

  it.each([
    ['a plaintext that is no JSON', 'not json', 'malformed_payload'],
    ['a JSON array', '[]', 'malformed_payload'],
    ['a JSON null', 'null', 'malformed_payload'],
    ['a missing version', JSON.stringify(withoutKey('v')), 'unknown_version'],
    ['the version as a string', JSON.stringify(plaintext({ v: '1' })), 'unknown_version'],
    ['an exerciseId in upper case', JSON.stringify(plaintext({ exerciseId: EX.toUpperCase() })), 'malformed_payload'],
    ['a missing updatedAt', JSON.stringify(withoutKey('updatedAt')), 'malformed_payload'],
    ['an updatedAt that is no integer', JSON.stringify(plaintext({ updatedAt: 1.5 })), 'malformed_payload'],
    ['an updatedAt beyond 2^53 - 1', JSON.stringify(plaintext({ updatedAt: 2 ** 53 })), 'malformed_payload'],
    ['a missing muscleGroups key', JSON.stringify(withoutKey('muscleGroups')), 'malformed_payload'],
    ['a missing capabilities key', JSON.stringify(withoutKey('capabilities')), 'malformed_payload'],
    ['a list that is a string', JSON.stringify(plaintext({ capabilities: 'x' })), 'malformed_payload'],
    ['an entry that is no object', JSON.stringify(plaintext({ muscleGroups: ['x'] })), 'malformed_payload'],
    ['an entry without id', JSON.stringify(plaintext({ muscleGroups: [{ level: 'PRIMARY' }] })), 'malformed_payload'],
    ['an entry id that is no UUID', JSON.stringify(plaintext({ muscleGroups: [{ id: 'x', level: 'PRIMARY' }] })), 'malformed_payload'],
    ['an unknown key in an entry', JSON.stringify(plaintext({ muscleGroups: [{ id: MG, level: 'PRIMARY', extra: 1 }] })), 'malformed_payload'],
    ['a muscle entry without level', JSON.stringify(plaintext({ muscleGroups: [{ id: MG }] })), 'malformed_payload'],
    ['a capability entry without level', JSON.stringify(plaintext({ capabilities: [{ id: CAP }] })), 'malformed_payload'],
    ['a capability level of the muscle axis', JSON.stringify(plaintext({ capabilities: [{ id: CAP, level: 'PRIMARY' }] })), 'malformed_payload'],
  ])('refuses %s', (_name, text, reason) => {
    expect(reasonOf(() => decodeExerciseLinkOverridePlaintext(text, ROW))).toBe(reason);
  });

  it('keeps an unsorted list in the order it was written', () => {
    const list = [{ id: MG_2, level: null }, { id: MG, level: 'STABILIZER' }];

    expect(decodeExerciseLinkOverridePlaintext(JSON.stringify(plaintext({ muscleGroups: list })), ROW).muscleGroups).toStrictEqual(list);
  });
});

describe('decrypting a personal list', () => {
  it('an empty payload is malformed', () => {
    expect(reasonOf(() => decryptExerciseLinkOverride({ ...ROW, encryptedPayload: '' }, OWN_TEST_KEY_B64))).toBe('malformed_payload');
  });

  it('a flipped byte in the ciphertext or its tag does not decrypt', () => {
    const envelope = JSON.parse(encryptForTest(JSON.stringify(plaintext()))) as { iv: string; ct: string };
    for (const position of [0, -1]) {
      const ct = Buffer.from(envelope.ct, 'base64');
      ct[position < 0 ? ct.length + position : position] ^= 0xff;
      const tampered = JSON.stringify({ iv: envelope.iv, ct: ct.toString('base64') });
      expect(reasonOf(() => decryptExerciseLinkOverride({ ...ROW, encryptedPayload: tampered }, OWN_TEST_KEY_B64))).toBe('decrypt_failed');
    }
  });

  it('an error message names the row and carries nothing of the payload', () => {
    const payload = encryptForTest(JSON.stringify(plaintext({ muscleGroups: [{ id: MG, level: 'HAUPTREIZ' }] })));
    let message = '';
    try {
      decryptExerciseLinkOverride({ ...ROW, encryptedPayload: payload }, OWN_TEST_KEY_B64);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('row-1');
    expect(message).not.toContain(MG);
    expect(message).not.toContain('HAUPTREIZ');
  });
});
