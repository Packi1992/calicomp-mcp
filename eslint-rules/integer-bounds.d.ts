// Types of the local ESLint rule `calicomp/integer-bounds` (integer-bounds.js) for the TypeScript tests.
import type { Rule } from 'eslint';

export declare const REGISTER: ReadonlyArray<{ file: string; contains: string; reason: string }>;

declare const integerBounds: Rule.RuleModule;
export default integerBounds;
