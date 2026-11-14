/**
 * FE-111 criterion 1 (lane U-FE-097-112): in the web view, `settings.dir` sets the direction of the
 * editing surface, and a paragraph's own `dir` sets its direction; a paragraph with no `dir`
 * inherits the surface's. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-111-direction.spec.ts --project=chromium --project=firefox --project=webkit`.
 *
 * The document is `rtlDocument()` in demo/embed-page.ts: `settings.dir` is `rtl`, and its three
 * paragraphs have `dir` `rtl`, `ltr` and none. The test reads the rendered direction and where the
 * text is drawn. Criteria 2 to 5 (bidirectional editing, the input matrix, the caret clamp and the
 * export) are not covered here.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface Painted {
  surfaceDir: string | null;
  surfaceComputed: string;
  paragraphs: Array<{
    dir: string | null;
    computed: string;
    text: string;
    left: number;
    right: number;
    surfaceRight: number;
  }>;
}

function measure(page: Page): Promise<Painted> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const surface = root.querySelector('.de-editing-surface') as HTMLElement;
    const paragraphs = [...surface.querySelectorAll('p.de-p')] as HTMLElement[];
    return {
      surfaceDir: surface.getAttribute('dir'),
      surfaceComputed: getComputedStyle(surface).direction,
      paragraphs: paragraphs.map((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        const box = range.getBoundingClientRect();
        return {
          dir: p.getAttribute('dir'),
          computed: getComputedStyle(p).direction,
          text: (p.textContent ?? '').slice(0, 20),
          left: box.left,
          right: box.right,
          surfaceRight: surface.getBoundingClientRect().right,
        };
      }),
    };
  }, editor);
}

test.describe('the web view renders the document direction (FE-111)', () => {
  test('settings.dir and a paragraph dir set the direction, and a paragraph without one inherits it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'rtl' });

    const m = await measure(page);
    expect(m.surfaceDir).toBe('rtl');
    expect(m.surfaceComputed).toBe('rtl');
    expect(m.paragraphs.map((p) => p.text)).toEqual([
      'مرحبا بالعالم',
      'Left to right text',
      'שלום עולם',
    ]);
    expect(m.paragraphs.map((p) => p.dir)).toEqual(['rtl', 'ltr', null]);
    expect(m.paragraphs.map((p) => p.computed)).toEqual(['rtl', 'ltr', 'rtl']);
  });

  test('right-to-left text is drawn from the right edge of the surface', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'rtl' });

    const m = await measure(page);
    const [rtl, ltr, inherited] = m.paragraphs;
    // A right-to-left paragraph's text ends at the surface's right edge (within the surface padding),
    // and the left-to-right paragraph's text starts at its left edge, so the two are drawn apart.
    expect(rtl!.surfaceRight - rtl!.right).toBeLessThan(40);
    expect(inherited!.surfaceRight - inherited!.right).toBeLessThan(40);
    expect(ltr!.left).toBeLessThan(rtl!.left);
  });
});
