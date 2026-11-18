/**
 * FE-139 criterion 1 in a real browser: the web view shows a preserved atom with its label, its
 * fallback text, its fallback picture when it has one, and its display size. The picture is drawn
 * only from the signed URL the backend gives for the asset (image-source.ts); a `data:` URL, an SVG
 * answer, a failed lookup and a view with no lookup leave the label and the fallback text alone.
 *
 * Runs through `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import type { AssetImage, AssetImageLookup } from '../image-source.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const PNG: AssetImage = {
  url: 'https://assets.example.test/a1.png?sig=1',
  contentType: 'image/png',
};

interface Drawn {
  readonly atom: HTMLElement;
  readonly imgs: HTMLImageElement[];
}

/** Mounts the spike document, inserts a preserved block before its first paragraph, and reads the DOM. */
async function draw(
  lookup: AssetImageLookup | undefined,
  attrs: Record<string, unknown>,
  tag: 'preserved_block' | 'preserved_inline' = 'preserved_block',
): Promise<Drawn> {
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
    const type = view.state.schema.nodes[tag];
    if (!type) throw new Error(`the schema has no ${tag} node`);
    const node = type.create({ label: 'chart', fragment: 'aFragment0000001', ...attrs });
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at >= 0) return false;
      if (
        tag === 'preserved_block' &&
        n.type.name === 'paragraph' &&
        view.state.doc.resolve(pos).parent.type.name === 'body'
      ) {
        at = pos;
        return false;
      }
      if (tag === 'preserved_inline' && n.isText && n.text?.includes('Alpha')) {
        at = pos;
        return false;
      }
      return true;
    });
    if (at < 0) throw new Error('no place found');
    view.dispatch(view.state.tr.insert(at, node));
    await new Promise((r) => setTimeout(r, 50));
    const atom = view.dom.querySelector<HTMLElement>('.de-preserved');
    if (!atom) throw new Error('the atom was not drawn');
    // The element is detached when the view goes; keep what the test reads.
    const copy = atom.cloneNode(true) as HTMLElement;
    copy.style.cssText = atom.style.cssText;
    return { atom: copy, imgs: Array.from(copy.querySelectorAll('img')) };
  } finally {
    unmount();
    core.destroy();
    host.remove();
  }
}

describe.skipIf(!isBrowser)('a preserved atom in the web view (FE-139 criterion 1)', () => {
  it('draws the fallback picture from the signed URL, between the label and the fallback text', async () => {
    const { atom, imgs } = await draw(async () => PNG, {
      fallbackAsset: 'aFallback0000001',
      fallbackText: 'Sales by month',
    });
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.src).toBe(PNG.url);
    expect(imgs[0]?.alt).toBe('');
    expect(imgs[0]?.style.maxInlineSize).toBe('100%');
    const kinds = Array.from(atom.children).map((c) => c.className);
    expect(kinds).toEqual(['de-preserved-label', 'de-preserved-image', 'de-preserved-fallback']);
    expect(atom.querySelector('.de-preserved-label')?.textContent).toBe(
      'Chart, from Word, not editable here',
    );
    expect(atom.querySelector('.de-preserved-fallback')?.textContent).toBe('Sales by month');
    expect(atom.getAttribute('aria-label')).toContain('Sales by month');
  });

  it('draws the atom at its display size in CSS pixels', async () => {
    // 3000 twips = 200 px and 1500 twips = 100 px at 15 twips to the pixel.
    const { atom } = await draw(undefined, { fallbackText: 'Sales', width: 3000, height: 1500 });
    expect(atom.style.inlineSize).toBe('200px');
    expect(atom.style.blockSize).toBe('100px');
  });

  it('draws the inline atom the same way', async () => {
    const { atom, imgs } = await draw(
      async () => PNG,
      { fallbackAsset: 'aFallback0000001', fallbackText: 'Logo', width: 1500, height: 1500 },
      'preserved_inline',
    );
    expect(atom.localName).toBe('span');
    expect(imgs).toHaveLength(1);
    expect(atom.style.inlineSize).toBe('100px');
    expect(atom.style.display).toBe('inline-block');
  });

  it('keeps the label and the fallback text when the picture cannot be drawn', async () => {
    const answers: Array<[string, AssetImageLookup | undefined]> = [
      ['no lookup', undefined],
      ['a failed lookup', () => Promise.reject(new Error('no'))],
      ['an unknown asset', async () => undefined],
      ['a data URL', async () => ({ url: 'data:image/png;base64,AAAA', contentType: 'image/png' })],
      [
        'an SVG',
        async () => ({ url: 'https://assets.example.test/a.svg', contentType: 'image/svg+xml' }),
      ],
    ];
    for (const [name, lookup] of answers) {
      const { atom, imgs } = await draw(lookup, {
        fallbackAsset: 'aFallback0000001',
        fallbackText: 'Sales by month',
      });
      expect(imgs, name).toHaveLength(0);
      expect(atom.querySelector('.de-preserved-label')?.textContent, name).toBe(
        'Chart, from Word, not editable here',
      );
      expect(atom.querySelector('.de-preserved-fallback')?.textContent, name).toBe(
        'Sales by month',
      );
    }
  });

  it('asks for no picture when the atom has none', async () => {
    let asked = 0;
    const { imgs } = await draw(
      async () => {
        asked++;
        return PNG;
      },
      { fallbackText: 'Text only' },
    );
    expect(asked).toBe(0);
    expect(imgs).toHaveLength(0);
  });
});
