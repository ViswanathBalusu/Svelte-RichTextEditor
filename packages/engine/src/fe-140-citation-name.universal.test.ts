/**
 * FE-140 criterion 3 in a browser (lane U-FE-129-141): a citation in the web view has an accessible
 * name that names the sources it cites, in order, and it is a note that assistive technology reads.
 * The rendering is the editing schema's own `toDOM` (schema.ts), serialised into a live document in
 * Chromium, Firefox and WebKit (`pnpm vitest run --project browser <this file>`). Whether a screen
 * reader announces it when the caret reaches it is not run here; the accessible name is what it reads.
 * In the node project the suite is skipped.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** Serialises one citation into a live host element in the page and returns that element. */
function renderCitation(attrs: Record<string, unknown>): HTMLElement {
  const schema = editingSchema();
  const node = schema.nodes['citation']!.create(attrs) as PMNode;
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(node), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  globalThis.document.body.append(host);
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('the citation did not render an element');
  return el;
}

describe.skipIf(!inBrowser)('FE-140 criterion 3 in a browser: citation accessible name', () => {
  it('names every cited source, in order, as the accessible name of a note', () => {
    const el = renderCitation({
      items: [{ source: 'smith2020' }, { source: 'jones2019', locator: 'p. 4' }],
      mode: 'normal',
      cached: null,
    });
    expect(el.getAttribute('role')).toBe('note');
    expect(el.getAttribute('aria-label')).toBe('Citation: smith2020, jones2019');
    expect(el.textContent).toBe('[citation]');
    el.parentElement?.remove();
  });

  it('shows the cached text when the citation has one, and keeps the same name', () => {
    const el = renderCitation({
      items: [{ source: 'smith2020' }],
      mode: 'normal',
      cached: '(Smith 2020)',
    });
    expect(el.textContent).toBe('(Smith 2020)');
    expect(el.getAttribute('aria-label')).toBe('Citation: smith2020');
    el.parentElement?.remove();
  });
});
