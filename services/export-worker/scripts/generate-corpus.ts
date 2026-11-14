/**
 * Generates the spike S4 measurement documents: valid CDM of roughly 1, 20 and 100 pages
 * (SPK-017). The text is made from a fixed word list with a seeded generator, so the files are
 * reproducible and carry no third-party text. Every document is checked with
 * `@docedit/model/validate` before it is written.
 *
 *   node services/export-worker/scripts/generate-corpus.ts [output directory]
 *
 * The measurement script reads any directory of `*.cdm.json`, so the shared corpus of FND-006
 * (packages/corpus) can replace these files without code changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CdmEnvelope,
  InlineNode,
  ParagraphNode,
  TableNode,
  TableRowNode,
} from '@docedit/model';
import { CDM1 } from '@docedit/model/definition';
import { validate } from '@docedit/model/validate';
import { mathGate } from '@docedit/export-latex';

const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', 'fixtures', 's4-corpus'));

/**
 * CDM-001 changes a footnote's content from inline nodes to one paragraph. The documents follow
 * whatever the model's definition says, and the paragraph identifiers come from a generator of
 * their own, so that the text of the documents is the same in both shapes.
 */
const FOOTNOTE_PARAGRAPHS = (CDM1.nodes.find((n) => n.name === 'footnote')?.content ?? '').includes(
  'paragraph',
);
let footnoteIds: Gen;

// Mulberry32: small, seeded, deterministic.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'the of and to in a is that for it as was with be by on not he this are or his from at which ' +
  'but have an they you were their one all we can her has there been if more when will would who ' +
  'so no other its about out many them then these may only some could into time two first also ' +
  'any new like our now over such even most after where through back years way well much before ' +
  'right three down own between each long great still last under must same another while state ' +
  'system public order part number report party policy service level clause schedule contract ' +
  'agreement supplier customer payment period notice term section review approval budget invoice ' +
  'delivery quality standard document change request owner region version record evidence audit ' +
  'access account market growth figure table value result method measure process project'
).split(' ');

const ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

class Gen {
  readonly r: () => number;
  private ids = new Set<string>();
  constructor(seed: number) {
    this.r = rng(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.r() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }
  id(): string {
    for (;;) {
      let s = '';
      for (let i = 0; i < 16; i++) s += ID[Math.floor(this.r() * 64)];
      if (!this.ids.has(s)) {
        this.ids.add(s);
        return s;
      }
    }
  }
  sentence(): string {
    const n = this.int(8, 22);
    const w: string[] = [];
    for (let i = 0; i < n; i++) w.push(this.pick(WORDS));
    const s = w.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + (this.r() < 0.1 ? '?' : '.');
  }
  sentences(n: number): string {
    return Array.from({ length: n }, () => this.sentence()).join(' ');
  }
}

const text = (t: string, marks?: unknown[]): InlineNode =>
  (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t }) as InlineNode;

function para(
  g: Gen,
  style: string,
  content: InlineNode[],
  extra: Record<string, unknown> = {},
): ParagraphNode {
  return { type: 'paragraph', attrs: { id: g.id(), style, ...extra }, content } as ParagraphNode;
}

/** A body paragraph with some formatting, sometimes a footnote, a link or inline math. */
function richParagraph(g: Gen, n: number): ParagraphNode {
  const parts: InlineNode[] = [text(g.sentences(g.int(1, 2)) + ' ')];
  const k = n % 7;
  if (k === 0)
    parts.push(text(g.sentence(), [{ type: 'bold', attrs: { value: true } }]), text(' '));
  if (k === 1)
    parts.push(text(g.sentence(), [{ type: 'italic', attrs: { value: true } }]), text(' '));
  if (k === 2)
    parts.push(
      text('underlined words', [{ type: 'underline', attrs: { style: 'single' } }]),
      text(' and '),
      text('struck words', [{ type: 'strike', attrs: { value: true } }]),
      text('. '),
    );
  if (k === 3)
    parts.push(
      text('a coloured phrase', [{ type: 'color', attrs: { value: '#1F5FAD' } }]),
      text(', '),
      text('highlighted', [{ type: 'highlight', attrs: { value: 'yellow' } }]),
      text(' and '),
      text('Small Capitals', [{ type: 'smallCaps', attrs: { value: true } }]),
      text('. '),
    );
  if (k === 4)
    parts.push(
      text('See '),
      text('the public register', [
        { type: 'link', attrs: { href: 'https://example.org/register?id=42&view=full#top' } },
      ]),
      text(' for details. '),
    );
  if (k === 5)
    parts.push(
      text('The rate is '),
      { type: 'equation', attrs: { latex: 'r = \\frac{a}{b} + x^2' } } as InlineNode,
      text(' per period. '),
    );
  if (k === 6)
    parts.push(
      text('larger text', [{ type: 'fontSize', attrs: { value: 280 } }]),
      text(' in a run. '),
    );
  parts.push(text(g.sentences(g.int(2, 5))));
  if (n % 5 === 0) {
    const id = g.id();
    const inline = [text(g.sentence())];
    parts.push({
      type: 'footnote',
      attrs: { id },
      content: FOOTNOTE_PARAGRAPHS
        ? [
            {
              type: 'paragraph',
              attrs: { id: footnoteIds.id(), style: 'FootnoteText' },
              content: inline,
            },
          ]
        : inline,
    } as unknown as InlineNode);
    parts.push(text(' ' + g.sentence()));
  }
  return para(g, 'Normal', parts);
}

