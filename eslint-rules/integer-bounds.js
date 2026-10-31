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
 * Origin: replaces the source-reading pattern test `tests/integer-bounds.test.ts` (phase 164 plan 33, IN-D01) as
 * part of phase 166.1 (D-06, D-10). Covered by `tests/eslint-rules/integer-bounds.test.ts`.
 *
 * Not seen: a call through an alias (`const { isInteger } = Number`) or a computed name built at run time.
 */

/**
 * Sites without a two-sided bound that are right as they are. None today.
 *
 * @type {ReadonlyArray<{ file: string, contains: string, reason: string }>}
 */
export const REGISTER = [];

const COMPARISONS = new Set(['<', '<=', '>', '>=']);

/** Whether [node] is the callee `Number.<name>` (plain or as a string-keyed member). */
function isNumberMember(node, name) {
  if (node?.type !== 'MemberExpression' || node.optional) return false;
  if (node.object.type !== 'Identifier' || node.object.name !== 'Number') return false;
  if (!node.computed) return node.property.type === 'Identifier' && node.property.name === name;
  return node.property.type === 'Literal' && node.property.value === name;
}

/** The top of the condition around [node]: climbs through `&&`, `||`, `??`, `!` and parentheses. */
function conditionTop(node) {
  let top = node;
  while (
    top.parent &&
    (top.parent.type === 'LogicalExpression' ||
      (top.parent.type === 'UnaryExpression' && top.parent.operator === '!'))
  ) {
    top = top.parent;
  }
  return top;
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
    if (text(c.left) === subject) {
      if (opensGreater) greater = true;
      else lesser = true;
    }
    if (text(c.right) === subject) {
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
        'the app refuses integers beyond a Long. Use `Number.isSafeInteger` or bound the value on both sides.',
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
