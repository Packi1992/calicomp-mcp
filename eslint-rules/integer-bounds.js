/**
 * Local ESLint rule `calicomp/integer-bounds` (virtual plugin `calicomp` in `eslint.config.js`).
 *
 * Error class: a decoder of the MCP accepts an integer the app's decoder refuses (protocol §1.7 and §1.9 "Decoded
 * rows"). `Number.isInteger` is true for every whole number a double can hold, also far beyond 2^53 and beyond a
 * Kotlin `Long`; the app reads such a value as `malformed_payload` (`longValueExact`), so the coach would name a row
 * the app cannot read.
 *
 * A call `Number.isInteger(x)` is reported unless the condition it stands in compares the same expression `x` in both
 * directions (a lower and an upper bound, e.g. `x >= 1 && x <= 5`, or the negated `x < 1 || x > 5`). The condition is
 * the chain of `&&`, `||`, `??` and `!` around the call. `Number.isSafeInteger(x)` is bounded by itself (±(2^53 - 1))
 * and never reported. A site that is right without a two-sided bound needs an entry in `REGISTER` (file, a text the
 * condition contains, reason); an entry without a hit in its file is reported at the end of that file.
 *
 * Since 166.1-review WR-17 also:
 * - `Number.isInteger` used as a value and not called (method reference `xs.every(Number.isInteger)`, an alias
 *   `const f = Number.isInteger`, `Number.isInteger.call(…)`) is reported: no bound on the checked value can be seen.
 *   A register entry matches against the text of the expression around the reference.
 * - Optional access (`Number?.isInteger(x)`, `Number.isInteger?.(x)`) and a template-literal name
 *   (Number[`isInteger`]) are calls like any other.
 * - A bound counts only if it can be smaller than a Long can hold: a numeric literal (also negated) beyond
 *   `Number.MAX_SAFE_INTEGER` in magnitude, `Infinity`, `Number.MAX_VALUE`, `Number.POSITIVE_INFINITY` and
 *   `Number.NEGATIVE_INFINITY` are no bound. A bound through a variable or call (`value <= max`) is trusted.
 *
 * Origin: replaces the source-reading pattern test `tests/integer-bounds.test.ts` (phase 164 plan 33, IN-D01) as
 * part of phase 166.1 (D-06, D-10). Covered by `tests/eslint-rules/integer-bounds.test.ts`.
 *
 * Not seen: a destructured alias (`const { isInteger } = Number`), `globalThis.Number.isInteger`, a computed name built at
 * run time, and the value of a variable used as a bound.
 */

/**
 * Sites without a two-sided bound that are right as they are. None today.
 *
 * @type {ReadonlyArray<{ file: string, contains: string, reason: string }>}
 */
export const REGISTER = [];

const COMPARISONS = new Set(['<', '<=', '>', '>=']);

/**
 * Whether [node] is the member `Number.<name>` (plain, optional `Number?.<name>`, or keyed by a string or a template
 * literal without expressions).
 */
function isNumberMember(node, name) {
  if (node?.type !== 'MemberExpression') return false;
  if (node.object.type !== 'Identifier' || node.object.name !== 'Number') return false;
  if (!node.computed) return node.property.type === 'Identifier' && node.property.name === name;
  if (node.property.type === 'Literal') return node.property.value === name;
  return (
    node.property.type === 'TemplateLiteral' &&
    node.property.expressions.length === 0 &&
    node.property.quasis[0]?.value.cooked === name
  );
}

/** The top of the condition around [node]: climbs through `&&`, `||`, `??`, `!`, optional chains and parentheses. */
function conditionTop(node) {
  let top = node;
  while (
    top.parent &&
    (top.parent.type === 'LogicalExpression' ||
      top.parent.type === 'ChainExpression' ||
      (top.parent.type === 'UnaryExpression' && top.parent.operator === '!'))
  ) {
    top = top.parent;
  }
  return top;
}

