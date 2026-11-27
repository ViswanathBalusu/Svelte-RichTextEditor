/**
 * UX-074 criterion 1 (lane w3, 2026-11-27): the memory of the element for a 100-page document after
 * a long editing session with a collaborator, in Chromium, with the real editing core, the real
 * layout and the mock service (which runs the real room of @docedit/authority).
 *
 * Method (owner decision 255; ADR 0329 decision 5): the figure is the JavaScript heap in use,
 * `Runtime.getHeapUsage().usedSize` after two `HeapProfiler.collectGarbage` calls, read through the
 * Chrome DevTools Protocol, so it is measurable in Chromium only. It is the heap of the whole page:
 * two `<doc-editor>` elements (the one measured and the collaborator's), the mock service and its
 * log, so it is an upper bound for one editor. It is not the reference laptop (decision 225), and
 * the figure says so. The session: the author and the collaborator type into paragraphs spread over
 * the whole document, each one's edits reaching the other through the room, and the author opens and
 * closes the panes in between.
 *
 * Run with
 * `DOCEDIT_DEMO_PORT=57365 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-074-memory-100-pages.spec.ts --project=chromium`.
 */
import type { CDPSession, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const PARAGRAPHS = Number(process.env['DOCEDIT_UX074_PARAGRAPHS'] ?? 1100);
const BURSTS = Number(process.env['DOCEDIT_UX074_BURSTS'] ?? 80);
const TARGET_BYTES = 300 * 1024 * 1024;
const PANES = ['view.outline', 'view.styles', 'view.permissions', 'view.shortcuts'] as const;

interface HeapUsage {
  usedSize: number;
  totalSize: number;
}

async function usedHeap(cdp: CDPSession): Promise<HeapUsage> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  return (await cdp.send('Runtime.getHeapUsage')) as HeapUsage;
}

/** A document of `count` paragraphs of about 420 characters, made from the first document's envelope. */
async function makeDocument(page: Page, count: number): Promise<string> {
  return page.evaluate((n) => {
    const e = (
      window as unknown as {
        __embed: {
          docId: string;
          service: {
            document(id: string): { content(): unknown };
            createDocument(env: unknown): string;
          };
        };
      }
    ).__embed;
    const full = JSON.parse(JSON.stringify(e.service.document(e.docId).content())) as {
      cdm: number;
      requires: string[];
      doc: { content: Array<{ type: string; content: unknown[] }> };
    };
    // The envelope without the metadata of the content read (seq, incarnation).
    const env = { cdm: full.cdm, requires: full.requires, doc: full.doc };
    const body = env.doc.content.find((x) => x.type === 'body')!;
    const words =
      'the parties agree that the supplier delivers the goods described in the schedule to the buyer at the address named in the order within thirty days and that payment falls due on receipt of a correct invoice'.split(
        ' ',
      );
    const paragraphs = Array.from({ length: n }, (_, i) => {
      let text = '';
      for (let k = 0; text.length < 420; k++) text += `${words[(i * 7 + k) % words.length]} `;
      return {
        type: 'paragraph',
        attrs: { id: `pL${String(i).padStart(14, '0')}`, style: 'Normal' },
        content: [{ type: 'text', text: `${i + 1}. ${text.trim()}` }],
      };
    });
    body.content = paragraphs;
    return e.service.createDocument(env);
  }, count);
}

async function mount(
  page: Page,
  doc: string,
  name: string,
  sub: string,
  view: 'web' | 'print',
): Promise<void> {
  await page.evaluate(
    async ({ doc, name, sub, view }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: { backend(user: unknown, docs: Record<string, string>): unknown };
          };
        }
      ).__embed;
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      if (view === 'print') el.setAttribute('view', 'print');
      el.style.display = 'block';
      el.style.height = '560px';
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener('de-error', (ev) => reject(new Error(JSON.stringify(ev))), {
          once: true,
        });
      });
      el.backend = e.service.backend({ sub, name: sub }, { [doc]: 'editor' });
      el.setAttribute('doc-id', doc);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { doc, name, sub, view },
  );
}

/**
 * Types `text` in the page view at `fraction` of the document's height: the view scrolls there, only
 * the pages near it are in the DOM, and the first line in view takes the text.
 */
