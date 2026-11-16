/**
 * FE-108 criterion 1 (lane w1): every ID reference the shell shows resolves in its own shadow root,
 * on every surface the shell has, not only on the first screen. The harness mounts the shell in the
 * shadow root of `#host`, as the element does.
 *
 * A recorder in the page watches the shadow root. After every change it reads each
 * `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-activedescendant`,
 * `aria-details`, `aria-errormessage`, `aria-flowto` and `for` in the root and notes whether every
 * ID in it is an element of the same root (`ShadowRoot.getElementById`). The test then opens each
 * surface in turn: every pane the registry offers, the four dialogs, the context menu, command
 * search, the toolbar's overflow menu, the mode switcher, the people list and each tab of the full
 * toolbar. It ends by asserting that the recorder saw references on those surfaces and that none
 * was ever unresolved.
 *
 * Not in the shell, so not here: the properties panel of a field (its own harness page, second
 * test) and controls placed on a page by the painter's overlay (FE-093), whose labels the editor
 * does not build yet.
 *
 * Run with `DOCEDIT_UI_PORT=<free port> pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/fe-108-idrefs-all-surfaces.spec.ts`.
 */
import { type Page, test as plain } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

interface Seen {
  attribute: string;
  id: string;
  owner: string;
  inRoot: boolean;
  inDocument: boolean;
  step: string;
}

interface Recorder {
  step: string;
  seen: Seen[];
  check(): void;
}

/** Starts the recorder on the shadow root of `selector` (or on the document when it has none). */
async function record(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const host = document.querySelector(sel)!;
    const root: ShadowRoot | Document = host.shadowRoot ?? document;
    const attributes = [
      'aria-labelledby',
      'aria-describedby',
      'aria-controls',
      'aria-owns',
      'aria-activedescendant',
      'aria-details',
      'aria-errormessage',
      'aria-flowto',
      'for',
    ];
    const known = new Set<string>();
    const recorder: Recorder = {
      step: 'start',
      seen: [],
      check() {
        for (const el of root.querySelectorAll('*')) {
          for (const attribute of attributes) {
            const value = el.getAttribute(attribute);
            if (value === null) continue;
            if (attribute === 'for' && el.tagName !== 'LABEL' && el.tagName !== 'OUTPUT') continue;
            for (const id of value.split(/\s+/).filter(Boolean)) {
              const inRoot = root.getElementById(id) !== null;
              const key = `${attribute}|${id}|${inRoot}`;
              if (known.has(key)) continue;
              known.add(key);
              const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
              recorder.seen.push({
                attribute,
                id,
                owner: `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`,
                inRoot,
                inDocument: document.getElementById(id) !== null,
                step: recorder.step,
              });
            }
          }
        }
      },
    };
    // Checked in the frame after a change, when the component has finished rendering both ends.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        recorder.check();
      });
    }).observe(root, { subtree: true, childList: true, attributes: true });
    recorder.check();
    (window as unknown as { __idrefs: Recorder }).__idrefs = recorder;
  }, selector);
}

async function step(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    const r = (window as unknown as { __idrefs: Recorder }).__idrefs;
    r.check();
    r.step = n;
  }, name);
}

async function seen(page: Page): Promise<Seen[]> {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = (window as unknown as { __idrefs: Recorder }).__idrefs;
    r.check();
    return r.seen;
  });
}

