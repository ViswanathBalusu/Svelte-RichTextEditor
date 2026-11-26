/**
 * UX-058 criterion 1 in a real browser: the web view shows a custom block whose extension is not
 * registered with the notice, the fallback picture when it has one (from the signed URL the backend
 * gives for the asset, image-source.ts) and the fallback text, and the document stays editable around
 * it. The payload never reaches the page.
 *
 * Runs through `pnpm exec vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import type { AssetImage, AssetImageLookup } from '../image-source.ts';
import { EXTENSION_NOTICE } from '../schema.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
const MARKER = 'UX058-PAYLOAD-MARKER';
const PNG: AssetImage = {
  url: 'https://assets.example.test/a1.png?sig=1',
  contentType: 'image/png',
};

interface Drawn {
  readonly block: HTMLElement;
  readonly imgs: HTMLImageElement[];
  /** The text of the first body paragraph after an edit made beside the block. */
  readonly editedText: string;
  readonly blockStillThere: boolean;
}

async function draw(
  lookup: AssetImageLookup | undefined,
  attrs: Record<string, unknown>,
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
    const type = view.state.schema.nodes['extension_block'];
    if (!type) throw new Error('the schema has no extension_block');
    const node = type.create({
      id: 'xBlock0000000001',
      extension: 'com.example.chart',
      payload: { secret: MARKER },
      fallbackAsset: null,
      fallbackText: null,
      ...attrs,
    });
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at >= 0) return false;
      if (n.type.name === 'paragraph' && view.state.doc.resolve(pos).parent.type.name === 'body') {
        at = pos;
        return false;
      }
      return true;
    });
    if (at < 0) throw new Error('no place found');
    view.dispatch(view.state.tr.insert(at, node));
    await new Promise((r) => setTimeout(r, 50));
    const drawn = view.dom.querySelector<HTMLElement>('.de-extension');
    if (!drawn) throw new Error('the block was not drawn');
    const block = drawn.cloneNode(true) as HTMLElement;
    // An edit beside the block: type at the start of the paragraph that follows it.
    let after = -1;
    view.state.doc.descendants((n, pos) => {
      if (after >= 0) return false;
      if (n.type.name === 'paragraph' && pos > at) {
        after = pos + 1;
        return false;
      }
      return true;
    });
    view.dispatch(view.state.tr.insertText('Edited. ', after));
    await new Promise((r) => setTimeout(r, 20));
    const editedText = view.state.doc.nodeAt(after - 1)?.textContent ?? '';
    return {
      block,
      imgs: Array.from(block.querySelectorAll('img')),
      editedText,
      blockStillThere: view.dom.querySelector('.de-extension') !== null,
    };
  } finally {
    unmount();
    core.destroy();
    host.remove();
  }
}

describe.skipIf(!isBrowser)('a custom block without its extension in the web view (UX-058 criterion 1)', () => {
  it('draws the notice, the fallback picture from the signed URL and the fallback text', async () => {
    const { block, imgs } = await draw(async () => PNG, {
      fallbackAsset: 'aFallback0000001',
      fallbackText: 'Sales by month',
    });
    expect(block.getAttribute('role')).toBe('group');
    expect(block.querySelector('.de-extension-notice')?.textContent).toBe(EXTENSION_NOTICE);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.src).toBe(PNG.url);
    expect(imgs[0]?.alt).toBe('');
    expect(imgs[0]?.closest('.de-extension-image')?.getAttribute('aria-label')).toBe(
      'Sales by month',
    );
    expect(block.querySelector('.de-extension-text')?.textContent).toBe('Sales by month');
    expect(block.innerHTML).not.toContain(MARKER);
  });

  it('draws the notice and the text alone for a text-only fallback, and asks for no picture', async () => {
    let asked = 0;
    const { block, imgs } = await draw(
      async () => {
        asked++;
        return PNG;
      },
      { fallbackText: 'A chart of three values' },
    );
    expect(asked).toBe(0);
    expect(imgs).toHaveLength(0);
    expect(block.querySelector('.de-extension-notice')?.textContent).toBe(EXTENSION_NOTICE);
    expect(block.querySelector('.de-extension-text')?.textContent).toBe('A chart of three values');
  });

  it('keeps the notice and the placeholder when the picture cannot be drawn', async () => {
    const answers: Array<[string, AssetImageLookup | undefined]> = [
      ['no lookup', undefined],
      ['a failed lookup', () => Promise.reject(new Error('no'))],
      ['a data URL', async () => ({ url: 'data:image/png;base64,AAAA', contentType: 'image/png' })],
      [
        'an SVG',
        async () => ({ url: 'https://assets.example.test/a.svg', contentType: 'image/svg+xml' }),
      ],
    ];
    for (const [name, lookup] of answers) {
      const { block, imgs } = await draw(lookup, {
        fallbackAsset: 'aFallback0000001',
        fallbackText: 'Sales',
      });
      expect(imgs, name).toHaveLength(0);
      expect(block.querySelector('.de-extension-notice')?.textContent, name).toBe(EXTENSION_NOTICE);
      expect(block.querySelector('.de-extension-image'), name).not.toBeNull();
    }
  });

  it('stays editable around the block: text typed beside it lands, and the block is kept', async () => {
    const { editedText, blockStillThere } = await draw(undefined, { fallbackText: 'Chart' });
    expect(editedText.startsWith('Edited. ')).toBe(true);
    expect(blockStillThere).toBe(true);
  });
});
