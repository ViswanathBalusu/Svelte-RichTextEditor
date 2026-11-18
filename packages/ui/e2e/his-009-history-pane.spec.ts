/**
 * The history pane in the browser (HIS-009): it opens from the command registry only with the
 * history port, lists groups and named versions with the names the directory gives, shows an
 * erased person as unknown, shows markup as text, narrows with the named-versions filter, explains
 * the restriction for a reader of named versions, shows an error with a retry, and passes axe.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57570 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts his-009-history-pane`.
 */
import { axe, expect, focused, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

test.describe('the history pane (HIS-009)', () => {
  test('is offered from the command registry, and lists groups and named versions with names', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    expect(await h.exec('view.history')).toMatchObject({ ran: true });
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    const group = pane.locator('[data-history="group"]').first();
    await expect(group).toContainText('Ada Lovelace');
    await expect(group).toContainText('3 changes');
    await expect(group).toContainText('2026');
    await expect(pane.locator('[data-history="version"]')).toContainText('Named version');
    expect(await axe(page)).toEqual([]);
  });

  test('shows an erased person as unknown and markup in a name or note as text', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-history="group"]').first()).toContainText('Unknown person');
    const version = pane.locator('[data-history="version"]');
    await expect(version.locator('[data-content]').first()).toContainText('<img');
    await expect(version.locator('[data-content]').nth(1)).toContainText('<b>Before review</b>');
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
  });

  test('narrows to named versions with the keyboard, and shows the active filter', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    const named = pane.getByLabel('Named versions only');
    await named.focus();
    await page.keyboard.press('Space');
    await expect(named).toBeChecked();
    await expect(pane.locator('[data-history="group"]')).toHaveCount(0);
    await expect(pane.locator('[data-filter="named"]')).toHaveText('Named versions');
  });

  test('tells a reader of named versions why the rest is not shown', async ({ page }) => {
    const h = await open(page, { history: 'named', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="named-only"]')).toContainText(
      'You can see named versions only',
    );
    await expect(pane.locator('[data-history="group"]')).toHaveCount(0);
  });

  test('shows an error message with a retry when the history cannot be read', async ({ page }) => {
    const h = await open(page, { history: 'failing', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="error"]')).toContainText(
      'The history could not be loaded.',
    );
    await expect(pane.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('is not offered without the history port', async ({ page }) => {
    const h = await open(page, { features: ['history'], people: 'host' });
    expect(await h.exec('view.history')).toMatchObject({ ran: false });
    await expect(page.locator(PANE)).toHaveCount(0);
  });

  test('narrows by one region, one field and one person, and shows which filters are active (criterion 2)', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    const groups = pane.locator('[data-history="group"]');
    await expect(groups).toHaveCount(2);

    await pane.getByLabel('Region').selectOption('r1');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toContainText('Ada Lovelace');
    await expect(pane.locator('[data-filter="region"]')).toHaveText('Region: Terms');

    await pane.getByLabel('Region').selectOption('');
    await pane.getByLabel('Field').selectOption('f1');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toContainText('Grace Hopper');
    await expect(pane.locator('[data-filter="field"]')).toHaveText('Field: Name');

    await pane.getByLabel('Field').selectOption('');
    await pane.getByLabel('Person').selectOption('u2');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toContainText('Grace Hopper');
    await expect(pane.locator('[data-filter="user"]')).toHaveText('Person: Grace Hopper');
    await expect(pane.locator('[data-history="version"]')).toHaveCount(0);

    // Together: a person and a region that no item shares leave nothing, and both chips show.
    await pane.getByLabel('Region').selectOption('r1');
    await expect(pane.locator('[data-status="empty"]')).toContainText('No history matches');
    await expect(pane.locator('.de-history-chips li')).toHaveCount(2);

    await pane.getByRole('button', { name: 'Clear filters' }).click();
    await expect(groups).toHaveCount(2);
    await expect(pane.locator('.de-history-chips')).toHaveCount(0);
  });

  test('every control is reached with the keyboard with a visible focus, and each group reads its authors and time range (criterion 5)', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-history="group"]')).toHaveCount(2);
    await pane.getByLabel('Named versions only').focus();

    // Tab walks the four filter controls in order, and each shows a focus ring of at least 2 px.
    const reached: string[] = [];
    const rings: Array<{ style: string; width: number }> = [];
    for (let i = 0; i < 4; i++) {
      const at = await focused(page);
      reached.push(at.tag === 'input' ? 'checkbox' : at.tag);
      rings.push(
        await page.evaluate(() => {
          const active = document.getElementById('host')!.shadowRoot!.activeElement!;
          const style = getComputedStyle(active);
          return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        }),
      );
      await page.keyboard.press('Tab');
    }
    expect(reached).toEqual(['checkbox', 'select', 'select', 'select']);
    for (const ring of rings) {
      expect(ring.style).not.toBe('none');
      expect(ring.width).toBeGreaterThanOrEqual(2);
    }

    // The accessibility tree of the list: each group's item carries its time range and its authors
    // as text, and a named version says so in words, not by colour.
    const tree = await pane.locator('ol.de-list').ariaSnapshot();
    expect(tree).toMatch(/\d+ changes/);
    expect(tree).toContain('Authors: Ada Lovelace, Unknown person');
    expect(tree).toContain('Authors: Grace Hopper');
    expect(tree).toMatch(/ to /);
    expect(tree).toContain('Named version');
    expect(tree).toContain('Named by Ada Lovelace');
    // No axe run here: Firefox crashes the page on it after keyboard focus (as noted above); the
    // first test runs axe on the same pane in all three engines.
  });

  test('loads its code on demand, not with the editor (criterion 6)', async ({ page }) => {
    const scripts: Array<Promise<{ url: string; body: string }>> = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/assets/') || !url.pathname.endsWith('.js')) return;
      scripts.push(
        response
          .text()
          .then((body) => ({ url: url.pathname, body }))
          .catch(() => ({ url: url.pathname, body: '' })),
      );
    });
    // A marker only the pane's markup holds: its filter chips.
    const MARKER = 'de-history-chips';
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    const initial = await Promise.all(scripts);
    expect(initial.length).toBeGreaterThan(0);
    for (const script of initial) {
      expect(script.url, 'the pane chunk is not requested at start').not.toMatch(/HistoryPane/);
      expect(script.body.includes(MARKER), `${script.url} carries the pane`).toBe(false);
    }
    const before = scripts.length;

    expect(await h.exec('view.history')).toMatchObject({ ran: true });
    await expect(page.locator(PANE)).toBeVisible();
    const after = await Promise.all(scripts);
    const loaded = after.slice(before);
    // Positive control: the chunk that arrives on opening does hold the marker.
    expect(
      loaded.some((script) => /HistoryPane/.test(script.url) && script.body.includes(MARKER)),
    ).toBe(true);
    // The measurement, on the harness build: the bytes of the initial scripts and of the pane chunk.
    const bytes = (list: Array<{ body: string }>) =>
      list.reduce((sum, script) => sum + new TextEncoder().encode(script.body).length, 0);
    test.info().annotations.push({
      type: 'bytes',
      description: `initial ${bytes(initial)}; history pane chunk ${bytes(loaded.filter((s) => /HistoryPane/.test(s.url)))}`,
    });
  });

  test('says each state in words: loading, empty and error (criterion 7)', async ({ page }) => {
    const slow = await open(page, { history: 'slow', features: ['history'], people: 'host' });
    await slow.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="loading"]')).toHaveText('Loading history.');
    await page.evaluate(() =>
      (window as unknown as { __historyRelease: () => void }).__historyRelease(),
    );
    await expect(pane.locator('[data-status="ready"]')).toHaveCount(1);
    await expect(pane.locator('[data-history="group"]').first()).toBeVisible();

    await page.goto('about:blank');
    const empty = await open(page, { history: 'empty', features: ['history'], people: 'host' });
    await empty.exec('view.history');
    await expect(page.locator(PANE).locator('[data-status="empty"]')).toHaveText(
      'No history matches these filters.',
    );

    await page.goto('about:blank');
    const failing = await open(page, { history: 'failing', features: ['history'], people: 'host' });
    await failing.exec('view.history');
    await expect(page.locator(PANE).locator('[data-status="error"]')).toContainText(
      'The history could not be loaded.',
    );
  });
});
