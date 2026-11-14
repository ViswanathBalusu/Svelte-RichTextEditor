/**
 * Extensions in the shell: client export filters in the export dialog (UX-055) and hooks fed from
 * the core's revision, off the typing path (UX-054). The harness registers the filters and hooks
 * through the shell's `filters` and `hooks` properties, as the element will for its extensions.
 */
import { axe, expect, focusSurface, open, test } from './helpers.ts';

const LIMITED = {
  rev: 2,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
  restrictions: ['no-export'],
};

test.describe('client export filters (UX-055)', () => {
  test('lists each export filter with its label next to the announced targets', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], exportFilters: true });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();
    const format = dialog.getByRole('group', { name: 'Format' });
    await expect(format.getByRole('radio')).toHaveCount(4);
    await expect(format.getByRole('radio', { name: 'PDF' })).toBeChecked();
    await expect(format.getByRole('radio', { name: 'Markdown (extension)' })).toBeEnabled();
    await expect(format.getByRole('radio', { name: 'Broken format (extension)' })).toBeEnabled();
    expect(await axe(page)).toEqual([]);
  });

  test('a chosen filter receives the document and its file is offered to save', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], exportFilters: true });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('radio', { name: 'Markdown (extension)' }).check();
    // The options of the server's PDF export are not shown for a client filter.
    await expect(dialog.getByRole('combobox', { name: 'Accessibility tagging' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Export' }).click();
    const link = dialog.getByRole('link', { name: 'Save document.md' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('download', 'document.md');
    expect(await link.getAttribute('href')).toMatch(/^blob:/);
    expect(await h.filterContents()).toEqual([await h.documentContent()]);
    expect(await h.exportRequests()).toEqual([]);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('document.md');
    const saved = await download.createReadStream().then(async (stream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    });
    expect(saved).toBe('Body text of the test document.\n');
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'The export has finished.',
    );
  });

  test('under no-export the filters are shown disabled with the reason and do not run', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports'],
      exportFilters: true,
      permissions: LIMITED,
    });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    const markdown = dialog.getByRole('radio', { name: 'Markdown (extension)' });
    await expect(markdown).toBeDisabled();
    await expect(markdown).toHaveAccessibleDescription('Your access does not allow export.');
    await expect(dialog.getByRole('radio', { name: 'Broken format (extension)' })).toBeDisabled();
    expect(await h.filterContents()).toEqual([]);
    expect(await axe(page)).toEqual([]);
  });

  test('with only client filters, the first one allowed is chosen and stays disabled under no-export', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      features: ['exports'],
      exportTargets: null,
      exportFilters: true,
    });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog.getByRole('radio')).toHaveCount(2);
    await expect(dialog.getByRole('radio', { name: 'Markdown (extension)' })).toBeChecked();
    await h.setPermissions(LIMITED);
    await expect(dialog.getByRole('radio', { name: 'Markdown (extension)' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(await h.filterContents()).toEqual([]);
  });

  test('a filter that throws is reported and the document is unchanged', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'], exportFilters: true });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    const before = await h.documentContent();
    await dialog.getByRole('radio', { name: 'Broken format (extension)' }).check();
    await dialog.getByRole('button', { name: 'Export' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'This format could not write the file. The document is unchanged.',
    );
    await expect(dialog.getByRole('link')).toHaveCount(0);
    // The filter received the document and tried to change it; the core's copy is as it was.
    expect(await h.filterContents()).toEqual([before]);
    expect(await h.documentContent()).toBe(before);
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('The export failed.');
  });
});

test.describe('extension hooks stay off the typing path (UX-054)', () => {
  test('typing is unaffected by a hook that throws or never resolves, and the queues stay bounded', async ({
    page,
  }) => {
    // `sync`: the shell's subscriber runs inside each input's dispatch, as a core's could.
    const h = await open(page, { extended: true, hooks: true, notify: 'sync' });
    await focusSurface(page);
    await page.keyboard.press('End');
    const typed = 'the quick brown fox jumps over the lazy dog';
    await page.keyboard.type(typed);
    // Every keystroke arrived, in order.
    await expect(page.locator('.de-editing-surface')).toContainText(typed);
    const revision = await h.revision();
    expect(revision).toBe(typed.length);
    // The recording hook has caught up, and was never called while an input was dispatched.
    await expect.poll(async () => (await h.hookCalls()).at(-1)?.revision).toBe(revision);
    const calls = await h.hookCalls();
    expect(calls.every((c) => !c.duringInput)).toBe(true);
    // The throwing hook was reported; every queue stayed within its bounds (8 and 2 here) and
    // accounts for each change.
    expect((await h.hookErrors()).length).toBeGreaterThan(0);
    const [throwing, hanging, recording] = await h.hookStats();
    expect(throwing!.failed + throwing!.dropped).toBe(revision);
    expect(hanging!.inFlight).toBeLessThanOrEqual(2);
    expect(hanging!.pending).toBeLessThanOrEqual(8);
    expect(hanging!.inFlight + hanging!.pending + hanging!.dropped).toBe(revision);
    expect(recording!.delivered + recording!.dropped).toBe(revision);
  });
});
