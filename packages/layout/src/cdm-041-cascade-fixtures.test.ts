/**
 * CDM-041 criterion 7, layout side (Node.js): the layout engine runs every case of
 * `packages/model/fixtures/semantics/cascade.json` through `toFlow`, and the flow paragraph it
 * makes carries the fixture's values. `flow.ts` has no cascade of its own: it calls the model's
 * `resolveParagraph`, `resolveRun` and `resolveLabelRun`, and this test reads what comes out of the
 * engine, in the engine's units (points) and names.
 *
 * The flow does not carry every property. Those it does not carry are listed in `NOT_IN_FLOW`, and
 * the test fails when a fixture expects a property that is neither compared nor listed there.
 */
import { describe, expect, it } from 'vitest';
import cascadeFile from '../../model/fixtures/semantics/cascade.json' with { type: 'json' };
import {
  flowParagraphs,
  toFlow,
  type CdmEnvelopeLike,
  type FlowFont,
  type FlowParagraph,
} from './flow.ts';

type J = Record<string, unknown>;

interface CascadeCase {
  id: string;
  description: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  paragraph: J;
  context?: { tableStyle?: string };
  marks?: J[];
  expected: { error?: string; styleId?: string; paragraph?: J; run?: J; labelRun?: J };
}

interface CascadeFile {
  settings: J;
  styles: J[];
  numberings: J[];
  cases: CascadeCase[];
}

const file = cascadeFile as unknown as CascadeFile;
const PARAGRAPH_ID = 'p00xxxxxxxxxxxxx';

/** Properties a flow paragraph or its fonts do not carry: the painter and later stories read them. */
const NOT_IN_FLOW = new Set([
  'paragraph.dir',
  'paragraph.borders',
  'paragraph.shading',
  'paragraph.contextualSpacing',
  'run.smallCaps',
  'run.highlight',
  'run.lang',
]);

/** Fixture definitions, overridden by the case's own definitions with the same `id`. */
function mergeById(base: readonly J[], extra: readonly J[] = []): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The document of one case, assembled as the fixture's `format` says. */
function documentOf(c: CascadeCase): CdmEnvelopeLike {
  const paragraph = {
    type: 'paragraph',
    attrs: { id: PARAGRAPH_ID, ...c.paragraph },
    content: [{ type: 'text', text: 'Text', ...(c.marks ? { marks: c.marks } : {}) }],
  };
  const tableStyle = c.context?.tableStyle;
  const block = tableStyle
    ? {
        type: 'table',
        attrs: { id: 'tablexxxxxxxxxxx', style: tableStyle, grid: [9000] },
        content: [
          {
            type: 'table_row',
            attrs: { id: 'rowxxxxxxxxxxxxx' },
            content: [
              { type: 'table_cell', attrs: { id: 'cellxxxxxxxxxxxx' }, content: [paragraph] },
            ],
          },
        ],
      }
    : paragraph;
  return {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { ...file.settings, ...c.settings } },
            ...mergeById(file.styles, c.styles),
            ...mergeById(file.numberings, c.numberings),
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: [block] },
      ],
    },
  } as unknown as CdmEnvelopeLike;
}

/** The flow paragraph the engine makes for the case's paragraph. */
function flowOf(c: CascadeCase): FlowParagraph {
  const flow = toFlow(documentOf(c));
  const all = flow.sections.flatMap((s) => [...flowParagraphs(s.blocks)]);
  const found = all.find((p) => p.id === PARAGRAPH_ID);
  if (!found) throw new Error(`the flow has no paragraph for ${c.id}`);
  return found;
}

const ALIGN: Record<string, string> = {
  start: 'left',
  end: 'right',
  center: 'center',
  justify: 'justify',
  distribute: 'distribute',
};

