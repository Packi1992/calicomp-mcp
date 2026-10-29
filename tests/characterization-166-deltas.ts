/**
 * Declared deltas of the characterization pins (Phase 166, plan 166-04, D-04 in the version
 * E-15 of the athlete, 2026-10-29).
 *
 * Phase 166 corrects existing fields of the MCP in place. Regenerating the pins would take
 * every unintended change along silently, so the pins of the state before 166 stay as they
 * are, and every intended change of a pinned value is declared in
 * `tests/vectors/characterization-166-deltas.json` before the code that produces it:
 *
 *   - a **delta** names `pinFile` (the bare file name), `pinKey`, `path` (an RFC 6901 JSON
 *     pointer into that pin), `before` (deeply equal to the pin at the pointer), `after` (the
 *     new value, derived by hand from the rule), `rule`, `plan` and `why`. A key that is gone
 *     after the change is declared by replacing its parent value as a whole.
 *   - an **addition** names `pinFile`, `pinKey`, `path` (a pointer, `*` for any list
 *     element), `rule`, `plan` and `why`: a key the pin does not know that is allowed to appear.
 *
 * `applyDeclaredDeltas` returns the pin with its deltas applied (and fails on a delta whose
 * `before` does not match); `expectPinsWithDeltas` compares a tool output against that, keeps
 * every old key deeply equal (`expectOldKeysUnchanged`) and, for `characterization-166.json`,
 * also rejects every key that is neither pinned nor a declared addition. Nothing else may
 * change: there is no silent change.
 *
 * `checkDeltaFile` enforces where each rule may act (see `DELTA_RULE_SCOPES`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expectOldKeysUnchanged } from './characterization-150-fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PIN_FILES = ['characterization-166.json', 'characterization-150.json', 'characterization-155.json'] as const;
export type PinFile = (typeof PIN_FILES)[number];

export const DELTA_FILE_PATH = join(__dirname, 'vectors', 'characterization-166-deltas.json');

export interface DeclaredDelta {
  pinFile: string;
  pinKey: string;
  path: string;
  before: unknown;
  after: unknown;
  rule: string;
  plan: string;
  why: string;
}

export interface DeclaredAddition {
  pinFile: string;
  pinKey: string;
  path: string;
  rule: string;
  plan: string;
  why: string;
}

export interface DeltaFile {
  deltas: DeclaredDelta[];
  additions: DeclaredAddition[];
}

export function loadDeltaFile(): DeltaFile {
  return JSON.parse(readFileSync(DELTA_FILE_PATH, 'utf-8')) as DeltaFile;
}

export function loadPinFile(pinFile: PinFile): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'vectors', pinFile), 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JSON pointer (RFC 6901)
// ---------------------------------------------------------------------------

export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`JSON pointer must start with "/": ${JSON.stringify(path)}`);
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function childOf(value: unknown, token: string): { found: boolean; value: unknown } {
  if (Array.isArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false, value: undefined };
    const index = Number(token);
    return index < value.length ? { found: true, value: value[index] } : { found: false, value: undefined };
  }
  if (value !== null && typeof value === 'object') {
    return Object.prototype.hasOwnProperty.call(value, token)
      ? { found: true, value: (value as Record<string, unknown>)[token] }
      : { found: false, value: undefined };
  }
  return { found: false, value: undefined };
}

export function resolvePointer(root: unknown, path: string): { found: boolean; value: unknown } {
  let current: { found: boolean; value: unknown } = { found: true, value: root };
  for (const token of parsePointer(path)) {
    current = childOf(current.value, token);
    if (!current.found) return current;
  }
  return current;
}

function setAtPointer(root: unknown, path: string, value: unknown): unknown {
  const tokens = parsePointer(path);
  if (tokens.length === 0) return value;
  let parent: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    const child = childOf(parent, token);
    if (!child.found) throw new Error(`parent of ${path} not found`);
    parent = child.value;
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    (parent as unknown[])[Number(last)] = value;
  } else {
    (parent as Record<string, unknown>)[last] = value;
  }
  return root;
}

function isPrefixPath(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((t, i) => t === b[i]);
}

function patternMatches(pattern: string[], tokens: string[]): boolean {
  return pattern.length === tokens.length && pattern.every((p, i) => p === tokens[i] || (p === '*' && /^\d+$/.test(tokens[i])));
}

// ---------------------------------------------------------------------------
// Where each rule may act (D-04 in the version E-15, plan 166-04 step 2)
// ---------------------------------------------------------------------------

const STATS_PIN_KEYS = new Set(['getStatsExercise', 'getStatsMuscle', 'getStatsCapabilities']);

/** A finding id of D-19 in the form of the test titles: `IN-06`, `IN-MCP-05`, `GR-MCP-03`, `WR-01`. */
const FINDING_ID = /^[A-Z]{2}(-[A-Z]{2,4})?-[0-9]{2}$/;

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/**
 * The scope of a delta rule: `S` only at `getTrainingState` under `/muscleBalance`, `M` only
 * there under `/personalRecords`, `P` only at the three `getStats` pins, `D-10` and `IN-02`
 * only at `getAdherence`, a D-19 finding id at any pin. Rule P changes of `muscleBalance` and
 * `personalRecords` are declared as S and M, because the protocol defines those fields as
 * Rule S over Rule P and Rule M over the population of Rule P (§1.11).
 */
