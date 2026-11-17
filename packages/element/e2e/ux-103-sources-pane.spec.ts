/**
 * UX-103 (lane w3): the sources pane in the real element, with the shell, the core and the
 * in-memory backend of the embed page. An editor adds, corrects, cites, deletes and imports
 * sources, and each change is read back from the confirmed document (the content the service
 * acknowledged), so it went through the log. A second session of a user who may edit only a region
 * (a `commenter` with a region grant) receives those sources through the same log, can cite one
 * inside the region, and has no control that changes a definition.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/ux-103-sources-pane.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

/** The confirmed document of the editor `name`: what the service has acknowledged. */
async function confirmed(page: Page, name: string): Promise<Node> {
  const json = await page.evaluate((n) => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { core: { confirmedContent(): { doc: unknown } } } };
        };
      }
    ).__embed;
    const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
    return JSON.stringify(e.internals(el).editor.core.confirmedContent().doc);
  }, name);
  return JSON.parse(json) as Node;
}

function nodes(root: Node, type: string): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (n.type === type) out.push(n);
    for (const child of n.content ?? []) walk(child);
  };
  walk(root);
  return out;
}

const sourceIds = async (page: Page, name: string): Promise<string[]> =>
  nodes(await confirmed(page, name), 'source_def').map((n) => String(n.attrs?.['id']));

const sourceAttrs = async (
  page: Page,
  name: string,
  id: string,
): Promise<Record<string, unknown>> =>
  nodes(await confirmed(page, name), 'source_def').find((n) => n.attrs?.['id'] === id)?.attrs ?? {};

/** The sources each confirmed citation names, with the kind of block that holds the citation. */
async function citations(page: Page, name: string): Promise<string[]> {
  return nodes(await confirmed(page, name), 'citation').map((n) =>
    (n.attrs?.['items'] as { source: string }[]).map((i) => i.source).join('+'),
  );
}

/** Puts the caret in the paragraph with `text` and opens the sources pane by the command search. */
async function openPane(page: Page, name: string, text: string): Promise<Locator> {
  const editor = `doc-editor[data-test="${name}"]`;
  await page.locator(`${editor} .de-editing-surface p`, { hasText: text }).click();
  await page.keyboard.press('Alt+q');
  await expect(page.locator(`${editor} [role="combobox"]`)).toBeFocused();
  await page.keyboard.type('Sources');
  await expect(page.locator(`${editor} [role="option"]`).first()).toContainText('Sources');
  await page.keyboard.press('Enter');
  const pane = page.locator(`${editor} .de-pane[data-pane="sources"]`);
  await expect(pane).toBeVisible();
  return pane;
}

const BIB = `
@inproceedings{hopper1952,
  author = {Hopper, Grace},
  title = {The education of a computer},
  booktitle = {Proceedings of the ACM},
  year = 1952,
  doi = {10.1145/609784.609818}
}
@book{dup1, title = {First of two}}
@book{DUP1, title = {Second of two}}
@book{lovelace1843, title = {Already in the document}}
@article{baddoi2000, title = {A bad DOI}, doi = {not a doi}}
`;

