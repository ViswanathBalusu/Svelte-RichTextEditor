/**
 * FE-077 criterion 6: the flow conversion conforms to the shared fixtures of `packages/model`
 * (`fixtures/semantics`, ADR 0032). The conversion consumes those that name a property a flow
 * block carries; each is run by one test file of this package, and this file runs the three that
 * had no consumer: the `seq` fields and numbered equations (`numbering-sequences.json`), the text of
 * `ref` fields (`numbering-references.json`) and the labels of a projection
 * (`numbering-projections.json`, owner decision 11: the full document's numbers).
 *
 * The roster at the end fails when a fixture file is neither consumed by a named test of this
 * package nor listed with the reason it is not a conversion rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import projections from '@docedit/model/fixtures/semantics/numbering-projections.json' with { type: 'json' };
import references from '@docedit/model/fixtures/semantics/numbering-references.json' with { type: 'json' };
import sequences from '@docedit/model/fixtures/semantics/numbering-sequences.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import {
  toFlow,
  type CdmEnvelopeLike,
  type CdmNode,
  type FlowBlock,
  type FlowDocument,
  type ToFlowOptions,
} from './flow.ts';

type J = Record<string, unknown>;

interface DocFile {
  settings?: J;
  styles?: J[];
  numberings?: J[];
}
interface Case {
  id: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
}

/** A case's own entries replace the file's with the same identifier, as in the model's tests. */
function mergeById(base: readonly J[], extra: readonly J[]): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The envelope of a case, assembled as the file's `format` says. */
function envelopeOf(file: DocFile, c: Case): CdmEnvelopeLike {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { ...file.settings, ...c.settings } },
          ...mergeById(file.styles ?? [], c.styles ?? []),
          ...mergeById(file.numberings ?? [], c.numberings ?? []),
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      ...(c.stories ?? []),
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: c.body ?? [] },
    ],
  };
  return { doc: doc as unknown as CdmNode };
}

function walk(blocks: readonly FlowBlock[], visit: (b: FlowBlock) => void): void {
  for (const b of blocks) {
    visit(b);
    if (b.kind === 'table')
      for (const row of b.rows) for (const cell of row.cells) walk(cell.blocks, visit);
  }
}

/** Every block of the flow: the body, the stories and the footnotes. */
function everyBlock(flow: FlowDocument, visit: (b: FlowBlock) => void): void {
  for (const section of flow.sections) walk(section.blocks, visit);
  for (const story of flow.stories.values()) walk(story, visit);
  for (const note of flow.notes.values()) walk(note.blocks, visit);
}

/** What the flow prints: numbers as literal text. A no-break space stands for an empty text. */
const plain = (text: string): string => text.replaceAll(String.fromCharCode(0xa0), ' ').trim();

interface Printed {
  /** Labels of numbered paragraphs, by paragraph identifier. */
  lists: Record<string, string>;
  /** `seq` field texts, by holding block, in order. */
  sequences: Record<string, string[]>;
  /** Numbers of equation blocks, by identifier. */
  equations: Record<string, string>;
  /** Footnote marks, by footnote identifier. */
  footnotes: Record<string, string>;
  /** `ref` field texts, in document order of the flow. */
  refs: string[];
}

function printed(flow: FlowDocument): Printed {
  const out: Printed = { lists: {}, sequences: {}, equations: {}, footnotes: {}, refs: [] };
  // The label of a footnote's first paragraph is the footnote's mark, which is read from `notes`.
  const inNotes = new Set<FlowBlock>();
  for (const note of flow.notes.values()) walk(note.blocks, (b) => inNotes.add(b));
  everyBlock(flow, (b) => {
    if (b.kind === 'box' && b.number !== undefined) out.equations[b.id] = b.number;
    if (b.kind !== 'paragraph') return;
    for (const i of b.inlines) {
      if (i.kind !== 'text') continue;
      if (i.role === 'label' && b.part === 0 && !inNotes.has(b)) out.lists[b.id] = i.text;
      if (i.role === 'field' && i.ref === 'seq') (out.sequences[b.id] ??= []).push(plain(i.text));
      if (i.role === 'field' && (i.ref === 'ref' || i.ref === 'styleRef'))
        out.refs.push(plain(i.text));
    }
  });
  for (const [id, note] of flow.notes) out.footnotes[id] = note.label;
  return out;
}

