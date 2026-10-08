/** RED stub (Plan 155-06 Aufgabe 2) — replaced in the GREEN commit. */
import type { AthleteFreeText, DecryptedForeignActivityType } from './types.js';

export interface ForeignBuiltinType {
  readonly key: string;
  readonly id: string;
  readonly nameEn: string;
  readonly nameDe: string;
}

export const FOREIGN_BUILTIN_TYPES: readonly ForeignBuiltinType[] = [];

export function wrapFreeText(text: string | null | undefined): AthleteFreeText | null {
  void text;
  return null;
}

export interface ForeignTypeFields {
  typeKey: string | null;
  typeName: string | AthleteFreeText | null;
  typeSource: 'builtin' | 'custom' | 'unknown';
  typeArchived: boolean;
  typeUnknown: boolean;
}

export function resolveForeignType(
  typeId: string,
  lang: string | undefined,
  types: DecryptedForeignActivityType[] | undefined,
): ForeignTypeFields {
  void typeId;
  void lang;
  void types;
  return { typeKey: null, typeName: null, typeSource: 'unknown', typeArchived: false, typeUnknown: true };
}
