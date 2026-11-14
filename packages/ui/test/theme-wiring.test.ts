/**
 * The wiring of the theme in the shell (UX-061, criteria 1 and 6). A source check of
 * `src/App.svelte`: the colour-scheme preference is read when the component is created, before its
 * first render, so `data-theme` is resolved from the start; `auto` is re-resolved through the
 * watcher, which is stopped with the component. The browser's own first paint is not run here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(fileURLToPath(new URL('../src/App.svelte', import.meta.url)), 'utf8');

describe('the theme is resolved in the shell from the first render (UX-061, criteria 1 and 6)', () => {
  it('reads the colour-scheme preference synchronously, before the state that holds it', () => {
    const watch = APP.indexOf('const scheme = watchColourScheme(');
    const state = APP.indexOf('let prefersDark = $state(scheme.dark);');
    expect(watch).toBeGreaterThanOrEqual(0);
    expect(state).toBeGreaterThan(watch);
  });

  it('derives the resolved theme from the setting and the preference', () => {
    expect(APP).toContain('const theme = $derived(resolveTheme(mode.theme, prefersDark));');
  });

  it('binds the resolved theme to the shell root as data-theme', () => {
    const root = APP.indexOf('data-theme={theme}');
    expect(root).toBeGreaterThanOrEqual(0);
    // The attribute is on the shell root element, which carries the `de-shell` class.
    const open = APP.lastIndexOf('<', root);
    expect(APP.slice(open, root)).toMatch(/de-shell/);
  });

  it('stops the colour-scheme watcher when the component is destroyed', () => {
    expect(APP).toContain('onDestroy(scheme.stop);');
  });
});