function table(g: Gen, rows: number, cols: number, headerRows: number): TableNode {
  const grid = Array.from({ length: cols }, () => Math.floor(9000 / cols));
  const mk = (header: boolean): TableRowNode =>
    ({
      type: 'table_row',
      attrs: { id: g.id() },
      content: Array.from({ length: cols }, (_, c) => ({
        type: 'table_cell',
        attrs: { id: g.id() },
        content: [
          para(g, 'Normal', [
            text(header ? `Column ${c + 1}` : g.sentences(1).slice(0, g.int(10, 70))),
          ]),
        ],
      })),
    }) as TableRowNode;
  return {
    type: 'table',
    attrs: {
      id: g.id(),
      grid,
      headerRows,
      borders: {
        top: { style: 'single' },
        bottom: { style: 'single' },
        insideH: { style: 'single' },
        insideV: { style: 'single' },
      },
    },
    content: [
      ...Array.from({ length: headerRows }, () => mk(true)),
      ...Array.from({ length: rows }, () => mk(false)),
    ],
  } as TableNode;
}

function section(g: Gen, s: number, lists: { bullet: string; number: string }): unknown[] {
  const out: unknown[] = [];
  out.push(
    para(g, 'Heading1', [
      text(
        `${g.pick(['Scope', 'Terms', 'Payment', 'Delivery', 'Review', 'Notices', 'Records', 'Audit'])} ${s + 1}`,
      ),
    ]),
  );
  for (let i = 0; i < 3; i++) out.push(richParagraph(g, s * 10 + i));
  if (s % 2 === 0) {
    const listId = g.id();
    for (let i = 0; i < 4; i++)
      out.push(
        para(g, 'Normal', [text(g.sentence())], {
          numbering: { numberingId: lists.bullet, level: i === 2 ? 1 : 0, listId },
        }),
      );
  } else {
    const listId = g.id();
    for (let i = 0; i < 4; i++)
      out.push(
        para(g, 'Normal', [text(g.sentence())], {
          numbering: { numberingId: lists.number, level: i === 2 ? 1 : 0, listId },
        }),
      );
  }
  out.push(para(g, 'Heading2', [text(`Details of part ${s + 1}`)]));
  out.push(richParagraph(g, s * 10 + 5));
  if (s % 3 === 0) out.push(table(g, 5, 3, 1));
  if (s % 4 === 1)
    out.push({
      type: 'equation_block',
      attrs: { id: g.id(), latex: '\\sum_{i=1}^{n} x_i = \\frac{n(n+1)}{2}', numbered: true },
    });
  out.push(richParagraph(g, s * 10 + 6));
  out.push(para(g, 'Quote', [text(g.sentences(2))]));
  return out;
}

