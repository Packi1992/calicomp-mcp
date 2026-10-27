/**
 * Plan 164-33 (IN-D01, protocol 1.46 §1.7 and §1.9 "Decoded rows"): structural guard for the error class "a decoder
 * of the MCP reads an integer the app's decoder refuses". `Number.isInteger` is true for every whole number a double
 * can hold, also far beyond 2^53 and beyond a Kotlin `Long`; the app reads such a value as `malformed_payload`
 * (`longValueExact`), so the coach named a row the app could not read.
 *
 * Scanned: every `src/*.ts` (comments removed). A site is a call `Number.isInteger(`. It is safe when it stands in a
 * statement that bounds the value on both sides with finite limits (a range check like `optionalIntInRange`), or when it
 * has a register entry with a reason. `Number.isSafeInteger(` is safe by itself (±(2^53 - 1)) and counted. Output
 * `INTEGER_BOUNDS dateien=<n> stellen=<n> sicher=<n> bereich=<n> register=<n> problems=<p>`. No file or no integer read
 * at all is NICHT GEMESSEN. A planted unbounded read must be reported as exactly one problem.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

interface Entry { file: string; contains: string; reason: string }

/** Sites without a two-sided bound that are right as they are. None today. */
const REGISTER: Entry[] = [];

const IS_INTEGER = /\bNumber\.isInteger\(/g;
const IS_SAFE = /\bNumber\.isSafeInteger\(/g;
/** A lower and an upper comparison in the same statement (an arrow `=>` is no comparison). */
const LOWER = />=?/;
const UPPER = /<=?/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** The statement around [at]: from the previous `;`, `{` or `}` to the next `;` or `?`. */
function statementAt(src: string, at: number): string {
  let start = at;
  while (start > 0 && !';{}'.includes(src[start - 1])) start--;
  let end = at;
  while (end < src.length && !';?'.includes(src[end])) end++;
  return src.slice(start, end).replace(/=>/g, ' ');
}

interface Result { files: number; sites: number; safe: number; ranged: number; registered: number; problems: string[] }

function scan(sources: Record<string, string>): Result {
  const r: Result = { files: Object.keys(sources).length, sites: 0, safe: 0, ranged: 0, registered: 0, problems: [] };
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    r.safe += [...src.matchAll(IS_SAFE)].length;
    for (const m of src.matchAll(IS_INTEGER)) {
      r.sites++;
      const at = m.index ?? 0;
      const statement = statementAt(src, at);
      const line = src.slice(0, at).split('\n').length;
      if (LOWER.test(statement) && UPPER.test(statement)) {
        r.ranged++;
      } else if (REGISTER.some((e) => e.file === file && statement.includes(e.contains))) {
        r.registered++;
      } else {
        r.problems.push(`${file}:${line}: Number.isInteger without a bound on both sides (use Number.isSafeInteger)`);
      }
    }
  }
  return r;
}

function sources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) out[f] = readFileSync(join(SRC, f), 'utf8');
  return out;
}

describe('integer bounds of the decoders (IN-D01)', () => {
  it('P164 no decoder reads an unbounded integer', () => {
    const r = scan(sources());
    console.log(
      `INTEGER_BOUNDS dateien=${r.files} stellen=${r.sites} sicher=${r.safe} bereich=${r.ranged} ` +
        `register=${r.registered} problems=${r.problems.length}`,
    );
    for (const p of r.problems) console.log(`INTEGER_BOUNDS_PROBLEM ${p}`);
    expect(r.files, 'NICHT GEMESSEN: no source file read').toBeGreaterThan(0);
    expect(r.sites + r.safe, 'NICHT GEMESSEN: no integer read found').toBeGreaterThan(0);
    expect(r.problems).toEqual([]);
  });

  it('P164 the guard reports a planted unbounded integer read', () => {
    const real = sources();
    const baseline = scan(real).problems.length;
    const planted = {
      ...real,
      'planted.ts': [
        '// Number.isInteger(x) in a comment is not a site',
        'export function read(p: { updatedAt: unknown }): number {',
        "  if (typeof p.updatedAt !== 'number' || !Number.isInteger(p.updatedAt)) throw new Error('x');",
        '  return p.updatedAt;',
        '}',
      ].join('\n'),
    };
    const problems = scan(planted).problems;
    expect(problems.length).toBe(baseline + 1);
    expect(problems.filter((p) => p.startsWith('planted.ts:'))).toHaveLength(1);
    // A second control: a read with a finite range on both sides is safe.
    const ranged = scan({ 'ranged.ts': 'const ok = Number.isInteger(v) && v >= 1 && v <= 5;' });
    expect(ranged.problems).toEqual([]);
    expect(ranged.ranged).toBe(1);
  });
});
