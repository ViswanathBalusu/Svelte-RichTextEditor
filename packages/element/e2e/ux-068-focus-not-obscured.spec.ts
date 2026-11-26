/**
 * UX-068, criterion 3, in the product's element (lane w3, 2026-11-26): focus is not hidden behind
 * the header, the toolbar, an open pane or the status bar. These parts stay in view while the
 * document scrolls, so they count as the pinned parts the criterion names (WCAG 2.2, 2.4.11).
 *
 * With a document of 240 long paragraphs (about thirty pages) in the web view and in the page
 * view, and the navigation pane open:
 * - in the page view the box in which the document scrolls does not overlap any pinned part, so no
 *   pinned part can lie over what the scroll brings into view (in the web view the host page scrolls,
 *   the browser window is the box, and the parts of the element scroll away with the page);
 * - the author moves the caret with the keyboard (arrow, page and document keys), and after each
 *   key the caret is inside the scroll box and outside every pinned part.
 *
 * The page view is not offered in Firefox (spike S5), so there only the web view is run. Run from
 * the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts ux-068-focus-not-obscured`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'ux068';
const EDITOR = `doc-editor[data-test="${NAME}"]`;
const PARAGRAPHS = 240;

interface Embed {
  service: {
    createDocument(content: unknown, opts?: { grants?: unknown[] }): string;
    backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
  };
  docId: string;
  internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } | null };
}

/** Mounts an editor on a long document (the embed page's, with more paragraphs added). */
async function mountLong(page: Page, attributes: Record<string, string>): Promise<void> {
  await page.evaluate(
    async ({ name, attributes, paragraphs }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      type Port = {
        connect(): Promise<void>;
        sync: {
          loadContent(id: string): Promise<{
            cdm: number;
            requires: string[];
            doc: { content: Array<{ type: string; content: unknown[] }> };
          }>;
        };
      };
      const reader = e.service.backend(
        { sub: 'olga', name: 'Olga' },
        { [e.docId]: 'owner' },
      ) as Port;
      await reader.connect();
      const source = await reader.sync.loadContent(e.docId);
      const body = source.doc.content.find((n) => n.type === 'body')!;
      const sentence =
        'The quick brown fox jumps over the lazy dog while the editor lays this line out on a page. ';
      for (let i = 1; i <= paragraphs; i++)
        body.content.push({
          type: 'paragraph',
          attrs: { id: `pLong${String(i).padStart(11, '0')}`, style: 'Normal' },
          content: [{ type: 'text', text: `Para ${i}: ${sentence.repeat(5).trim()}` }],
        });
      const docId = e.service.createDocument({
        cdm: source.cdm,
        requires: source.requires,
        doc: source.doc,
      });
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      for (const [attribute, value] of Object.entries(attributes))
        el.setAttribute(attribute, value);
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [docId]: 'editor' });
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { name: NAME, attributes, paragraphs: PARAGRAPHS },
  );
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Geometry {
  scroller: Box | null;
  pinned: Array<Box & { name: string }>;
  caret: Box | null;
  scrollTop: number;
}

/** The scroll box, the pinned parts and the caret, as they are on screen now. */
function geometry(page: Page, scrollerSelector: string | null): Promise<Geometry> {
  return page.evaluate(
    ({ selector, scrollerSelector }) => {
      const host = document.querySelector(selector)!;
      const root = host.shadowRoot!;
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      const scroller = scrollerSelector ? root.querySelector<HTMLElement>(scrollerSelector) : null;
      const pinned = [...root.querySelectorAll('.de-header, .de-toolbar, .de-status, .de-pane')]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ name: el.className.split(' ')[0] ?? '', ...box(el) }));
      let caret: Box | null = null;
      const painted = root.querySelector('.de-caret');
      if (painted) caret = box(painted);
      else {
        // Chromium reads a selection inside a shadow root from the root; Firefox and WebKit give it
        // as composed ranges of the window's selection.
        const rootWithSelection = root as unknown as { getSelection?: () => Selection | null };
        const win = window.getSelection() as
          | (Selection & {
              getComposedRanges?: (o: { shadowRoots: ShadowRoot[] }) => StaticRange[];
            })
          | null;
        const own = rootWithSelection.getSelection?.() ?? null;
        const composed = own ? undefined : win?.getComposedRanges?.({ shadowRoots: [root] })[0];
        const node = own ? own.focusNode : (composed?.endContainer ?? null);
        const at = own ? own.focusOffset : (composed?.endOffset ?? 0);
        if (node && node.nodeType === Node.TEXT_NODE) {
          const length = node.textContent?.length ?? 0;
          const range = document.createRange();
          range.setStart(node, Math.max(0, at - (at > 0 ? 1 : 0)));
          range.setEnd(node, Math.min(length, at + (at > 0 ? 0 : 1)));
          const rects = [...range.getClientRects()];
          if (rects.length === 0) rects.push(range.getBoundingClientRect());
          const first = rects[0]!;
          if (first.height > 0) caret = box({ getBoundingClientRect: () => first } as Element);
        }
      }
      return {
        scroller: scroller
          ? box(scroller)
          : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth },
        pinned,
        caret,
        scrollTop: scroller ? scroller.scrollTop : window.scrollY,
      };
    },
    { selector: EDITOR, scrollerSelector },
  );
}

