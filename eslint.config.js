import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import integerBounds from './eslint-rules/integer-bounds.js';

export default [
  ...tsPlugin.configs['flat/recommended'],
  {
    languageOptions: {
      parser: tsParser,
    },
    // Local rules as the virtual plugin `calicomp` (phase 166.1, D-10); each has a RuleTester test in tests/eslint-rules/.
    plugins: {
      calicomp: {
        rules: {
          'integer-bounds': integerBounds,
        },
      },
    },
    rules: {
      'no-console': ['error', { allow: ['error'] }],
      'calicomp/integer-bounds': 'error',
    },
  },
];
