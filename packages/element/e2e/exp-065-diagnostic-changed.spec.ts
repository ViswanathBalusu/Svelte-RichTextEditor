/**
 * EXP-065 criterion 3 in the production element (lane w2, 2026-11-26): an export diagnostic that
 * names a block is marked when the block changed after the job's `seq`, choosing it moves the
 * editor to the block, and the dialog says that the block has changed. The element runs with the
 * demo's mock service and its real editing core (`blockChangedSince` and `selectBlock` of
 * `@docedit/engine`), which confirms the test's own edit; the test adds an exports port whose job
 * names two blocks, one that the edit changed and one that it did not.
 *
 * Run with
 * `DOCEDIT_DEMO_PORT=57365 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/exp-065-diagnostic-changed.spec.ts --project=<browser>`.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="exp065"]';

interface Core {
  confirmedSeq: { get(): number };
  selectionScope(): { blockId: string | null };
}

async function mount(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const e = (
      window as unknown as {
        __embed: {
          docId: string;
          SPIKE_IDS: { last: string; title: string };
          backend(sub: string, role: string): unknown;
        };
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
    const w = window as unknown as { __exp065Seq: number };
    const job = (state: string) => ({
      id: 'job-exp065-1',
      doc: e.docId,
      target: 'pdf',
      seq: w.__exp065Seq,
      state,
      progress: state === 'completed' ? 100 : null,
      result:
        state === 'completed'
          ? {
              url: `${location.origin}/exports/sample.pdf`,
              expiresAt: '2099-01-01T00:00:00Z',
              pages: 1,
              layout: null,
              converged: true,
            }
          : null,
      diagnostics:
        state === 'completed'
          ? [
              {
                severity: 'warning',
                code: 'tab_approximate',
                blockId: e.SPIKE_IDS.last,
                message: 'A tab stop was approximated.',
              },
              {
                severity: 'warning',
                code: 'table_cannot_span_pages',
                blockId: e.SPIKE_IDS.title,
                message: 'A table could not span pages.',
              },
            ]
          : [],
      createdAt: '2026-11-26T10:00:00Z',
      updatedAt: '2026-11-26T10:00:00Z',
    });
    backend.exports = {
      request: async (
        _docId: string,
        _body: unknown,
        opts?: { onProgress?: (j: unknown) => void },
      ) => {
        opts?.onProgress?.(job('queued'));
        setTimeout(() => opts?.onProgress?.(job('completed')), 40);
        return job('queued');
      },
      get: async () => job('completed'),
      cancel: async () => {},
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'exp065';
    el.setAttribute('doc-id', e.docId);
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = backend;
    document.getElementById('mount')!.append(el);
    await ready;
  });
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

const core = <T = number>(page: Page, read: string): Promise<T> =>
  page.evaluate(
    ({ sel, read }) => {
      const hooks = (globalThis as unknown as { __embed: { internals(el: Element): unknown } })
        .__embed;
      const c = (hooks.internals(document.querySelector(sel)!) as { editor: { core: Core } }).editor
        .core;
      return new Function('core', `return ${read}`)(c) as T;
    },
    { sel: EDITOR, read },
  );

test('a diagnostic whose block changed after the export is marked, moves the editor and says so (EXP-065 criterion 3)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);

  // The export is of the document as it stands; then the author edits the last paragraph.
  const exported = await core(page, 'core.confirmedSeq.get()');
  await page.evaluate((seq) => {
    (window as unknown as { __exp065Seq: number }).__exp065Seq = seq;
  }, exported);
  await page.locator(`${EDITOR} .de-editing-surface p`).last().click();
  // The caret goes to the end of the diagnostic's own block, whatever the browser's click chose.
  await page.evaluate(async (sel) => {
    const e = (
      window as unknown as {
        __embed: {
          SPIKE_IDS: { last: string };
          harness(el: Element): Promise<{ caretIn(id: string, at: 'start' | 'end'): void }>;
        };
      }
    ).__embed;
    (await e.harness(document.querySelector(sel)!)).caretIn(e.SPIKE_IDS.last, 'end');
  }, EDITOR);
  await page.keyboard.type(' typed');
  await expect.poll(() => core(page, 'core.confirmedSeq.get()')).toBeGreaterThan(exported);

  // The caret goes to the first paragraph, so that the move to the last one can be seen.
  await page.locator(`${EDITOR} .de-editing-surface p`).first().click();
  await page.evaluate(
    (sel) =>
      (document.querySelector(sel) as unknown as { exec(name: string): unknown }).exec(
        'document.export',
      ),
    EDITOR,
  );
  const dialog = page.locator(`${EDITOR} dialog[data-dialog="export"]`);
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const items = dialog.getByRole('list', { name: 'Problems found' }).getByRole('button');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Changed since this export');
  await expect(items.nth(1)).not.toContainText('Changed since this export');

  // Choosing the changed block: the editor moves to it and the dialog says the block has changed.
  const before = await core<string | null>(page, 'core.selectionScope().blockId');
  await items.nth(0).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'changed since this export' }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await core<string | null>(page, 'core.selectionScope().blockId')).not.toBe(before);

  // Choosing a block that has not changed: the editor moves and the dialog closes.
  await items.nth(1).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
