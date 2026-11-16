// Lint rules of the element package, on top of the workspace's (../../eslint.config.js). ESLint
// uses the configuration nearest to each file, so this one applies to packages/element.
import root, {
  editorTests,
  noDocumentLookup,
  oneDispatchHelper,
  svelteParsing,
} from '../../eslint.config.js';

// FE-022: every event leaves the component through emit() in src/events.ts.
const throughEmit = [
  { ...oneDispatchHelper, message: 'Raise events through emit() in src/events.ts (FE-022).' },
  {
    selector: "NewExpression[callee.name='CustomEvent']",
    message: 'Raise events through emit() in src/events.ts (FE-022).',
  },
];
// Where document-wide lookups are allowed: tests, which drive the real page, and the PDF viewer,
// which runs as its own page with its own document (FE-108).
const lookupsAllowed = [...editorTests, 'src/pdf/**'];

export default [
  ...root,
  ...svelteParsing(['src/**/*.svelte']),
  {
    // FE-022, and FE-108 criterion 2: no id or selector lookup on the document.
    files: ['src/**/*.{ts,js,svelte}'],
    ignores: ['src/events.ts', ...lookupsAllowed],
    rules: { 'no-restricted-syntax': ['error', ...throughEmit, ...noDocumentLookup] },
  },
  {
    files: lookupsAllowed.map((glob) => (glob.startsWith('src/') ? glob : `src/${glob}`)),
    ignores: ['src/events.ts'],
    rules: { 'no-restricted-syntax': ['error', ...throughEmit] },
  },
  {
    files: ['src/events.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noDocumentLookup] },
  },
  {
    // FE-016; 10 §3.1: DOM is built with DOM APIs, never from HTML strings.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Build DOM with DOM APIs (FE-016).' },
        { property: 'outerHTML', message: 'Build DOM with DOM APIs (FE-016).' },
        { property: 'insertAdjacentHTML', message: 'Build DOM with DOM APIs (FE-016).' },
        { property: 'srcdoc', message: 'Load frames from a URL (FE-016, FE-071).' },
        { property: 'createContextualFragment', message: 'Build DOM with DOM APIs (FE-016).' },
        { object: 'document', property: 'write', message: 'Build DOM with DOM APIs (FE-016).' },
        { object: 'document', property: 'writeln', message: 'Build DOM with DOM APIs (FE-016).' },
      ],
    },
  },
];
