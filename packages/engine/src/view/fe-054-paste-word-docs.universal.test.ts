/**
 * FE-054 criterion 4: clipboard HTML in the shapes Word and Google Docs write, read through the
 * whitelist (`fragmentFromHtmlString`) and pasted into a document. Headings, lists, tables, bold,
 * italic and links map to their CDM equivalents, and no vendor markup reaches the fragment.
 *
 * The samples are in `packages/engine/test/clipboard-corpus/`. They are written by hand in the markup
 * those programs produce (Word's `mso-list` paragraphs and `o:p` elements, Google Docs' wrapping
 * `<b style="font-weight:normal">`, `aria-level` lists and span styles). They are not captures from
 * the programs; see the story notes.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. Skipped in
 * Node.js, which has no DOM.
 */
import { TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { styledDocument } from '../../test/fixtures.ts';
import gdocsLists from '../../test/clipboard-corpus/gdocs-lists.html?raw';
import gdocsTable from '../../test/clipboard-corpus/gdocs-table.html?raw';
import gdocsText from '../../test/clipboard-corpus/gdocs-text.html?raw';
import wordLists from '../../test/clipboard-corpus/word-lists.html?raw';
import wordTable from '../../test/clipboard-corpus/word-table.html?raw';
import wordText from '../../test/clipboard-corpus/word-text.html?raw';
import type { CdmFragment, CdmJsonNode } from '../cdm-fragment.ts';
import { fragmentFromHtmlString } from '../clipboard-html.ts';
import { DocumentCore } from '../headless.ts';
import { internals } from '../testing.ts';

const isBrowser = typeof document !== 'undefined' && typeof DOMParser !== 'undefined';

const SAMPLES = {
  'word-text': wordText,
  'word-lists': wordLists,
  'word-table': wordTable,
  'gdocs-text': gdocsText,
  'gdocs-lists': gdocsLists,
  'gdocs-table': gdocsTable,
} as const;

function read(html: string): CdmFragment {
  const fragment = fragmentFromHtmlString(html, 1);
  if (fragment === null) throw new Error('the sample yielded no fragment');
  return fragment;
}

/** The runs of a paragraph as text: `**bold**`, `_italic_`, `[text](href)`. */
function runs(block: CdmJsonNode): string {
  return (block.content ?? [])
    .map((n) => {
      let out = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') out = `**${out}**`;
        else if (m.type === 'italic') out = `_${out}_`;
        else if (m.type === 'link') out = `[${out}](${String(m.attrs?.['href'])})`;
      }
      return out;
    })
    .join('');
}

/** A paragraph as one line: its style or list membership, then its runs. */
function line(block: CdmJsonNode): string {
  const numbering = block.attrs?.['numbering'] as
    { numberingId: string; level: number } | undefined;
  const prefix = numbering
    ? `${numbering.numberingId}@${numbering.level}`
    : String(block.attrs?.['style'] ?? 'p');
  return `${prefix}: ${runs(block)}`;
}

/** A table as lines: its grid, then its rows, cells joined by `|`, with their spans. */
function tableLines(table: CdmJsonNode): string[] {
  const out = [`table grid=${JSON.stringify(table.attrs?.['grid'])}`];
  for (const row of table.content ?? []) {
    out.push(
      (row.content ?? [])
        .map((cell) => {
          const spans = ['colspan', 'rowspan']
            .filter((k) => cell.attrs?.[k] !== undefined)
            .map((k) => `${k}=${String(cell.attrs?.[k])}`)
            .join(',');
          const text = (cell.content ?? []).map(runs).join('/');
          return spans ? `${text}{${spans}}` : text;
        })
        .join(' | '),
    );
  }
  return out;
}

/** Every block as text, tables expanded. */
function outline(fragment: CdmFragment): string[] {
  return fragment.content.flatMap((b) => (b.type === 'table' ? tableLines(b) : [line(b)]));
}

