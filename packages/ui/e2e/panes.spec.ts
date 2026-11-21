/**
 * The pane host and its panes (UX-019, UX-070; 13 §3, §9): panes known, offered only with their
 * data, loaded on demand with a loading state announced, focus in and back, never over the text.
 * The navigation pane (UX-020), the styles pane (UX-022) and recovered edits (UX-017).
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

test.describe('the pane host (UX-019, UX-070)', () => {
  test('requests a pane’s code only when it first opens, and announces the loading', async ({
    page,
  }) => {
    const chunks: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/assets/')) chunks.push(path);
    });
    const h = await open(page, { extended: true, styles: STYLES });
    const panes = [
      'OutlinePane',
      'StylesPane',
      'RecoveredPane',
      'ShortcutsPane',
      'PermissionsPane',
      'FillPane',
    ];
    for (const name of panes)
      expect(
        chunks.filter((c) => c.includes(name)),
        name,
      ).toEqual([]);
    expect(await h.exec('view.styles')).toEqual({ ran: true, reason: null });
    await expect(page.locator('.de-pane[data-pane="styles"]')).toBeVisible();
    expect(chunks.filter((c) => c.includes('StylesPane'))).toHaveLength(1);
    expect(chunks.filter((c) => c.includes('RecoveredPane'))).toEqual([]);
    expect(await h.state('view.styles')).toMatchObject({ active: true });
    // Every pane of 13 §3 is known; those without content or port are not offered. The comments
    // pane has its content since UX-030, so its command is registered, and it is not offered while
    // the backend has not announced the feature.
    expect(await h.state('view.comments')).toMatchObject({
      offered: false,
      enabled: false,
      reason: 'unannounced',
    });
  });

  test('a network trace shows no pane code at start, and each pane as its own chunk on first open (UX-070)', async ({
    page,
  }) => {
    // Every request of the page from the first navigation, as the browser sends it.
    const trace: string[] = [];
    page.on('request', (r) => trace.push(new URL(r.url()).pathname));
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      regions: [{ id: 'r1', title: 'Terms', policy: 'restricted', order: 0, state: 'draft' }],
      grants: [],
      fill: {
        active: true,
        inactive: null,
        fields: [{ id: 'f1', label: 'Name', required: true, filled: false, invalid: null }],
      },
    });
    await h.setAside([{ id: 'i1', reason: 'rebase', commit: null, text: 'My words', seq: 4 }]);
    await h.frames(2);
    const PANES = [
      'OutlinePane',
      'StylesPane',
      'PermissionsPane',
      'RecoveredPane',
      'ShortcutsPane',
      'FillPane',
    ];
    const chunks = () => trace.filter((p) => p.startsWith('/assets/') && p.endsWith('.js'));
    // The editor has started: its code is loaded and none of it is a pane's.
    expect(chunks().length).toBeGreaterThan(0);
    for (const name of PANES)
      expect(
        chunks().filter((c) => c.includes(name)),
        name,
      ).toEqual([]);
    const opened: Record<string, string> = {};
    const openPane = async (name: string, id: string, run: () => Promise<unknown>) => {
      const before = chunks().length;
      await run();
      await expect(page.locator(`.de-pane[data-pane="${id}"]`)).toBeVisible();
      const added = chunks().slice(before);
      // Exactly one new chunk, and it is this pane's own (no other pane's code comes with it).
      expect(added, name).toHaveLength(1);
      expect(added[0], name).toMatch(new RegExp(`^/assets/${name}-[\\w-]+\\.js$`));
      opened[name] = added[0]!;
    };
    await openPane('OutlinePane', 'outline', () => h.exec('view.outline'));
    await openPane('StylesPane', 'styles', () => h.exec('view.styles'));
    await openPane('PermissionsPane', 'permissions', () => h.exec('view.permissions'));
    await openPane('RecoveredPane', 'recovered', () => h.exec('view.recovered'));
    await openPane('ShortcutsPane', 'shortcuts', () => h.exec('view.shortcuts'));
    await openPane('FillPane', 'fill', () =>
      page
        .getByRole('region', { name: 'Filling in' })
        .getByRole('button', { name: 'What is left' })
        .click(),
    );
    expect(new Set(Object.values(opened)).size).toBe(PANES.length);
    // A pane opened again is not requested again.
    const before = chunks().length;
    await h.exec('view.styles');
    await expect(page.locator('.de-pane[data-pane="styles"]')).toBeVisible();
    expect(chunks().slice(before)).toEqual([]);
  });

  test('moves focus into the pane, and back where it was when it closes', async ({ page }) => {
    const h = await open(page, { extended: true, styles: STYLES, toolbar: 'full' });
    await page.getByRole('tab', { name: 'View', exact: true }).click();
    const toolbarButton = page.locator('.de-toolbar [data-command-id="view.styles"]');
    await toolbarButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.de-pane[data-pane="styles"]')).toBeVisible();
    expect((await focused(page)).inside).toBe('pane');
    await page.keyboard.press('Escape');
    await expect(page.locator('.de-pane')).toHaveCount(0);
    await expect(toolbarButton).toBeFocused();
    // Opened from the text, it gives focus back to the text; the close button does the same.
    await focusSurface(page);
    await h.exec('view.shortcuts');
    await expect(page.locator('.de-pane[data-pane="shortcuts"]')).toBeVisible();
    await page.getByRole('button', { name: 'Close Keyboard shortcuts' }).click();
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('offers no pane whose data the core does not offer', async ({ page }) => {
    const h = await open(page);
    expect(await h.commandIds()).not.toContain('view.styles');
    expect(await h.commandIds()).not.toContain('view.permissions');
    expect(await h.exec('view.styles')).toEqual({ ran: false, reason: 'unknown' });
  });

  test('never covers the text in a narrow container, and exposes the sidebar part', async ({
    page,
  }) => {
    const h = await open(page, { width: 420 });
    await focusSurface(page);
    await h.exec('view.outline');
    const pane = page.locator('.de-pane');
    await expect(pane).toBeVisible();
    const p = (await pane.boundingBox())!;
    const s = (await page.locator('.de-editing-surface').boundingBox())!;
    const overlap = !(
      p.x >= s.x + s.width ||
      p.x + p.width <= s.x ||
      p.y >= s.y + s.height ||
      p.y + p.height <= s.y
    );
    expect(overlap).toBe(false);
    expect(await pane.getAttribute('part')).toBe('sidebar');
  });
});

test.describe('the navigation pane (UX-020)', () => {
  test('lists the headings as a tree with levels, and goes to the one chosen', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    const tree = page.getByRole('tree', { name: 'Headings' });
    await expect(tree.getByRole('treeitem')).toHaveText(['Scope', 'Terms', 'Payment', 'Annex']);
    const levels = await tree
      .getByRole('treeitem')
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute('aria-level'), e.getAttribute('aria-expanded')]),
      );
    expect(levels).toEqual([
      ['1', 'true'],
      ['2', null],
      ['2', null],
      ['1', null],
    ]);
    await tree.getByRole('treeitem', { name: 'Scope' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: 'Terms' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await h.callsOf('selectBlock')).toEqual([['h2']]);
    // Collapsing hides the children; Left goes to the parent first.
    await page.keyboard.press('ArrowLeft');
    await expect(tree.getByRole('treeitem', { name: 'Scope' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tree.getByRole('treeitem')).toHaveText(['Scope', 'Annex']);
    await page.keyboard.press('ArrowRight');
    await expect(tree.getByRole('treeitem')).toHaveCount(4);
  });

  test('updates without losing the author’s place', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    const tree = page.getByRole('tree', { name: 'Headings' });
    await tree.getByRole('treeitem', { name: 'Payment' }).click();
    await tree.getByRole('treeitem', { name: 'Payment' }).focus();
    await h.setOutline([
      { id: 'h0', level: 1, text: 'Preamble' },
      { id: 'h1', level: 1, text: 'Scope' },
      { id: 'h2', level: 2, text: 'Terms and conditions' },
      { id: 'h3', level: 2, text: 'Payment' },
    ]);
    await expect(tree.getByRole('treeitem')).toHaveText([
      'Preamble',
      'Scope',
      'Terms and conditions',
      'Payment',
    ]);
    await expect(tree.getByRole('treeitem', { name: 'Payment' })).toBeFocused();
  });

  test('searches what the reader holds, lists results with a count, and goes to one', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await h.exec('view.find');
    const field = page.getByRole('searchbox', { name: 'Search for' });
    await expect(field).toBeFocused();
    await field.fill('te');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-status="search"]')).toHaveText('3 results');
    const results = page.getByRole('list', { name: 'Results' }).getByRole('button');
    await expect(results).toHaveCount(3);
    await results.nth(2).click();
    expect(await h.callsOf('selectMatch')).toEqual([[2]]);
    await field.fill('nothing here');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-status="search"]')).toHaveText('No results');
  });
});

test.describe('the styles pane (UX-022)', () => {
  test('lists the styles by kind, marks the one at the caret, and applies the one chosen', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      selection: { style: 'Normal', styleId: 'Normal' },
    });
    await h.exec('view.styles');
    const pane = page.locator('.de-pane[data-pane="styles"]');
    await expect(pane.getByRole('heading')).toContainText([
      'Paragraph style',
      'Character style',
      'Table style',
    ]);
    const normal = pane.getByRole('button', { name: /^Normal/ });
    await expect(normal).toHaveAttribute('aria-current', 'true');
    await expect(normal).toContainText('In use at the cursor');
    await pane.getByRole('button', { name: 'Heading 1' }).click();
    expect(await h.named()).toEqual([['paragraphStyle', { style: 'Heading1' }]]);
    await expect(pane.getByRole('button', { name: /^Heading 1/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // Keyboard: every style is reachable and named.
    await pane.getByRole('button', { name: 'Strong' }).focus();
    await page.keyboard.press('Enter');
    expect((await h.named()).at(-1)).toEqual(['characterStyle', { style: 'Strong' }]);
  });

  test('a user who may edit only a region applies an existing style there', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      styles: STYLES,
      access: { scope: 'region:r1', caps: ['view', 'comment', 'suggest', 'edit'], limit: null },
      permissions: {
        rev: 2,
        docRole: 'viewer',
        caps: ['view'],
        scopes: { body: ['view'], 'region:r1': ['view', 'comment', 'suggest', 'edit'] },
      },
    });
    await h.exec('view.styles');
    await page.locator('.de-pane').getByRole('button', { name: 'Heading 1' }).click();
    expect(await h.named()).toEqual([['paragraphStyle', { style: 'Heading1' }]]);
    // Outside the region the same command is disabled, with the reason.
    await h.moveTo({ scope: 'body', caps: ['view'], limit: 'role' }, { scope: 'body' });
    await h.frames(2);
    const heading = page.locator('.de-pane').getByRole('button', { name: 'Heading 1' });
    await expect(heading).toHaveAttribute('aria-disabled', 'true');
    await heading.click({ force: true });
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'You can view this part of the document but not change it.',
    );
  });
});

test.describe('recovered edits (UX-017)', () => {
  const ITEMS = [
    {
      id: 'i1',
      reason: 'permission_denied',
      commit: 'c1',
      text: 'My words',
      seq: 4,
      scope: 'region:r1',
      changedBy: 'u2',
    },
    { id: 'i2', reason: 'rebase', commit: null, text: 'More words', seq: 5 },
  ];

  test('lists what was set aside with the reason, the region and who changed the permission', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: [{ id: 'r1', title: 'Terms', policy: 'restricted', order: 0, state: 'draft' }],
    });
    await h.setAside(ITEMS);
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      /2 changes could not be saved/,
    );
    await h.exec('view.recovered');
    const pane = page.locator('.de-pane[data-pane="recovered"]');
    const first = pane.locator('[data-item="i1"]');
    await expect(first).toContainText('Not saved: your permissions changed');
    await expect(first).toContainText('Region: Terms');
    await expect(first).toContainText('Permission changed by Grace Hopper');
    await expect(first.locator('blockquote')).toHaveText('My words');
    await expect(pane.locator('[data-item="i2"]')).toContainText('could not be combined');
  });

  test('inserts at the caret through the guards, and discards only on a second, deliberate step', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await h.setAside(ITEMS);
    await h.exec('view.recovered');
    const pane = page.locator('.de-pane[data-pane="recovered"]');
    await pane
      .locator('[data-item="i1"]')
      .getByRole('button', { name: 'Insert at the cursor' })
      .click();
    expect(await h.named()).toEqual([['insertRecovered', { id: 'i1' }]]);
    await expect(pane.locator('[data-item="i1"]')).toHaveCount(0);
    const second = pane.locator('[data-item="i2"]');
    await second.getByRole('button', { name: 'Discard' }).click();
    await expect(second).toContainText('Discard this text for good?');
    await expect(second.getByRole('button', { name: 'Discard for good' })).toBeFocused();
    await second.getByRole('button', { name: 'Keep it' }).click();
    await expect(second).toBeVisible();
    await second.getByRole('button', { name: 'Discard' }).click();
    await second.getByRole('button', { name: 'Discard for good' }).click();
    await expect(pane.locator('[data-item]')).toHaveCount(0);
    await expect(pane).toContainText('Nothing has been set aside.');
    expect((await h.named()).map((n) => n[0])).toEqual(['insertRecovered', 'discardRecovered']);
  });

  test('refuses to insert where the user may not edit, and says why', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      access: { scope: 'body', caps: ['view'], limit: 'role' },
    });
    await h.setAside(ITEMS);
    await h.exec('view.recovered');
    const insert = page
      .locator('[data-item="i1"]')
      .getByRole('button', { name: 'Insert at the cursor' });
    await expect(insert).toHaveAttribute('aria-disabled', 'true');
    await insert.click({ force: true });
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'You can view this part of the document but not change it.',
    );
    expect(await h.named()).toEqual([]);
  });
});
