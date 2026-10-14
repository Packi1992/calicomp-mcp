/**
 * Tests for src/app-language.ts (Phase 156, D-17/D-18).
 *
 * Coverage:
 *   - resolveAppLanguage reads the synchronized setting `default_language` and returns its
 *     language code when it is two to three lower-case letters (protocol §1.7 "The app
 *     language"), otherwise `null` with the reason `setting_not_synced` (missing) or
 *     `setting_unrecognized` (any other value) — and never throws.
 */

import { describe, it, expect } from 'vitest';
import { APP_LANGUAGE_SETTING_KEY, resolveAppLanguage } from '../src/app-language.js';
import type { DecryptedSnapshot } from '../src/types.js';

function snapshotWithSettings(settings: DecryptedSnapshot['settings']): DecryptedSnapshot {
  return {
    syncedAt: 1_700_000_000_000,
    exercises: [],
    exerciseTranslations: [],
    templates: [],
    blocks: [],
    templateExercises: [],
    sessions: [],
    setLogs: [],
    hrSamples: [],
    plannedWorkouts: [],
    settings,
  };
}

const TIME_ZONE_ROW = { key: 'training_timezone_id', type: 's', value: 'Europe/Berlin' };

describe('resolveAppLanguage (D-18)', () => {
  it('P156 D-18 resolveAppLanguage reports the setting or a named reason', () => {
    expect(APP_LANGUAGE_SETTING_KEY).toBe('default_language');

    // A recognized code is returned as is.
    expect(
      resolveAppLanguage(snapshotWithSettings([TIME_ZONE_ROW, { key: 'default_language', type: 's', value: 'de' }])),
    ).toEqual({ languageCode: 'de' });
    expect(resolveAppLanguage(snapshotWithSettings([{ key: 'default_language', type: 's', value: 'en' }]))).toEqual({
      languageCode: 'en',
    });
    expect(resolveAppLanguage(snapshotWithSettings([{ key: 'default_language', type: 's', value: 'fil' }]))).toEqual({
      languageCode: 'fil',
    });

    // Missing setting: the app has never synced a chosen language.
    expect(resolveAppLanguage(snapshotWithSettings([]))).toEqual({ languageCode: null, reason: 'setting_not_synced' });
    expect(resolveAppLanguage(snapshotWithSettings([TIME_ZONE_ROW]))).toEqual({
      languageCode: null,
      reason: 'setting_not_synced',
    });

    // Present, but not a two-to-three-letter lower-case code.
    for (const value of ['Deutsch', 'de-DE', 'DE', 'de_AT', '', ' de', 'd', 'deut']) {
      expect(
        resolveAppLanguage(snapshotWithSettings([{ key: 'default_language', type: 's', value }])),
        `value ${JSON.stringify(value)}`,
      ).toEqual({ languageCode: null, reason: 'setting_unrecognized' });
    }
  });

  it('P156 D-18 resolveAppLanguage never throws on a malformed settings row', () => {
    const malformed = snapshotWithSettings([
      { key: 'default_language', type: 's', value: undefined as unknown as string },
    ]);
    expect(() => resolveAppLanguage(malformed)).not.toThrow();
    expect(resolveAppLanguage(malformed)).toEqual({ languageCode: null, reason: 'setting_unrecognized' });

    const noSettings = { ...snapshotWithSettings([]), settings: undefined as unknown as DecryptedSnapshot['settings'] };
    expect(() => resolveAppLanguage(noSettings)).not.toThrow();
    expect(resolveAppLanguage(noSettings)).toEqual({ languageCode: null, reason: 'setting_not_synced' });
  });
});
