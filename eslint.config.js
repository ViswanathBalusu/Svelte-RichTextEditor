// Linting for the whole workspace (FND-001). Architecture boundaries are enforced separately by
// dependency-cruiser (.dependency-cruiser.cjs) and by each package's TypeScript lib setting (FND-004).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'docs/**',
      'spec/**',
      'packages/*/src/generated/**',
      'services/export-worker/out/**',
      'packages/export-latex/out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // noUncheckedIndexedAccess is on, so `!` after a bounds check is the deliberate idiom.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Tooling and scripts run in Node.js.
    files: [
      '**/scripts/**',
      '**/*.config.{js,ts,mjs,cjs}',
      '.dependency-cruiser.cjs',
      'services/**',
      'infra/containers/**/*.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
