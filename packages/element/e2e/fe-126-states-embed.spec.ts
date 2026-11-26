/**
 * FE-126 criterion 1, named page states on the production shell (lane w1, 2026-11-26). The
 * fe-126-axe-states spec covers the S1 spike page; this spec mounts the element on the embed page
 * (the shell with its header) and runs axe, through the shadow roots, in the states the criterion
 * names: editing, a side pane (the outline), forced colours, the dark theme and pseudo right-to-left
 * (a document whose text is right to left). Each state is compared with the editing state (the
 * FE-019 comparison, as in fe-126-dialogs-axe): it must add no rule and grow no rule's node count.
 * The dialog state is in fe-126-dialogs-axe. Chromium only (time budget). Run from the repository
 * root with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-126-states-embed.spec.ts --project=chromium`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { clickToolbarCommand, mountEditor, openEmbed } from './embed-helpers.ts';
import { handOverAxe } from './axe-results.ts';
import { record } from './helpers.ts';

type Summary = Map<string, number>;

async function summarise(page: Page): Promise<Summary> {
  const results = await new AxeBuilder({ page }).analyze();
  handOverAxe(page, test.info(), results.violations);
  const summary: Summary = new Map();
  for (const v of results.violations) summary.set(v.id, v.nodes.length);
  return summary;
}

test.describe('FE-126 states on the production shell: axe finds nothing new', () => {
  // Five axe runs, two mounts and a demo page that is built on the first request: past the 60 s default.
  test.setTimeout(180_000);
  test('editing, pane, forced colours, dark theme and pseudo right-to-left add no rule', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'axe is run in Chromium only (time budget)');
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(page.locator('doc-editor[data-test="one"] .de-editing-surface')).toHaveAttribute(
      'contenteditable',
      'true',
    );

    const editing = await summarise(page);

    // The embed page loads the element from source, so no chunk request shows the pane opening.
    // The shadow DOM's element count before and after is recorded as the evidence that it grew.
    const shadowCount = () =>
      page.evaluate(() => {
        const el = document.querySelector('doc-editor[data-test="one"]');
        return el?.shadowRoot ? el.shadowRoot.querySelectorAll('*').length : 0;
      });
    const before = await shadowCount();
    await clickToolbarCommand(page, 'outline');
    await page.waitForTimeout(500);
    const after = await shadowCount();
    record('fe-126-states-pane-grow', { before, after });
    const pane = await summarise(page);

    await page.keyboard.press('Escape');
    await page.emulateMedia({ forcedColors: 'active' });
    const forced = await summarise(page);
    await page.emulateMedia({ forcedColors: 'none' });

    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await summarise(page);
    await page.emulateMedia({ colorScheme: 'light' });

    // A second mount in the same page would hide the first; reload the page for the RTL document.
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', doc: 'rtl' });
    await expect(page.locator('doc-editor[data-test="one"] .de-editing-surface')).toHaveAttribute(
      'contenteditable',
      'true',
    );
    const rtl = await summarise(page);

    const states = { pane, forced, dark, rtl };
    const report: Record<string, { added: string[]; grew: string[] }> = {};
    for (const [name, summary] of Object.entries(states)) {
      report[name] = {
        added: [...summary.keys()].filter((id) => !editing.has(id)),
        grew: [...summary.keys()].filter(
          (id) => editing.has(id) && summary.get(id)! > editing.get(id)!,
        ),
      };
    }
    record('fe-126-states-embed', {
      editing: Object.fromEntries(editing),
      states: Object.fromEntries(
        Object.entries(states).map(([k, v]) => [k, Object.fromEntries(v)]),
      ),
      report,
    });
    for (const [name, r] of Object.entries(report)) {
      expect({ state: name, added: r.added, grew: r.grew }).toEqual({
        state: name,
        added: [],
        grew: [],
      });
    }
  });
});
