/**
 * Host extensions registered through the shell's extension list (UX-050, lane V-UX-046-060). The
 * harness sets the list with `setExtensions` (as the element's `extensions` property does through
 * the shell) and records each problem the shell reports. Run from the repository root with
 * `DOCEDIT_UI_PORT=57280 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-050-extensions.spec.ts`.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

test.describe('register host extensions (UX-050)', () => {
  test('a bad manifest is reported by name and the other extensions still load', async ({
    page,
  }) => {
    const h = await open(page);
    await h.setExtensions('mixed');
    await h.frames(2);
    const reports = await h.extensionReports();
    // The entry with a bad identifier is named by its position in the list (#2).
    const bad = reports.find((r) => r.reason === 'invalid-manifest');
    expect(bad?.extension).toBe('#2');
    expect(bad?.fatal).toBe(false);
    // The valid extension is active: its command is in the registry.
    expect(await h.commandIds()).toContain('ext.notes.insert');
  });

  test('an extension for an unsupported API version is not activated, and the reason is reported', async ({
    page,
  }) => {
    const h = await open(page);
    await h.setExtensions('mixed');
    await h.frames(2);
    const reports = await h.extensionReports();
    const old = reports.find((r) => r.extension === 'ext.old');
    expect(old?.reason).toBe('unsupported-api-version');
    expect(old?.message).toContain('API version 0 is not supported');
    expect(old?.fatal).toBe(false);
    // Its activation never ran, so its command was never registered.
    expect(await h.commandIds()).not.toContain('ext.old.cmd');
  });

  test('an extension added or removed at run time appears or disappears without a reload', async ({
    page,
  }) => {
    const h = await open(page);
    expect(await h.commandIds()).not.toContain('ext.notes.insert');
    await h.setExtensions('valid');
    await h.frames(2);
    expect(await h.commandIds()).toContain('ext.notes.insert');
    await h.setExtensions('none');
    await h.frames(2);
    expect(await h.commandIds()).not.toContain('ext.notes.insert');
    await h.setExtensions('valid');
    await h.frames(2);
    expect(await h.commandIds()).toContain('ext.notes.insert');
    // Nothing was reported for the valid extension across the changes.
    expect(await h.extensionReports()).toEqual([]);
  });

  test('an extension that throws is reported non-fatally, its partial contribution is undone, and editing continues', async ({
    page,
  }) => {
    // The hooks option makes the harness count each input as a revision, as the typing path does.
    const h = await open(page, { hooks: true });
    await h.setExtensions('mixed');
    await h.frames(2);
    const reports = await h.extensionReports();
    const boom = reports.find((r) => r.extension === 'ext.boom');
    expect(boom?.reason).toBe('activation-failed');
    expect(boom?.message).toBe('the extension failed while starting');
    expect(boom?.fatal).toBe(false);
    // The command it registered before throwing is removed with it.
    expect(await h.commandIds()).not.toContain('ext.boom.cmd');
    // Editing continues: typing still changes the document.
    await focusSurface(page);
    const before = await h.revision();
    await page.keyboard.type('x');
    await h.frames(2);
    expect(await h.revision()).toBeGreaterThan(before);
  });
});