test.describe('UX-103 the sources pane', () => {
  test('an editor adds, corrects, cites, deletes and imports sources through the log; a region-only editor can only cite', async ({
    page,
    browserName,
  }) => {
    test.setTimeout(120_000);
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'bob', role: 'editor' });
    const pane = await openPane(page, 'one', 'Last paragraph.');
    await expect(pane.locator('[data-sources="empty"]')).toBeVisible();
    expect(await sourceIds(page, 'one')).toEqual([]);

    // Criterion 1, add: a value its grammar refuses is marked and nothing is committed.
    await pane.locator('[data-sources="add"]').click();
    await pane.getByLabel('Key').fill('lovelace1843');
    await pane.getByLabel('Type').selectOption('article-journal');
    await pane.getByLabel('Title').fill('Notes on the Analytical Engine');
    await pane.getByLabel('Authors').fill('Lovelace, Ada; Babbage, Charles');
    await pane.getByLabel('Date').fill('1843-09');
    await pane.getByLabel('Journal, book or site').fill('Scientific Memoirs');
    await pane.getByLabel('DOI').fill('not a doi');
    await pane.getByLabel('Web address').fill('https://example.org/notes');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect(pane.locator('[data-sources="error"]')).toBeVisible();
    await expect(pane.getByLabel('DOI')).toHaveAttribute('aria-invalid', 'true');
    await expect(pane.getByLabel('Title')).not.toHaveAttribute('aria-invalid', 'true');
    expect(await sourceIds(page, 'one')).toEqual([]);

    if (browserName === 'chromium') {
      // axe on the pane with its form open and an error shown.
      const results = await new AxeBuilder({ page })
        .include({
          fromShadowDom: ['doc-editor[data-test="one"]', '.de-pane[data-pane="sources"]'],
        })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    }

    await pane.getByLabel('DOI').fill('10.1000/notes.1843');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect(pane.locator('li[data-source="lovelace1843"]')).toContainText(
      'Notes on the Analytical Engine',
    );
    await expect.poll(() => sourceIds(page, 'one')).toEqual(['lovelace1843']);
    expect(await sourceAttrs(page, 'one', 'lovelace1843')).toMatchObject({
      kind: 'article-journal',
      title: 'Notes on the Analytical Engine',
      authors: [
        { family: 'Lovelace', given: 'Ada' },
        { family: 'Babbage', given: 'Charles' },
      ],
      issued: '1843-09',
      containerTitle: 'Scientific Memoirs',
      doi: '10.1000/notes.1843',
      url: 'https://example.org/notes',
    });

    // Criterion 1, edit.
    await pane.getByRole('button', { name: 'Edit Notes on the Analytical Engine' }).click();
    await pane.getByLabel('Title').fill('Notes by the translator');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(async () => (await sourceAttrs(page, 'one', 'lovelace1843'))['title'])
      .toBe('Notes by the translator');
    // The attributes that were not changed are as they were.
    expect((await sourceAttrs(page, 'one', 'lovelace1843'))['issued']).toBe('1843-09');

    // Criterion 2: cite it, then try to delete it.
    await page
      .locator('doc-editor[data-test="one"] .de-editing-surface p', { hasText: 'Last paragraph.' })
      .click();
    await pane.getByRole('button', { name: 'Cite Notes by the translator' }).click();
    await expect.poll(() => citations(page, 'one')).toEqual(['lovelace1843']);
    await expect(pane.locator('li[data-source="lovelace1843"] [data-sources="count"]')).toHaveText(
      'Cited in 1 place.',
    );
    await pane.getByRole('button', { name: 'Delete Notes by the translator' }).click();
    const cited = pane.locator('li[data-source="lovelace1843"] [data-sources="cited"]');
    await expect(cited).toContainText('still cited');
    await expect(cited.locator('li')).toHaveText(['Last paragraph.']);
    await expect(pane.locator('li[data-source="lovelace1843"]')).toHaveCount(1);
    expect(await sourceIds(page, 'one')).toEqual(['lovelace1843']);

    // Criterion 1, delete: a source nothing cites goes, as a commit.
    await pane.locator('[data-sources="add"]').click();
    await pane.getByLabel('Key').fill('temp1');
    await pane.getByLabel('Title').fill('A source nobody cites');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sourceIds(page, 'one')).toEqual(['lovelace1843', 'temp1']);
    await pane.getByRole('button', { name: 'Delete A source nobody cites' }).click();
    await expect.poll(() => sourceIds(page, 'one')).toEqual(['lovelace1843']);
    await expect(pane.locator('li[data-source="temp1"]')).toHaveCount(0);

    // Criterion 3: a BibTeX file with one good entry, a key twice, a key the document has, and a
    // value its grammar refuses.
    await pane
      .locator('input[type="file"]')
      .setInputFiles({ name: 'refs.bib', mimeType: 'text/plain', buffer: Buffer.from(BIB) });
    const report = pane.locator('[data-sources="report"]');
    await expect(report.locator('[data-sources="created"]')).toHaveText('1 source added.');
    await expect(report.locator('[data-refused="duplicate"]')).toHaveCount(2);
    await expect(report.locator('[data-refused="duplicate"]').first()).toContainText('dup1');
    await expect(report.locator('[data-refused="exists"]')).toContainText('lovelace1843');
    await expect(report.locator('[data-refused="invalid"]')).toContainText('baddoi2000');
    await expect(report.locator('[data-refused="invalid"]')).toContainText('doi');
    await expect.poll(() => sourceIds(page, 'one')).toEqual(['lovelace1843', 'hopper1952']);
    expect(await sourceAttrs(page, 'one', 'hopper1952')).toMatchObject({
      kind: 'paper-conference',
      title: 'The education of a computer',
      authors: [{ family: 'Hopper', given: 'Grace' }],
      containerTitle: 'Proceedings of the ACM',
      issued: '1952',
      doi: '10.1145/609784.609818',
    });

    // Criterion 4: Ada is a commenter with an editor grant on the region "Legal review" only.
    await mountEditor(page, { name: 'two', sub: 'ada', role: 'commenter' });
    // Her session received the sources through the log.
    await expect.poll(() => sourceIds(page, 'two')).toEqual(['lovelace1843', 'hopper1952']);
    const hers = await openPane(page, 'two', 'Liability is limited to');
    await expect(hers.locator('li[data-source]')).toHaveCount(2);
    await expect(hers.locator('[data-sources="read-only"]')).toBeVisible();
    await expect(hers.locator('[data-sources="add"]')).toHaveCount(0);
    await expect(hers.locator('[data-sources="import"]')).toHaveCount(0);
    await expect(hers.locator('input[type="file"]')).toHaveCount(0);
    await expect(hers.getByRole('button', { name: /^(Edit|Delete) / })).toHaveCount(0);
    // Inside the region she may cite an existing source.
    const cite = hers.getByRole('button', { name: 'Cite The education of a computer' });
    // The caret is put in the region with the pane open (opening the pane by the command search
    // leaves the caret at the start of the document, where she may not write).
    await page
      .locator('doc-editor[data-test="two"] .de-editing-surface p', {
        hasText: 'Liability is limited to',
      })
      .click();
    await expect(cite).not.toHaveAttribute('aria-disabled', 'true');
    await cite.click();
    await expect
      .poll(async () => (await citations(page, 'two')).sort())
      .toEqual(['hopper1952', 'lovelace1843']);
    // The definitions are as they were: citing changed the text only.
    expect(await sourceIds(page, 'two')).toEqual(['lovelace1843', 'hopper1952']);
    // Outside the region she may not change the text, so she cannot cite there.
    await page
      .locator('doc-editor[data-test="two"] .de-editing-surface p', { hasText: 'Last paragraph.' })
      .click();
    await expect(cite).toHaveAttribute('aria-disabled', 'true');
    // The button is disabled for assistive technology but still takes a click: nothing is cited.
    await cite.click({ force: true });
    await page.waitForTimeout(300);
    expect((await citations(page, 'two')).length).toBe(2);
    expect(await sourceIds(page, 'two')).toEqual(['lovelace1843', 'hopper1952']);
  });
});
