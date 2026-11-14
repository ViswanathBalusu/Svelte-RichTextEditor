/**
 * Spike S1 (SPK-014) for CDM-001: the two footnote content models of 03 §13, prototyped in the
 * footnote sub-editor (FE-056, FE-058):
 *
 * - `inline` (option A, the draft): `note_inline*`;
 * - `paragraph` (option B): `paragraph+`, limited to one paragraph by the editing core.
 *
 * Each test records what happened (test-results/evidence/footnote-*.json) and asserts it.
 *
 * CDM-001 chose option B, and the engine has one footnote model since: the option A runs are in the
 * S1 report (section 5) and no longer run here.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, openPanel, openS1, record } from './helpers.ts';

const MODELS: ReadonlyArray<'inline' | 'paragraph'> = ['paragraph'];

interface Node {
  type: string;
  text?: string;
  content: Node[];
}

for (const model of MODELS) {
  test.describe(`footnote model: ${model}`, () => {
    test('typing, Enter and Shift+Enter in the sub-editor', async ({ page }) => {
      const h = await openS1(page, `?model=${model}`);
      await openPanel(page, 'footnote');
      await h.subCaret('end');
      await page.keyboard.type(' more');
      await expect.poll(() => h.nodeText(SPIKE_IDS.footnote)).toBe('Footnote text more');
      await page.keyboard.press('Enter');
      const afterEnter = { text: await h.nodeText(SPIKE_IDS.footnote), sub: await h.subDoc() };
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('line two');
      const doc = (await h.subDoc()) as Node;
      const inline = model === 'inline' ? doc.content : doc.content[0]!.content!;
      const sequence = inline.map((n) => (n.type === 'text' ? `text:${n.text}` : n.type));
      const validation = await h.validate();
      record(`footnote-${model}-typing`, { afterEnter, sequence, validation });
      // Enter adds no second paragraph under either model (A: nothing to split; B: the limit).
      expect(afterEnter.text).toBe('Footnote text more');
      const subContent = (afterEnter.sub as Node).content;
      expect(subContent.filter((n) => n.type === 'paragraph').length).toBe(
        model === 'paragraph' ? 1 : 0,
      );
      expect(validation.violations).toEqual([]);
      const wanted = ['text:Footnote text more', 'break', 'text:line two'];
      if (model === 'paragraph') {
        // A line break at the end of the paragraph, and typing continues after it.
        expect(sequence).toEqual(wanted);
      } else {
        // Under `inline` the sub-editor's root is the footnote itself, which is not a textblock,
        // so ProseMirror's trailing-break workaround does not apply: the caret cannot get past a
        // break at the end (see the S1 report for the per-browser results).
        expect(sequence).not.toEqual(wanted);
      }
    });

    test('pasting two paragraphs into the sub-editor', async ({ page }) => {
      const h = await openS1(page, `?model=${model}`);
      await openPanel(page, 'footnote');
      await h.subCaret('end');
      const handled = await h.pasteHTML('sub', '<p>One</p><p>Two</p>');
      const result = {
        handled,
        text: await h.nodeText(SPIKE_IDS.footnote),
        doc: await h.subDoc(),
        validation: await h.validate(),
      };
      record(`footnote-${model}-paste-paragraphs`, result);
      expect(result.validation.violations).toEqual([]);
      if (model === 'inline') {
        // The paragraphs are flattened into the inline content: the boundary is lost.
        expect(result.text).toBe('Footnote textOneTwo');
      } else {
        // The limit refuses the paste as a whole: nothing changes.
        expect(result.text).toBe('Footnote text');
      }
    });

    test('pasting a footnote into the sub-editor (nesting, I10)', async ({ page }) => {
      const h = await openS1(page, `?model=${model}`);
      await openPanel(page, 'footnote');
      await h.subCaret('end');
      await h.pasteHTML('sub', 'x<span data-footnote="">Nested</span>y');
      const footnotes = await h.footnotes();
      const validation = await h.validate();
      record(`footnote-${model}-paste-nested`, { footnotes, validation, sub: await h.subDoc() });
      if (model === 'inline') {
        // note_inline* has no footnote: the schema drops the nested one and keeps its text.
        expect(footnotes).toHaveLength(1);
        expect(validation.violations).toEqual([]);
      } else {
        // S1 found that paragraph's inline* admits a footnote and that model.validate() did not
        // refuse one inside a footnote. Since CDM-001 both refuse it: validate() reports I10 and
        // the editing core refuses the paste (the panel's filter and the main guard).
        expect(footnotes).toHaveLength(1);
        expect(validation.violations).toEqual([]);
      }
    });

    test('copying body text that contains the footnote, through the HTML clipboard', async ({
      page,
    }) => {
      const h = await openS1(page, `?model=${model}`);
      await h.selectBetween('Alpha', ' delta'); // the text and the whole footnote
      // Under `paragraph` the footnote's paragraph adds a block separator.
      expect((await h.selectedText()).replace('\n', '')).toBe('Alpha bravo charlieFootnote text');
      const html = await h.copyPasteSelection('main');
      const result = {
        html,
        footnotes: await h.footnotes(),
        bodyText: await h.bodyText(),
        validation: await h.validate(),
      };
      record(`footnote-${model}-clipboard`, result);
      expect(result.validation.violations).toEqual([]);
      if (model === 'inline') {
        // The pasted copy of the footnote keeps its content.
        expect(result.footnotes.map((f) => f.text)).toEqual(['Footnote text', 'Footnote text']);
      } else {
        // <p> inside <span> inside <p> does not survive the HTML parser: the copy's paragraph is
        // pushed out of the footnote and the footnote is refilled empty.
        expect(result.footnotes.map((f) => f.text)).toEqual(['Footnote text', '']);
        expect(result.bodyText).toContain('\nFootnote text');
      }
    });

    test('inserting a new footnote fills its identifiers', async ({ page }) => {
      const h = await openS1(page, `?model=${model}`);
      await h.caretIn(SPIKE_IDS.last, 'end');
      await page.locator('doc-editor button[data-command="insertFootnote"]').click();
      await page.locator('doc-editor .de-sub-editor').waitFor();
      await page.keyboard.type('New note');
      const ids = (await h.ids()).filter((i) => i.type === 'footnote' || i.type === 'paragraph');
      const validation = await h.validate();
      record(`footnote-${model}-insert`, { ids, validation, sub: await h.subDoc() });
      expect(ids.every((i) => typeof i.id === 'string')).toBe(true);
      expect(validation.violations).toEqual([]);
      expect(await h.subText()).toBe('New note');
    });

    test('a remote commit into the open footnote appears in the sub-editor', async ({ page }) => {
      const h = await openS1(page, `?model=${model}`);
      await openPanel(page, 'footnote');
      await h.subCaret('end');
      const node = model === 'inline' ? SPIKE_IDS.footnote : SPIKE_IDS.footnoteParagraph;
      await h.remote({ kind: 'insert', node, at: 'start', text: '«R»', mode: 'rebase' });
      await page.keyboard.type('!');
      await expect.poll(() => h.subText()).toBe('«R»Footnote text!');
      expect(await h.nodeText(SPIKE_IDS.footnote)).toBe('«R»Footnote text!');
    });
  });
}
