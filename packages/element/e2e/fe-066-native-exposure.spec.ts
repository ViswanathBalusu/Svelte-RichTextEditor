/**
 * FE-066 criterion 5 (lane V-FE-065-080): in the web view, paragraphs, headings, tables and images
 * are exposed to assistive technology as document content. The check reads the accessibility tree
 * that Playwright takes from the browser (`ariaSnapshot`, which pierces the shadow root) for a
 * document holding one heading, one paragraph, a two-row table and an inline image with alt text.
 *
 * This is the browser's accessibility tree, which is what a screen reader is given; it is not a run
 * with a screen reader. The document is created through the embedding demo's service (the same
 * route as fe-067-hostile-corpus.spec.ts), and the element is mounted in the page.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-066-native-exposure.spec.ts`
 * in Chromium, Firefox and WebKit, against the demo on DOCEDIT_DEMO_PORT (default 4791).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const HEADING = 'Exposure heading';
const PARAGRAPH = 'Exposure paragraph text';
const CELL_A = 'Cell alpha';
const CELL_B = 'Cell beta';
const IMAGE_ALT = 'Exposure logo';

/** A CDM identifier: exactly 16 characters of [A-Za-z0-9_-] (the CDM's I11 rule). */
const id16 = (prefix: string): string => (prefix + '0'.repeat(16)).slice(0, 16);

function envelope() {
  const paragraph = (id: string, style: string | null, text: string) => ({
    type: 'paragraph',
    attrs: style === null ? { id } : { id, style },
    content: [{ type: 'text', text }],
  });
  const cell = (prefix: string, text: string) => ({
    type: 'table_cell',
    attrs: { id: id16(prefix), colspan: 1, rowspan: 1 },
    content: [paragraph(id16(prefix + 'p'), null, text)],
  });
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Heading1',
                kind: 'paragraph',
                name: 'Heading 1',
                builtIn: true,
                basedOn: 'Normal',
                next: 'Normal',
              },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            paragraph(id16('pHead'), 'Heading1', HEADING),
            paragraph(id16('pBody'), null, PARAGRAPH),
            {
              type: 'table',
              attrs: { id: id16('tTable'), grid: [4000, 4000] },
              content: [
                {
                  type: 'table_row',
                  attrs: { id: id16('trRow1') },
                  content: [cell('tcA', CELL_A), cell('tcB', CELL_B)],
                },
                {
                  type: 'table_row',
                  attrs: { id: id16('trRow2') },
                  content: [cell('tcC', 'Cell gamma'), cell('tcD', 'Cell delta')],
                },
              ],
            },
            {
              type: 'paragraph',
              attrs: { id: id16('pInline') },
              content: [
                {
                  type: 'image',
                  attrs: {
                    asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
                    width: 96,
                    height: 96,
                    alt: IMAGE_ALT,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

async function mountCreated(page: Page): Promise<void> {
  await page.evaluate(
    async ({ env, name }) => {
      const w = window as unknown as {
        __embed: {
          service: {
            createDocument(e: unknown): string;
            backend(user: unknown, grants: Record<string, string>): unknown;
          };
        };
      };
      const id = w.__embed.service.createDocument(env);
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      const ready = new Promise<string>((resolve) => {
        el.addEventListener('de-ready', () => resolve('ready'), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => resolve(`error ${JSON.stringify((ev as CustomEvent).detail)}`),
          { once: true },
        );
      });
      el.backend = w.__embed.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      const outcome = await ready;
      if (outcome !== 'ready') throw new Error(`the editor did not become ready: ${outcome}`);
    },
    { env: envelope(), name: 'fe-066-exposure' },
  );
}

test('FE-066 criterion 5: paragraphs, headings, tables and images are exposed as document content', async ({
  page,
}) => {
  await openEmbed(page);
  await mountCreated(page);
  const surface = page.locator('doc-editor[data-test="fe-066-exposure"] .de-editing-surface');
  await expect(surface).toContainText(PARAGRAPH);

  const tree = await surface.ariaSnapshot();

  // A heading is exposed with its level, not as plain text.
  expect(tree, 'heading exposed').toMatch(new RegExp(`heading "${HEADING}" \\[level=1\\]`));
  // The paragraph keeps its text in the tree.
  expect(tree, 'paragraph text exposed').toContain(PARAGRAPH);
  // The table is a table with two rows of cells, each cell with its text.
  expect(tree, 'table exposed').toMatch(/table/);
  expect(tree, 'table rows exposed').toMatch(/row/);
  expect(tree, 'cell text exposed').toContain(CELL_A);
  expect(tree, 'cell text exposed').toContain(CELL_B);
  // The image is exposed as an image with its alt text (the span has role="img").
  expect(tree, 'image exposed with alt text').toMatch(new RegExp(`img "${IMAGE_ALT}"`));
});
