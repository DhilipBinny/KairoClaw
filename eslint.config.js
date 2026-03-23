// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.svelte-kit/**',
      '**/build/**',
      'packages/ui/**', // Svelte needs separate eslint-plugin-svelte setup
      '_local/**',
      'docs/**',
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript rules — only bug-catching, not style
  ...tseslint.configs.recommended,

  // Custom overrides — focus on bugs, not aesthetics
  {
    rules: {
      // Turn OFF style rules — we don't care about formatting
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      'no-throw-literal': 'off',
      'preserve-caught-error': 'off',

      // Keep ON — these catch real bugs
      'no-constant-condition': 'warn',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-empty-pattern': 'error',
      'no-fallthrough': 'warn',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-labels': 'warn',
      'no-useless-catch': 'warn',
      'no-var': 'error',
      'prefer-const': 'warn',

      // Suppress common patterns in our codebase
      'no-empty': ['error', { allowEmptyCatch: true }], // we use empty catch blocks intentionally
      'no-control-regex': 'off', // we use \x00 checks for null byte detection
      'no-useless-escape': 'warn', // downgrade to warning
      'no-useless-assignment': 'off', // too many false positives with let + reassign patterns
    },
  },
);