test.describe('ID references on every surface of the shell (FE-108 criterion 1)', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('no reference on any pane, dialog, menu or toolbar leaves the shadow root', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports', 'history', 'presence', 'fields', 'regions', 'sign', 'rules'],
      exportFilters: true,
      comments: true,
      commentsPane: true,
      checker: true,
      headerPanes: true,
      principals: 'host',
    });
    await record(page, '#host');
    const ids = await h.commandIds();
    const opened: string[] = [];

    // Every pane the registry offers, and the dialogs, through their commands.
    const panes = ids.filter((id) => id.startsWith('view.'));
    const dialogs = ['format.language', 'insert.region', 'review.comment', 'document.export'];
    for (const id of [...panes, ...dialogs.filter((d) => ids.includes(d))]) {
      await focusSurface(page);
      await h.setSelection({ empty: false, marks: [] });
      await step(page, id);
      const result = await h.exec(id);
      await h.frames(3);
      if (result.ran) opened.push(id);
      // Text typed into the surface's first field brings out lists and messages that depend on it.
      const dialog = page.getByRole('dialog');
      if ((await dialog.count()) > 0) {
        await page.keyboard.press('Tab');
        await h.frames(2);
        await page.keyboard.press('Escape');
      } else if (id.startsWith('view.') && result.ran) {
        // The same command closes a pane it opened.
        await h.frames(2);
      }
      await h.frames(2);
    }

    // The context menu.
    await step(page, 'context menu');
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await h.frames(2);
    await page.keyboard.press('Escape');

    // Command search, with a query, moving through the options.
    await step(page, 'command search');
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('a');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await h.frames(2);
    await page.keyboard.press('Escape');

    // The mode switcher.
    await step(page, 'mode switcher');
    const switcher = page.locator('[data-mode-switcher] button, .de-mode-switcher button').first();
    if ((await switcher.count()) > 0) {
      await switcher.click();
      await h.frames(2);
      await page.keyboard.press('Escape');
    }

    // The toolbar's overflow menu, at a width where the row does not fit.
    await step(page, 'toolbar overflow');
    await page.setViewportSize({ width: 700, height: 900 });
    await h.frames(3);
    const more = page.locator('[data-command-id="toolbar.more"]');
    if ((await more.count()) > 0 && (await more.isVisible())) {
      await more.click();
      await h.frames(2);
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 1400, height: 900 });

    // The full toolbar: each tab and its panel.
    await step(page, 'full toolbar');
    await h.setSettings({ toolbar: 'full' });
    await h.frames(3);
    const tabs = page.locator('[role="tab"][data-group]');
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await h.frames(2);
    }

    const all = await seen(page);
    const steps = [...new Set(all.map((s) => s.step))];
    // The references seen, kept with the test's results for the record.
    await test.info().attach('idrefs.json', {
      body: JSON.stringify(all, null, 1),
      contentType: 'application/json',
    });
    test.info().annotations.push({
      type: 'idrefs',
      description: `${all.length} distinct references over ${steps.length} steps; opened ${opened.join(', ')}`,
    });
    // Non-vacuity: panes and dialogs did open, and references were seen on many of the surfaces.
    expect(opened.filter((id) => id.startsWith('view.')).length).toBeGreaterThanOrEqual(5);
    expect(opened.filter((id) => !id.startsWith('view.')).length).toBeGreaterThanOrEqual(2);
    expect(all.length).toBeGreaterThan(20);
    expect(steps.length).toBeGreaterThan(8);
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for'])
      expect(
        all.some((s) => s.attribute === attribute),
        attribute,
      ).toBe(true);
    // The check itself: nothing unresolved, on any surface, at any moment a frame showed.
    expect(all.filter((s) => !s.inRoot)).toEqual([]);
  });

  test('the panes and controls that show references only with data keep them in the root', async ({
    page,
  }) => {
    const access = {
      rev: 3,
      docRole: 'owner',
      caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
      scopes: {
        body: ['view', 'comment', 'suggest', 'edit'],
        'region:r1': ['view', 'comment', 'suggest', 'edit'],
      },
    };
    const regions = [
      {
        id: 'r1',
        title: 'Terms',
        policy: 'restricted' as const,
        order: 0,
        state: 'draft' as const,
        editors: { roles: ['owner'], principals: ['user:u1', 'group:legal'] },
      },
    ];
    const peers = Array.from({ length: 12 }, (_, i) => ({
      session: `s${i}`,
      user: `u${i}`,
      status: 'active' as const,
      name: `Person ${i}`,
    }));
    type Options = NonNullable<Parameters<typeof open>[1]>;
    const scenarios: Array<{
      name: string;
      options: Options;
      act?: (h: Awaited<ReturnType<typeof open>>) => Promise<void>;
    }> = [
      {
        name: 'permissions',
        options: {
          extended: true,
          regions,
          permissions: access,
          grants: [
            { region: 'r1', principal: 'user:u1', role: 'editor' },
            { region: 'r1', principal: 'group:legal', role: 'viewer' },
          ],
          principals: 'host',
        } as Options,
        act: async (h) => {
          const pane = page.locator('.de-pane[data-pane="permissions"]');
          await pane.locator('[data-region="r1"]').getByRole('button').first().click();
          await h.frames(3);
          const search = pane.getByRole('combobox').first();
          if ((await search.count()) > 0) {
            await search.fill('a');
            await h.frames(3);
            await page.keyboard.press('ArrowDown');
            await h.frames(2);
          }
        },
      },
      {
        name: 'history',
        options: { history: 'full', features: ['history'], people: 'host' } as Options,
      },
      {
        name: 'styles',
        options: {
          extended: true,
          styles: [
            { id: 'Normal', name: 'Normal', kind: 'paragraph' },
            { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' },
            { id: 'Strong', name: 'Strong', kind: 'character' },
          ],
        } as Options,
      },
      {
        name: 'fill',
        options: {
          extended: true,
          fill: {
            active: true,
            fields: [
              { id: 'f1', label: 'Name', required: true, filled: true, invalid: null },
              { id: 'f2', label: 'Date of birth', required: true, filled: false, invalid: null },
              { id: 'f3', label: 'Amount', required: true, filled: true, invalid: 'range' },
            ],
          },
        } as Options,
      },
      {
        name: 'presence',
        options: { features: ['presence'], presence: peers, people: 'host' } as Options,
        act: async (h) => {
          // Narrow enough that the people do not all fit, so the button for the rest shows.
          await page.setViewportSize({ width: 520, height: 900 });
          await h.frames(4);
          const more = page.locator('.de-presence-more');
          await expect(more).toBeVisible();
          await more.click();
          await h.frames(2);
          await page.setViewportSize({ width: 1400, height: 900 });
        },
      },
      {
        name: 'modes',
        options: { extended: true, modes: ['edit', 'review', 'view', 'fill'] } as Options,
        act: async (h) => {
          await page.locator('.de-mode-button').click();
          await h.frames(2);
          await page.keyboard.press('ArrowDown');
          await h.frames(2);
        },
      },
    ];

    const all: Seen[] = [];
    for (const scenario of scenarios) {
      const h = await open(page, scenario.options);
      await record(page, '#host');
      // Every pane this mount offers, then what the scenario adds.
      for (const id of (await h.commandIds()).filter((c) => c.startsWith('view.'))) {
        await step(page, `${scenario.name}: ${id}`);
        await h.exec(id);
        await h.frames(3);
      }
      await step(page, `${scenario.name}: own`);
      await scenario.act?.(h);
      all.push(...(await seen(page)));
    }
    await test.info().attach('idrefs-data.json', {
      body: JSON.stringify(all, null, 1),
      contentType: 'application/json',
    });
    // Non-vacuity: each scenario showed references on the surface it is there for.
    const proof: Record<string, string> = {
      permissions: 'permissions: own',
      history: 'history: view.history',
      styles: 'styles: view.styles',
      fill: 'fill: view.fillSummary',
      presence: 'presence: own',
      modes: 'modes: own',
    };
    for (const scenario of scenarios)
      expect(
        all.filter((s) => s.step === proof[scenario.name]).length,
        `references seen at "${proof[scenario.name]}"`,
      ).toBeGreaterThan(0);
    expect(all.filter((s) => !s.inRoot)).toEqual([]);
  });

  // The plain test: the panel's page has no shell harness for the shared fixture to read.
  plain(
    'the properties panel of a field labels its controls in its own root (criterion 3)',
    async ({ page }) => {
      // The panel's harness page mounts it alone, in the page itself: the root is the document.
      await page.goto('/field-properties.html');
      await page.locator('#host label').first().waitFor();
      await record(page, '#host');
      const all = await seen(page);
      const labels = all.filter((s) => s.attribute === 'for');
      expect(labels.length).toBeGreaterThanOrEqual(10);
      expect(all.some((s) => s.attribute === 'aria-labelledby')).toBe(true);
      expect(all.filter((s) => !s.inRoot)).toEqual([]);
      // Each label's control is a form control inside the panel, not something else with that id.
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll('#host label[for]')].map((label) => {
          const control = document.getElementById(label.getAttribute('for')!);
          return {
            id: label.getAttribute('for'),
            tag: control?.tagName.toLowerCase() ?? null,
            inPanel: control !== null && document.getElementById('host')!.contains(control),
          };
        }),
      );
      for (const c of controls) {
        expect(c.inPanel, `control ${c.id}`).toBe(true);
        expect(['input', 'select', 'textarea']).toContain(c.tag);
      }
    },
  );

  test('the recorder reports a reference that leaves the root', async ({ page }) => {
    await open(page, { extended: true });
    await record(page, '#host');
    await step(page, 'control');
    await page.evaluate(() => {
      // A label in the page and a control in the shadow root that points at it: the broken case.
      const label = document.createElement('span');
      label.id = 'fe-108-outside';
      document.body.append(label);
      const root = document.getElementById('host')!.shadowRoot!;
      root.querySelector('button')!.setAttribute('aria-labelledby', 'fe-108-outside');
    });
    const all = await seen(page);
    expect(all.filter((s) => !s.inRoot)).toEqual([
      expect.objectContaining({
        attribute: 'aria-labelledby',
        id: 'fe-108-outside',
        inRoot: false,
        inDocument: true,
      }),
    ]);
    // The control spoils the page on purpose; nothing else of the test's clean-up depends on it.
  });
});
