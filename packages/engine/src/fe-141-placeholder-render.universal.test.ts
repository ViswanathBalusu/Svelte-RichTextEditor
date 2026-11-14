/**
 * FE-141 criterion 1 in a browser (lane U-FE-129-141): a `hidden_region` placeholder renders as one
 * non-editable atom that names its title when the projection carries one, and that a screen reader
 * can read as a note. The rendering is the editing schema's own `toDOM` (schema.ts), serialised into a
 * live document in Chromium, Firefox and WebKit (`pnpm vitest run --project browser <this file>`).
 * The fixed size and the whole-only selection are not tested here: the size is a CSS rule of the
 * element, and the selection is the view's. In the node project the suite is skipped.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** Serialises one placeholder into a live host element in the page and returns that element. */
function renderPlaceholder(attrs: Record<string, unknown>): HTMLElement {
  const schema = editingSchema();
  const node = schema.nodes[PLACEHOLDER]!.create(attrs) as PMNode;
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(node), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  globalThis.document.body.append(host);
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('the placeholder did not render an element');
  return el;
}

describe.skipIf(!inBrowser)('FE-141 criterion 1 in a browser: hidden region placeholders', () => {
  it('renders the placeholder with its title, a note role and a name that holds the title', () => {
    const el = renderPlaceholder({ id: 'hid0000000000001', title: 'Clause 4' });
    expect(el.textContent).toBe('Clause 4');
    expect(el.getAttribute('role')).toBe('note');
    expect(el.getAttribute('aria-label')).toBe('Hidden region: Clause 4');
    expect(el.getAttribute('data-id')).toBe('hid0000000000001');
    el.parentElement?.remove();
  });

  it('is one non-editable unit with no content inside it', () => {
    const el = renderPlaceholder({ id: 'hid0000000000002', title: null });
    expect(el.getAttribute('contenteditable')).toBe('false');
    expect(el.textContent).toBe('Hidden region');
    expect(el.children.length).toBe(0);
    el.parentElement?.remove();
  });
});
