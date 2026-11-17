/**
 * FE-067 criterion 3 in a real browser: the web view draws a picture from a signed asset URL and
 * from nothing else. A `data:` URL, a `javascript:` URL, an SVG answer, a lookup that fails and a
 * view with no lookup leave the placeholder without an `<img>`, and hostile alt text is an attribute
 * value, never markup.
 *
 * Runs through `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import type { AssetImage, AssetImageLookup } from '../image-source.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const PLACEHOLDERS = 1;
const HOSTILE_ALT = '"><img src=x onerror="window.__fe067=1"><svg onload="window.__fe067=1">';

async function draw(
  lookup: AssetImageLookup | undefined,
  alt = 'A chart',
): Promise<{ imgs: HTMLImageElement[]; placeholders: HTMLElement[]; extra: number }> {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: spikeDocument(),
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
    ...(lookup ? { assetImage: lookup } : {}),
  });
  const unmount = core.mountBody(host);
  try {
    const view = viewsOf(core).view;
    if (!view) throw new Error('the body view is not mounted');
    const type = view.state.schema.nodes['image'];
    if (!type) throw new Error('the schema has no image node');
    const node = type.create({ asset: 'asset-1', width: 1440, height: 1440, alt });
    // At the start of the first body text that holds "Alpha".
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at >= 0) return false;
      if (n.isText && n.text?.includes('Alpha')) {
        at = pos;
        return false;
      }
      return true;
    });
    if (at < 0) throw new Error('no body text found');
    view.dispatch(view.state.tr.insert(at, node));
    await new Promise((r) => setTimeout(r, 50));
    const imgs = Array.from(view.dom.querySelectorAll('.de-image img'));
    const placeholders = Array.from(view.dom.querySelectorAll<HTMLElement>('.de-image'));
    // Elements of a kind that never belong in a document surface.
    const extra = view.dom.querySelectorAll('svg, script, iframe, object, embed').length;
    return { imgs, placeholders, extra };
  } finally {
    unmount();
    core.destroy();
    host.remove();
  }
}

const answer = (url: string, contentType: string): AssetImageLookup => {
  const image: AssetImage = { url, contentType };
  return () => Promise.resolve(image);
};

describe.skipIf(!isBrowser)(
  'pictures draw from signed asset URLs only (FE-067 criterion 3)',
  () => {
    it('draws an https URL of a raster type inside the placeholder, with the alt text on the span', async () => {
      const { imgs, placeholders } = await draw(
        answer('https://assets.example/a.png?sig=1', 'image/png'),
      );
      expect(placeholders.length).toBe(PLACEHOLDERS);
      expect(imgs.length).toBe(1);
      expect(imgs[0]?.src).toBe('https://assets.example/a.png?sig=1');
      expect(imgs[0]?.referrerPolicy).toBe('no-referrer');
      expect(placeholders.some((p) => p.getAttribute('aria-label') === 'A chart')).toBe(true);
      expect(placeholders).toContain(imgs[0]?.parentElement);
    });

    it('draws an http URL of a JPEG', async () => {
      const { imgs } = await draw(answer('http://assets.example/a.jpg', 'image/jpeg; q=1'));
      expect(imgs.length).toBe(1);
    });

    it.each([
      ['a data: URL', answer('data:image/png;base64,iVBORw0KGgo=', 'image/png')],
      ['a javascript: URL', answer('javascript:window.__fe067=1', 'image/png')],
      ['a blob: URL', answer('blob:https://assets.example/1', 'image/png')],
      ['a file: URL', answer('file:///etc/passwd', 'image/png')],
      ['an SVG type', answer('https://assets.example/a.svg', 'image/svg+xml')],
      ['an SVG type in capitals', answer('https://assets.example/a.svg', 'IMAGE/SVG+XML')],
      ['a PDF type', answer('https://assets.example/a.pdf', 'application/pdf')],
      ['credentials in the URL', answer('https://user:pw@assets.example/a.png', 'image/png')],
      ['a lookup that rejects', () => Promise.reject(new Error('offline'))],
      ['no answer', () => Promise.resolve(undefined)],
    ])('draws no picture for %s', async (_name, lookup) => {
      const { imgs, placeholders, extra } = await draw(lookup as AssetImageLookup);
      expect(placeholders.length).toBe(PLACEHOLDERS);
      expect(imgs.length).toBe(0);
      expect(extra).toBe(0);
      expect((window as unknown as { __fe067?: number }).__fe067).toBeUndefined();
    });

    it('draws no picture when the view has no lookup', async () => {
      const { imgs, placeholders } = await draw(undefined);
      expect(placeholders.length).toBe(PLACEHOLDERS);
      expect(imgs.length).toBe(0);
    });

    it('keeps hostile alt text as an attribute value, never as markup', async () => {
      const { imgs, placeholders, extra } = await draw(
        answer('https://assets.example/a.png', 'image/png'),
        HOSTILE_ALT,
      );
      expect(placeholders.some((p) => p.getAttribute('aria-label') === HOSTILE_ALT)).toBe(true);
      expect(imgs.length).toBe(1);
      expect(imgs[0]?.getAttribute('onerror')).toBeNull();
      expect(extra).toBe(0);
      expect((window as unknown as { __fe067?: number }).__fe067).toBeUndefined();
    });
  },
);