const fileOf = (f: unknown): DocFile => f as DocFile;

describe('seq fields and numbered equations (numbering-sequences.json)', () => {
  const file = sequences as unknown as DocFile & {
    cases: (Case & {
      expected: {
        sequences?: { holder: string; texts: string[] }[];
        equations?: { id: string; text: string }[];
      };
    })[];
  };
  for (const c of file.cases)
    it(`prints the numbers of ${c.id}`, () => {
      const got = printed(toFlow(envelopeOf(fileOf(file), c)));
      const sequencesWanted = Object.fromEntries(
        (c.expected.sequences ?? []).map((e) => [e.holder, e.texts]),
      );
      expect(got.sequences).toEqual(sequencesWanted);
      for (const e of c.expected.equations ?? []) expect(got.equations[e.id], e.id).toBe(e.text);
      expect(Object.keys(got.equations).sort()).toEqual(
        (c.expected.equations ?? []).map((e) => e.id).sort(),
      );
    });
});

describe('ref fields (numbering-references.json)', () => {
  const file = references as unknown as DocFile & {
    cases: (Case & { expected: { references?: { target: string; text: string | null }[] } })[];
  };
  for (const c of file.cases)
    it(`prints what a ref field prints for ${c.id}`, () => {
      const got = printed(toFlow(envelopeOf(fileOf(file), c)));
      const wanted = c.expected.references ?? [];
      // One ref field per expected target, in the order of the body.
      expect(got.refs).toHaveLength(wanted.length);
      wanted.forEach((w, i) => {
        // A target that carries no label keeps the field's own text (here no cached text: `?`).
        expect(got.refs[i], w.target).toBe(w.text ?? '?');
      });
    });
});

describe('a projection prints the full document numbers (numbering-projections.json)', () => {
  const file = projections as unknown as DocFile & {
    cases: (Case & {
      effects: NonNullable<ToFlowOptions['effects']>;
      expected: Wanted;
      expectedWithoutEffects: Wanted;
    })[];
  };
  interface Wanted {
    lists?: { id: string; text: string }[];
    sequences?: { holder: string; texts: string[] }[];
    footnotes?: { id: string; text: string }[];
  }
  const asPrinted = (w: Wanted): Pick<Printed, 'lists' | 'sequences' | 'footnotes'> => ({
    lists: Object.fromEntries((w.lists ?? []).map((e) => [e.id, e.text])),
    sequences: Object.fromEntries((w.sequences ?? []).map((e) => [e.holder, e.texts])),
    footnotes: Object.fromEntries((w.footnotes ?? []).map((e) => [e.id, e.text])),
  });
  const subset = (p: Printed): Pick<Printed, 'lists' | 'sequences' | 'footnotes'> => ({
    lists: p.lists,
    sequences: p.sequences,
    footnotes: p.footnotes,
  });
  for (const c of file.cases) {
    it(`${c.id}: with the effects the labels are the full document's`, () => {
      const flow = toFlow(envelopeOf(fileOf(file), c), { effects: c.effects });
      const want = asPrinted(c.expected);
      const got = subset(printed(flow));
      expect(got.lists).toEqual(want.lists);
      expect(got.sequences).toEqual(want.sequences);
      expect(got.footnotes).toEqual(want.footnotes);
    });
    it(`${c.id}: without the effects it numbers what it holds`, () => {
      const got = subset(printed(toFlow(envelopeOf(fileOf(file), c))));
      const want = asPrinted(c.expectedWithoutEffects);
      expect(got.lists).toEqual(want.lists);
      expect(got.sequences).toEqual(want.sequences);
      expect(got.footnotes).toEqual(want.footnotes);
    });
  }
});

