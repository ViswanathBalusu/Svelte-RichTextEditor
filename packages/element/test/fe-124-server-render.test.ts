/**
 * FE-124 criterion 3, the server half: importing the element's entry point where there is no DOM
 * (Node.js, a server render) throws nothing, defines no element and reads no browser global. The
 * hydration half is a browser run (not done here; see the story's Notes).
 */
import { expect, test } from 'vitest';

test('importing the entry point with no DOM throws nothing and defines nothing', async () => {
  expect('customElements' in globalThis).toBe(false);
  expect('HTMLElement' in globalThis).toBe(false);
  const mod = await import('../src/index.ts');
  expect('customElements' in globalThis).toBe(false);
  expect(typeof mod.DocEditorElement).toBe('function');
  expect(typeof mod.EMBEDDING_VERSION).toBe('string');
  // Registration is a no-op without a registry: no throw, and the result says nothing was defined.
  expect(mod.defineDocEditor()).toBe('other');
});
