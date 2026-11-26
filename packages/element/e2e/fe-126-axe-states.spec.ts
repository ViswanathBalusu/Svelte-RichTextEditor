/**
 * FE-126 criterion 1 (lane U-FE-113-128): axe, run through the shadow roots, on named page states of
 * the S1 page. The editing state is the baseline; each other state must report no rule that the
 * baseline does not report, and no rule with more nodes than the baseline (the FE-019 comparison).
 * States covered here: editing, a side panel (footnote), dark theme, forced colours and a
 * right-to-left page (`dir="rtl"`). Not covered yet: dialogs (the shell's dialogs, such as the
 * language dialog of `format.language`, are not on the S1 page; a try to open one from a button
 * named "language" found none) and the other states listed in FE-126. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-126-axe-states.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { handOverAxe } from './axe-results.ts';
import { SPIKE_IDS, openPanel, openS1, record } from './helpers.ts';
import type { Page } from '@playwright/test';

type Summary = Record<string, number>;

/** Violation counts by rule. `pierced` is true when axe checked a node inside a shadow root. */
async function summarise(page: Page): Promise<Summary & { pierced?: boolean }> {
  const results = await new AxeBuilder({ page }).analyze();
  handOverAxe(page, test.info(), results.violations);
  const summary: Summary & { pierced?: boolean } = {};
  for (const v of results.violations) summary[v.id] = v.nodes.length;
  const checked = [...results.passes, ...results.violations, ...results.incomplete];
  summary.pierced = checked.some((rule) =>
    rule.nodes.some((node) => node.target.some((t) => Array.isArray(t))),
  );
  return summary;
}

test('axe finds no rule in a named page state that the editing state does not already report', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'axe is run once per state in Chromium (time budget)');
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  const editing = await summarise(page);
  expect(editing.pierced).toBe(true);

  const states: Record<string, () => Promise<void>> = {
    'side panel (footnote)': async () => {
      await openPanel(page, 'footnote');
    },
    'dark theme': async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
    },
    'forced colours': async () => {
      await page.emulateMedia({ colorScheme: 'light', forcedColors: 'active' });
    },
    'right-to-left page': async () => {
      await page.emulateMedia({ forcedColors: 'none' });
      await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    },
  };

  const observed: Record<string, Summary> = { editing };
  for (const [name, apply] of Object.entries(states)) {
    await apply();
    const now = await summarise(page);
    observed[name] = now;
    expect(now.pierced).toBe(true);
    const rules = Object.keys(now).filter((id) => id !== 'pierced');
    const added = rules.filter((id) => !(id in editing));
    const grew = rules.filter((id) => id in editing && now[id]! > editing[id]!);
    expect({ state: name, added, grew }).toEqual({ state: name, added: [], grew: [] });
  }
  record('fe-126-axe-states', observed);
});