function document(
  name: string,
  seed: number,
  sections: number,
  longTableRows: number,
): CdmEnvelope {
  const g = new Gen(seed);
  footnoteIds = new Gen(seed * 7919 + 13);
  const bullet = 'bulletList';
  const number = 'numberedList';
  const footer = g.id();
  const header = g.id();
  const body: unknown[] = [];
  body.push(para(g, 'Title', [text(`Measurement document ${name}`)]));
  if (sections > 0) body.push({ type: 'toc', attrs: { id: g.id(), minLevel: 1, maxLevel: 2 } });
  body.push(
    para(g, 'Normal', [
      text(
        'Characters TeX treats specially print as typed: \\ { } $ & # _ % ^ ~ and [brackets], -- and --- stay as typed,' +
          String.fromCharCode(0xa0) +
          'no-break spaces stay, and  double  spaces  stay.',
      ),
    ]),
  );
  if (sections === 0) {
    // The one-page document: a heading, three paragraphs and a short list.
    body.push(para(g, 'Heading1', [text('Scope')]));
    for (let i = 0; i < 3; i++) body.push(richParagraph(g, i));
    const listId = g.id();
    for (let i = 0; i < 3; i++)
      body.push(
        para(g, 'Normal', [text(g.sentence())], {
          numbering: { numberingId: number, level: 0, listId },
        }),
      );
  }
  for (let s = 0; s < sections; s++) {
    const content = section(g, s, { bullet, number });
    // Every third section sits in a region, which must leave no trace in the output (09 §3.1).
    if (s % 3 === 2)
      body.push({
        type: 'region',
        attrs: { id: g.id(), title: `Region ${s}`, policy: 'restricted' },
        content,
      });
    else body.push(...content);
    if (s % 3 === 2) body.push(para(g, 'Normal', [text(g.sentence())]));
  }
  if (longTableRows > 0) {
    body.push(para(g, 'Heading1', [text('Schedule of rates')]));
    body.push(table(g, longTableRows, 4, 1));
    body.push(para(g, 'Normal', [text('End of schedule.')]));
  }
  if (sections > 0) body.push(para(g, 'Normal', [text(g.sentences(2))], { pageBreakBefore: true }));
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Noto Serif',
                fontSize: 220,
                spaceAfter: 160,
                lineSpacing: 1150,
                lineRule: 'multiple',
                align: 'justify',
                widowControl: true,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Title',
                kind: 'paragraph',
                name: 'Title',
                builtIn: true,
                basedOn: 'Normal',
                fontFamily: 'Noto Sans',
                fontSize: 480,
                bold: true,
                spaceAfter: 240,
                align: 'start',
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Heading1',
                kind: 'paragraph',
                name: 'Heading 1',
                builtIn: true,
                basedOn: 'Normal',
                next: 'Normal',
                outlineLevel: 1,
                fontFamily: 'Noto Sans',
                fontSize: 320,
                bold: true,
                spaceBefore: 360,
                spaceAfter: 120,
                keepNext: true,
                align: 'start',
                color: '#1F3864',
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Heading2',
                kind: 'paragraph',
                name: 'Heading 2',
                builtIn: true,
                basedOn: 'Heading1',
                next: 'Normal',
                outlineLevel: 2,
                fontSize: 260,
                spaceBefore: 240,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Quote',
                kind: 'paragraph',
                name: 'Quote',
                builtIn: true,
                basedOn: 'Normal',
                italic: true,
                indentLeft: 720,
                indentRight: 720,
                align: 'start',
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'FootnoteText',
                kind: 'paragraph',
                name: 'Footnote Text',
                builtIn: true,
                basedOn: 'Normal',
                fontSize: 180,
                spaceAfter: 0,
                lineSpacing: 1000,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Footer',
                kind: 'paragraph',
                name: 'Footer',
                builtIn: true,
                basedOn: 'Normal',
                fontSize: 180,
                align: 'center',
                spaceAfter: 0,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Header',
                kind: 'paragraph',
                name: 'Header',
                builtIn: true,
                basedOn: 'Normal',
                fontSize: 180,
                align: 'end',
                spaceAfter: 0,
                color: '#595959',
              },
            },
            {
              type: 'numbering_def',
              attrs: {
                id: bullet,
                name: 'Bullets',
                levels: [
                  {
                    format: 'bullet',
                    text: '',
                    start: 1,
                    bulletChar: '•',
                    indentLeft: 720,
                    hanging: 360,
                  },
                  // '◦' (U+25E6) is in the published bullet list but not in Noto Serif; the class
                  // makes a missing glyph an error (09 §3.2), so the corpus uses an en dash here.
                  {
                    format: 'bullet',
                    text: '',
                    start: 1,
                    bulletChar: '–',
                    indentLeft: 1440,
                    hanging: 360,
                  },
                ],
              },
            },
            {
              type: 'numbering_def',
              attrs: {
                id: number,
                name: 'Numbers',
                levels: [
                  { format: 'decimal', text: '%1.', start: 1, indentLeft: 720, hanging: 360 },
                  { format: 'lowerLetter', text: '(%2)', start: 1, indentLeft: 1440, hanging: 432 },
                ],
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
                headerDefault: header,
                footerDefault: footer,
              },
            },
          ],
        },
        {
          type: 'story',
          attrs: { id: header, kind: 'header' },
          content: [para(g, 'Header', [text(`Measurement document ${name}`)])],
        },
        {
          type: 'story',
          attrs: { id: footer, kind: 'footer' },
          content: [
            para(g, 'Footer', [
              text('Page '),
              { type: 'field', attrs: { kind: 'page' } } as InlineNode,
              text(' of '),
              { type: 'field', attrs: { kind: 'pageCount' } } as InlineNode,
            ]),
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  } as unknown as CdmEnvelope;
}

const docs: Array<[string, number, number, number]> = [
  ['s4-01p', 1, 0, 0],
  ['s4-20p', 20, 11, 40],
  ['s4-100p', 100, 56, 160],
];

mkdirSync(outDir, { recursive: true });
for (const [name, seed, sections, longRows] of docs) {
  const env = document(name, seed, sections, longRows);
  const result = validate(env, {
    attachedAssets: new Set(),
    retiredRegionIds: new Set(),
    mathGate: (latex, display) => {
      const r = mathGate(latex, display);
      return r.ok ? null : r.reason;
    },
  });
  if (!result.valid) {
    console.error(name, JSON.stringify(result.violations.slice(0, 10), null, 2));
    process.exit(1);
  }
  writeFileSync(join(outDir, `${name}.cdm.json`), JSON.stringify(env) + '\n');
  console.log(
    `${name}: valid, ${JSON.stringify(env).length} bytes, not checked: ${result.notChecked.join('; ') || 'none'}`,
  );
}
