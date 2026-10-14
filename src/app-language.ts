/**
 * The app language — Phase 156, D-17/D-18.
 *
 * Source: docs/COACH-PLANNING-PROTOCOL.md §1.7 "Which language" and "The app language".
 *
 * The athlete's chosen app language travels as the synchronized setting `default_language`
 * (one `settings` row, the same mirror `resolveTimeZoneId` reads in
 * `training-state/time-zone.ts`). It serves two purposes:
 *
 *   - D-17: it is the effective language of an own exercise name whenever a tool is called
 *     without `lang` (`exercise-names.ts`). `exerciseName` itself never follows it.
 *   - D-18: it becomes the visible field `get_training_state.appLanguage` (156-09).
 *
 * A value counts only when it consists of two to three lower-case letters
 * (`^[a-z]{2,3}$`, for example `de`). Otherwise the result is `null` with a named reason:
 * `setting_not_synced` when the row is missing (the app syncs `default_language` only once
 * the athlete has chosen a language), `setting_unrecognized` when its value is not such a
 * code. Unlike `resolveTimeZoneId`, this function NEVER throws: a missing app language only
 * takes away the own-name fallback, it never fails a tool.
 *
 * Pure, no I/O, no console output.
 */

import type { DecryptedSnapshot } from './types.js';

/** The synchronized `settings` key carrying the app's chosen language code. */
export const APP_LANGUAGE_SETTING_KEY = 'default_language';

/** The language code of the app, or `null` with the reason it is not available. */
export type AppLanguageResolution =
  | { languageCode: string }
  | { languageCode: null; reason: 'setting_not_synced' | 'setting_unrecognized' };

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}$/;

/**
 * Resolve the app language from a decrypted snapshot's `settings` array (protocol §1.7
 * "The app language"). Never throws.
 */
export function resolveAppLanguage(snapshot: DecryptedSnapshot): AppLanguageResolution {
  const settings: DecryptedSnapshot['settings'] | undefined = snapshot.settings;
  const row = Array.isArray(settings) ? settings.find((s) => s.key === APP_LANGUAGE_SETTING_KEY) : undefined;
  if (!row) {
    return { languageCode: null, reason: 'setting_not_synced' };
  }
  const value: unknown = row.value;
  if (typeof value !== 'string' || !LANGUAGE_CODE_PATTERN.test(value)) {
    return { languageCode: null, reason: 'setting_unrecognized' };
  }
  return { languageCode: value };
}
