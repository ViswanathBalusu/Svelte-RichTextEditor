/**
 * FE-106 criterion 4: a larger default font size in the browser clips or overlaps no text in the
 * web view. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-106-text-zoom.spec.ts --project=chromium --project=firefox`.
 *
 * Each test opens the S1 page in its own browser profile whose default font size is doubled, the
 * setting a person changes in the browser's font options:
 *  - Chromium (and Edge): `webkit.webprefs.default_font_size` in the profile's Preferences file,
 *    written before the browser starts.
 *  - Firefox: `font.size.variable.x-western` in `firefoxUserPrefs`.
 * WebKit has no such setting that Playwright can reach, so it is skipped. The test first checks that
 * the setting took effect (a probe element in `font-size: medium` is at least 32 pixels), so a
 * browser that ignored the profile fails rather than passing on an unchanged page.
 *
 * Text-only zoom through the browser's menu or a keyboard shortcut is browser chrome, which
 * Playwright cannot drive. A larger default font size is the other setting that criterion names,
 * and it scales the same em- and rem-based sizes without touching the CSS pixel viewport.
 *
 * The audit walks every text node in the editor's shadow root. For each text box (a client rectangle
 * of the text) it checks that no ancestor with `overflow` of `hidden` or `clip` cuts it, and that it
 * does not overlap the box of another text node by more than 30 percent of the smaller height. It
 * also lists any element or text of the editor that reaches past the viewport or scrolls sideways;
 * an element that scrolls by design (a table, `overflow: auto`) is not among them at this size.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, chromium, expect, firefox, test } from '@playwright/test';

const DEFAULT_FONT_PX = 32;

interface Audit {
  probePx: number;
  viewport: number;
  wide: string[];
  textBoxes: number;
  clipped: string[];
  overlapping: string[];
}

/** Opens the S1 page in a fresh profile with the doubled default font and the given viewport width. */
async function open(
  browserName: string,
  channel: string | undefined,
  baseURL: string,
  width: number,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'fe-106-zoom-w1-'));
  const options = { baseURL, viewport: { width, height: 700 } };
  let context;
  if (browserName === 'firefox') {
    context = await firefox.launchPersistentContext(dir, {
      ...options,
      firefoxUserPrefs: { 'font.size.variable.x-western': DEFAULT_FONT_PX },
    });
  } else {
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(
      join(dir, 'Default', 'Preferences'),
      JSON.stringify({
        webkit: { webprefs: { default_font_size: DEFAULT_FONT_PX, minimum_font_size: 0 } },
      }),
    );
    context = await chromium.launchPersistentContext(dir, {
      ...options,
      channel: channel ?? 'chromium',
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/pages/s1.html');
  await page.waitForFunction(() =>
    document.querySelector('doc-editor')?.shadowRoot?.querySelector('.de-editing-surface'),
  );
  return {
    page,
    close: async () => {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Measures the editor's text boxes and looks for clipped and overlapping ones. */
function audit(page: Page): Promise<Audit> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.fontSize = 'medium';
    probe.textContent = 'x';
    document.body.append(probe);
    const probePx = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();

    const root = document.querySelector('doc-editor')!.shadowRoot!;
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
    const visible = (el: Element) =>
      (el as unknown as { checkVisibility(o: object): boolean }).checkVisibility({
        visibilityProperty: true,
        opacityProperty: false,
      });
    // A box of one pixel or less, or a clipped one, is visually hidden text for screen readers.
    const visuallyHidden = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        if ((r.width <= 1 || r.height <= 1) && cs.overflow !== 'visible') return true;
        if (cs.clip !== 'auto' && cs.position === 'absolute') return true;
      }
      return false;
    };

    interface Box {
      l: number;
      r: number;
      t: number;
      b: number;
      node: Node;
      text: string;
    }
    const boxes: Box[] = [];
    const clipped: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      const parent = n.parentElement;
      if (!text || !parent || !visible(parent) || visuallyHidden(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        boxes.push({
          l: rect.left,
          r: rect.right,
          t: rect.top,
          b: rect.bottom,
          node: n,
          text: text.slice(0, 24),
        });
        for (let a: Element | null = parent; a && a !== root.host; a = a.parentElement) {
          const cs = getComputedStyle(a);
          const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
          const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
          if (!clipsX && !clipsY) continue;
          const ar = a.getBoundingClientRect();
          if (
            (clipsX && (rect.left < ar.left - 1 || rect.right > ar.right + 1)) ||
            (clipsY && (rect.top < ar.top - 1 || rect.bottom > ar.bottom + 1))
          )
            clipped.push(`"${text.slice(0, 24)}" cut by ${name(a)}`);
        }
      }
    }
    const wide: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1 && visible(el))
        wide.push(`${name(el)} right ${Math.round(r.right)}`);
    }
    for (const el of [root.host, ...root.querySelectorAll('*')]) {
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1 && visible(el))
        wide.push(`${name(el)} scrolls ${el.scrollWidth} in ${el.clientWidth}`);
    }
    for (const b of boxes)
      if (b.r > window.innerWidth + 1)
        wide.push(`text "${b.text}" in ${name(b.node.parentElement!)} right ${Math.round(b.r)}`);
    const overlapping: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const x = boxes[i]!;
        const y = boxes[j]!;
        if (x.node === y.node) continue;
        const w = Math.min(x.r, y.r) - Math.max(x.l, y.l);
        const h = Math.min(x.b, y.b) - Math.max(x.t, y.t);
        const smaller = Math.min(x.b - x.t, y.b - y.t);
        if (w > 1 && h > 0.3 * smaller) overlapping.push(`"${x.text}" over "${y.text}"`);
      }
    }
    return {
      probePx,
      viewport: window.innerWidth,
      wide: wide.slice(0, 12),
      textBoxes: boxes.length,
      clipped,
      overlapping,
    };
  });
}

test.describe('a larger default font size in the browser (FE-106 criterion 4)', () => {
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'WebKit has no default font size setting that Playwright can reach',
  );

  for (const width of [1280, 320]) {
    test(`clips and overlaps no text at ${width} CSS pixels wide`, async ({
      browserName,
      channel,
      baseURL,
    }) => {
      const { page, close } = await open(browserName, channel, baseURL!, width);
      try {
        const result = await audit(page);
        // The setting took effect: the unstyled medium size is the doubled default.
        expect(result.probePx).toBeGreaterThanOrEqual(DEFAULT_FONT_PX);
        expect(result.viewport).toBe(width);
        // The editor drew text to look at.
        expect(result.textBoxes).toBeGreaterThan(5);
        expect(result.clipped).toEqual([]);
        expect(result.overlapping).toEqual([]);
        // Nothing of the editor reaches past the viewport or scrolls sideways (the test page's own
        // heading is outside the editor and is not looked at).
        expect(result.wide).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
