// Linting for the whole workspace (FND-001). Architecture boundaries are enforced separately by
// dependency-cruiser (.dependency-cruiser.cjs) and by each package's TypeScript lib setting (FND-004).
import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

// FE-022 criterion 3: every `de-` event leaves through one helper per package, so a host can rely
// on `composed`, `bubbles` and the name prefix (02 §4). Any other `dispatchEvent` call fails.
export const oneDispatchHelper = {
  selector: "CallExpression[callee.property.name='dispatchEvent']",
  message:
    'Dispatch events through the one helper (dispatchDocEvent in packages/ui/src/de-event.ts, emit in packages/element/src/events.ts), never with dispatchEvent directly (FE-022).',
};

// FE-108 criterion 2: an id or selector lookup on the document reaches outside the shadow root, so
// an ARIA or `for` reference built from it cannot resolve (02 §2). Look up from the root instead.
const lookupName = '/^(getElementById|getElementsBy[A-Za-z]+|querySelector|querySelectorAll)$/';
export const noDocumentLookup = [
  `MemberExpression[object.name='document'][property.name=${lookupName}]`,
  `MemberExpression[object.property.name='document'][property.name=${lookupName}]`,
].map((selector) => ({
  selector,
  message:
    'Do not look up elements on the document: it reaches outside the shadow root. Use the root or an element inside it (FE-108).',
}));

// Tests drive the real page on purpose, so the two rules above do not apply to them.
export const editorTests = ['**/*.test.ts', '**/*.test.js'];

/**
 * Parses the Svelte components matched by `files`, so that rules reach them. Only the parser is
 * set up: the plugin's own rule sets are not turned on.
 */
export function svelteParsing(files) {
  return [
    ...svelte.configs.base.map((config) => ({ ...config, files })),
    {
      files,
      languageOptions: {
        parserOptions: { parser: tseslint.parser },
        globals: { ...globals.browser },
      },
    },
  ];
}
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.worktrees/**',
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
  // The element package has its own configuration on top of this one (packages/element/
  // eslint.config.js), and ESLint uses the configuration nearest to each file, so the blocks below
  // cover the shell and the editing core, and the element's file applies the same rules there.
  ...svelteParsing(['packages/ui/src/**/*.svelte']),
  {
    // The shell: one dispatch helper (FE-022) and no document-wide lookups (FE-108).
    files: ['packages/ui/src/**/*.{ts,js,svelte}'],
    ignores: [...editorTests, 'packages/ui/src/de-event.ts'],
    rules: { 'no-restricted-syntax': ['error', oneDispatchHelper, ...noDocumentLookup] },
  },
  {
    files: ['packages/ui/src/de-event.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noDocumentLookup] },
  },
  {
    // The editing core renders inside the same root (FE-108); it has no `de-` events of its own.
    files: ['packages/engine/src/**/*.{ts,js}'],
    ignores: editorTests,
    rules: { 'no-restricted-syntax': ['error', ...noDocumentLookup] },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
