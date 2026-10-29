/**
 * The app language — Phase 156, D-17/D-18; since Phase 166, gap plan 166-20 (E-16, protocol 1.50).
 *
 * Source: docs/COACH-PLANNING-PROTOCOL.md §1.7 "Which language" and "The app language".
 *
 * Two synchronized `settings` rows carry the language the athlete sees in the app (the same mirror
 * `resolveTimeZoneId` reads in `training-state/time-zone.ts`), read in this order:
 *
 *   1. `default_language` — the athlete's explicit choice;
 *   2. `effective_language` — since 1.50 a device fact like `training_timezone_id`: the app writes the
 *      language it actually uses (the choice, otherwise the device language, as a code of its list
 *      `SupportedLanguages`, otherwise `en`) on every sync run, so the language is known also without
 *      an explicit choice.
 *
 * It serves two purposes:
 *
 *   - E-16 (before: D-17 for own names only): it is the effective language of EVERY name a tool
 *     returns whenever the tool is called without `lang` (`effectiveNameLanguage`, used by
 *     `exercise-names.ts`, the foreign type fields, `get_exercise_catalog` and the sentence
 *     `narrative`). With `lang`, `lang` applies.
 *   - D-18: it becomes the visible field `get_training_state.appLanguage` (156-09).
 *
 * A value counts only when it consists of two to three lower-case letters (`^[a-z]{2,3}$`, for
 * example `de`). Without such a value in either row the result is `null` with one reason over both
 * rows: `setting_unreadable` when one of them arrived but could not be decrypted or decoded (it then
 * stands in the decode report's `unreadable` list with `entity: "setting"` and its key; Phase 156 gap
 * round, WR-MCP-04, protocol 1.29), otherwise `setting_unrecognized` when one of them is readable but
 * not such a code, otherwise `setting_not_synced` (neither row). A pull without
 * `effective_language` yields every reason exactly as in 1.49. The decode report is optional: a
 * caller without one (the name resolver, which only needs the code) gets `setting_not_synced` for an
 * unreadable row too, which takes away the same fallback. Unlike `resolveTimeZoneId`, this function
 * NEVER throws: a missing app language only leaves the names in English, it never fails a tool.
 *
 * Pure, no I/O, no console output.
 */

import type { DecodeReport, DecryptedSnapshot } from './types.js';

/** The synchronized `settings` key carrying the app's chosen language code. */
export const APP_LANGUAGE_SETTING_KEY = 'default_language';

/**
 * Since protocol 1.50 (166-20, E-16): the synchronized device fact carrying the language the app
 * actually uses, written by the app itself on every sync run; read after `default_language`.
 */
export const EFFECTIVE_LANGUAGE_SETTING_KEY = 'effective_language';

/**
 * Plan 166-20 (E-16, MCP-09; protocol 1.50 §1.7 "Which language"): the one sentence every name tool
 * carries in its description (nine tools). English and without a dash, like every tool text.
 */
export const APP_LANGUAGE_NAMES_SENTENCE =
  'Without lang, every name follows the app language (appLanguage of get_training_state): ' +
  'exerciseName, typeName, localizedName and the name of a catalog exercise in narrative use the ' +
  'translation of that language, otherwise English; when the app language is unknown, every name ' +
  'is English.';

/**
 * Plan 166-10 (156-GR-MCP-05), reworded in 166-20 (E-16, protocol 1.50 §1.7 "The app language"):
 * the sentence every tool with own names carries (seven tools).
 */
export const OWN_NAMES_WITHOUT_LANG_SENTENCE =
  'Without lang, own names follow the app language too: when it is unknown (neither chosen in ' +
  'the app nor synced by it) or unreadable, no own name appears (get_training_state names the ' +
  'reason in appLanguageUnavailableReason); call again with lang, for example "de", to see the ' +
  'own names of that language.';

/** The language code of the app, or `null` with the reason it is not available. */
export type AppLanguageResolution =
  | { languageCode: string }
  | { languageCode: null; reason: AppLanguageUnavailableReason };

/**
 * Why the app language is not available (protocol §1.7 "The app language"), over both rows
 * `default_language` and `effective_language`: `setting_unreadable` = one of them arrived but cannot
 * be decrypted or decoded, otherwise `setting_unrecognized` = one of them is readable but not a
 * language code, otherwise `setting_not_synced` = neither row is in the pull.
 */
export type AppLanguageUnavailableReason = 'setting_not_synced' | 'setting_unreadable' | 'setting_unrecognized';

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}$/;

/** The state of one language row of the pull. */
type LanguageRowState =
  | { state: 'code'; code: string }
  | { state: 'missing' | 'unreadable' | 'unrecognized' };

function readLanguageRow(
  snapshot: DecryptedSnapshot,
  report: Pick<DecodeReport, 'unreadable'> | undefined,
  key: string,
): LanguageRowState {
  const settings: DecryptedSnapshot['settings'] | undefined = snapshot.settings;
  const row = Array.isArray(settings) ? settings.find((s) => s.key === key) : undefined;
  if (!row) {
    const unreadable: unknown = report?.unreadable;
    const arrivedUnreadable =
      Array.isArray(unreadable) &&
      unreadable.some(
        (r: { entity?: unknown; key?: unknown } | null | undefined) => r?.entity === 'setting' && r.key === key,
      );
    return { state: arrivedUnreadable ? 'unreadable' : 'missing' };
  }
  const value: unknown = row.value;
  if (typeof value !== 'string' || !LANGUAGE_CODE_PATTERN.test(value)) return { state: 'unrecognized' };
  return { state: 'code', code: value };
}

/**
 * Resolve the app language from a decrypted snapshot's `settings` array (protocol §1.7 "The app
 * language", version 1.50): `default_language` when it is a code, otherwise `effective_language`
 * when it is one, otherwise `null` with the reason over both rows (`setting_unreadable`, then
 * `setting_unrecognized`, then `setting_not_synced`). With the decode report of the same read, a row
 * listed there as unreadable counts as unreadable instead of missing. Never throws.
 */
export function resolveAppLanguage(
  snapshot: DecryptedSnapshot,
  report?: Pick<DecodeReport, 'unreadable'>,
): AppLanguageResolution {
  const chosen = readLanguageRow(snapshot, report, APP_LANGUAGE_SETTING_KEY);
  if (chosen.state === 'code') return { languageCode: chosen.code };
  const mirrored = readLanguageRow(snapshot, report, EFFECTIVE_LANGUAGE_SETTING_KEY);
  if (mirrored.state === 'code') return { languageCode: mirrored.code };
  const states = [chosen.state, mirrored.state];
  const reason: AppLanguageUnavailableReason = states.includes('unreadable')
    ? 'setting_unreadable'
    : states.includes('unrecognized')
      ? 'setting_unrecognized'
      : 'setting_not_synced';
  return { languageCode: null, reason };
}

/**
 * THE effective language of every name a tool returns (protocol 1.50 §1.7 "Which language", E-16):
 * `lang` when the tool receives it, otherwise the app language, otherwise `null` (then every name
 * stays English and there is no own-name field, as in 1.49). Tools without a `lang` parameter pass
 * `undefined`. Never throws.
 */
export function effectiveNameLanguage(snapshot: DecryptedSnapshot, lang: string | undefined): string | null {
  return lang ?? resolveAppLanguage(snapshot).languageCode;
}