export function deltaRuleProblem(d: Pick<DeclaredDelta, 'rule' | 'pinKey' | 'path'>): string | null {
  switch (d.rule) {
    case 'S':
      return d.pinKey === 'getTrainingState' && under(d.path, '/muscleBalance') ? null : 'rule S acts only on getTrainingState /muscleBalance';
    case 'M':
      return d.pinKey === 'getTrainingState' && under(d.path, '/personalRecords') ? null : 'rule M acts only on getTrainingState /personalRecords';
    case 'P':
      return STATS_PIN_KEYS.has(d.pinKey) ? null : 'rule P acts only on the getStats pins';
    case 'D-10':
    case 'IN-02':
      return d.pinKey === 'getAdherence' ? null : `${d.rule} acts only on getAdherence`;
    default:
      return FINDING_ID.test(d.rule) ? null : `unknown rule ${JSON.stringify(d.rule)}`;
  }
}

/**
 * The scope of an addition: `STAT-03` only `getTrainingState /capabilityBalance`, `STAT-05`
 * only `getTrainingState /dataQuality` or a `suspect` key in `getHistory`, a D-19 finding id
 * anywhere except beside a field that a delta corrects (no parallel field, D-04 E-15).
 */
export function additionRuleProblem(a: Pick<DeclaredAddition, 'rule' | 'pinKey' | 'path' | 'pinFile'>, deltas: DeclaredDelta[]): string | null {
  const tokens = parsePointer(a.path);
  if (tokens.length === 0) return 'an addition needs a key';
  switch (a.rule) {
    case 'STAT-03':
      return a.pinKey === 'getTrainingState' && under(a.path, '/capabilityBalance') ? null : 'STAT-03 adds only getTrainingState /capabilityBalance';
    case 'STAT-05':
      if (a.pinKey === 'getTrainingState' && under(a.path, '/dataQuality')) return null;
      if (a.pinKey === 'getHistory' && tokens[tokens.length - 1] === 'suspect') return null;
      return 'STAT-05 adds only getTrainingState /dataQuality or getHistory .../suspect';
    default: {
      if (!FINDING_ID.test(a.rule)) return `unknown addition rule ${JSON.stringify(a.rule)}`;
      const parent = tokens.slice(0, -1);
      const beside = deltas.some((d) => {
        if (d.pinFile !== a.pinFile || d.pinKey !== a.pinKey) return false;
        const dt = parsePointer(d.path);
        return dt.length === parent.length + 1 && patternMatches(parent, dt.slice(0, -1));
      });
      return beside ? 'an addition beside a corrected field is a parallel field (D-04 E-15)' : null;
    }
  }
}

