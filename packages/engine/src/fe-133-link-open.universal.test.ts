/**
 * FE-133 criterion 4 in a browser (lane U-FE-129-141): a rendered link to a web page opens in a new
 * browsing context (`target="_blank"`) without an opener (`rel="noopener noreferrer"`), while an
 * in-document link to a bookmark keeps the current context. The rendering is the editing schema's own
 * `toDOM` (schema.ts), serialised into a live document in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser <this file>`). In the node project the suite is skipped.
 */
import { DOMSerializer, Fragment } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** Serialises a text run carrying a link mark to a live anchor in the page. */
function renderLink(href: string): HTMLAnchorElement {
  const schema = editingSchema();
  const mark = schema.marks['link']!.create({ href, title: null });
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

describe.skipIf(!inBrowser)('FE-133 criterion 4 in a browser: links to web pages', () => {
  it('opens an https link in a new browsing context without an opener', () => {
    const a = renderLink('https://example.com/page');
    expect(a.getAttribute('href')).toBe('https://example.com/page');
    expect(a.getAttribute('target')).toBe('_blank');
    const rel = (a.getAttribute('rel') ?? '').split(/\s+/);
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
    a.parentElement?.remove();
  });

  it('keeps an in-document bookmark link in the current context', () => {
    const a = renderLink('#intro');
    expect(a.getAttribute('href')).toBe('#intro');
    expect(a.hasAttribute('target')).toBe(false);
    a.parentElement?.remove();
  });
});
