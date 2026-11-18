/**
 * UX-005 on the mounted element (lane w3): the host's `queryCommand` and `exec` take the identifiers
 * of the shell's command registry (`format.bold`), report what the built-in toolbar shows, pass the
 * same guards as the toolbar, say that nothing ran for a refused or unknown command, and the
 * `de-command-state` detail names the registry's commands. Uses the embed page and its in-memory
 * backend; the built-in toolbar is the one of the same element.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name: string) => `doc-editor[data-test="${name}"]`;
const surface = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-editing-surface`);

type Host = HTMLElement & {
  queryCommand(id: string): { enabled: boolean; active: boolean };
  exec(id: string): boolean;
};

/** The state of a command as the host reads it and as the built-in toolbar button shows it. */
async function bothStates(page: Page, name: string, id: string) {
  return page.evaluate(
    ({ sel, id }) => {
      const el = document.querySelector(sel) as Host;
      const button = el.shadowRoot!.querySelector(`button[data-command-id="${id}"]`);
      return {
        host: el.queryCommand(id),
        toolbar: button
          ? {
              enabled:
                button.getAttribute('aria-disabled') !== 'true' &&
                !(button as HTMLButtonElement).disabled,
              active: button.getAttribute('aria-pressed') === 'true',
            }
          : null,
      };
    },
    { sel: editor(name), id },
  );
}

test.describe('UX-005 a host-built toolbar on the mounted element', () => {
  test('queryCommand and the built-in toolbar agree over a walk of selections (criterion 2)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const last = surface(page).locator('p', { hasText: 'Last paragraph.' });
    const first = surface(page).locator('p').first();

    const walk: Array<{ at: string; state: Awaited<ReturnType<typeof bothStates>> }> = [];
    const record = async (at: string) => {
      await expect
        .poll(
          async () => {
            const s = await bothStates(page, 'one', 'format.bold');
            return (
              s.toolbar !== null &&
              s.toolbar.enabled === s.host.enabled &&
              s.toolbar.active === s.host.active
            );
          },
          { message: `the host and the toolbar agree at: ${at}` },
        )
        .toBe(true);
      walk.push({ at, state: await bothStates(page, 'one', 'format.bold') });
    };

    await first.click();
    await page.keyboard.press('Home');
    await record('caret in plain text');
    await last.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await record('plain selection');
    await page.keyboard.press('Control+B');
    await record('bold selection');
    await first.click();
    await page.keyboard.press('Home');
    await record('caret back in plain text');
    await last.click();
    await page.keyboard.press('End');
    await record('caret in bold text');

    expect(walk.map((w) => w.state.host.active)).toEqual([false, false, true, false, true]);
    expect(walk.every((w) => w.state.host.enabled)).toBe(true);
  });

  test('exec changes the document as the toolbar button does, and a viewer, or an unknown id, runs nothing (criteria 3 and 4)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'victor', role: 'viewer', target: 'mount-2' });

    const last = surface(page).locator('p', { hasText: 'Last paragraph.' });
    await last.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    const ran = await page.evaluate(
      (sel) => (document.querySelector(sel) as Host).exec('format.bold'),
      editor('one'),
    );
    expect(ran).toBe(true);
    await expect(last.locator('strong, b, [data-mark="bold"]').first()).toBeVisible();
    expect((await bothStates(page, 'one', 'format.bold')).toolbar?.active).toBe(true);

    const refused = await page.evaluate(
      ({ one, two }) => {
        const a = document.querySelector(one) as Host;
        const b = document.querySelector(two) as Host;
        return {
          viewerState: b.queryCommand('format.bold'),
          viewerRan: b.exec('format.bold'),
          unknownState: a.queryCommand('format.nonsense'),
          unknownRan: a.exec('format.nonsense'),
        };
      },
      { one: editor('one'), two: editor('two') },
    );
    expect(refused).toEqual({
      viewerState: { enabled: false, active: false },
      viewerRan: false,
      unknownState: { enabled: false, active: false },
      unknownRan: false,
    });
  });

  test('de-command-state lists the registry commands whose state changed (criterion 5)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as Host;
      (window as unknown as { __seen: unknown[] }).__seen = [];
      el.addEventListener('de-command-state', (e) =>
        (window as unknown as { __seen: unknown[] }).__seen.push((e as CustomEvent).detail),
      );
    }, editor('one'));
    const last = surface(page).locator('p', { hasText: 'Last paragraph.' });
    await last.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Control+B');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __seen: Array<{ commands: Array<{ name: string; active: boolean }> }>;
            }
          ).__seen
            .flatMap((d) => d.commands)
            .filter((c) => c.name === 'format.bold')
            .map((c) => c.active),
        ),
      )
      .toContain(true);
  });
});