describe.skipIf(!isBrowser)(
  'FE-054 criterion 4: Word and Google Docs clipboard HTML maps to CDM structure',
  () => {
    it('reads Word headings, bold, italic and links (and drops a script link)', () => {
      expect(outline(read(SAMPLES['word-text']))).toEqual([
        'Heading1: Quarterly review',
        'p: The team **finished early** and _under budget_. See the [full report](https://example.com/report).',
        'Heading2: Next steps',
        'p: Write to [the lead](mailto:lead@example.com) or open [the appendix](#_Toc1234).',
        'p: Do not follow this link.',
      ]);
    });

    it('reads Google Docs headings and spans, with its wrapper bold turned off', () => {
      expect(outline(read(SAMPLES['gdocs-text']))).toEqual([
        'Heading1: Meeting notes',
        'p: We agreed to **ship on Friday** and _review later_. Details: [the plan](https://example.com/plan).',
        'Heading3: Actions',
      ]);
    });

    it('reads Word list paragraphs as bullets and numbers by level, without the marker text', () => {
      const fragment = read(SAMPLES['word-lists']);
      expect(outline(fragment)).toEqual([
        'PastedBullets@0: Apples',
        'PastedBullets@1: Green ones',
        'PastedBullets@0: Pears',
        'PastedNumbered@0: First **step**',
        'PastedNumbered@0: Second step',
      ]);
      const ids = fragment.content.map(
        (b) => (b.attrs?.['numbering'] as { listId: string }).listId,
      );
      expect(new Set(ids.slice(0, 3)).size, 'one bullet list').toBe(1);
      expect(new Set(ids.slice(3)).size, 'one numbered list').toBe(1);
      expect(ids[0]).not.toBe(ids[3]);
      expect(fragment.defs.map((d) => d.attrs?.['id'])).toEqual([
        'PastedBullets',
        'PastedNumbered',
      ]);
    });

    it('reads Google Docs lists, nested by aria-level, in one list instance', () => {
      const fragment = read(SAMPLES['gdocs-lists']);
      expect(outline(fragment)).toEqual([
        'PastedBullets@0: Milk',
        'PastedBullets@1: Oat, **not** soy',
        'PastedBullets@0: Bread',
        'PastedNumbered@0: Preheat',
        'PastedNumbered@0: Bake',
      ]);
      const ids = fragment.content.map(
        (b) => (b.attrs?.['numbering'] as { listId: string }).listId,
      );
      expect(new Set(ids.slice(0, 3)).size, 'the nested list shares its parent list').toBe(1);
      expect(new Set(ids.slice(3)).size).toBe(1);
      expect(ids[0]).not.toBe(ids[3]);
    });

    it('reads a Word table with a merged cell', () => {
      expect(outline(read(SAMPLES['word-table']))).toEqual([
        'table grid=[4513,4513]',
        '**Item** | **Count**',
        'Widgets | 12',
        '_Merged footer_{colspan=2}',
      ]);
    });

    it('reads a Google Docs table with a row span, padding the cell the span leaves', () => {
      expect(outline(read(SAMPLES['gdocs-table']))).toEqual([
        'table grid=[3008,3008,3008]',
        '**Name** | **Role** | **Notes**',
        'Ada | Lead | _Shared note_{rowspan=2}',
        'Grace | ',
      ]);
    });

    it('leaves no vendor markup in any sample', () => {
      for (const [name, html] of Object.entries(SAMPLES)) {
        const json = JSON.stringify(read(html));
        expect(json, name).not.toMatch(
          /docs-internal|mso-|Mso|<o:p|font-weight|font-family|xmlns|StartFragment|supportLists|&nbsp;|\u00a0|javascript:/,
        );
      }
    });

    it('pastes every sample into a document that still validates, with the heading styles and lists', () => {
      for (const [name, html] of Object.entries(SAMPLES)) {
        const core = new DocumentCore({
          doc: styledDocument(),
          schedule: (run) => queueMicrotask(run),
        });
        const ic = internals(core);
        let caret = 0;
        ic.state.doc.descendants((node, pos) => {
          if (caret === 0 && node.isTextblock && node.textContent.length > 0) caret = pos + 1;
          return caret === 0;
        });
        ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, caret)));
        // The fixture document has two violations of its own (reserved style ids); the paste adds none.
        const before = validate(core.getContent()).violations.map((v) => v.code);
        const fragment = read(html);
        expect(core.pasteFromClipboard({ html, foreign: fragment }), name).toEqual({ ok: true });
        expect(
          validate(core.getContent()).violations.map((v) => v.code),
          name,
        ).toEqual(before);
        const doc = internals(core).state.doc;
        const styles = new Set<string>();
        const numberings = new Set<string>();
        let tables = 0;
        doc.descendants((node) => {
          if (node.type.name === 'table') tables++;
          const style = node.attrs['style'];
          if (node.type.name === 'paragraph' && typeof style === 'string') styles.add(style);
          const n = node.attrs['numbering'] as { numberingId?: string } | null | undefined;
          if (n?.numberingId) numberings.add(n.numberingId);
          return true;
        });
        if (name === 'word-text')
          expect([...styles], name).toEqual(expect.arrayContaining(['Heading1', 'Heading2']));
        if (name === 'gdocs-text')
          // The fixture has no Heading3 style, so that heading pastes as plain (CDM-023).
          expect([...styles], name).toContain('Heading1');
        if (name.endsWith('-lists'))
          expect([...numberings].sort(), name).toEqual(['PastedBullets', 'PastedNumbered']);
        if (name.endsWith('-table')) expect(tables, name).toBe(1);
      }
    });
  },
);