/** Members of `Number` that are no bound for a Long. */
const UNBOUNDED_NUMBER_MEMBERS = ['MAX_VALUE', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY'];

/**
 * Whether [node] can serve as a bound: not a literal beyond `Number.MAX_SAFE_INTEGER` in magnitude, not `Infinity`,
 * not `Number.MAX_VALUE` or an infinity. Anything else (a variable, a call, `Number.MAX_SAFE_INTEGER`) is trusted.
 */
function isUsableBound(node) {
  const inner = node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+') ? node.argument : node;
  if (inner.type === 'Literal') {
    if (typeof inner.value === 'number') return Math.abs(inner.value) <= Number.MAX_SAFE_INTEGER;
    if (typeof inner.value === 'bigint') {
      const v = inner.value < 0n ? -inner.value : inner.value;
      return v <= BigInt(Number.MAX_SAFE_INTEGER);
    }
    return true;
  }
  if (inner.type === 'Identifier' && inner.name === 'Infinity') return false;
  return !UNBOUNDED_NUMBER_MEMBERS.some((m) => isNumberMember(inner, m));
}

/** Every comparison (`<`, `<=`, `>`, `>=`) inside [root], walked with the parser's visitor keys. */
function comparisonsIn(root, visitorKeys) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === 'BinaryExpression' && COMPARISONS.has(node.operator)) out.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') stack.push(c);
      } else if (child && typeof child.type === 'string') {
        stack.push(child);
      }
    }
  }
  return out;
}

/**
 * Whether [comparisons] bound the expression with source text [subject] in both directions. `x > a`, `x >= a`,
 * `a < x`, `a <= x` put `x` on the greater side; `x < b`, `x <= b`, `b > x`, `b >= x` on the lesser side. Both
 * sides together are a range, whether the condition accepts it (`x >= 1 && x <= 5`) or rejects its outside
 * (`x < 1 || x > 5`).
 */
function boundedBothWays(comparisons, subject, text) {
  let greater = false;
  let lesser = false;
  for (const c of comparisons) {
    const opensGreater = c.operator.startsWith('>');
    if (text(c.left) === subject && isUsableBound(c.right)) {
      if (opensGreater) greater = true;
      else lesser = true;
    }
    if (text(c.right) === subject && isUsableBound(c.left)) {
      if (opensGreater) lesser = true;
      else greater = true;
    }
  }
  return greater && lesser;
}

function normalizedPath(filename) {
  return String(filename).replace(/\\/g, '/');
}

function fileMatches(filename, entryFile) {
  const f = normalizedPath(filename);
  const e = normalizedPath(entryFile);
  return f === e || f.endsWith(`/${e}`);
}

/** @type {import('eslint').Rule.RuleModule} */
const integerBounds = {
  meta: {
    type: 'problem',
    docs: {
      description: 'require a two-sided bound around Number.isInteger in decoders (use Number.isSafeInteger)',
    },
    schema: [
      {
        type: 'object',
        properties: {
          register: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', minLength: 1 },
                contains: { type: 'string', minLength: 1 },
                reason: { type: 'string', minLength: 1 },
              },
              required: ['file', 'contains', 'reason'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unbounded:
        '`Number.isInteger({{subject}})` without a lower and an upper bound on the same value in the same condition: ' +
        'the app refuses integers beyond a Long. Use `Number.isSafeInteger` or bound the value on both sides ' +
        '(a bound beyond Number.MAX_SAFE_INTEGER, Infinity or Number.MAX_VALUE does not count).',
      reference:
        '`Number.isInteger` used as a value and not called (`{{text}}`): no bound on the checked value can be seen. ' +
        'Use `Number.isSafeInteger` or call `Number.isInteger(x)` with a two-sided bound.',
      registerWithoutHit:
        'Register entry of calicomp/integer-bounds for "{{contains}}" has no hit in this file; remove the entry.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const register = context.options[0]?.register ?? REGISTER;
    const entries = register.filter((e) => fileMatches(context.filename, e.file));
    const hit = new Set();
    const text = (node) => sourceCode.getText(node);
    return {
      MemberExpression(node) {
        if (!isNumberMember(node, 'isInteger')) return;
        if (node.parent?.type === 'CallExpression' && node.parent.callee === node) return;
        const around = text(node.parent ?? node);
        const entry = entries.find((e) => around.includes(e.contains));
        if (entry) {
          hit.add(entry);
          return;
        }
        context.report({ node, messageId: 'reference', data: { text: around } });
      },
      CallExpression(node) {
        if (!isNumberMember(node.callee, 'isInteger') || node.arguments.length === 0) return;
        const subject = text(node.arguments[0]);
        const top = conditionTop(node);
        if (boundedBothWays(comparisonsIn(top, sourceCode.visitorKeys), subject, text)) return;
        const condition = text(top);
        const entry = entries.find((e) => condition.includes(e.contains));
        if (entry) {
          hit.add(entry);
          return;
        }
        context.report({ node, messageId: 'unbounded', data: { subject } });
      },
      'Program:exit'(node) {
        for (const e of entries) {
          if (!hit.has(e)) context.report({ node, messageId: 'registerWithoutHit', data: { contains: e.contains } });
        }
      },
    };
  },
};

export default integerBounds;
