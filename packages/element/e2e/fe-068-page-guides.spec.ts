/**
 * FE-068 criteria 1 to 3 (lane V-FE-065-080, round 3): page guides in the web view come from the
 * `layout.json` of a completed export, and only when the host turns them on with `config`. A guide
 * is drawn before the block a page starts at (offset 0) and nowhere inside a paragraph; the view is
 * still labelled "Web layout". Criterion 4 (an edit since the compile's `seq`) is not decided here.
 *
 * The backend is the embed page's in-memory mock, given an `exports` port and the `exports` feature
 * by the test (as e2e/pro-086-export-events.spec.ts does), because the mock has neither. The stand-in
 * port reports the job completed at once, with a `layout` URL: a data URL that holds the report, which
 * the element reads with `fetch` (src/page-guides.ts, loadLayoutReport). The report is built by the
 * export worker's own code from a class sidecar file and a converter map naming the regions
 * document's paragraphs, and passes the worker's schema check (test/fe-068-worker-layout.ts), so it
 * has the shape the worker serves (09 §7.1: `pages[].starts`). Run from the repository root
 * with `DOCEDIT_DEMO_PORT=57040 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-068-page-guides.spec.ts`
 * (Chromium, Firefox and WebKit).
 */
import { expect, test, type Page } from '@playwright/test';
import { workerLayoutJson } from '../test/fe-068-worker-layout.ts';
import { openEmbed } from './embed-helpers.ts';

const BEFORE = 'pBefore000000001';
const REGION_FIRST = 'pRegionFirst0001';
const AFTER = 'pAfter0000000001';

/**
 * The regions document's paragraphs in document order (demo/embed-page.ts), as the converter
 * numbers them, and a three-page layout: page 1 starts at `BEFORE`, page 2 inside the paragraph
 * `REGION_FIRST` at offset 7, page 3 at `AFTER`.
 */
const LAYOUT = workerLayoutJson(
  [BEFORE, REGION_FIRST, 'pRegionLast00001', AFTER, 'pEndText00000001', 'pTrailing0000001'],
  [
    { block: 0, offset: 0 },
    { block: 1, offset: 7 },
    { block: 3, offset: 0 },
  ],
  1,
);

/**
 * Mounts a `<doc-editor>` on the regions document with an exports stand-in whose export completes
 * with the layout above, and returns nothing; `config` is set before the element connects.
 */
async function mountWithExports(page: Page, config: Record<string, unknown> | null): Promise<void> {
  await page.evaluate(
    async ({ config, layout }) => {
      const e = (
        window as unknown as {
          __embed: { backend(sub: string, role: string): unknown; regionsDocId: string };
        }
      ).__embed;
      const backend = e.backend('ada', 'editor') as {
        features: ReadonlySet<string>;
        connect(): Promise<void>;
        exports?: unknown;
      };
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        await connect();
        backend.features = new Set([...backend.features, 'exports']);
      };
      backend.exports = {
        request: async (
          docId: string,
          _body: unknown,
          opts?: { onProgress?: (job: unknown) => void },
        ) => {
          const job = {
            id: 'job-v-fe-065-080-068',
            docId,
            state: 'completed',
            progress: 100,
            target: 'pdf',
            result: {
              url: 'https://assets.invalid/export.pdf',
              expiresAt: '2030-01-01T00:00:00Z',
              pages: 2,
              layout: `data:application/json,${encodeURIComponent(JSON.stringify(layout))}`,
              converged: true,
            },
          };
          // The report comes after the request returns, as a poll would deliver it.
          setTimeout(() => opts?.onProgress?.(job), 0);
          return { ...job, state: 'queued', result: null, progress: null };
        },
        get: async () => {
          throw new Error('not used by this test');
        },
        cancel: async () => {},
      };
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        config: unknown;
      };
      el.dataset['test'] = 'v-fe-065-080-068';
      if (config !== null) el.config = config;
      const ready = new Promise<void>((resolve) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
      });
      el.backend = backend;
      el.setAttribute('doc-id', e.regionsDocId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { config, layout: LAYOUT },
  );
}

/** Requests the export of the mounted element; the report arrives after this resolves. */
async function requestExport(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="v-fe-065-080-068"]') as HTMLElement & {
      requestExport(options: { target: string }): Promise<{ jobId: string }>;
    };
    await el.requestExport({ target: 'pdf' });
  });
}

const element = 'doc-editor[data-test="v-fe-065-080-068"]';

test('guides are off by default, even after a completed export reports pages (FE-068, criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountWithExports(page, null);
  await requestExport(page);
  // Give the report time to be read; nothing should be drawn.
  await page.waitForTimeout(300);
  await expect(page.locator(`${element} .de-page-guide`)).toHaveCount(0);
});

test('with config.pageGuides on, a guide sits before each block a page starts at only (FE-068, criteria 1 and 2)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountWithExports(page, { pageGuides: true });
  await requestExport(page);

  // Pages 1 and 3 start at a block; page 2 starts inside a paragraph and gets no guide.
  const guides = page.locator(`${element} .de-page-guide`);
  await expect(guides).toHaveCount(2);
  const facts = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    return {
      guides: [...root.querySelectorAll<HTMLElement>('.de-page-guide')].map((guide) => ({
        blockId: guide.dataset['blockId'],
        next: guide.nextElementSibling?.textContent ?? null,
        insideParagraph: guide.closest('p') !== null,
        hidden: guide.getAttribute('aria-hidden'),
      })),
      label: root.querySelector('.de-view-label')?.textContent ?? null,
    };
  }, element);
  expect(facts.guides).toEqual([
    { blockId: BEFORE, next: 'Before region.', insideParagraph: false, hidden: 'true' },
    { blockId: AFTER, next: 'After region.', insideParagraph: false, hidden: 'true' },
  ]);
  expect(facts.guides.map((g) => g.blockId)).not.toContain(REGION_FIRST);
  // The view is still the web layout (criterion 3).
  expect(facts.label).toBe('Web layout');
});

test('turning the config switch off removes the guides again (FE-068, criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountWithExports(page, { pageGuides: true });
  await requestExport(page);
  await expect(page.locator(`${element} .de-page-guide`)).toHaveCount(2);
  await page.evaluate((sel) => {
    (document.querySelector(sel) as HTMLElement & { config: unknown }).config = {
      pageGuides: false,
    };
  }, element);
  await expect(page.locator(`${element} .de-page-guide`)).toHaveCount(0);
});
