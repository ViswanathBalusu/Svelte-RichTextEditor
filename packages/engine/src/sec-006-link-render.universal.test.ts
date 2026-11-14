/**
 * SEC-006 criterion 2 in a browser (lane U-SEC-001-016): a rendered `link` mark is an anchor that
 * carries `rel="noopener noreferrer"`, and a link whose scheme the allow-list refuses is rendered
 * without an `href`. The rendering is the editing schema's own `toDOM` (engine schema.ts), serialised
 * with ProseMirror's DOMSerializer into a live document, in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser <this file>`). In the node project the suite is skipped.
 */
import { DOMSerializer, Fragment } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** Serialises a text run carrying a link mark to a live anchor in the page. */
function renderLink(href: string, title: string | null = null): HTMLAnchorElement {
  const schema = editingSchema();
  const mark = schema.marks['link']!.create({ href, title });
  const text = schema.text('the link', [mark]);
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(text), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  globalThis.document.body.append(host);
  const anchor = host.querySelector('a');
  if (!anchor) throw new Error('the link mark did not render an anchor');
  return anchor;
}

describe.skipIf(!inBrowser)('SEC-006 criterion 2 in a browser: rendered links', () => {
  it('renders an https link with rel noopener noreferrer and the href', () => {
    const a = renderLink('https://example.com/a?b=c', 'a title');
    expect(a.getAttribute('href')).toBe('https://example.com/a?b=c');
    expect(a.getAttribute('title')).toBe('a title');
    const rel = (a.getAttribute('rel') ?? '').split(/\s+/);
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
    a.parentElement?.remove();
  });

  it('keeps rel noopener noreferrer on an anchor whose scheme is refused, and drops the href', () => {
    const hostile = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
    ];
    for (const href of hostile) {
      const a = renderLink(href);
      expect(a.hasAttribute('href'), href).toBe(false);
      expect(a.getAttribute('rel'), href).toBe('noopener noreferrer');
      a.parentElement?.remove();
    }
  });

  it('activation of a rendered link does not run script in the page', () => {
    // A control for the refused case: a live anchor with a javascript href would run this flag.
    (globalThis as { __sec006Ran?: boolean }).__sec006Ran = false;
    const a = renderLink('javascript:globalThis.__sec006Ran = true');
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect((globalThis as { __sec006Ran?: boolean }).__sec006Ran).toBe(false);
    a.parentElement?.remove();
  });
});
