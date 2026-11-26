/**
 * Client import filters in the shell (UX-055 criterion 1): the import command is offered when an
 * extension registered an import filter and the core can take a fragment, the dialog lists the
 * formats with their labels, a file is read by the filter of its extension, and the fragment goes to
 * the core's `insertContent`, which applies the guards of typing (FE-027; tested in the engine). A
 * filter that throws, and a fragment the core refuses, are reported and insert nothing. Run with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-055-import-filters.spec.ts`.
 */
import { axe, expect, focusSurface, open, test } from './helpers.ts';

const file = (name: string, text: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(text),
});

test.describe('client import filters (UX-055 criterion 1)', () => {
  test('the command lists the formats with their labels and is the only way in', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, importFilters: true });
    await focusSurface(page);
    expect((await h.exec('document.import')).ran).toBe(true);
    const dialog = page.getByRole('dialog', { name: 'Import a file' });
    await expect(dialog).toBeVisible();
    const formats = dialog.getByRole('list', { name: 'Format' });
    await expect(formats.getByRole('listitem')).toHaveText([
      'Notes (extension)',
      'Broken format (extension)',
      'Refused format (extension)',
    ]);
    expect(await axe(page)).toEqual([]);
  });

  test('a file of the filter’s type is turned into a fragment and inserted through the core', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, importFilters: true });
    await focusSurface(page);
    await h.exec('document.import');
    const dialog = page.getByRole('dialog', { name: 'Import a file' });
    await dialog.getByLabel('File').setInputFiles(file('todo.note', 'Imported by the filter.'));
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog.getByRole('status')).toContainText('Imported todo.note.');
    expect(await h.insertedFragments()).toEqual([
      { cdm: 1, requires: [], content: [{ type: 'paragraph', text: 'Imported by the filter.' }] },
    ]);
  });

  test('a filter that throws is reported and nothing is inserted', async ({ page }) => {
    const h = await open(page, { extended: true, importFilters: true });
    await focusSurface(page);
    await h.exec('document.import');
    const dialog = page.getByRole('dialog', { name: 'Import a file' });
    await dialog.getByLabel('File').setInputFiles(file('x.bad', 'anything'));
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog.getByRole('alert')).toContainText('could not read the file');
    expect(await h.insertedFragments()).toEqual([]);
  });

  test('a fragment the core refuses is reported with its reason and nothing is inserted', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, importFilters: true });
    await focusSurface(page);
    await h.exec('document.import');
    const dialog = page.getByRole('dialog', { name: 'Import a file' });
    await dialog.getByLabel('File').setInputFiles(file('x.nope', 'anything'));
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog.getByRole('alert')).toContainText('region you may not change');
    expect(await h.insertedFragments()).toEqual([]);
  });

  test('a file of no registered type is not read', async ({ page }) => {
    const h = await open(page, { extended: true, importFilters: true });
    await focusSurface(page);
    await h.exec('document.import');
    const dialog = page.getByRole('dialog', { name: 'Import a file' });
    await dialog.getByLabel('File').setInputFiles(file('x.unknown', 'anything'));
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(await h.insertedFragments()).toEqual([]);
  });

  test('without an import filter the command is not offered', async ({ page }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    expect(await h.exec('document.import')).toEqual({ ran: false, reason: 'unknown' });
  });
});
