/**
 * FE-135 criterion 5 in a browser (lane U-FE-129-141): a page or column break in the web view is
 * marked with a visible, non-editable label that assistive technology reads, and the view draws no
 * page for it. The rendering is the editing schema's own `toDOM` (schema.ts), serialised into a live
 * document in Chromium, Firefox and WebKit (`pnpm vitest run --project browser <this file>`). In the
 * node project the suite is skipped. The section break's warning (criterion 6) is not tested here.
 */
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** Serialises one node into a live host element in the page and returns the host. */
function renderNode(node: PMNode): HTMLElement {
  const schema = editingSchema();
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(node), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  globalThis.document.body.append(host);
  return host;
}

describe.skipIf(!inBrowser)('FE-135 criterion 5 in a browser: break marks', () => {
  it('marks a page break with a label that is read as a separator, and is not editable', () => {
    const schema = editingSchema();
    const host = renderNode(schema.nodes['break']!.create({ kind: 'page' }) as PMNode);
    const mark = host.querySelector<HTMLElement>('.de-break');
    if (!mark) throw new Error('the page break did not render a mark');
    expect(mark.textContent).toBe('Page break');
    expect(mark.getAttribute('aria-label')).toBe('Page break');
    expect(mark.getAttribute('role')).toBe('separator');
    expect(mark.getAttribute('contenteditable')).toBe('false');
    expect(mark.getAttribute('data-kind')).toBe('page');
    // The label is drawn: the mark has a box in the live page.
    expect(mark.getBoundingClientRect().width).toBeGreaterThan(0);
    host.remove();
  });

  it('marks a column break with its own label and keeps a line break as a line break', () => {
    const schema = editingSchema();
    const column = renderNode(schema.nodes['break']!.create({ kind: 'column' }) as PMNode);
    expect(column.querySelector('.de-break')?.textContent).toBe('Column break');
    column.remove();

    const line = renderNode(schema.nodes['break']!.create({ kind: 'line' }) as PMNode);
    expect(line.querySelector('br')).not.toBeNull();
    expect(line.querySelector('.de-break')).toBeNull();
    line.remove();
  });

  it('marks a section break as a separator with its start type, and draws no page for it', () => {
    const schema = editingSchema();
    const node = schema.nodes['section_break']!.create({
      id: 'sb0000000000001',
      pageSetup: 'ps0000000000001',
      start: 'continuous',
    }) as PMNode;
    const host = renderNode(node);
    const mark = host.querySelector<HTMLElement>('hr.de-section-break');
    if (!mark) throw new Error('the section break did not render a mark');
    expect(mark.getAttribute('data-start')).toBe('continuous');
    expect(mark.getBoundingClientRect().height).toBeLessThan(100);
    host.remove();
  });

  it('draws no page: the break mark is an inline label, not a block with a page size', () => {
    const schema = editingSchema();
    const host = renderNode(schema.nodes['break']!.create({ kind: 'page' }) as PMNode);
    const mark = host.querySelector<HTMLElement>('.de-break');
    if (!mark) throw new Error('the page break did not render a mark');
    expect(getComputedStyle(mark).display).toBe('inline');
    expect(mark.getBoundingClientRect().height).toBeLessThan(100);
    host.remove();
  });
});
