/**
 * FE-104 criterion 5, the panes the embed page of the element does not offer (lane w1): the
 * comments, styles, accessibility checker and history panes, opened on the shell harness (the
 * real shell over the harness's stand-in ports) through their commands. Every visible
 * pointer-operated control of each pane is at least 24 by 24 CSS pixels in its bounding box
 * (WCAG 2.2 criterion 2.5.8; the spacing exception is not used). The other panes are measured in
 * packages/element/e2e/fe-104-target-size-panes.spec.ts. The harness's ports hold a few items each,
 * so a control that only appears with many items, or with data the harness does not have, is not
 * measured here.
 *
 * Run from the repository root with
 * `DOCEDIT_UI_PORT=57176 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/fe-104-target-size-panes.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="combobox"], [role="switch"], [role="option"], input, select, textarea, a[href]';

interface Small {
  label: string;
  width: number;
  height: number;
}

function measurePane(page: Page): Promise<{ count: number; small: Small[] }> {
  return page.evaluate((selector) => {
    const pane = document.getElementById('host')!.shadowRoot!.querySelector('.de-pane');
    if (!pane) return { count: 0, small: [] };
    const found = [...pane.querySelectorAll(selector)]
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label =
          el.getAttribute('aria-label') ??
          el.getAttribute('title') ??
          el.textContent?.trim() ??
          el.tagName;
        return {
          label: `${el.tagName.toLowerCase()} ${label.slice(0, 40)}`,
          width: rect.width,
          height: rect.height,
        };
      });
    return { count: found.length, small: found.filter((t) => t.width < 24 || t.height < 24) };
  }, SELECTOR);
}

const PANES: Array<{ id: string; command: string }> = [
  { id: 'comments', command: 'view.comments' },
  { id: 'styles', command: 'view.styles' },
  { id: 'checker', command: 'view.checker' },
  { id: 'history', command: 'view.history' },
];

test('FE-104: the comments, styles, checker and history panes have no pointer control under 24 by 24', async ({
  page,
}) => {
  const h = await open(page, {
    extended: true,
    comments: true,
    checker: true,
    history: 'full',
    features: ['history', 'comments'],
    people: 'host',
    styles: [
      { id: 'Normal', name: 'Normal', kind: 'paragraph' },
      { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' },
    ] as never,
  });
  const measured: Record<string, { count: number; small: Small[] }> = {};
  for (const pane of PANES) {
    const ran = await h.exec(pane.command);
    expect(ran, pane.command).toEqual({ ran: true, reason: null });
    await expect(page.locator(`.de-pane[data-pane="${pane.id}"]`)).toBeVisible();
    await page.waitForTimeout(300);
    measured[pane.id] = await measurePane(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.de-pane')).toHaveCount(0);
  }
  for (const [id, m] of Object.entries(measured)) {
    expect(m.count, `${id} has controls`).toBeGreaterThan(0);
    expect(m.small, `${id}: controls under 24 by 24`).toEqual([]);
  }
  console.log(
    'MEASURED',
    JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.count]))),
  );
});

test('FE-104: the comment, region and export dialogs and the mini toolbar have no pointer control under 24 by 24', async ({
  page,
}) => {
  const h = await open(page, {
    extended: true,
    comments: true,
    features: ['exports'],
    selection: { empty: false },
  });
  const measureIn = (selector: string): Promise<{ count: number; small: Small[] }> =>
    page.evaluate(
      ({ selector, controls }) => {
        const root = document.getElementById('host')!.shadowRoot!;
        const scope = root.querySelector(selector);
        if (!scope) return { count: 0, small: [] };
        const found = [...scope.querySelectorAll(controls)]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return (
              getComputedStyle(el).visibility !== 'hidden' && rect.width > 0 && rect.height > 0
            );
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              label: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`,
              width: rect.width,
              height: rect.height,
            };
          });
        return { count: found.length, small: found.filter((t) => t.width < 24 || t.height < 24) };
      },
      { selector, controls: SELECTOR },
    );
  const measured: Record<string, { count: number; small: Small[] }> = {};
  for (const [name, command, selector] of [
    ['comment dialog', 'review.comment', '[data-dialog="comment"]'],
    ['region dialog', 'insert.region', '[data-dialog="region"]'],
    ['export dialog', 'document.export', '[data-dialog="export"]'],
  ] as const) {
    const ran = await h.exec(command);
    expect(ran, command).toEqual({ ran: true, reason: null });
    await expect(page.locator(selector)).toBeVisible();
    measured[name] = await measureIn(selector);
    await page.keyboard.press('Escape');
    await expect(page.locator(selector)).toHaveCount(0);
  }
  await page.locator('.de-editing-surface').focus();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.de-mini-toolbar')).toBeVisible();
  measured['mini toolbar'] = await measureIn('.de-mini-toolbar');
  for (const [id, m] of Object.entries(measured)) {
    expect(m.count, `${id} has controls`).toBeGreaterThan(0);
    expect(m.small, `${id}: controls under 24 by 24`).toEqual([]);
  }
  console.log(
    'MEASURED2',
    JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.count]))),
  );
});

test('FE-104: the header and footnote panel has no pointer control under 24 by 24', async ({
  page,
}) => {
  const h = await open(page, { extended: true, headerPanes: true });
  expect(await h.exec('page.header')).toEqual({ ran: true, reason: null });
  await expect(page.locator('.de-panel')).toBeVisible();
  const sizes = await page.locator('.de-panel button').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent?.trim() ?? '', width: r.width, height: r.height };
    }),
  );
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.filter((t) => t.width < 24 || t.height < 24)).toEqual([]);
});
