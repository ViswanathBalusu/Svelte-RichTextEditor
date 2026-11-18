/**
 * FE-132 criterion 2 with a real mouse and keyboard: a figure's resize handle, dragged, stores the
 * new width and height in twips (15 per CSS pixel) and keeps the aspect ratio; Shift on release
 * unlocks it; the arrow keys step the size. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-132-resize.spec.ts --project=chromium --project=firefox --project=webkit --output <scratch dir>`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openS1 } from './helpers.ts';

/** Appends a figure of 3000 by 1500 twips (200 by 100 pixels) to the body. */
async function addFigure(page: Page): Promise<void> {
  await page.evaluate(() => {
    type View = {
      state: {
        doc: {
          forEach(f: (n: { type: { name: string }; nodeSize: number }, o: number) => void): void;
        };
        schema: { nodes: Record<string, { create(attrs: unknown): unknown }> };
        tr: { insert(pos: number, node: unknown): unknown };
      };
      dispatch(tr: unknown): void;
    };
    const view = (window as unknown as { h: { view: View } }).h.view;
    let end = -1;
    view.state.doc.forEach((child, offset) => {
      if (child.type.name === 'body') end = offset + child.nodeSize - 1;
    });
    const figure = view.state.schema.nodes['figure']!.create({
      id: null,
      asset: 'a'.repeat(32),
      width: 3000,
      height: 1500,
      alt: 'A chart',
      align: null,
      placement: 'here',
    });
    view.dispatch(view.state.tr.insert(end, figure));
  });
}

/** The figure's stored size, read from the document. */
async function stored(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    type Node = { type: { name: string }; attrs: Record<string, unknown> };
    const view = (
      window as unknown as {
        h: { view: { state: { doc: { descendants(f: (n: Node) => boolean): void } } } };
      }
    ).h.view;
    let out = { width: 0, height: 0 };
    view.state.doc.descendants((n) => {
      if (n.type.name === 'figure')
        out = { width: n.attrs['width'] as number, height: n.attrs['height'] as number };
      return true;
    });
    return out;
  });
}

test.describe('a figure resizes with its handle (FE-132, criterion 2)', () => {
  test('a mouse drag stores twips and keeps the ratio; Shift unlocks it; keys step it', async ({
    page,
  }) => {
    await openS1(page);
    await addFigure(page);
    const handle = page.locator('doc-editor .de-figure-image .de-resize-handle');
    await handle.scrollIntoViewIfNeeded();
    expect(await stored(page)).toEqual({ width: 3000, height: 1500 });

    let box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 5, { steps: 4 });
    await page.mouse.up();
    // 40 pixels is 600 twips; the height follows the width (3600 by 1800).
    expect(await stored(page)).toEqual({ width: 3600, height: 1800 });

    box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 - 10, { steps: 4 });
    await page.keyboard.down('Shift');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    // 20 pixels right and 10 up: 300 twips wider, 150 twips lower, each on its own.
    expect(await stored(page)).toEqual({ width: 3900, height: 1650 });

    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    // 150 twips narrower; the height follows: 3750 * 1650 / 3900 = 1586.5, stored as 1587.
    expect(await stored(page)).toEqual({ width: 3750, height: 1587 });
  });
});
