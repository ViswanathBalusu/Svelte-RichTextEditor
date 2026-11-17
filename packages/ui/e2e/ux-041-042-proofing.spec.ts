/**
 * Spelling and grammar in the shell (UX-041 criteria 4, 5 and 6; UX-042 criteria 1 and 3). The
 * harness core carries a fake proofing state (`proofing`), so what is tested is the shell: the
 * quiet status item, the two commands that exist only with a port, the sentence a screen reader
 * hears, and the finding's context menu. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-041-042-proofing.spec.ts`.
 */
import type { Page } from '@playwright/test';
import type { ProofingFindingView, ProofingStatus } from '../src/core-api.ts';
import { axe, expect, focused, focusSurface, open, test } from './helpers.ts';

const teh: ProofingFindingView = {
  id: 'b1:0:3:spelling',
  kind: 'spelling',
  message: 'Unknown word',
  text: 'teh',
  suggestions: ['the', 'tea'],
  scope: 'body',
  lang: 'en-GB',
};
const clause: ProofingFindingView = {
  id: 'b2:4:9:grammar',
  kind: 'grammar',
  message: 'Subject and verb do not agree',
  text: 'they is',
  suggestions: [],
  scope: 'body',
  lang: 'en-GB',
};

const idle = (over: Partial<ProofingStatus> = {}): ProofingStatus => ({
  available: true,
  state: 'idle',
  count: 2,
  dictionary: true,
  current: null,
  atCaret: null,
  ...over,
});

test.describe('no proofing port (UX-041 criterion 5)', () => {
  test('shows no proofing item and offers no proofing command', async ({ page }) => {
    const h = await open(page, { extended: true });
    await expect(page.locator('[data-status="proofing"]')).toHaveCount(0);
    expect((await h.state('proofing.next')).offered).toBe(false);
    expect((await h.state('proofing.previous')).offered).toBe(false);
    expect(await h.commandIds()).not.toContain('proofing.next');
  });

  test('a port that leaves again takes the item and the commands with it', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      proofing: { status: idle(), findings: [teh] },
    });
    await expect(page.locator('[data-status="proofing"]')).toBeVisible();
    expect((await h.state('proofing.next')).offered).toBe(true);
    await h.setProofing({ ...idle(), available: false });
    await expect(page.locator('[data-status="proofing"]')).toHaveCount(0);
    expect((await h.state('proofing.next')).offered).toBe(false);
  });
});

test.describe('the quiet proofing state (UX-041 criterion 4)', () => {
  test('says checking, not available, or the count, as text, and never takes focus', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      proofing: { status: idle({ state: 'checking', count: 0 }), findings: [] },
    });
    const item = page.locator('[data-status="proofing"]');
    await expect(item).toHaveText('Checking spelling and grammar');
    await h.setProofing(idle({ state: 'unavailable', count: 0 }));
    await expect(item).toHaveText('Spelling and grammar check is not available');
    await expect(item).toHaveAttribute('data-state', 'unavailable');
    await h.setProofing(idle({ count: 1 }));
    await expect(item).toHaveText('1 spelling or grammar issue');
    await h.setProofing(idle({ count: 0 }));
    await expect(item).toHaveText('No spelling or grammar issues');
    expect((await focused(page)).inside).not.toBe('status');
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('moving between findings (UX-041 criterion 6)', () => {
  test('Alt+F7 and Alt+Shift+F7 move between findings and say kind, text, message and suggestions', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      proofing: { status: idle(), findings: [teh, clause] },
    });
    await focusSurface(page);
    const live = page.locator('.de-visually-hidden[role="status"]');
    await page.keyboard.press('Alt+F7');
    await expect(live).toHaveText('Spelling: teh. Unknown word Suggestions: the, tea.');
    await page.keyboard.press('Alt+F7');
    await expect(live).toHaveText(
      'Grammar: they is. Subject and verb do not agree No suggestions.',
    );
    await page.keyboard.press('Alt+Shift+F7');
    await expect(live).toHaveText('Spelling: teh. Unknown word Suggestions: the, tea.');
    expect(await h.proofingCalls()).toEqual(['step:1', 'step:1', 'step:-1']);
  });

  test('says so when there is no finding to move to', async ({ page }) => {
    await open(page, {
      extended: true,
      proofing: { status: idle({ count: 0 }), findings: [] },
    });
    await focusSurface(page);
    await page.keyboard.press('Alt+F7');
    await expect(page.locator('.de-visually-hidden[role="status"]')).toHaveText(
      'No spelling or grammar issues to move to',
    );
  });
});

test.describe('acting on a finding (UX-042 criteria 1 and 3)', () => {
  async function menuOn(page: Page, status: Partial<ProofingStatus>, access?: string[]) {
    const h = await open(page, {
      extended: true,
      ...(access ? { access: { scope: 'body', caps: access as never } } : {}),
      proofing: { status: idle({ atCaret: teh, current: teh, ...status }), findings: [teh] },
    });
    await focusSurface(page);
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Commands for the selection' });
    await expect(menu).toBeVisible();
    return { h, menu };
  }

  test('the menu on a finding lists each suggestion and the other actions first, and runs them from the keyboard', async ({
    page,
  }) => {
    const { h, menu } = await menuOn(page, {});
    const actions = menu.locator('[data-finding-action]');
    await expect(actions).toHaveText([
      'Change to the',
      'Change to tea',
      'Ignore once',
      'Ignore all',
      'Add to dictionary',
    ]);
    // Focus starts on the first item, and arrows move through the finding's items and then the commands.
    expect((await focused(page)).className).toContain('de-menu-item');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    expect(await h.proofingCalls()).toEqual([`apply:${teh.id}:1`]);
    expect(await axe(page)).toEqual([]);
  });

  test('ignore once, ignore all and add to dictionary reach the core', async ({ page }) => {
    const { h, menu } = await menuOn(page, {});
    await menu.locator('[data-finding-action="ignore-once"]').click();
    await page.keyboard.press('Shift+F10');
    await page.locator('[data-finding-action="ignore-everywhere"]').click();
    await page.keyboard.press('Shift+F10');
    await page.locator('[data-finding-action="add-to-dictionary"]').click();
    await expect.poll(async () => (await h.proofingCalls()).length).toBe(3);
    expect(await h.proofingCalls()).toEqual([
      `ignore-once:${teh.id}`,
      `ignore-all:${teh.id}`,
      `add-word:${teh.id}`,
    ]);
  });

  test('offers no dictionary action when the port keeps no dictionary', async ({ page }) => {
    const { menu } = await menuOn(page, { dictionary: false });
    await expect(menu.locator('[data-finding-action="add-to-dictionary"]')).toHaveCount(0);
    await expect(menu.locator('[data-finding-action="ignore-once"]')).toHaveCount(1);
  });

  test('offers no apply where the author may not change text', async ({ page }) => {
    const { menu } = await menuOn(page, {}, ['view', 'comment']);
    await expect(menu.locator('[data-finding-action="apply"]')).toHaveCount(0);
    await expect(menu.locator('[data-finding-action="ignore-once"]')).toHaveCount(1);
  });
});
