/**
 * FE-139 criteria 1, 3 and 5 in a browser (lane U-FE-129-141): a preserved atom shows its label that
 * names its kind and where it came from, its fallback text, and an accessible name that a screen
 * reader announces; it is not editable; and the original XML of its fragment never reaches the page.
 * The rendering is the editing schema's own `toDOM` (schema.ts), serialised into a live document in
 * Chromium, Firefox and WebKit (`pnpm vitest run --project browser <this file>`). In the node project
 * the suite is skipped.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** A marker in the fragment that must never appear on the page (the editor never renders the XML). */
const XML_MARKER = 'FE139-FRAGMENT-XML-MARKER';

/** Serialises one preserved atom into a live host element in the page and returns that element. */
function renderAtom(
  type: 'preserved_block' | 'preserved_inline',
  attrs: Record<string, unknown>,
): HTMLElement {
  const schema = editingSchema();
  const atom = schema.nodes[type]!.create(attrs) as PMNode;
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(atom), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  globalThis.document.body.append(host);
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('the preserved atom did not render an element');
  return el;
}

describe.skipIf(!inBrowser)('FE-139 criteria 1, 3 and 5 in a browser: preserved atoms', () => {
  it('shows a label naming the kind and the source, then the fallback text, in a block atom', () => {
    const el = renderAtom('preserved_block', {
      label: 'chart',
      fallbackText: 'Sales by quarter',
      fragment: XML_MARKER,
    });
    const label = el.querySelector('.de-preserved-label');
    expect(label?.textContent).toBe('Chart, from Word, not editable here');
    expect(el.querySelector('.de-preserved-fallback')?.textContent).toBe('Sales by quarter');
    el.parentElement?.remove();
  });

  it('gives the atom an accessible name that holds its label and its fallback text', () => {
    const el = renderAtom('preserved_inline', {
      label: 'text box',
      fallbackText: 'Note to reader',
      fragment: null,
    });
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe(
      'Text box, from Word, not editable here: Note to reader',
    );
    el.parentElement?.remove();
  });

  it('is not editable: the atom and the content inside it carry contenteditable false', () => {
    const el = renderAtom('preserved_block', {
      label: 'chart',
      fallbackText: 'Sales',
      fragment: null,
    });
    expect(el.getAttribute('contenteditable')).toBe('false');
    el.parentElement?.remove();
  });

  it('never renders the XML of the fragment, only the label and the fallback text', () => {
    const el = renderAtom('preserved_block', {
      label: 'chart',
      fallbackText: 'Sales',
      fragment: XML_MARKER,
    });
    expect(el.outerHTML.includes(XML_MARKER)).toBe(false);
    expect(el.textContent?.includes(XML_MARKER)).toBe(false);
    el.parentElement?.remove();
  });

  it('shows the label alone when there is no fallback text', () => {
    const el = renderAtom('preserved_inline', {
      label: 'equation',
      fallbackText: null,
      fragment: null,
    });
    expect(el.getAttribute('aria-label')).toBe('Equation, from Word, not editable here');
    expect(el.querySelector('.de-preserved-fallback')?.textContent).toBe('');
    el.parentElement?.remove();
  });
});
