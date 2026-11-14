/**
 * SEC-011 criterion 2 (lane U-SEC-001-016): a simulated browser extension mutates the editor's DOM
 * and dispatches input events. Two cases, in Chromium, Edge, Firefox and WebKit:
 * 1. An editor types nothing; the extension appends text to an open paragraph and inserts an
 *    element that is not in the schema. The text must arrive as ordinary input (it is stored as
 *    text) and the element must not survive: the stored document holds no node type the schema
 *    did not hold before, and no element of the editing surface outside the schema remains.
 * 2. A user without the grant of the restricted region ("Legal review") has the extension change
 *    a paragraph in that region. The server must not store the change: the stored document keeps
 *    the paragraph's original text.
 * The stored document is read through the in-memory service (`__embed.service`), the same store
 * the wire commits go to. This runs in the memory service only; the PostgreSQL run is not made.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

interface EmbedHooks {
  docId: string;
  service: { document(id: string): { content(): unknown } | undefined };
}

/** Everything the service stores for the document, as text. */
async function storedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const doc = e.service.document(e.docId);
    return JSON.stringify(doc?.content() ?? null);
  });
}

/** The text of the surface's paragraphs, in order. */
async function paragraphTexts(page: Page, name: string): Promise<string[]> {
  return page
    .locator(`doc-editor[data-test="${name}"] .de-editing-surface p`)
    .evaluateAll((ps) => ps.map((p) => p.textContent ?? ''));
}

test('SEC-011: an extension edit to an open paragraph arrives as text and an unknown element is dropped', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-011-open' });
  const surface = page.locator('doc-editor[data-test="sec-011-open"] .de-editing-surface');
  await expect(surface.locator('p').last()).toBeVisible();
  const before = await storedText(page);

  await page.evaluate(() => {
    const host = document.querySelector('doc-editor[data-test="sec-011-open"]')!;
    const root = host.shadowRoot!;
    const surfaceEl = root.querySelector('.de-editing-surface') as HTMLElement;
    const ps = Array.from(surfaceEl.querySelectorAll('p'));
    const p = ps[ps.length - 1]!;
    // The extension edits the text, dispatches an input event, and adds an element of its own.
    p.append(document.createTextNode(' EXT-EDIT-7f2c'));
    p.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: 'EXT',
      }),
    );
    const extra = document.createElement('span');
    extra.setAttribute('data-ext', 'x');
    extra.textContent = 'EXT-SPAN';
    p.append(extra);
    p.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }),
    );
  });

  await expect.poll(async () => storedText(page), { timeout: 10_000 }).toContain('EXT-EDIT-7f2c');
  await page.waitForTimeout(300);

  const after = await storedText(page);
  // Stored as text: the typed text is there, the span the extension added is not a node of the
  // stored document (its text may survive as plain text, which the schema allows).
  expect(after).toContain('EXT-EDIT-7f2c');
  expect(after).not.toContain('"span"');
  expect(after).not.toContain('<');
  expect(before).not.toContain('EXT-EDIT-7f2c');
  // The element on the surface holds no element the extension added.
  const extraNodes = await surface.locator('[data-ext]').count();
  expect(extraNodes).toBe(0);
});

test('SEC-011: an extension edit inside a region the user may not edit is refused by the server', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { sub: 'bob', role: 'editor', name: 'sec-011-region' });
  const surface = page.locator('doc-editor[data-test="sec-011-region"] .de-editing-surface');
  await expect(surface.locator('p').last()).toBeVisible();

  const target = await paragraphTexts(page, 'sec-011-region');
  const legal = target.find((t) => t.includes('Liability is limited'));
  expect(legal, 'the restricted paragraph is on the surface').toBeDefined();
  const beforeStore = await storedText(page);

  await page.evaluate(() => {
    const host = document.querySelector('doc-editor[data-test="sec-011-region"]')!;
    const surfaceEl = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
    const p = Array.from(surfaceEl.querySelectorAll('p')).find((x) =>
      (x.textContent ?? '').includes('Liability is limited'),
    )!;
    p.append(document.createTextNode(' EXT-LEGAL-9d1e'));
    p.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: 'EXT',
      }),
    );
  });

  // Give the component and the service time to refuse or accept the change.
  await page.waitForTimeout(1_000);
  const afterStore = await storedText(page);
  expect(beforeStore).not.toContain('EXT-LEGAL-9d1e');
  expect(afterStore, 'the service stores no change to the restricted region').not.toContain(
    'EXT-LEGAL-9d1e',
  );
  expect(afterStore).toContain('Liability is limited to');
});