async function typeInPages(page: Page, sel: string, fraction: number, text: string) {
  await page.locator(sel).scrollIntoViewIfNeeded();
  await page.evaluate(
    ({ sel, fraction }) => {
      const el = document.querySelector(sel)!;
      const s = el.shadowRoot!.querySelector('.de-page-scroller') as HTMLElement;
      s.scrollTop = fraction * (s.scrollHeight - s.clientHeight);
    },
    { sel, fraction },
  );
  const view = page.locator(`${sel} .de-page-scroller`);
  await expect(page.locator(`${sel} .de-page .de-line`).first()).toBeVisible();
  const box = await view.boundingBox();
  const target = page.locator(`${sel} .de-page .de-line`);
  const n = await target.count();
  for (let i = 0; i < n; i++) {
    const b = await target.nth(i).boundingBox();
    if (b && box && b.y > box.y + 40 && b.y + b.height < box.y + box.height - 40) {
      await target.nth(i).click();
      await page.keyboard.press('End');
      await page.keyboard.type(text, { delay: 2 });
      return;
    }
  }
  throw new Error('no line in view to type into');
}
test.describe('memory of a 100-page document (UX-074 criterion 1)', () => {
  test.setTimeout(1_800_000);

  test('stays under 300 MB after a long editing session with a collaborator', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'the heap figure comes from the Chrome DevTools Protocol',
    );
    await openEmbed(page);
    const cdp = await page.context().newCDPSession(page);
    const doc = await makeDocument(page, PARAGRAPHS);
    await mount(page, doc, 'author', 'ada', 'print');
    await mount(page, doc, 'collab', 'bob', 'print');
    const author = 'doc-editor[data-test="author"]';
    const collab = 'doc-editor[data-test="collab"]';

    // The layout has finished when the page view holds its pages. The count is the number of pages
    // in the page view's scroll height (one page and its gap is the pitch), which holds whether or
    // not every page is in the DOM.
    const measure = (): Promise<{ dom: number; pitch: number; height: number; pages: number }> =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)!;
        const scroller = el.shadowRoot!.querySelector('.de-page-scroller') as HTMLElement | null;
        const pagesInDom = [...(scroller?.querySelectorAll('.de-page') ?? [])] as HTMLElement[];
        const first = pagesInDom[0];
        const second = pagesInDom[1];
        const pitch =
          first && second
            ? second.getBoundingClientRect().top - first.getBoundingClientRect().top
            : (first?.getBoundingClientRect().height ?? 0);
        const height = scroller?.scrollHeight ?? 0;
        return {
          dom: pagesInDom.length,
          pitch: Math.round(pitch * 100) / 100,
          height,
          pages: pitch > 0 ? Math.round(height / pitch) : 0,
        };
      }, author);
    await expect
      .poll(async () => (await measure()).pages, { timeout: 180_000 })
      .toBeGreaterThanOrEqual(100);
    const layout = await measure();
    const pageCount = layout.pages;
    console.log(`ux-074 page view: ${JSON.stringify(layout)}`);
    console.log('ux-074 step: layout done ' + new Date().toISOString());
    const loaded = await usedHeap(cdp);
    console.log('ux-074 step: loaded heap ' + loaded.usedSize);
    const samples: number[] = [];
    for (let burst = 0; burst < BURSTS; burst++) {
      // Edits spread over the whole document, by both editors in turn.
      const a = 1 + ((burst * 37) % PARAGRAPHS);
      const b = 1 + ((burst * 61 + 11) % PARAGRAPHS);
      console.log('ux-074 step: burst ' + burst + ' ' + new Date().toISOString());
      await typeInPages(page, author, (a - 1) / PARAGRAPHS, ` author ${burst}`);
      console.log('ux-074 step: collab ' + burst);
      await typeInPages(page, collab, (b - 1) / PARAGRAPHS, ` collaborator ${burst}`);
      if (burst % 10 === 9) {
        for (const id of PANES) {
          await page.evaluate(
            ({ id }) => {
              const el = document.querySelector('doc-editor[data-test="author"]') as HTMLElement & {
                exec(id: string): boolean;
              };
              el.exec(id);
            },
            { id },
          );
          await page.waitForTimeout(150);
          await page.keyboard.press('Escape');
        }
        samples.push((await usedHeap(cdp)).usedSize);
      }
    }
    await page.waitForTimeout(2000);
    const final = await usedHeap(cdp);
    const peak = Math.max(final.usedSize, ...samples);

    const record = {
      figure: 'Runtime.getHeapUsage().usedSize after two HeapProfiler.collectGarbage calls',
      browser: 'chromium',
      machine: 'the development machine, not the reference laptop (decision 225)',
      pages: pageCount,
      paragraphs: PARAGRAPHS,
      editors: 2,
      bursts: BURSTS,
      loadedBytes: loaded.usedSize,
      afterSessionBytes: final.usedSize,
      peakSampleBytes: peak,
      samples,
      targetBytes: TARGET_BYTES,
    };
    test.info().annotations.push({ type: 'heap-usage', description: JSON.stringify(record) });
    console.log(`ux-074 100-page heap: ${JSON.stringify(record)}`);
    expect(final.usedSize).toBeLessThan(TARGET_BYTES);
    expect(peak).toBeLessThan(TARGET_BYTES);
  });
});