const overlaps = (a: Box, b: Box): boolean =>
  a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;

async function openNavigation(page: Page): Promise<void> {
  const opened = await page.evaluate((selector) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    return e.internals(document.querySelector(selector)!).editor!.openPane('outline');
  }, EDITOR);
  expect(opened).toBe(true);
  await expect(page.locator(`${EDITOR} .de-outline`)).toBeVisible();
}

const VIEWS = [
  { view: 'web', scroller: null, surface: '.de-body-host' },
  { view: 'print', scroller: '.de-page-scroller', surface: '.de-page-view .de-page' },
] as const;

test.describe('focus is not hidden behind the pinned parts of the element (UX-068, criterion 3)', () => {
  for (const { view, scroller, surface } of VIEWS) {
    test(`the ${view} view: the scroll box is clear of the pinned parts and the caret stays in it`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        view === 'print' && browserName === 'firefox',
        'the page view is not offered in Firefox (S5)',
      );
      await openEmbed(page);
      await mountLong(page, view === 'web' ? {} : { view });
      await expect(page.locator(`${EDITOR} ${surface}`).first()).toBeVisible({ timeout: 30_000 });
      await openNavigation(page);

      const start = await geometry(page, scroller);
      expect(start.scroller, 'the scroll box exists').not.toBeNull();
      // Header, toolbar, status bar and the pane: nothing pinned is missing from the walk.
      const names = new Set(start.pinned.map((p) => p.name));
      for (const name of ['de-toolbar', 'de-status', 'de-pane']) expect(names).toContain(name);
      for (const part of scroller === null ? [] : start.pinned) {
        // A pane may sit beside the document, but never over the box in which it scrolls.
        expect(overlaps(part, start.scroller!), `${part.name} overlaps the scroll box`).toBe(false);
      }

      // WebKit gives no rectangle for a caret inside a shadow root in the web view (the range has no
      // box), so there only the page view is walked.
      test.skip(
        view === 'web' && browserName === 'webkit',
        'WebKit gives no caret box in the web view',
      );
      // Put the caret in the first paragraph, then walk the document with the keyboard.
      await page.locator(`${EDITOR} ${surface} p, ${EDITOR} ${surface} .de-line`).first().click();
      const keys = [
        ...Array<string>(30).fill('ArrowDown'),
        ...Array<string>(12).fill('PageDown'),
        'Control+End',
        ...Array<string>(12).fill('PageUp'),
        ...Array<string>(30).fill('ArrowUp'),
        'Control+Home',
      ];
      let measured = 0;
      let scrolled = false;
      for (const key of keys) {
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        const g = await geometry(page, scroller);
        if (g.scrollTop > 0) scrolled = true;
        if (!g.caret || !g.scroller) continue;
        measured += 1;
        const within = g.caret.top >= g.scroller.top - 1 && g.caret.bottom <= g.scroller.bottom + 1;
        expect(within, `after ${key} the caret is inside the scroll box`).toBe(true);
        for (const part of g.pinned)
          expect(overlaps(part, g.caret), `after ${key} ${part.name} covers the caret`).toBe(false);
      }
      // The walk reached the caret often enough, and the document did scroll.
      expect(measured).toBeGreaterThan(keys.length / 2);
      expect(scrolled).toBe(true);
    });
  }
});
