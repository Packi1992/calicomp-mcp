/**
 * RuleTester of the local ESLint rule `calicomp/integer-bounds` (`eslint-rules/integer-bounds.js`).
 *
 * The rule replaces the source-reading pattern test of phase 164 plan 33 (IN-D01, protocol §1.7 and §1.9
 * "Decoded rows") in phase 166.1 (D-06, D-10): the planted unbounded read and the ranged read of that test's control
 * case stand here as invalid and valid cases. That `src/` itself is clean is proven by `npm run lint`, where the
 * rule runs at level `error`.
 */

import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import integerBounds from '../../eslint-rules/integer-bounds.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser },
});

const DECODER = 'src/decoder.ts';
const register = (contains: string, file = DECODER) => [{ register: [{ file, contains, reason: 'invented reason' }] }];

ruleTester.run('integer-bounds', integerBounds, {
  valid: [
    {
      name: 'a read bounded on both sides by a range check is safe',
      code: "const ok = typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;",
    },
    {
      name: 'rejecting the outside of a range bounds the read on both sides',
      code: "if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error('x');",
    },
    {
      name: 'a bound with the value on the right side counts',
      code: 'const ok = Number.isInteger(v) && 1 <= v && 5 >= v;',
    },
    {
      name: 'a read with a range in the same return condition is safe',
      code: "function f(value: unknown, min: number, max: number) { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null; }",
    },
    {
      name: 'Number.isSafeInteger is bounded by itself',
      code: "function f(p: { updatedAt: unknown }) { if (typeof p.updatedAt !== 'number' || !Number.isSafeInteger(p.updatedAt)) throw new Error('x'); return p.updatedAt; }",
    },
    {
      name: 'Number.isInteger in a comment is no site',
      code: '// Number.isInteger(x) in a comment is not a site\nconst y = 1;',
    },
    {
      name: 'a registered site without a bound is allowed',
      code: 'const whole = Number.isInteger(ratio);',
      filename: DECODER,
      options: register('Number.isInteger(ratio)'),
    },
    {
      name: 'optional access on Number is a call like any other and counts its bounds (166.1-review WR-17)',
      code: 'const ok = Number?.isInteger(v) && v >= 1 && v <= 5;',
    },
    {
      name: 'an optional call counts its bounds (166.1-review WR-17)',
      code: 'const ok = Number.isInteger?.(v) && v >= 1 && v <= 5;',
    },
    {
      name: 'Number.MAX_SAFE_INTEGER and a literal within it are upper bounds (166.1-review WR-17)',
      code: 'const ok = Number.isInteger(v) && v >= -9007199254740991 && v <= Number.MAX_SAFE_INTEGER;',
    },
    {
      name: 'a registered method reference is allowed (166.1-review WR-17)',
      code: 'const all = xs.every(Number.isInteger);',
      filename: DECODER,
      options: register('xs.every(Number.isInteger)'),
    },
  ],
  invalid: [
    {
      name: 'an integer read without any bound is an error',
      code: [
        '// Number.isInteger(x) in a comment is not a site',
        'export function read(p: { updatedAt: unknown }): number {',
        "  if (typeof p.updatedAt !== 'number' || !Number.isInteger(p.updatedAt)) throw new Error('x');",
        '  return p.updatedAt;',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'unbounded', data: { subject: 'p.updatedAt' }, line: 3 }],
    },
    {
      name: 'a read with only a lower bound is an error',
      code: 'const ok = Number.isInteger(v) && v >= 0;',
      errors: [{ messageId: 'unbounded' }],
    },
    {
      name: 'a range on another value does not bound the read',
      code: 'const ok = Number.isInteger(v) && w >= 1 && w <= 5;',
      errors: [{ messageId: 'unbounded' }],
    },
    {
      name: 'a range check in the next statement does not bound the read',
      code: "if (!Number.isInteger(v)) throw new Error('x');\nif (v < 1 || v > 5) throw new Error('y');",
      errors: [{ messageId: 'unbounded', line: 1 }],
    },
    {
      name: 'a register entry of another file does not cover the read',
      code: 'const whole = Number.isInteger(ratio);',
      filename: DECODER,
      options: register('Number.isInteger(ratio)', 'src/other.ts'),
      errors: [{ messageId: 'unbounded' }],
    },
    {
      name: 'a register entry without a hit in its file is an error',
      code: 'const whole = Number.isSafeInteger(ratio);',
      filename: DECODER,
      options: register('Number.isInteger(ratio)'),
      errors: [{ messageId: 'registerWithoutHit', data: { contains: 'Number.isInteger(ratio)' } }],
    },
    {
      name: 'a method reference passes every value unbounded (166.1-review WR-17)',
      code: 'const all = xs.every(Number.isInteger);',
      errors: [{ messageId: 'reference' }],
    },
    {
      name: 'an alias through assignment hides the call and is an error (166.1-review WR-17)',
      code: 'const isInt = Number.isInteger;\nconst ok = isInt(v) && v >= 1 && v <= 5;',
      errors: [{ messageId: 'reference', line: 1 }],
    },
    {
      name: 'Number.isInteger.call hides the call and is an error (166.1-review WR-17)',
      code: 'const ok = Number.isInteger.call(null, v) && v >= 1 && v <= 5;',
      errors: [{ messageId: 'reference' }],
    },
    {
      name: 'optional access on Number without a bound is an error (166.1-review WR-17)',
      code: 'const ok = Number?.isInteger(v) && v >= 0;',
      errors: [{ messageId: 'unbounded', data: { subject: 'v' } }],
    },
    {
      name: 'a template-literal member name is the same call (166.1-review WR-17)',
      code: 'const ok = Number[`isInteger`](v) && v >= 0;',
      errors: [{ messageId: 'unbounded' }],
    },
    {
      name: 'an upper bound beyond Number.MAX_SAFE_INTEGER is no bound (166.1-review WR-17)',
      code: 'const ok = Number.isInteger(v) && v >= 0 && v <= 1e300;',
      errors: [{ messageId: 'unbounded' }],
    },
    {
      name: 'a lower bound below -Number.MAX_SAFE_INTEGER is no bound (166.1-review WR-17)',
      code: "if (!Number.isInteger(v) || v < -1e300 || v > 5) throw new Error('x');",
      errors: [{ messageId: 'unbounded' }],
    },
    {
      name: 'Infinity and Number.MAX_VALUE are no bounds (166.1-review WR-17)',
      code: 'const a = Number.isInteger(v) && v >= 0 && v <= Infinity;\nconst b = Number.isInteger(w) && w >= 0 && w < Number.MAX_VALUE;\nconst c = Number.isInteger(u) && Number.NEGATIVE_INFINITY < u && u <= 5;',
      errors: [
        { messageId: 'unbounded', line: 1 },
        { messageId: 'unbounded', line: 2 },
        { messageId: 'unbounded', line: 3 },
      ],
    },
  ],
});