/** Every problem of a delta file, empty when it is sound. */
export function checkDeltaFile(file: DeltaFile, pins: Partial<Record<PinFile, Record<string, unknown>>>): string[] {
  const problems: string[] = [];
  const planOk = (plan: string): boolean => /^166-(0[4-9]|10)$/.test(plan);
  const textOk = (why: string): boolean => typeof why === 'string' && why.trim().length > 0;
  file.deltas.forEach((d, i) => {
    const at = `deltas[${i}] ${d.pinFile}:${d.pinKey}${d.path}`;
    if (!(PIN_FILES as readonly string[]).includes(d.pinFile)) problems.push(`${at}: pinFile must be a bare pin file name`);
    if (!planOk(d.plan)) problems.push(`${at}: plan must be 166-04 to 166-10`);
    if (!textOk(d.why)) problems.push(`${at}: why is missing`);
    const ruleProblem = deltaRuleProblem(d);
    if (ruleProblem) problems.push(`${at}: ${ruleProblem}`);
    const pin = pins[d.pinFile as PinFile]?.[d.pinKey];
    if (pin === undefined) {
      problems.push(`${at}: pin key not found`);
    } else {
      const at0 = resolvePointer(pin, d.path);
      if (!at0.found) problems.push(`${at}: pointer not found in the pin`);
      else if (!isDeepStrictEqual(at0.value, d.before)) problems.push(`${at}: before differs from the pin`);
    }
    if (isDeepStrictEqual(d.before, d.after)) problems.push(`${at}: after equals before`);
    file.deltas.forEach((o, j) => {
      if (j <= i || o.pinFile !== d.pinFile || o.pinKey !== d.pinKey) return;
      const a = parsePointer(d.path);
      const b = parsePointer(o.path);
      if (isPrefixPath(a, b) || isPrefixPath(b, a)) problems.push(`${at}: overlaps deltas[${j}] ${o.path}`);
    });
  });
  file.additions.forEach((a, i) => {
    const at = `additions[${i}] ${a.pinFile}:${a.pinKey}${a.path}`;
    if (!(PIN_FILES as readonly string[]).includes(a.pinFile)) problems.push(`${at}: pinFile must be a bare pin file name`);
    if (!planOk(a.plan)) problems.push(`${at}: plan must be 166-04 to 166-10`);
    if (!textOk(a.why)) problems.push(`${at}: why is missing`);
    const ruleProblem = additionRuleProblem(a, file.deltas);
    if (ruleProblem) problems.push(`${at}: ${ruleProblem}`);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Applying deltas and comparing
// ---------------------------------------------------------------------------

/**
 * The pin `pinFile`:`pinKey` with every declared delta of that pin applied. Throws when a
 * delta's `before` is not deeply equal to the pin at its pointer, or `after` equals `before`.
 */
export function applyDeclaredDeltas(pinFile: PinFile, pinKey: string, pinned: unknown, file: DeltaFile = loadDeltaFile()): unknown {
  let result: unknown = structuredClone(pinned);
  for (const d of file.deltas) {
    if (d.pinFile !== pinFile || d.pinKey !== pinKey) continue;
    const at = resolvePointer(pinned, d.path);
    if (!at.found) throw new Error(`delta ${pinFile}:${pinKey}${d.path}: pointer not found in the pin`);
    if (!isDeepStrictEqual(at.value, d.before)) {
      throw new Error(
        `delta ${pinFile}:${pinKey}${d.path}: before ${JSON.stringify(d.before)} differs from the pin ${JSON.stringify(at.value)}`,
      );
    }
    if (isDeepStrictEqual(d.before, d.after)) throw new Error(`delta ${pinFile}:${pinKey}${d.path}: after equals before`);
    result = setAtPointer(result, d.path, structuredClone(d.after));
  }
  return result;
}

/** Keys of `actual` that `expected` does not know and no declared addition allows (JSON pointers). */
export function undeclaredKeys(actual: unknown, expected: unknown, additions: DeclaredAddition[]): { undeclared: string[]; used: Set<number> } {
  const undeclared: string[] = [];
  const used = new Set<number>();
  const patterns = additions.map((a) => parsePointer(a.path));
  const walk = (a: unknown, e: unknown, tokens: string[]): void => {
    if (Array.isArray(a) && Array.isArray(e)) {
      a.forEach((item, i) => { if (i < e.length) walk(item, e[i], [...tokens, String(i)]); });
      return;
    }
    if (a !== null && typeof a === 'object' && !Array.isArray(a) && e !== null && typeof e === 'object' && !Array.isArray(e)) {
      for (const key of Object.keys(a as Record<string, unknown>)) {
        const next = [...tokens, key];
        if (Object.prototype.hasOwnProperty.call(e, key)) {
          walk((a as Record<string, unknown>)[key], (e as Record<string, unknown>)[key], next);
          continue;
        }
        const index = patterns.findIndex((p) => patternMatches(p, next));
        if (index >= 0) used.add(index);
        else undeclared.push('/' + next.join('/'));
      }
    }
  };
  walk(actual, expected, []);
  return { undeclared, used };
}

/**
 * Compare a tool output against its pin with the declared deltas applied. Every old key stays
 * deeply equal; for `characterization-166.json` every key the pin does not know must be a
 * declared addition of this pin, and every declared addition of this pin must be used.
 */
export function expectPinsWithDeltas(actual: unknown, pinFile: PinFile, pinKey: string, pinned: unknown, file: DeltaFile = loadDeltaFile()): void {
  const expected = applyDeclaredDeltas(pinFile, pinKey, pinned, file);
  expectOldKeysUnchanged(actual, expected, `${pinFile}:${pinKey}`);
  if (pinFile !== 'characterization-166.json') return;
  const additions = file.additions.filter((a) => a.pinFile === pinFile && a.pinKey === pinKey);
  const { undeclared, used } = undeclaredKeys(actual, expected, additions);
  if (undeclared.length > 0) {
    throw new Error(`${pinFile}:${pinKey}: keys neither pinned nor declared as additions: ${undeclared.join(', ')}`);
  }
  const unused = additions.filter((_, i) => !used.has(i)).map((a) => a.path);
  if (unused.length > 0) {
    throw new Error(`${pinFile}:${pinKey}: declared additions that the output does not carry: ${unused.join(', ')}`);
  }
}
