/**
 * PRO-081 criterion 4 (lane w5): a feature switch in `config` that turns a group off leaves the
 * editor without that group's controls when it loads (owner decision 89 in
 * docs/owner-decisions-2026-11-15.md: comments and suggestions, export and print, history,
 * assistant and proofing).
 *
 * The embed page's mock backend has none of these features, so each test mounts a baseline editor
 * whose backend announces `comments`, `history` and `exports` and has stand-in exports, proofing and
 * assistant ports (e2e/embed-helpers.ts `announce` and `ports`: the stand-ins only exist, which is
 * all the shell asks for before it draws a control). The baseline then shows every group. A second
 * editor, with one switch off, must lack exactly the controls of that group: the buttons of the
 * toolbar and the header (their accessible names), the commands of the "More" menu, and the modes
 * of the mode menu.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-081-feature-switches.spec.ts --retries=0
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

type Group = 'comments' | 'export' | 'history' | 'assistant';

/** What each group's switch must remove: accessible names of buttons, More-menu commands and modes. */
const GONE: Record<Group, { buttons: string[]; menu: string[]; modes: string[] }> = {
  comments: { buttons: ['Comments', 'Review pane'], menu: ['view.review'], modes: ['Reviewing'] },
  export: { buttons: ['Export', 'Print'], menu: ['document.export', 'document.print'], modes: [] },
  history: { buttons: ['Catch up'], menu: [], modes: [] },
  assistant: { buttons: ['Assistant'], menu: ['view.assistant'], modes: [] },
};

const FULL = {
  announce: ['comments', 'history', 'exports'],
  ports: ['exports', 'proofing', 'assistant'] as ('exports' | 'proofing' | 'assistant')[],
};

interface Controls {
  buttons: string[];
  menu: string[];
  modes: string[];
}

/** The controls the shell draws for the editor named `name`. */
async function controls(page: Page, name: string): Promise<Controls> {
  const ed = page.locator(`doc-editor[data-test="${name}"]`);
  await ed.locator('[data-command-id="toolbar.more"]').click();
  const menu = await ed.evaluate((el) =>
    [...el.shadowRoot!.querySelectorAll('[data-menu-item]')].map(
      (m) => m.getAttribute('data-command-id') ?? '',
    ),
  );
  await page.keyboard.press('Escape');
  await ed.locator('button[aria-label^="Mode"]').click();
  const modes = await ed.evaluate((el) =>
    [
      ...el.shadowRoot!.querySelectorAll(
        '[role="menuitemradio"], [role="menuitem"], [role="option"]',
      ),
    ].map((m) => m.textContent?.trim() ?? ''),
  );
  await page.keyboard.press('Escape');
  const buttons = await ed.evaluate((el) =>
    [
      ...el.shadowRoot!.querySelectorAll(
        'header button, [role="toolbar"] button, [part*="header"] button',
      ),
    ]
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '')
      // The overflow button names how many commands it holds, which changes with the others.
      .filter((label) => !label.startsWith('More')),
  );
  return { buttons, menu, modes };
}

test.describe('PRO-081 criterion 4: a switch that is off removes the controls of its group', () => {
  test('the baseline draws the controls of every group', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'on', sub: 'ada', ...FULL });
    const on = await controls(page, 'on');
    for (const g of Object.values(GONE)) {
      for (const b of g.buttons) expect(on.buttons, b).toContain(b);
      for (const m of g.menu) expect(on.menu, m).toContain(m);
      for (const m of g.modes) expect(on.modes, m).toContain(m);
    }
  });

  for (const group of Object.keys(GONE) as Group[]) {
    test(`features.${group} = false: the controls of ${group} are absent and no other control is lost`, async ({
      page,
    }) => {
      await openEmbed(page);
      await mountEditor(page, { name: 'on', sub: 'ada', ...FULL });
      await mountEditor(page, {
        name: 'off',
        sub: 'ada',
        target: 'mount-2',
        ...FULL,
        config: { features: { [group]: false } },
      });
      const on = await controls(page, 'on');
      const off = await controls(page, 'off');
      const want = GONE[group];
      const lost = (a: string[], b: string[]) => a.filter((x) => !b.includes(x)).sort();
      expect(lost(on.buttons, off.buttons)).toEqual([...want.buttons].sort());
      expect(lost(on.menu, off.menu)).toEqual([...want.menu].sort());
      expect(lost(on.modes, off.modes)).toEqual([...want.modes].sort());
      // Nothing appears that the baseline did not have.
      expect(lost(off.buttons, on.buttons)).toEqual([]);
      expect(lost(off.menu, on.menu)).toEqual([]);
      expect(lost(off.modes, on.modes)).toEqual([]);
    });
  }

  test('a value that is not false, and a key that is not a group, leave every control in place', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'on', sub: 'ada', ...FULL });
    await mountEditor(page, {
      name: 'odd',
      sub: 'ada',
      target: 'mount-2',
      ...FULL,
      config: { features: { comments: 'no', export: 0, history: null, other: false } },
    });
    expect(await controls(page, 'odd')).toEqual(await controls(page, 'on'));
  });

  test('all four switches off draw no control of any group', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, {
      name: 'none',
      sub: 'ada',
      ...FULL,
      config: { features: { comments: false, export: false, history: false, assistant: false } },
    });
    const off = await controls(page, 'none');
    for (const g of Object.values(GONE)) {
      for (const b of g.buttons) expect(off.buttons, b).not.toContain(b);
      for (const m of g.menu) expect(off.menu, m).not.toContain(m);
      for (const m of g.modes) expect(off.modes, m).not.toContain(m);
    }
  });
});
