/**
 * FE-035 criterion 4 (lane U-FE-033-048): an acknowledged commit that equals the client's own
 * rebased version is a no-op, and no DOM node of the editing surface is mutated by the rebuild.
 *
 * Ada types one key in the editor while the service holds her write (`holdWrites`), so the key is
 * visible at once and unconfirmed. A MutationObserver is attached to the editing surface only after
 * that key's own DOM work has settled. Then the held write is released: the service stores Ada's
 * commit unchanged (no remote commit is in the way), and the acknowledgement reaches the core. The
 * observer must record no mutation between the release and the moment the editor is confirmed.
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/fe-035-ack-noop.spec.ts --project=chromium --workers=1`.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { mountEditor, openEmbed } from './embed-helpers.ts';

test('FE-035 criterion 4: an acknowledgement equal to the local document mutates no node of the editing surface', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada' });
  const id = SPIKE_IDS.last;

  // Hold Ada's write at the service, so the acknowledgement is released by the test, not by timing.
  await page.evaluate(() => {
    const w = window as unknown as {
      __embed: {
        service: { holdWrites(docId: string): { release(): Promise<void> } };
        docId: string;
      };
      __fe035: { release(): Promise<void> } | undefined;
      __fe035Records: number;
      __fe035Observer: MutationObserver | undefined;
    };
    w.__fe035 = w.__embed.service.holdWrites(w.__embed.docId);
    w.__fe035Records = 0;
  });

  // Put the caret at the end of the paragraph and type one key.
  await page.evaluate(async (node) => {
    const el = document.querySelector('doc-editor[data-test="one"]')!;
    const h = await (
      window as unknown as {
        __embed: { harness(el: Element): Promise<{ caretIn(id: string, at: 'end'): void }> };
      }
    ).__embed.harness(el);
    h.caretIn(node, 'end');
  }, id);
  await page.keyboard.press('K');

  // The key's own DOM work is done when the paragraph shows it and the frames have settled.
  await expect
    .poll(() =>
      page.evaluate(async (node) => {
        const el = document.querySelector('doc-editor[data-test="one"]')!;
        const h = await (
          window as unknown as {
            __embed: { harness(el: Element): Promise<{ nodeText(id: string): string | null }> };
          }
        ).__embed.harness(el);
        return h.nodeText(node) ?? '';
      }, id),
    )
    .toMatch(/K$/);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let n = 0;
        const f = () => (++n >= 10 ? resolve() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
  );

  // Attach the observer to the editing surface, then release the held write.
  await page.evaluate(() => {
    const w = window as unknown as {
      __fe035: { release(): Promise<void> } | undefined;
      __fe035Observer: MutationObserver | undefined;
      __fe035Records: number;
    };
    const el = document.querySelector('doc-editor[data-test="one"]')!;
    const surface = el.shadowRoot!.querySelector('.de-editing-surface')!;
    w.__fe035Observer = new MutationObserver((list) => {
      w.__fe035Records += list.length;
    });
    w.__fe035Observer.observe(surface, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    void w.__fe035!.release();
  });

  // The acknowledgement is confirmed: the editor has no pending commit.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const el = document.querySelector('doc-editor[data-test="one"]')!;
        const h = await (
          window as unknown as {
            __embed: { harness(el: Element): Promise<{ pending(): number }> };
          }
        ).__embed.harness(el);
        return h.pending();
      }),
    )
    .toBe(0);

  // Let the frames run after the acknowledgement, then read what the observer recorded.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let n = 0;
        const f = () => (++n >= 10 ? resolve() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
  );
  const mutations = await page.evaluate(() => {
    const w = window as unknown as {
      __fe035Observer: MutationObserver | undefined;
      __fe035Records: number;
    };
    const pending = w.__fe035Observer?.takeRecords().length ?? 0;
    w.__fe035Observer?.disconnect();
    return w.__fe035Records + pending;
  });

  expect(mutations, 'DOM mutations of the editing surface after the acknowledgement').toBe(0);
  // The document is unchanged by the acknowledgement: the key is kept once.
  await expect
    .poll(() =>
      page.evaluate(async (node) => {
        const el = document.querySelector('doc-editor[data-test="one"]')!;
        const h = await (
          window as unknown as {
            __embed: { harness(el: Element): Promise<{ nodeText(id: string): string | null }> };
          }
        ).__embed.harness(el);
        return h.nodeText(node);
      }, id),
    )
    .toMatch(/K$/);
});
