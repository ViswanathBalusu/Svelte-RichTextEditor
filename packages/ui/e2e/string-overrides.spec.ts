/**
 * Host string replacements in the shell (UX-063, criterion 2): an override by key shows in the
 * shell, a key without an override falls back to the source table, and a key no table knows is
 * reported. The element has no property that passes overrides yet (05 section 8.1, UX-064 criterion
 * 3), so this proves the shell's side only.
 */
import { expect, open, test, visibleStrings } from './helpers.ts';

test.describe('host string overrides in the shell (UX-063, criterion 2)', () => {
  test('an override by key appears where the key is shown', async ({ page }) => {
    await open(page, { overrides: { 'toolbar.label': 'Writing tools' } });
    const strings = await visibleStrings(page);
    const label = strings.filter((s) => s.where.startsWith('aria-label of'));
    expect(label.map((s) => s.text)).toContain('Writing tools');
  });

  test('a key without an override falls back to the source table', async ({ page }) => {
    // The same shell with no overrides, then with one: only the replaced key's text differs.
    await open(page);
    const source = (await visibleStrings(page)).map((s) => s.text);
    await open(page, { overrides: { 'toolbar.label': 'Writing tools' } });
    const replaced = (await visibleStrings(page)).map((s) => s.text);
    expect(source).toContain('Editing');
    expect(replaced).not.toContain('Editing');
    expect(replaced).toContain('Writing tools');
    expect(replaced.filter((text) => text !== 'Writing tools')).toEqual(
      source.filter((text) => text !== 'Editing'),
    );
  });

  test('an unknown key is reported, and the shell still renders', async ({ page }) => {
    const h = await open(page, { overrides: { 'no.such.key': 'x', 'toolbar.label': 'Writing' } });
    expect(await h.unknownKeys()).toEqual(['no.such.key']);
    const strings = await visibleStrings(page);
    expect(strings.map((s) => s.text)).toContain('Writing');
  });

  test('an override is shown as text, never as markup', async ({ page }) => {
    await open(page, { overrides: { 'toolbar.label': '<b>Writing</b>' } });
    const markup = await page.evaluate(
      () => document.getElementById('host')!.shadowRoot!.querySelectorAll('b').length,
    );
    expect(markup).toBe(0);
    const strings = await visibleStrings(page);
    const labels = strings.filter((s) => s.where.startsWith('aria-label of')).map((s) => s.text);
    expect(labels).toContain('<b>Writing</b>');
  });
});
