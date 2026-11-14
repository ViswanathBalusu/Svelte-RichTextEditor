/**
 * SEC-009 criterion 4 (lane V-SEC-001-016, partial): a scripted session types into the element,
 * flushes, asks for an export, and then every `de-*` event detail the page recorded is scanned for
 * any substring of the document text. Content leaves the element only through the explicit methods
 * (`getContent`), so no event may carry it.
 *
 * What this does not prove: the criterion also names comments and fills. The element has no public
 * entry point for either (no comment or field method in src/doc-editor.ts), so the session does not
 * run them. The criterion stays unticked in the story; this file is its partial evidence.
 * The export refusal of the embed mock (no `exports` port) is accepted; a refused request raises no
 * content either. Events come from the embed page's recorder on `document`, so a recorded event has
 * left the shadow root. Chromium, Edge, Firefox and WebKit (playwright.config.ts projects).
 */
import { expect, test } from '@playwright/test';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const MARKER = 'sec009scanmarker';

test('SEC-009: no de-* event detail carries a substring of the document text in a typing and export session', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { name: 'sec-009-scan', sub: 'ada', role: 'editor' });
  const surface = page.locator('doc-editor[data-test="sec-009-scan"] .de-editing-surface');
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(` ${MARKER}`);
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain(MARKER);

  await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="sec-009-scan"]') as HTMLElement & {
      flush(): Promise<void>;
      requestExport(options: { target: string }): Promise<unknown>;
    };
    await el.flush();
    // The embed mock has no exports port, so the element refuses; the refusal is part of the session.
    await el.requestExport({ target: 'pdf' }).catch(() => undefined);
  });
  await page.waitForTimeout(300);

  const corpus = await page.evaluate(
    () => (window as unknown as { __embed: { docText: string[] } }).__embed.docText,
  );
  const texts = [...corpus, MARKER];
  const recorded = await events(page);
  const names = new Set(recorded.map((e) => e.name));
  expect(names.has('de-ready'), 'the session raised de-ready').toBe(true);

  for (const event of recorded) {
    if (!event.name.startsWith('de-')) continue;
    const detail = JSON.stringify(event.detail ?? null);
    for (const text of texts) {
      expect(detail, `${event.name} carries document text`).not.toContain(text);
    }
  }
});
