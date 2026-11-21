/**
 * UX-008 criterion 5, the shell's rule for a context click (lane w3): the menu lists the
 * suggestions of the finding whose mark was clicked, wherever the caret is, and no finding's
 * suggestions for a click beside a mark. From the keyboard the finding is the one at the caret
 * (ux-041-042-proofing.spec.ts).
 *
 * The harness core is a fake. The mark (`data-de-finding`, as the engine's decorations carry it) is
 * put into its surface by the test, and `proofingFinding(id)` answers from the findings the test
 * gave. The product's element with the real core and a proofing port is tested in
 * packages/element/e2e/ux-008-proofing-menu.spec.ts.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/ui/playwright.config.ts ux-008-finding-click.spec.ts
 */
import type { Page } from '@playwright/test';
import type { ProofingFindingView, ProofingStatus } from '../src/core-api.ts';
import { expect, open, test } from './helpers.ts';

const teh: ProofingFindingView = {
  id: 'b1:0:3:spelling',
  kind: 'spelling',
  message: 'Unknown word',
  text: 'teh',
  suggestions: ['the', 'tea'],
  scope: 'body',
  lang: 'en-GB',
};
const wrod: ProofingFindingView = {
  id: 'b1:9:13:spelling',
  kind: 'spelling',
  message: 'Unknown word',
  text: 'wrod',
  suggestions: ['word'],
  scope: 'body',
  lang: 'en-GB',
};

const status = (atCaret: ProofingFindingView | null): ProofingStatus => ({
  available: true,
  state: 'idle',
  count: 2,
  dictionary: false,
  current: null,
  atCaret,
});

/** Appends a marked word to the fake surface's paragraph, as the engine draws a finding. */
async function mark(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, text }) => {
      const root = document.getElementById('host')!.shadowRoot!;
      const p = root.querySelector('.de-editing-surface p')!;
      const span = document.createElement('span');
      span.dataset['deFinding'] = id;
      span.dataset['mark'] = text;
      span.textContent = text;
      p.append(' ', span);
    },
    { id, text },
  );
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Commands for the selection' });

test.describe('a context click on a proofing mark (UX-008 criterion 5)', () => {
  test('lists the suggestions of the finding that was clicked, not of the one at the caret', async ({
    page,
  }) => {
    // The caret is in `wrod`; the click lands on the mark of `teh`.
    const h = await open(page, {
      extended: true,
      proofing: { status: status(wrod), findings: [teh, wrod] },
    });
    await mark(page, teh.id, 'teh');
    await page.locator('[data-mark="teh"]').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('[data-finding-action]')).toHaveText([
      'Change to the',
      'Change to tea',
      'Ignore once',
      'Ignore all',
    ]);
    await menu(page).locator('[data-finding-action="apply"]').first().click();
    await expect(menu(page)).toHaveCount(0);
    expect(await h.proofingCalls()).toEqual([`apply:${teh.id}:0`]);
  });

  test('a click beside the mark lists no finding, although the caret is in one', async ({
    page,
  }) => {
    await open(page, {
      extended: true,
      proofing: { status: status(teh), findings: [teh, wrod] },
    });
    await mark(page, teh.id, 'teh');
    await page
      .locator('.de-editing-surface p')
      .click({ button: 'right', position: { x: 6, y: 6 } });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('[data-finding-action]')).toHaveCount(0);
    await expect(menu(page).locator('[data-menu-item]').first()).toBeVisible();
  });

  test('a mark whose finding is no longer shown lists no finding', async ({ page }) => {
    await open(page, {
      extended: true,
      proofing: { status: status(null), findings: [wrod] },
    });
    // The mark outlived its finding (the text changed under it and the port has not answered yet).
    await mark(page, teh.id, 'teh');
    await page.locator('[data-mark="teh"]').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('[data-finding-action]')).toHaveCount(0);
  });
});