describe('every shared fixture has a consumer or a reason (FE-077 criterion 6)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '../../model/fixtures/semantics');
  /** The test files of this package that run each fixture file through `toFlow` or the breaker. */
  const consumers: Record<string, string> = {
    'cascade.json': 'cdm-041-cascade-fixtures.test.ts',
    'line-spacing.json': 'cdm-043-line-heights.test.ts',
    'tabs.json': 'cdm-044-tabs.test.ts',
    'paragraph-spacing.json': 'cdm-043-fixtures.test.ts',
    'header-growth.json': 'cdm-045-header-growth.test.ts',
    'numbering-lists.json': 'numbering-labels.test.ts',
    'numbering-footnotes.json': 'footnote-labels.test.ts',
    'numbering-sequences.json': 'fe-077-fixtures.test.ts',
    'numbering-references.json': 'fe-077-fixtures.test.ts',
    'numbering-projections.json': 'fe-077-fixtures.test.ts',
  };
  /** Fixtures of rules the writers apply, not the flow conversion. */
  const notConversion: Record<string, string> = {
    'whitespace.json':
      'which spaces a TeX writer writes explicitly (09 §3.2); the layout keeps every space as it is',
    'date-fields.json':
      'a date field prints the time zone of the export job, never the client (03 §7); the page view shows a stand-in',
  };

  it('lists every fixture file of the model', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files)
      expect(consumers[f] !== undefined || notConversion[f] !== undefined, f).toBe(true);
  });

  it('names consumers that exist and read their fixture', () => {
    for (const [fixture, test] of Object.entries(consumers)) {
      const source = readFileSync(join(here, test), 'utf8');
      expect(source.includes(fixture), `${test} reads ${fixture}`).toBe(true);
    }
  });
});

describe('formatting comes from the model, not from a cascade of the layout (FE-077 criterion 1)', () => {
  it('has no basedOn walk of its own in the conversion', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'flow.ts'), 'utf8');
    expect(source.includes('basedOn')).toBe(false);
    for (const name of ['resolveParagraph', 'resolveRun', 'resolveLabelRun', 'resolveTableFormat'])
      expect(source.includes(name), name).toBe(true);
  });

  const tableEnvelope = (tableAttrs: Record<string, unknown>): CdmEnvelopeLike => {
    const cell = (id: string): CdmNode => ({
      type: 'table_cell',
      attrs: { id },
      content: [{ type: 'paragraph', attrs: { id: `${id}p` }, content: [] }],
    });
    return {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'defs',
            content: [
              { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
              {
                type: 'style_def',
                attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
              },
              {
                type: 'style_def',
                attrs: {
                  id: 'BaseGrid',
                  kind: 'table',
                  name: 'Base grid',
                  borders: { top: { width: 4 } },
                },
              },
              {
                type: 'style_def',
                attrs: {
                  id: 'Grid',
                  kind: 'table',
                  name: 'Grid',
                  basedOn: 'BaseGrid',
                  cellMargins: { top: 20, right: 40, bottom: 20, left: 40 },
                },
              },
              { type: 'page_setup', attrs: { id: 'ps1' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1' },
            content: [
              {
                type: 'table',
                attrs: { id: 't1', grid: [2000], ...tableAttrs },
                content: [{ type: 'table_row', attrs: { id: 'r1' }, content: [cell('c1')] }],
              },
            ],
          },
        ],
      },
    };
  };
  const tableOf = (attrs: Record<string, unknown>) => {
    const t = toFlow(tableEnvelope(attrs)).sections[0]!.blocks[0]!;
    if (t.kind !== 'table') throw new Error('expected a table');
    return t;
  };

  it('takes a table\u2019s margins and borders from its style chain, and a direct value wins', () => {
    const styled = tableOf({ style: 'Grid' });
    expect(styled.bordered).toBe(true); // from BaseGrid, down the chain
    expect(styled.cellMargins).toEqual({ top: 1, right: 2, bottom: 1, left: 2 });
    const direct = tableOf({
      style: 'Grid',
      cellMargins: { top: 100, right: 100, bottom: 100, left: 100 },
    });
    expect(direct.cellMargins).toEqual({ top: 5, right: 5, bottom: 5, left: 5 });
    const none = tableOf({});
    expect(none.bordered).toBe(false);
  });
});