/** Compares one expected paragraph property with the flow paragraph. Returns false when not carried. */
function checkParagraph(p: FlowParagraph, expected: J, key: string): boolean {
  const v = expected[key];
  switch (key) {
    case 'align':
      expect(p.align, key).toBe(ALIGN[v as string]);
      return true;
    case 'indentLeft':
    case 'indentRight':
    case 'indentFirstLine':
    case 'spaceBefore':
    case 'spaceAfter':
      expect(p[key], key).toBe((v as number) / 20);
      return true;
    case 'keepNext':
    case 'keepLines':
    case 'pageBreakBefore':
    case 'widowControl':
      expect(p[key], key).toBe(v);
      return true;
    case 'lineRule':
      expect(p.line.rule, key).toBe(v);
      return true;
    case 'lineSpacing':
      if (p.line.rule === 'multiple') expect(p.line.factor, key).toBe((v as number) / 1000);
      else expect(p.line.pt, key).toBe((v as number) / 20);
      return true;
    case 'tabs':
      expect(p.tabs, key).toEqual(
        (v as { position: number; align: string; leader: string }[]).map((t) => ({
          position: t.position / 20,
          align: t.align,
          leader: t.leader,
        })),
      );
      return true;
    default:
      return false;
  }
}

/** Compares one expected run property with a flow font. Returns false when the font does not carry it. */
function checkFont(font: FlowFont, expected: J, key: string): boolean {
  const v = expected[key];
  switch (key) {
    case 'fontFamily':
      // Null means "no layer names a font": the engine then uses its default face.
      if (v !== null) expect(font.family, key).toBe(v);
      return true;
    case 'fontSize':
      expect(font.sizePt, key).toBe((v as number) / 20);
      return true;
    case 'bold':
    case 'italic':
    case 'strike':
    case 'color':
      expect(font[key], key).toBe(v);
      return true;
    case 'underline':
      expect(font.underline, key).toBe(v !== 'none');
      return true;
    case 'vertAlign':
      expect(font.vertAlign, key).toBe(v === 'baseline' ? null : v);
      return true;
    default:
      return false;
  }
}

describe('cascade fixtures through the layout engine (CDM-041 criterion 7)', () => {
  const uncompared = new Set<string>();

  for (const c of file.cases)
    it(`${c.id}: ${c.description}`, () => {
      if (c.expected.error) {
        // The resolver's typed error does not stop the layout: the paragraph is still laid out.
        expect(flowOf(c).inlines.some((i) => i.kind === 'text' && i.text === 'Text')).toBe(true);
        return;
      }
      const p = flowOf(c);
      if (c.expected.styleId) expect(p.styleId).toBe(c.expected.styleId);
      for (const key of Object.keys(c.expected.paragraph ?? {}))
        if (!checkParagraph(p, c.expected.paragraph ?? {}, key)) uncompared.add(`paragraph.${key}`);

      const run = c.expected.run ?? {};
      const text = p.inlines.find((i) => i.kind === 'text' && i.role === 'text');
      if (run['hidden'] === true) {
        // Hidden text is not laid out.
        expect(text).toBeUndefined();
      } else if (Object.keys(run).length > 0) {
        if (!text || text.kind !== 'text') throw new Error('the paragraph has no text run');
        for (const key of Object.keys(run)) {
          if (key === 'hidden') continue;
          if (key === 'allCaps') expect(text.text, key).toBe(run[key] ? 'TEXT' : 'Text');
          else if (!checkFont(text.font, run, key)) uncompared.add(`run.${key}`);
        }
      }

      const labelRun = c.expected.labelRun ?? {};
      if (Object.keys(labelRun).length > 0) {
        const label = p.inlines.find((i) => i.kind === 'text' && i.role === 'label');
        if (!label || label.kind !== 'text') throw new Error('the paragraph has no label');
        for (const key of Object.keys(labelRun))
          if (!checkFont(label.font, labelRun, key)) uncompared.add(`labelRun.${key}`);
      }
    });

  it('compares every expected property the flow carries', () => {
    expect([...uncompared].filter((k) => !NOT_IN_FLOW.has(k))).toEqual([]);
  });
});
