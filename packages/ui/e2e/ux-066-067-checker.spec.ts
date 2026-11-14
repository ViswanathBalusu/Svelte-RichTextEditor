/**
 * The accessibility checker pane (UX-066 criteria 2 and 7; UX-067 criteria 1, 3 and 4). The pane
 * lists the issues of the document the core holds, grouped by kind, each with its block and why;
 * it marks the issues this reader may not fix; it moves to a block through the core; a change
 * updates the list. Run by lane V-UX-061-075 in Chromium, Firefox and WebKit.
 */
import { axe, expect, open, test } from './helpers.ts';

const PERMISSIONS = {
  rev: 1,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { 'region:rLegal': ['view', 'comment'] },
};

const REGIONS = [
  {
    id: 'rLegal',
    title: 'Legal review',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
  },
];

/** One issue of each kind; the figure in region rLegal is one this reader may not change. */
const EXPECTED = [
  { kind: 'alt-text', block: 'fNoAlt' },
  { kind: 'alt-text', block: 'fLegal' },
  { kind: 'heading-order', block: 'hTooDeep' },
  { kind: 'table-header', block: 'tNoHeader' },
  { kind: 'link-text', block: 'pLink' },
  { kind: 'contrast', block: 'pNavy' },
];

test.describe('the accessibility checker pane (UX-066, UX-067)', () => {
  test('its code is requested only when it first opens (UX-066 criterion 7)', async ({ page }) => {
    const trace: string[] = [];
    page.on('request', (r) => trace.push(new URL(r.url()).pathname));
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: PERMISSIONS,
      regions: REGIONS,
    });
    const chunks = () => trace.filter((p) => p.startsWith('/assets/') && p.endsWith('.js'));
    expect(chunks().filter((c) => c.includes('CheckerPane'))).toEqual([]);
    const before = chunks().length;
    await h.exec('view.checker');
    await expect(page.locator('.de-pane[data-pane="checker"]')).toBeVisible();
    const added = chunks().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^\/assets\/CheckerPane-[\w-]+\.js$/);
  });

  test('lists each issue with its kind, block and explanation, grouped by kind (UX-066 criterion 2)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: PERMISSIONS,
      regions: REGIONS,
    });
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    await expect(pane.locator('[data-status="count"]')).toHaveText('6 accessibility issues found.');
    const items = pane.locator('li.de-checker-item');
    await expect(items).toHaveCount(EXPECTED.length);
    for (const [i, e] of EXPECTED.entries()) {
      const item = items.nth(i);
      await expect(item).toHaveAttribute('data-kind', e.kind);
      await expect(item).toHaveAttribute('data-block', e.block);
      await expect(item.locator('.de-checker-where')).toContainText(e.block);
      await expect(item.locator('.de-checker-why')).not.toHaveText('');
    }
    // Grouped: one heading per kind that has issues, in the checker's order.
    const kinds = await pane
      .locator('h3.de-checker-kind')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')));
    expect(kinds).toEqual(['alt-text', 'heading-order', 'table-header', 'link-text', 'contrast']);
    await expect(items.nth(2).locator('.de-checker-why')).toHaveText(
      'A level 1 heading is followed by a level 3 heading.',
    );
    await expect(items.nth(4).locator('.de-checker-why')).toHaveText(
      'The link text is generic, such as "click here".',
    );
  });

  test('marks what this reader cannot fix, with who can fix it (UX-067 criterion 3)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: PERMISSIONS,
      regions: REGIONS,
    });
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    await expect(pane.locator('li[data-block="fNoAlt"] [data-fixable="true"]')).toHaveText(
      'You can fix this here.',
    );
    const locked = pane.locator('li[data-block="fLegal"] [data-fixable="false"]');
    await expect(locked).toContainText('You cannot fix this.');
    // The words name who can fix it (the region lock indicator's sentence), not an empty mark.
    expect((await locked.textContent())!.length).toBeGreaterThan('You cannot fix this.'.length);
  });

  test('moves to the block of an issue through the core (UX-067 criterion 1, the core selects)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: PERMISSIONS,
      regions: REGIONS,
    });
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    await pane.locator('li[data-block="pNavy"] button').click();
    expect(await h.checkerSelected()).toEqual(['pNavy']);
    await expect(pane.locator('li[data-block="pNavy"] button')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('re-evaluates after a change: the issue goes and the count is announced (UX-067 criterion 4)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: PERMISSIONS,
      regions: REGIONS,
    });
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    await expect(pane.locator('li[data-block="fNoAlt"]')).toHaveCount(1);
    await h.editChecker(true);
    await expect(pane.locator('li[data-block="fNoAlt"]')).toHaveCount(0);
    await expect(pane.locator('[data-status="count"]')).toHaveText('5 accessibility issues found.');
    await expect(pane.locator('[role="status"][data-status="count"]')).toHaveCount(1);
  });

  test('has no axe violation with the issues listed (UX-068 criterion 1, the checker pane)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: PERMISSIONS,
      regions: REGIONS,
    });
    await h.exec('view.checker');
    await expect(
      page.locator('.de-pane[data-pane="checker"] li.de-checker-item').first(),
    ).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
