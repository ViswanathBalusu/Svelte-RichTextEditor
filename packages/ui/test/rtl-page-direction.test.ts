/**
 * The document's direction follows the document and not the interface (UX-065, criterion 4). The
 * shell takes its direction from the interface's locale; the page takes it from the core's
 * `settings.dir`. This is a quick check on the component source; the behaviour itself is shown in
 * the browsers by `e2e/page-direction.spec.ts`, which reads the computed direction.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = readFileSync(fileURLToPath(new URL('../src/App.svelte', import.meta.url)), 'utf8');
const coreApi = readFileSync(fileURLToPath(new URL('../src/core-api.ts', import.meta.url)), 'utf8');

/** The attributes of the opening tag that starts with the given text. */
function openingTag(source: string, start: RegExp): string {
  const match = start.exec(source);
  if (!match) throw new Error(`no element matches ${start}`);
  const end = source.indexOf('>', match.index);
  return source.slice(match.index, end + 1);
}

describe('the page takes the document direction, not the interface (UX-065, criterion 4)', () => {
  it('the core declares the direction as the document base direction (settings.dir)', () => {
    expect(coreApi).toMatch(/readonly direction\?: ReadView<'ltr' \| 'rtl'>;/);
    expect(coreApi).toMatch(/settings\.dir/);
  });

  it('the page element binds its dir to the core direction, with ltr as the fallback', () => {
    const page = openingTag(app, /<div\s+bind:this=\{pageEl\}/);
    expect(page).toContain(`dir={direction?.current ?? 'ltr'}`);
    expect(page).not.toMatch(/dir=\{tr\.dir\}/);
  });

  it('the shell takes the interface direction, and the page does not inherit it', () => {
    const shell = openingTag(app, /<div\s+bind:this=\{shellEl\}/);
    expect(shell).toContain('dir={tr.dir}');
    const page = openingTag(app, /<div\s+bind:this=\{pageEl\}/);
    expect(page).toMatch(/\bdir=/);
  });
});
