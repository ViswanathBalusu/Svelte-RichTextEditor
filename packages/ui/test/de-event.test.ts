/**
 * FE-022 criterion 3: the shell dispatches every `de-` event through one helper. A source scan
 * fails any other `dispatchEvent(` call in packages/ui/src (and in packages/element/src, where the
 * one helper is `emit` in events.ts). The workspace ESLint configuration does not parse Svelte
 * files, so this scan stands in for the lint rule the criterion names.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dispatchDocEvent } from '../src/de-event.ts';

const UI_SRC = fileURLToPath(new URL('../src', import.meta.url));
const ELEMENT_SRC = fileURLToPath(new URL('../../element/src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|svelte|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

function callersOf(dir: string): string[] {
  return sourceFiles(dir)
    .filter((file) => /dispatchEvent\s*\(/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(dir, file).replaceAll('\\', '/'));
}

describe('FE-022 criterion 3: one helper dispatches the de- events', () => {
  it('the shell calls dispatchEvent only in de-event.ts', () => {
    expect(callersOf(UI_SRC)).toEqual(['de-event.ts']);
  });

  it('the element calls dispatchEvent only in events.ts (emit)', () => {
    expect(callersOf(ELEMENT_SRC)).toEqual(['events.ts']);
  });

  it('the helper makes a composed, bubbling CustomEvent with the given name and detail', () => {
    const target = new EventTarget();
    let seen: CustomEvent | null = null;
    target.addEventListener('de-command-state', (e) => (seen = e as CustomEvent));
    expect(dispatchDocEvent(target, 'de-command-state', { commands: ['bold'] })).toBe(true);
    expect(seen).not.toBeNull();
    const event = seen as unknown as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail).toEqual({ commands: ['bold'] });
  });
});
