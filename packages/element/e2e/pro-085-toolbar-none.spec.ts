/**
 * PRO-085 criteria 3 and 5 (lane w5).
 *
 * Criterion 5: with `toolbar="none"` a host that builds its own toolbar from `queryCommand` and
 * `exec` can reach every command of the built-in toolbar. The test mounts one editor with the full
 * toolbar and collects the identifier of every command it draws (the buttons and the "More" menu).
 * A second editor with `toolbar="none"` draws none of them. For each identifier, the second
 * editor's `queryCommand` gives the state the first editor's button shows (enabled, active), and
 * its `exec` is answered by the registry: it never says `unknown` or `not-loaded`, and it runs the
 * command when the state says it is enabled.
 *
 * Criterion 3: a command the user's access does not allow runs nothing and `exec` says why
 * (`{ ok: false, reason: 'no-access' }`, owner decision 188).
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-085-toolbar-none.spec.ts --retries=0
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name: string) => `doc-editor[data-test="${name}"]`;

/** Commands that exist only with a backend feature or port: the baseline offers them too (see pro-081). */
const MORE = {
  announce: ['comments', 'history', 'exports'],
  ports: ['exports', 'proofing', 'assistant'] as ('exports' | 'proofing' | 'assistant')[],
};

type Host = HTMLElement & {
  queryCommand(id: string): { enabled: boolean; active: boolean };
  exec(id: string): { ok: boolean; reason: string | null };
};

/** Every command the built-in toolbar offers: its buttons, and the commands of the "More" menu. */
async function toolbarCommands(page: Page, name: string) {
  const ed = page.locator(editor(name));
  const states = new Map<string, { enabled: boolean; active: boolean }>();
  const read = async (menu: boolean) =>
    ed.evaluate((el, inMenu) => {
      const out: Array<{ id: string; enabled: boolean; active: boolean }> = [];
      const nodes = inMenu
        ? el.shadowRoot!.querySelectorAll('[data-menu-item][data-command-id]')
        : el.shadowRoot!.querySelectorAll('button[data-command-id]');
      for (const b of nodes) {
        const id = b.getAttribute('data-command-id')!;
        if (id.startsWith('toolbar.')) continue;
        out.push({
          id,
          enabled: b.getAttribute('aria-disabled') !== 'true' && !(b as HTMLButtonElement).disabled,
          active:
            b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true',
        });
      }
      return out;
    }, menu);
  for (const c of await read(false)) states.set(c.id, c);
  await ed.locator('[data-command-id="toolbar.more"]').click();
  for (const c of await read(true)) if (!states.has(c.id)) states.set(c.id, c);
  await page.keyboard.press('Escape');
  return states;
}

test.describe('PRO-085 criterion 5: toolbar="none" reaches every command of the built-in toolbar', () => {
  test('queryCommand gives the state of each built-in button and exec reaches its command', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'full', sub: 'ada', ...MORE });
    await mountEditor(page, {
      name: 'none',
      sub: 'ada',
      target: 'mount-2',
      attributes: { toolbar: 'none' },
      ...MORE,
    });
    const builtIn = await toolbarCommands(page, 'full');
    expect(builtIn.size, 'the built-in toolbar offers commands').toBeGreaterThan(20);
    // The editor with no toolbar draws none of the toolbar's buttons. What stays is the header's
    // (the share button and the like), which the list of the full editor holds too.
    const left = await page
      .locator(editor('none'))
      .evaluate((el) =>
        [...el.shadowRoot!.querySelectorAll('button[data-command-id]')].map((b) =>
          b.getAttribute('data-command-id'),
        ),
      );
    expect(left.length).toBeLessThan(builtIn.size / 2);
    expect(left).not.toContain('format.bold');
    expect(left).not.toContain('edit.undo');

    const ids = [...builtIn.keys()];
    const result = await page.evaluate(
      ({ sel, ids }) => {
        const el = document.querySelector(sel) as Host;
        return ids.map((id) => ({ id, state: el.queryCommand(id) }));
      },
      { sel: editor('none'), ids },
    );
    for (const { id, state } of result) {
      expect(state, `${id}: the host sees what the built-in button shows`).toEqual({
        enabled: builtIn.get(id)!.enabled,
        active: builtIn.get(id)!.active,
      });
    }

    // exec reaches each command. A disabled one says why; an enabled one runs or has no effect.
    // A command run earlier may change what a later one is enabled for (Select all makes a selection,
    // which enables "New comment"), so each is asked for its state just before it is run.
    const outcomes: Record<string, { ok: boolean; reason: string | null }> = {};
    const enabledBefore: Record<string, boolean> = {};
    for (const id of ids) {
      const r = await page.evaluate(
        ({ sel, id }) => {
          const el = document.querySelector(sel) as Host;
          return { enabled: el.queryCommand(id).enabled, outcome: el.exec(id) };
        },
        { sel: editor('none'), id },
      );
      outcomes[id] = r.outcome;
      enabledBefore[id] = r.enabled;
      // A command may open a pane or a dialog; the next one is run from a clean shell.
      await page.keyboard.press('Escape');
    }
    for (const id of ids) {
      const o = outcomes[id]!;
      expect(o.reason, `${id} is known to the registry`).not.toBe('unknown');
      expect(o.reason, `${id}: a document is loaded`).not.toBe('not-loaded');
      if (enabledBefore[id]) expect(o.reason, `${id} is enabled`).not.toBe('no-access');
      else expect(o.ok, `${id} is disabled, so nothing runs`).toBe(false);
    }
    test.info().annotations.push({
      type: 'commands reached',
      description: `${ids.length}: ${ids.join(', ')}`,
    });
  });
});

test.describe('PRO-085 criterion 3: a command the access does not allow says why', () => {
  test('a viewer gets { ok: false, reason: "no-access" } and the document is unchanged', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'viewer', sub: 'victor', role: 'viewer' });
    const content = (sel: string) =>
      page.evaluate(async (s) => {
        const el = document.querySelector(s) as unknown as {
          getContent(): Promise<{ doc: unknown }>;
        };
        return JSON.stringify((await el.getContent()).doc);
      }, sel);
    const before = await content(editor('viewer'));
    const out = await page.evaluate(
      ({ sel }) => {
        const el = document.querySelector(sel) as Host;
        return {
          state: el.queryCommand('format.bold'),
          bold: el.exec('format.bold'),
          italic: el.exec('format.italic'),
          footnote: el.exec('insert.footnote'),
          unknown: el.exec('format.nonsense'),
        };
      },
      { sel: editor('viewer') },
    );
    expect(out.state).toEqual({ enabled: false, active: false });
    for (const k of ['bold', 'italic', 'footnote'] as const)
      expect(out[k], k).toEqual({ ok: false, reason: 'no-access' });
    expect(out.unknown).toEqual({ ok: false, reason: 'unknown' });
    expect(await content(editor('viewer'))).toBe(before);
  });
});
