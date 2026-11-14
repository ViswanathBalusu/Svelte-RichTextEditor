// Lint rules of the element package, on top of the workspace's (../../eslint.config.js). ESLint
// uses the configuration nearest to each file, so this one applies to packages/element.
import root from '../../eslint.config.js';

export default [
  ...root,
  {
    // FE-022: every event leaves the component through emit() in src/events.ts.
    files: ['src/**/*.ts'],
    ignores: ['src/events.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='dispatchEvent']",
          message: 'Raise events through emit() in src/events.ts (FE-022).',
        },
        {
          selector: "NewExpression[callee.name='CustomEvent']",
          message: 'Raise events through emit() in src/events.ts (FE-022).',
        },
      ],
    },
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
