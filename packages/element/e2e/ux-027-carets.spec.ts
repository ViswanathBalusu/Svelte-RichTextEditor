/**
 * UX-027 criteria 1 and 2 on the mounted element (lane w3): two `<doc-editor>` elements on the same
 * document, with two users of the embed page's in-memory backend. The second user selects a
 * paragraph; the first user's editor draws the selection and a flag that names the second user, at
 * the place of that text (the rectangles the shell draws are the ones the text itself occupies). When
 * the first user then types in front of the text, the drawn selection moves with it and still covers
 * the same text. The positions are mapped by the core (SYN-036); the concurrent case, with both
 * users editing at once, is tested in packages/engine/test/ux-027-concurrent-carets.test.ts.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const ada = 'doc-editor[data-test="ada"]';
const bob = 'doc-editor[data-test="bob"]';
const TEXT = 'Remote target paragraph.';

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The union of the rectangles the shell draws for the peer's selection in `sel`'s editor. */
const drawn = (page: Page, sel: string): Promise<Box | null> =>
  page.evaluate((s) => {
    const root = document.querySelector(s)!.shadowRoot!;
    const rects = [...root.querySelectorAll('.de-peer-selection')].map((e) =>
      e.getBoundingClientRect(),
    );
    if (rects.length === 0) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  }, sel);

/** The box the text `needle` occupies in the editor's own surface, found in its paragraph. */
const placeOf = (page: Page, sel: string, needle: string): Promise<Box | null> =>
  page.evaluate(
    ({ s, n }) => {
      const root = document.querySelector(s)!.shadowRoot!;
      const surface = root.querySelector('.de-editing-surface')!;
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let t = walker.nextNode(); t; t = walker.nextNode()) nodes.push(t as Text);
      const paragraph = [...surface.querySelectorAll('p')].find((p) =>
        (p.textContent ?? '').includes(n),
      );
      if (!paragraph) return null;
      const inside = nodes.filter((t) => paragraph.contains(t));
      const whole = inside.map((t) => t.data).join('');
      const start = whole.indexOf(n);
      if (start < 0) return null;
      const at = (offset: number): { node: Text; offset: number } => {
        let left = offset;
        for (const t of inside) {
          if (left <= t.data.length) return { node: t, offset: left };
          left -= t.data.length;
        }
        throw new Error('offset out of range');
      };
      const range = document.createRange();
      const from = at(start);
      const to = at(start + n.length);
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      const rects = [...range.getClientRects()];
      return {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
    },
    { s: sel, n: needle },
  );

function near(a: Box, b: Box, tolerance = 3): void {
  expect(Math.abs(a.left - b.left), 'left edge').toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.right - b.right), 'right edge').toBeLessThanOrEqual(tolerance);
  // The drawn rectangle is a line box; the text range is the glyphs: they overlap on the same line.
  expect(a.top, 'top').toBeLessThanOrEqual(b.bottom);
  expect(a.bottom, 'bottom').toBeGreaterThanOrEqual(b.top);
}

test.describe('UX-027 collaborators’ carets on the mounted element', () => {
  test('draws the other user’s selection over the same text with a flag naming them, and follows edits in front of it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'ada', sub: 'ada' });
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.id = 'mount-peer';
      document.body.append(div);
    });
    await mountEditor(page, { name: 'bob', sub: 'bob', target: 'mount-peer' });

    // Bob selects the paragraph; a triple click selects its text in every browser.
    await page.locator(`${bob} .de-editing-surface p`, { hasText: TEXT }).click({ clickCount: 3 });
    await expect(page.locator(`${ada} .de-peer-flag`)).toContainText('Bob', { timeout: 15_000 });
    await expect.poll(() => drawn(page, ada), { timeout: 15_000 }).not.toBeNull();

    const first = (await drawn(page, ada))!;
    const text = (await placeOf(page, ada, TEXT))!;
    near(first, text);

    // Ada types in front of the paragraph: the text moves, and the drawn selection with it.
    await page.locator(`${ada} .de-editing-surface p`, { hasText: TEXT }).click();
    await page.keyboard.press('Home');
    await page.keyboard.type('Inserted words in front. ', { delay: 0 });
    await expect(
      page.locator(`${ada} .de-editing-surface p`, { hasText: 'Inserted words in front.' }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const d = await drawn(page, ada);
          const t = await placeOf(page, ada, TEXT);
          return d && t
            ? Math.abs(d.left - t.left) <= 3 && Math.abs(d.right - t.right) <= 3
            : false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const moved = (await placeOf(page, ada, TEXT))!;
    // The text did move (or wrap): the check above was not made on the old place.
    expect(Math.abs(moved.left - text.left) + Math.abs(moved.top - text.top)).toBeGreaterThan(5);
    // The flag is still drawn, and the same one.
    await expect(page.locator(`${ada} .de-peer-flag`)).toContainText('Bob');
  });
});
