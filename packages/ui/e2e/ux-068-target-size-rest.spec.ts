/**
 * Pointer target size in the states the earlier files left out (UX-068, criterion 2; lane w3,
 * 2026-11-15): the outline pane, the command search with results listed, the presence list (the
 * header's list and the full list), the mode switcher's menu, the toolbar's overflow menu and the
 * header's commands with their counts. The toolbar's tabs are in ux-068-target-size.spec.ts, the
 * context menu and the export dialog in ux-068-axe-states.spec.ts, and the other panes and dialogs
 * in ux-068-target-size-panes.spec.ts. Every visible, enabled control of the shell root is measured
 * against 24 by 24 CSS pixels (WCAG 2.2, 2.5.8). A radio or checkbox inside its `label.de-check` is
 * measured by the label (docs/adr/0329-lane-V-UX-061-075.md, decision 1, proposed).
 *
 * Run from the repository root with
 * `DOCEDIT_UI_PORT=57462 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-068-target-size-rest`.
 */
import type { Page } from '@playwright/test';
import type { ThreadSummary } from '../src/core-api.ts';
import { expect, open, test } from './helpers.ts';

const PEOPLE = ['u1', 'u2', 'u5', 'u6', 'u7', 'u8', 'u9'].map((user, i) => ({
  session: `s${i}`,
  user,
  status: i % 2 ? ('idle' as const) : ('active' as const),
}));

/** The controls under 24 by 24 CSS pixels inside `within` (the whole shell root when absent). */
async function measure(
  page: Page,
  within?: string,
): Promise<{ measured: number; small: string[] }> {
  return page.evaluate((scope) => {
    const root = document.getElementById('host')!.shadowRoot!;
    const out: string[] = [];
    let measured = 0;
    const selector =
      'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="treeitem"], [role="radio"], [role="checkbox"], [role="link"], summary, select, input:not([type="hidden"]), textarea, a[href]';
    const seen = new Set<Element>();
    const scopes = scope ? [...root.querySelectorAll(scope)] : [root];
    for (const s of scopes) {
      for (const raw of s.querySelectorAll<HTMLElement>(selector)) {
        if (raw.closest('.de-page, [data-content], [hidden]')) continue;
        const el = raw.closest<HTMLElement>('label.de-check') ?? raw;
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.getClientRects().length === 0) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        measured += 1;
        const box = el.getBoundingClientRect();
        if (box.width < 24 || box.height < 24) {
          const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
          out.push(
            `${el.tagName.toLowerCase()}.${el.className} ${Math.round(box.width)}x${Math.round(box.height)} "${name}"`,
          );
        }
      }
    }
    return { measured, small: out };
  }, within ?? null);
}

function expectTargets(
  result: { measured: number; small: string[] },
  state: string,
  min = 1,
): void {
  // An empty state would pass vacuously.
  expect(result.measured, `controls measured in ${state}`).toBeGreaterThanOrEqual(min);
  expect(result.small, `controls under 24 by 24 CSS pixels in ${state}`).toEqual([]);
}

const RANGE = { range: { from: 3, to: 12, baseSeq: 41 } } as const;
const THREADS: ThreadSummary[] = [
  {
    id: 't1',
    position: 30,
    state: 'open',
    author: 'Ada Lovelace',
    createdAt: '2026-11-10T09:15:00.000Z',
    replyCount: 2,
    assignee: 'Grace Hopper',
    target: RANGE,
    excerpt: 'Check this sentence.',
    blockKind: null,
  },
  {
    id: 't3',
    position: 50,
    state: 'open',
    author: 'Alan Turing',
    createdAt: '2026-11-11T16:30:00.000Z',
    replyCount: 1,
    assignee: 'Grace Hopper',
    target: RANGE,
    excerpt: null,
    blockKind: null,
  },
];

test.describe('pointer targets in the remaining shell states (UX-068, criterion 2)', () => {
  test('the comments pane with threads listed', async ({ page }) => {
    const h = await open(page, { extended: true, comments: true, commentsPane: true });
    await h.setThreads(THREADS);
    expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="comments"]');
    await expect(pane.locator('li[data-thread]')).toHaveCount(2);
    expectTargets(await measure(page, '.de-pane[data-pane="comments"]'), 'the comments pane', 2);
    expectTargets(await measure(page), 'the shell with the comments pane');
  });

  test('the history pane with groups and a named version', async ({ page }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    expect(await h.exec('view.history')).toMatchObject({ ran: true });
    const pane = page.locator('.de-pane[data-pane="history"]');
    await expect(pane.locator('[data-history="group"]').first()).toBeVisible();
    expectTargets(await measure(page, '.de-pane[data-pane="history"]'), 'the history pane', 2);
  });

  test('the accessibility checker pane with issues listed', async ({ page }) => {
    const h = await open(page, { extended: true, checker: true });
    await h.exec('view.checker');
    const pane = page.locator('.de-pane[data-pane="checker"]');
    await expect(pane.locator('li.de-checker-item').first()).toBeVisible();
    expectTargets(await measure(page, '.de-pane[data-pane="checker"]'), 'the checker pane', 2);
  });

  test('the outline pane', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    await page.locator('.de-outline').waitFor();
    expectTargets(await measure(page, '.de-pane'), 'the outline pane');
    expectTargets(await measure(page), 'the shell with the outline pane');
  });

  test('the command search with results listed', async ({ page }) => {
    await open(page, { extended: true });
    await page.locator('.de-editing-surface').focus();
    await page.keyboard.press('Alt+q');
    await expect(page.getByRole('combobox', { name: 'Command name' })).toBeFocused();
    await page.keyboard.type('a');
    const options = page.getByRole('listbox').locator('[role="option"]');
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThan(1);
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const small: string[] = [];
      const els = [
        ...root.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]'),
        ...root.querySelectorAll<HTMLElement>('[role="combobox"]'),
      ];
      for (const el of els) {
        const b = el.getBoundingClientRect();
        if (b.width < 24 || b.height < 24)
          small.push(`${el.getAttribute('role')} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return { measured: els.length, small };
    });
    expectTargets(result, 'the command search', 3);
  });

  test('the presence list, the full list and the header commands with counts', async ({ page }) => {
    await open(page, {
      // Narrow enough that seven people never fit beside the title in any font: the header's commands
      // wrap onto a row of their own in wide fonts, which leaves the presence the whole row at 640.
      width: 420,
      features: ['presence', 'comments', 'history'],
      headerPanes: true,
      share: true,
      counts: { comments: 4, catchUp: 2 },
      presence: PEOPLE,
    });
    await expect(page.locator('.de-presence-more')).toBeVisible();
    expectTargets(await measure(page, '.de-header'), 'the header with presence', 3);
    await page.locator('.de-presence-more').click();
    await expect(page.getByRole('list', { name: 'Everyone in this document' })).toBeVisible();
    expectTargets(await measure(page, '.de-header'), 'the header with the full presence list', 3);
    expectTargets(await measure(page), 'the shell with the full presence list', 3);
  });

  test('the mode switcher menu', async ({ page }) => {
    await open(page, { extended: true });
    await page.locator('.de-mode-button').click();
    const items = page.locator('.de-modes-menu [role="menuitemradio"]');
    await expect(items.first()).toBeVisible();
    expectTargets(await measure(page, '.de-modes'), 'the mode switcher', 3);
  });

  test('the overflow menu of a narrow toolbar', async ({ page }) => {
    await open(page, { width: 420 });
    await page.locator('.de-more').click();
    await expect(page.getByRole('menu')).toBeVisible();
    const result = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const menu = root.querySelector('[role="menu"]')!;
      const small: string[] = [];
      const els = [
        ...menu.querySelectorAll<HTMLElement>(
          'button, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], select',
        ),
      ].filter((el) => el.getClientRects().length > 0);
      for (const el of els) {
        const b = el.getBoundingClientRect();
        if (b.width < 24 || b.height < 24)
          small.push(`${el.tagName} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return { measured: els.length, small };
    });
    expectTargets(result, 'the overflow menu', 2);
    expectTargets(await measure(page), 'the narrow shell with the overflow menu');
  });
});
