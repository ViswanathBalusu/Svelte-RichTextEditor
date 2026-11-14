/**
 * The corpus documents (FND-006). Each recipe builds one CDM envelope from its own seeded streams,
 * so documents are independent of each other and identical from run to run.
 *
 * The documents of 20 pages and more are made of chapters. A chapter holds the ordinary mix of a
 * long report (headings, prose with footnotes, inline math and links, lists, a figure, a table, a
 * display equation, a region, CJK text) and a special unit that exercises one hard case (a table
 * longer than a page, a landscape section, two columns, a paragraph of more than 5,000 characters,
 * legal numbering in a restricted region, typography, spans, content in cells, a row taller than a
 * page, list edge cases, terms in three CJK languages). The 20-page document holds every special
 * unit once. Units of about a page are added until the page estimate reaches the target. A unit is
 * built only when it is added, so every cross-reference points at something in the document.
 */
import type {
  CdmEnvelope,
  CdmFeature,
  CdmMark,
  DocNode,
  FigureNode,
  ImageNode,
  InlineNode,
  JsonEnvelope,
  ParagraphNode,
  RoleDefNode,
  RuleDefNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@docedit/model';
import { PageEstimator } from './analyse.ts';
import {
  columnBreak,
  equation,
  field,
  image,
  lineBreak,
  mark,
  Nodes,
  pageBreak,
  tab,
  text,
  type BodyChild,
  type CaptionInline,
  type CellChild,
  type NoteInline,
  type RegionChild,
} from './cdm.ts';
import {
  buildDefinitions,
  TEXT_WIDTH,
  type Definitions,
  type DefinitionOptions,
  type PageSetups,
} from './defs.ts';
import { imageByKey, type ImageKey } from './images.ts';
import { IdSource, Rng } from './random.ts';
import {
  cjkText,
  CJK_LANG_TAGS,
  DISPLAY_EQUATIONS,
  Prose,
  SIMPLE_EQUATIONS,
  TYPOGRAPHY_SAMPLES,
  type CjkLanguage,
} from './text.ts';

export interface BuiltDocument {
  envelope: CdmEnvelope;
  /** Asset identifiers the document refers to, in order of first use (invariant I4). */
  assets: string[];
}

export interface DocumentRecipe {
  name: string;
  description: string;
  /** The length the recipe aims at, in estimated A4 pages. */
  targetPages: number;
  /** Small documents are kept in the repository; the others are generated on demand. */
  inRepository: boolean;
  build: () => BuiltDocument;
}

export type Special =
  | 'longTable'
  | 'landscape'
  | 'columns'
  | 'longParagraph'
  | 'articles'
  | 'typography'
  | 'spans'
  | 'cellContent'
  | 'tallRow'
  | 'listEdges'
  | 'cjk';

export const SPECIALS: readonly Special[] = [
  'longTable',
  'landscape',
  'columns',
  'longParagraph',
  'articles',
  'typography',
  'spans',
  'cellContent',
  'tallRow',
  'listEdges',
  'cjk',
];

/** A unit of content, built when it is added to the document. */
type Unit = () => BodyChild[];

type NoteKind = 'plain' | 'ref' | 'math' | 'link' | 'image';

const WEB = 'https://example.com/docedit/corpus';

/** Builds one document: its definitions, its body blocks and the running page estimate. */
class Writer {
  readonly nodes: Nodes;
  readonly rng: Rng;
  readonly prose: Prose;
  readonly defs: Definitions;
  readonly bodySetup: keyof PageSetups;
  readonly blocks: BodyChild[] = [];
  readonly #cjkRng: Rng;
  readonly #estimator: PageEstimator;
  readonly #assets: string[] = [];
  readonly #bookmarks = new Set<string>();
  readonly #headingIds: string[] = [];
  readonly #figureBookmarks: string[] = [];
  readonly #tableCaptionIds: string[] = [];
  readonly #equationLabels: string[] = [];
  #figures = 0;
  #tables = 0;
  #equations = 0;
  #cjk = 0;
  chapter = 0;

  constructor(name: string, bodySetup: keyof PageSetups, options: DefinitionOptions) {
    this.nodes = new Nodes(new IdSource(`docedit-corpus/${name}/ids`));
    this.rng = new Rng(`docedit-corpus/${name}/structure`);
    this.prose = new Prose(new Rng(`docedit-corpus/${name}/prose`));
    this.#cjkRng = new Rng(`docedit-corpus/${name}/cjk`);
    this.defs = buildDefinitions(this.nodes, options);
    this.bodySetup = bodySetup;
    this.#estimator = new PageEstimator(this.#doc([], [], []) as unknown as JsonEnvelope['doc']);
  }

  get styles(): Definitions['styles'] {
    return this.defs.styles;
  }

  #doc(blocks: BodyChild[], roles: RoleDefNode[], rules: RuleDefNode[]): DocNode {
    const d = this.defs;
    return {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: d.settings },
            ...d.styleDefs,
            ...d.numberingDefs,
            ...d.pageSetupDefs,
            ...roles,
            ...rules,
          ],
        },
        ...d.stories,
        { type: 'body', attrs: { pageSetup: d.pageSetups[this.bodySetup] }, content: blocks },
      ],
    };
  }

  envelope(
    requires: CdmFeature[] = [],
    roles: RoleDefNode[] = [],
    rules: RuleDefNode[] = [],
  ): BuiltDocument {
    for (const story of this.defs.stories)
      for (const block of story.content ?? [])
        if (block.type === 'paragraph')
          for (const c of block.content ?? [])
            if (c.type === 'image' && c.attrs?.asset) this.use(c.attrs.asset);
    return {
      envelope: { cdm: 1, requires, doc: this.#doc(this.blocks, roles, rules) },
      assets: [...this.#assets],
    };
  }

  emit(...blocks: BodyChild[]): void {
    for (const b of blocks) {
      this.blocks.push(b);
      this.#estimator.add(b as unknown as JsonEnvelope['doc']);
    }
  }

  pages(): number {
    return this.#estimator.pages();
  }

  /** Records an asset as attached to the document and returns its identifier. */
  use(asset: string): string {
    if (!this.#assets.includes(asset)) this.#assets.push(asset);
    return asset;
  }

  bookmark(base: string): string {
    let name = base;
    for (let i = 2; this.#bookmarks.has(name); i++) name = `${base}_${i}`;
    this.#bookmarks.add(name);
    return name;
  }

  // -------------------------------------------------------------------------------------------
  // Inline content

  /** A sentence as runs, sometimes with one marked phrase. */
  #sentenceRuns(sentence: string): InlineNode[] {
    const r = this.rng;
    if (!r.chance(0.3)) return [text(sentence)];
    const words = sentence.split(' ');
    if (words.length < 6) return [text(sentence)];
    const at = r.range(1, words.length - 3);
    const len = r.range(1, 2);
    const s = this.styles;
    const marks: CdmMark[][] = [
      [mark.bold()],
      [mark.italic()],
      [mark.charStyle('Strong')],
      [mark.charStyle('Emphasis')],
      [mark.charStyle(s.term)],
      [mark.charStyle(s.code)],
      [mark.underline()],
      [mark.bold(), mark.italic()],
    ];
    return [
      text(`${words.slice(0, at).join(' ')} `),
      text(words.slice(at, at + len).join(' '), ...r.pick(marks)),
      text(` ${words.slice(at + len).join(' ')}`),
    ];
  }

  /** Prose of at least `words` words, as runs. */
  proseRuns(words: number): InlineNode[] {
    const out: InlineNode[] = [];
    let n = 0;
    while (n < words) {
      const s = this.prose.sentence();
      if (out.length) out.push(text(' '));
      out.push(...this.#sentenceRuns(s));
      n += s.split(' ').length;
    }
    return out;
  }

  inlineImage(key: ImageKey, size: number, alt: string): ImageNode {
    return image(this.use(imageByKey(key).id), size, size, alt);
  }

  footnote(kind: NoteKind = 'plain'): InlineNode {
    const content: NoteInline[] = [text(this.prose.sentence())];
    switch (kind) {
      case 'ref': {
        const target = this.#headingIds[this.rng.int(this.#headingIds.length)];
        if (target)
          content.push(
            text(' See section '),
            field({ kind: 'ref', target: `node:${target}` }),
            text('.'),
          );
        break;
      }
      case 'math':
        content.push(text(' In symbols, '), equation(this.rng.pick(SIMPLE_EQUATIONS)), text('.'));
        break;
      case 'link':
        content.push(
          text(' More at '),
          text('example.com', mark.link(`${WEB}/notes/${this.chapter}`)),
          text('.'),
        );
        break;
      case 'image':
        content.push(
          text(' It is marked with '),
          this.inlineImage('dot', 160, 'An amber dot'),
          text('.'),
        );
        break;
      case 'plain':
        break;
    }
    return this.nodes.footnote(content);
  }

  #crossReference(): InlineNode[] {
    const r = this.rng;
    const choices: Array<() => InlineNode[]> = [];
    if (this.#headingIds.length > 1)
      choices.push(() => [
        text(' As section '),
        field({
          kind: 'ref',
          target: `node:${this.#headingIds[r.int(this.#headingIds.length - 1)]}`,
        }),
        text(' explains, this is expected.'),
      ]);
    if (this.#figureBookmarks.length)
      choices.push(() => {
        const bm = r.pick(this.#figureBookmarks);
        return [
          text(' Compare '),
          text('the figure', mark.link(`#${bm}`)),
          text(' (figure '),
          field({ kind: 'ref', target: `bookmark:${bm}` }),
          text(').'),
        ];
      });
    if (this.#tableCaptionIds.length)
      choices.push(() => [
        text(' The values are in table '),
        field({ kind: 'ref', target: `node:${r.pick(this.#tableCaptionIds)}` }),
        text('.'),
      ]);
    if (this.#equationLabels.length)
      choices.push(() => [
        text(' Equation '),
        field({ kind: 'ref', target: `eq:${r.pick(this.#equationLabels)}` }),
        text(' gives the rule.'),
      ]);
    return choices.length ? r.pick(choices)() : [];
  }

  // -------------------------------------------------------------------------------------------
  // Blocks

  heading(level: number, title: string, extra: InlineNode[] = []): ParagraphNode {
    const p = this.nodes.paragraph({ style: `Heading${level}` }, [text(title), ...extra]);
    if (level <= 2) this.#headingIds.push(p.attrs!.id!);
    return p;
  }

  /** A body paragraph of prose; options add a footnote, inline math, an image, links or a cross-reference. */
  paragraph(
    words: number,
    o: {
      note?: NoteKind;
      math?: boolean;
      image?: boolean;
      link?: boolean;
      ref?: boolean;
      style?: string;
    } = {},
  ): ParagraphNode {
    const content = this.proseRuns(words);
    if (o.math)
      content.push(
        text(' The relation '),
        equation(this.rng.pick(SIMPLE_EQUATIONS)),
        text(' holds here.'),
      );
    if (o.image)
      content.push(
        text(' The marker '),
        this.inlineImage('dot', 200, 'An amber dot'),
        text(' flags an item.'),
      );
    if (o.link)
      content.push(
        text(' Details are on the '),
        text('project page', mark.link(`${WEB}/chapter-${this.chapter}`, 'Example page')),
        text(' or by email to '),
        text('corpus@example.org', mark.link('mailto:corpus@example.org')),
        text('.'),
      );
    if (o.ref) content.push(...this.#crossReference());
    if (o.note) content.splice(Math.max(1, content.length - 1), 0, this.footnote(o.note));
    const style = o.style ?? (this.rng.chance(0.5) ? this.styles.bodyText : this.styles.bodyIndent);
    return this.nodes.paragraph({ style }, content);
  }

  figure(
    key: ImageKey,
    o: {
      float?: boolean;
      align?: 'start' | 'center' | 'end';
      width?: number;
      captionImage?: boolean;
    } = {},
  ): FigureNode {
    const img = imageByKey(key);
    const n = ++this.#figures;
    const bm = this.bookmark(`fig_${n}`);
    this.#figureBookmarks.push(bm);
    const width = o.width ?? 4320;
    const caption: CaptionInline[] = [
      text('Figure '),
      field({ kind: 'seq', name: 'Figure', cached: String(n) }),
      text(`: ${this.prose.title()}`),
      this.nodes.anchor(bm),
    ];
    if (o.captionImage)
      caption.push(text(', marked '), this.inlineImage('dot', 160, 'An amber dot'));
    return this.nodes.figure(
      {
        asset: this.use(img.id),
        width,
        height: Math.round((width * img.height) / img.width),
        alt: img.description,
        align: o.align ?? 'center',
        ...(o.float === true ? { placement: 'float' as const } : {}),
      },
      caption,
    );
  }

  /** A table caption: a paragraph in the Caption style with a `seq` field (03 §4.3). */
  tableCaption(title: string): ParagraphNode {
    const n = ++this.#tables;
    const p = this.nodes.paragraph({ style: 'Caption' }, [
      text('Table '),
      field({ kind: 'seq', name: 'Table', cached: String(n) }),
      text(`: ${title}`),
    ]);
    this.#tableCaptionIds.push(p.attrs!.id!);
    return p;
  }

  cellParagraph(content: InlineNode[], align?: 'start' | 'center' | 'end'): ParagraphNode {
    return this.nodes.paragraph(
      align ? { style: 'NoSpacing', align } : { style: 'NoSpacing' },
      content,
    );
  }

  cell(content: string | CellChild[], attrs: Parameters<Nodes['cell']>[1] = {}): TableCellNode {
    const blocks = typeof content === 'string' ? [this.cellParagraph([text(content)])] : content;
    return this.nodes.cell(blocks, attrs);
  }

  /**
   * A table in the Data Table style with a repeated header row and `rows` data rows: an item number,
   * a description, then numbers. With `numeric`, every column after the first holds a number.
   */
  dataTable(
    rows: number,
    cols: number,
    grid: number[] = evenGrid(cols),
    numeric = false,
  ): TableNode {
    const r = this.rng;
    const amount = (): TableCellNode =>
      this.cell([
        this.cellParagraph(
          [text(`${r.range(1, 999)}.${String(r.int(100)).padStart(2, '0')}`)],
          'end',
        ),
      ]);
    const header = this.nodes.row(
      grid.map((_, c) =>
        this.cell([
          this.cellParagraph([
            text(c === 0 ? 'No.' : (this.prose.title().split(' ')[1] ?? 'Value'), mark.bold()),
          ]),
        ]),
      ),
      { cantSplit: true },
    );
    const body: TableRowNode[] = [];
    for (let i = 0; i < rows; i++)
      body.push(
        this.nodes.row(
          grid.map((_, c) => {
            if (c === 0) return this.cell(String(i + 1).padStart(3, '0'));
            if (numeric || c === cols - 1) return amount();
            if (c === 1)
              return this.cell(r.chance(0.2) ? this.prose.sentence() : this.prose.phrase());
            return this.cell(this.prose.phrase());
          }),
        ),
      );
    return this.nodes.table({ style: this.styles.dataTable, grid, headerRows: 1 }, [
      header,
      ...body,
    ]);
  }

  displayEquation(): BodyChild {
    const n = ++this.#equations;
    const label = `eq-${n}`;
    this.#equationLabels.push(label);
    return this.nodes.equationBlock(
      DISPLAY_EQUATIONS[(n - 1) % DISPLAY_EQUATIONS.length]!,
      true,
      label,
    );
  }

  cjkParagraph(lang?: CjkLanguage): ParagraphNode {
    const l = lang ?? (['zh', 'ja', 'ko'] as const)[this.#cjk++ % 3]!;
    const t = cjkText(this.#cjkRng, l, this.rng.range(120, 220));
    return this.nodes.paragraph({ style: this.styles.cjkBody }, [
      text(t, mark.lang(CJK_LANG_TAGS[l])),
    ]);
  }

  bulletList(items: number): ParagraphNode[] {
    const listId = this.nodes.id();
    const out: ParagraphNode[] = [];
    let level = 0;
    for (let i = 0; i < items; i++) {
      out.push(
        this.nodes.paragraph(
          {
            style: 'ListParagraph',
            numbering: { numberingId: this.defs.numbering.bullets, level, listId },
          },
          [text(this.prose.clause())],
        ),
      );
      level = i === 0 ? 1 : this.rng.int(3) === 0 ? Math.min(level + 1, 2) : Math.max(0, level - 1);
    }
    return out;
  }

  /** Items of a numbered list on the shared definition; a new list instance unless `listId` is given. */
  numberedList(
    levels: readonly number[],
    listId = this.nodes.id(),
    restartAt?: number,
  ): ParagraphNode[] {
    return levels.map((level, i) =>
      this.nodes.paragraph(
        {
          style: 'ListParagraph',
          numbering: { numberingId: this.defs.numbering.list, level, listId },
          ...(restartAt !== undefined && i === 0 ? { numberingRestart: restartAt } : {}),
        },
        [text(`${this.prose.clause()}.`)],
      ),
    );
  }

  /** A region and the body paragraph the editing core keeps after it (03 §4.2). */
  region(title: string, policy: 'inherit' | 'restricted', content: RegionChild[]): BodyChild[] {
    return [this.nodes.region(title, policy, content), this.paragraph(40)];
  }
}

function evenGrid(cols: number, width = TEXT_WIDTH): number[] {
  const base = Math.floor(width / cols);
  return Array.from({ length: cols }, (_, i) =>
    i === cols - 1 ? width - base * (cols - 1) : base,
  );
}

// ---------------------------------------------------------------------------------------------
// Chapters

const FIGURE_KEYS: readonly ImageKey[] = [
  'bars',
  'checker',
  'rings',
  'stripes',
  'gradient',
  'noise',
];

/** The ordinary content of a chapter, in units of about a page. */
function chapterUnits(w: Writer): Unit[] {
  const r = w.rng;
  const p = w.prose;
  const k = ++w.chapter;
  return [
    () => [
      w.heading(1, p.title()),
      w.paragraph(r.range(110, 160), { note: 'plain' }),
      w.paragraph(r.range(110, 170), { math: true }),
    ],
    () => [
      w.heading(2, p.title()),
      w.paragraph(r.range(120, 180), { note: k % 3 === 0 ? 'math' : 'ref', link: true }),
      ...w.bulletList(r.range(3, 5)),
      w.paragraph(r.range(90, 140), { image: true }),
      w.figure(FIGURE_KEYS[k % FIGURE_KEYS.length]!, {
        float: k % 4 === 1,
        captionImage: k % 5 === 1,
      }),
      w.paragraph(r.range(100, 150), { ref: true }),
    ],
    () => [
      w.heading(2, p.title()),
      w.paragraph(r.range(110, 160), { note: k % 2 ? 'link' : 'image' }),
      ...w.numberedList([0, 1, 1, 2, 0, 1]),
      w.tableCaption(p.title()),
      w.dataTable(r.range(4, 7), 4),
      w.paragraph(r.range(80, 120), { ref: true }),
    ],
    () => [
      w.heading(3, p.title()),
      w.paragraph(r.range(100, 150), { note: 'ref' }),
      w.displayEquation(),
      w.paragraph(r.range(80, 130), { ref: true }),
      w.cjkParagraph(),
    ],
    () => [
      w.heading(2, p.title()),
      ...w.region(`Chapter ${k} review`, k % 2 ? 'inherit' : 'restricted', [
        w.paragraph(r.range(80, 120)),
        w.nodes.paragraph({ style: 'Quote' }, w.proseRuns(r.range(30, 50))),
        w.paragraph(r.range(80, 120), { note: 'plain' }),
      ]),
      w.paragraph(r.range(120, 170), { ref: true }),
    ],
  ];
}

function typography(w: Writer): Unit[] {
  const p = w.prose;
  const st = w.styles;
  return [
    () => [
      w.heading(2, 'Typography and direct formatting'),
      ...TYPOGRAPHY_SAMPLES.map((t) => w.nodes.paragraph({ style: st.bodyText }, [text(t)])),
      w.nodes.paragraph({ style: st.bodyText }, [
        text('Run formatting: '),
        text('strike', mark.strike()),
        text(', '),
        text('small caps', mark.smallCaps()),
        text(', '),
        text('all caps', mark.allCaps()),
        text(', '),
        text('double', mark.underline('double')),
        text(' and '),
        text('dotted', mark.underline('dotted')),
        text(' underline, H'),
        text('2', mark.sub()),
        text('O and x'),
        text('2', mark.sup()),
        text(', '),
        text('colour', mark.color('#C00000')),
        text(', '),
        text('highlight', mark.highlight('yellow')),
        text(', '),
        text('a larger size', mark.size(280)),
        text(', '),
        text('a sans-serif face', mark.font('Noto Sans')),
        text(', '),
        text('code', mark.charStyle(st.code)),
        text(' with a '),
        text('keyword', mark.charStyle(st.codeKeyword)),
        text(', '),
        text('bold switched off', mark.charStyle('Strong'), mark.notBold()),
        text(', and hidden text'),
        text(' that is not shown', mark.hidden()),
        text('.'),
      ]),
      w.nodes.paragraph(
        {
          style: 'Normal',
          tabs: [
            { position: 2880, align: 'left', leader: 'none' },
            { position: 5040, align: 'center', leader: 'none' },
            { position: 7200, align: 'decimal', leader: 'none' },
            { position: TEXT_WIDTH, align: 'right', leader: 'dot' },
          ],
        },
        [
          text('Item'),
          tab(),
          text('Left'),
          tab(),
          text('Centre'),
          tab(),
          text('12.50'),
          tab(),
          text('Right'),
          lineBreak(),
          text('Second line'),
          tab(),
          text('A'),
          tab(),
          text('B'),
          tab(),
          text('1250.5'),
          tab(),
          text('99'),
        ],
      ),
      w.nodes.paragraph({ style: st.codeBlock }, [
        text('function total(items) {'),
        lineBreak(),
        text('  return items.length;'),
        lineBreak(),
        text('}'),
      ]),
      w.nodes.paragraph({ style: st.note }, w.proseRuns(30)),
    ],
    () => [
      w.nodes.paragraph({ style: 'Normal', align: 'center', keepNext: true }, [text(p.sentence())]),
      w.nodes.paragraph({ style: 'Normal', align: 'end', indentRight: 720 }, [text(p.sentence())]),
      w.nodes.paragraph(
        { style: 'Normal', align: 'distribute', lineSpacing: 360, lineRule: 'exact' },
        [text(p.sentence())],
      ),
      w.nodes.paragraph(
        {
          style: 'Normal',
          align: 'justify',
          indentLeft: 720,
          indentFirstLine: -360,
          spaceBefore: 120,
          spaceAfter: 240,
          lineSpacing: 300,
          lineRule: 'atLeast',
          keepLines: true,
          borders: {
            top: { style: 'dashed', width: 4, color: '#7F7F7F', space: 2 },
            bottom: { style: 'double', width: 6, color: '#7F7F7F', space: 2 },
          },
          shading: { fill: '#FFF2CC' },
        },
        w.proseRuns(40),
      ),
      w.nodes.paragraph({ style: 'IntenseQuote' }, w.proseRuns(30)),
      w.nodes.paragraph({ style: 'Normal', dir: 'ltr' }, [
        text(p.sentence()),
        pageBreak(),
        text(p.sentence()),
      ]),
    ],
  ];
}

function specialUnits(w: Writer, s: Special): Unit[] {
  const r = w.rng;
  const p = w.prose;
  const st = w.styles;
  const back = w.defs.pageSetups.continued;
  switch (s) {
    case 'longTable':
      return [
        () => [
          w.heading(2, 'A table longer than a page'),
          w.paragraph(60),
          w.tableCaption(`${p.title()}, fifty rows`),
          w.dataTable(50, 4, [1100, 4326, 1800, 1800]),
        ],
        () => [w.paragraph(r.range(80, 120), { ref: true })],
      ];
    case 'landscape':
      return [
        () => [
          w.nodes.sectionBreak(w.defs.pageSetups.landscape, 'nextPage'),
          w.heading(2, 'A landscape section'),
          w.paragraph(80),
          w.tableCaption('A wide table in a landscape section'),
          w.dataTable(10, 9, evenGrid(9, 16838 - 2 * 1080), true),
          w.paragraph(60),
          w.nodes.sectionBreak(back, 'nextPage'),
          w.paragraph(r.range(60, 100)),
        ],
      ];
    case 'columns':
      return [
        () => [
          w.nodes.sectionBreak(w.defs.pageSetups.twoColumn, 'continuous'),
          w.heading(2, 'Two columns'),
          w.paragraph(120),
          w.paragraph(120, { note: 'image' }),
          w.tableCaption('A table inside a column'),
          w.nodes.table({ style: 'TableGrid', grid: [1400, 2463], headerRows: 1 }, [
            w.nodes.row([w.cell('Key'), w.cell('Value')], { cantSplit: true }),
            ...Array.from({ length: 5 }, (_, i) =>
              w.nodes.row([w.cell(`K${i + 1}`), w.cell(p.phrase())]),
            ),
          ]),
          w.nodes.paragraph({ style: st.bodyText }, [
            ...w.proseRuns(60),
            columnBreak(),
            ...w.proseRuns(40),
          ]),
          w.paragraph(120),
          w.paragraph(100),
          w.nodes.sectionBreak(back, 'continuous'),
          w.paragraph(r.range(60, 90)),
        ],
      ];
    case 'longParagraph':
      return [
        // The heading carries a footnote: a moving argument in LaTeX (09 §3.1).
        () => [
          w.heading(2, 'A very long paragraph', [w.footnote('math')]),
          w.nodes.paragraph({ style: st.bodyText }, [text(p.longParagraph(5200))]),
        ],
        () => [w.paragraph(r.range(80, 120))],
      ];
    case 'articles': {
      const listId = w.nodes.id();
      const article = (level: number, words: number): ParagraphNode =>
        w.nodes.paragraph(
          {
            style: st.bodyText,
            numbering: { numberingId: w.defs.numbering.articles, level, listId },
          },
          [text(p.paragraph(words))],
        );
      return [
        () => [
          w.heading(2, 'Terms under legal review'),
          ...w.region('Legal review', 'restricted', [
            article(0, 8),
            article(1, 40),
            article(2, 20),
            article(2, 20),
            article(1, 40),
            article(2, 20),
            article(0, 8),
            article(1, 35),
            article(2, 25),
          ]),
        ],
      ];
    }
    case 'typography':
      return typography(w);
    case 'spans':
      return [
        () => {
          const c = (t: string, attrs: Parameters<Nodes['cell']>[1] = {}): TableCellNode =>
            w.cell(t, attrs);
          const head = { shading: { fill: '#D9E2F3' }, vAlign: 'center' as const };
          const total = { shading: { fill: '#F2F2F2' } };
          return [
            w.heading(2, 'Row and column spans'),
            w.paragraph(60),
            w.tableCaption('Spans across rows and columns'),
            w.nodes.table(
              {
                style: st.plainTable,
                grid: [1800, 1806, 1806, 1806, 1808],
                headerRows: 2,
                align: 'center',
                width: { type: 'pct', value: 10000 },
              },
              [
                w.nodes.row(
                  [
                    c('Region', { ...head, rowspan: 2 }),
                    c('Quarter', { ...head, colspan: 3 }),
                    c('Total', { ...head, rowspan: 2 }),
                  ],
                  {
                    cantSplit: true,
                  },
                ),
                w.nodes.row([c('Q1', head), c('Q2', head), c('Q3', head)], { cantSplit: true }),
                w.nodes.row([
                  c('North', { rowspan: 3, vAlign: 'center' }),
                  c('12'),
                  c('15'),
                  c('11'),
                  c('38'),
                ]),
                w.nodes.row([c('9'), c('14'), c('10'), c('33')]),
                w.nodes.row([c('8'), c('7'), c('13'), c('28')]),
                w.nodes.row([c('South'), c('Not reported', { colspan: 2 }), c('6'), c('6')]),
                w.nodes.row([c('All regions', { ...total, colspan: 4 }), c('105', total)]),
              ],
            ),
            w.paragraph(r.range(60, 90), { ref: true }),
          ];
        },
      ];
    case 'cellContent':
      return [
        () => {
          const rows: TableRowNode[] = [
            w.nodes.row([w.cell('Picture'), w.cell('Equation'), w.cell('Note'), w.cell('Image')], {
              cantSplit: true,
            }),
            w.nodes.row(
              [
                w.cell([w.figure('stripes', { width: 1440 })], { vAlign: 'center' }),
                w.cell([w.nodes.equationBlock(DISPLAY_EQUATIONS[0]!, false)], { vAlign: 'center' }),
                w.cell(
                  [
                    w.cellParagraph([
                      text('A cell with a footnote'),
                      w.footnote('plain'),
                      text('.'),
                    ]),
                  ],
                  {
                    vAlign: 'bottom',
                    margins: { top: 120, bottom: 120, left: 180, right: 180 },
                  },
                ),
                w.cell(
                  [
                    w.cellParagraph([
                      text('Inline '),
                      w.inlineImage('dot', 200, 'An amber dot'),
                      text(' image.'),
                    ]),
                  ],
                  {
                    borders: {
                      top: { style: 'thick', width: 18, color: '#ED7D31', space: 0 },
                      bottom: { style: 'dotted', width: 8, color: null, space: 0 },
                    },
                    shading: { fill: '#E2EFDA' },
                  },
                ),
              ],
              { height: 1800, heightRule: 'atLeast' },
            ),
            w.nodes.row(
              [w.cell('Fixed height'), w.cell('720 twips'), w.cell('exact'), w.cell(p.phrase())],
              {
                height: 720,
                heightRule: 'exact',
              },
            ),
          ];
          return [
            w.heading(2, 'Content inside table cells'),
            w.paragraph(60),
            w.tableCaption('Figures, equations, notes and images in cells'),
            w.nodes.table(
              {
                style: 'TableGrid',
                grid: [2256, 2256, 2257, 2257],
                headerRows: 1,
                cellMargins: { left: 108, right: 108, top: 60, bottom: 60 },
              },
              rows,
            ),
            w.paragraph(r.range(60, 90)),
          ];
        },
      ];
    case 'tallRow':
      return [
        () => [
          w.heading(2, 'A row taller than a page'),
          w.paragraph(50),
          w.tableCaption('One row that does not fit on a page'),
          w.nodes.table({ style: 'TableGrid', grid: [1800, 7226] }, [
            w.nodes.row([w.cell('Row 1'), w.cell(p.phrase())]),
            w.nodes.row([
              w.cell('Row 2'),
              w.nodes.cell(Array.from({ length: 6 }, () => w.cellParagraph(w.proseRuns(70)))),
            ]),
            w.nodes.row([w.cell('Row 3'), w.cell(p.phrase())]),
          ]),
          w.paragraph(r.range(60, 90)),
        ],
      ];
    case 'cjk':
      return [
        () => {
          const zh = mark.lang(CJK_LANG_TAGS.zh);
          const ja = mark.lang(CJK_LANG_TAGS.ja);
          const ko = mark.lang(CJK_LANG_TAGS.ko);
          const terms: Array<[string, string, string, string]> = [
            ['document', '文档', '文書', '문서'],
            ['page', '页', 'ページ', '쪽'],
            ['table', '表格', '表', '표'],
            ['footnote', '脚注', '脚注', '각주'],
          ];
          const row = (cells: [string, string, string, string], header = false): TableRowNode =>
            w.nodes.row(
              [
                w.cell([w.cellParagraph([text(cells[0])])]),
                w.cell([w.cellParagraph([text(cells[1], zh)])]),
                w.cell([w.cellParagraph([text(cells[2], ja)])]),
                w.cell([w.cellParagraph([text(cells[3], ko)])]),
              ],
              header ? { cantSplit: true } : {},
            );
          return [
            w.heading(2, 'Chinese, Japanese and Korean'),
            w.cjkParagraph('zh'),
            w.nodes.paragraph({ style: 'Heading3' }, [text('日本語の見出し', ja)]),
            w.cjkParagraph('ja'),
            w.cjkParagraph('ko'),
            w.nodes.paragraph({ style: st.bodyText }, [
              text('Mixed text: '),
              text('编辑器', zh),
              text(', '),
              text('エディター', ja),
              text(' and '),
              text('편집기', ko),
              text(' all mean editor.'),
              w.nodes.footnote([text('脚注也可以包含中文。', zh)]),
            ]),
            w.tableCaption('One term in three languages'),
            w.nodes.table({ style: st.dataTable, grid: [2256, 2256, 2257, 2257], headerRows: 1 }, [
              row(['English', '中文', '日本語', '한국어'], true),
              ...terms.map((t) => row(t)),
            ]),
            w.paragraph(40),
          ];
        },
      ];
    case 'listEdges': {
      const listId = w.nodes.id();
      return [
        () => [
          w.heading(2, 'Lists across tables and levels'),
          w.paragraph(50),
          // A skipped level (0, then 2), then a table between items of the same list.
          ...w.numberedList([0, 2, 1, 0], listId),
          w.tableCaption('A table between list items'),
          w.dataTable(3, 3),
          ...w.numberedList([0, 1, 2, 3, 4], listId),
          w.paragraph(40),
          // The same list once more, restarted at 1.
          ...w.numberedList([0, 1, 0], listId, 1),
          w.paragraph(40),
          // A second list on the same definition numbers on its own (03 §4.3, listId).
          ...w.numberedList([0, 1, 2, 0]),
          w.paragraph(60, { ref: true }),
        ],
      ];
    }
  }
}

interface BookOptions {
  name: string;
  targetPages: number;
  title: string;
  /** Specials of the first chapters; later chapters take one special each, in rotation. */
  schedule: readonly Special[][];
  frontMatter: boolean;
  tocLevels: number;
}

function book(o: BookOptions): BuiltDocument {
  const w = new Writer(o.name, o.frontMatter ? 'front' : 'portrait', {
    title: o.title,
    chapterBreaks: true,
    headerVariants: true,
    hyphenation: true,
  });
  const st = w.styles;
  w.emit(
    w.nodes.paragraph({ style: 'Title' }, [text(o.title)]),
    w.nodes.paragraph({ style: 'Subtitle' }, [
      text('A generated document for layout, export and performance tests'),
    ]),
    w.nodes.paragraph({ style: st.abstract }, [
      text(
        `This document is part of the shared corpus. Its text is generated from a fixed seed and has no meaning; its structure is what the tests need. It aims at about ${o.targetPages} A4 pages. `,
      ),
      ...w.proseRuns(60),
    ]),
    w.nodes.paragraph({ style: 'TOCHeading' }, [text('Contents')]),
    w.nodes.toc(o.tocLevels === 3 ? {} : { maxLevel: o.tocLevels }),
    w.nodes.paragraph({ style: 'TOCHeading' }, [text('Figures')]),
    w.nodes.toc({ of: 'Figure' }),
    w.nodes.paragraph({ style: 'TOCHeading' }, [text('Tables')]),
    w.nodes.toc({ of: 'Table' }),
  );
  if (o.frontMatter) w.emit(w.nodes.sectionBreak(w.defs.pageSetups.main, 'nextPage'));

  // Chapters are added until the estimate reaches the target. Scheduled specials are always added;
  // ordinary units after a chapter's opening unit are skipped once the target is reached.
  const pending = new Set<Special>(o.schedule.flat());
  const reached = (): boolean => w.pages() >= o.targetPages;
  for (let chapter = 0; !reached() || pending.size > 0; chapter++) {
    const specials = o.schedule[chapter] ?? [SPECIALS[chapter % SPECIALS.length]!];
    const [opening, figure, table, equation, region] = chapterUnits(w);
    w.emit(...opening!());
    const plan: Array<Unit | Special> = [figure!, equation!, region!, ...specials, table!];
    for (const step of plan) {
      if (typeof step === 'string') {
        for (const unit of specialUnits(w, step)) w.emit(...unit());
        pending.delete(step);
      } else if (!reached()) w.emit(...step());
      if (reached() && pending.size === 0) break;
    }
  }
  if (w.blocks[w.blocks.length - 1]?.type !== 'paragraph') w.emit(w.paragraph(40));
  return w.envelope();
}

// ---------------------------------------------------------------------------------------------
// The one-page document

function onePage(): BuiltDocument {
  const w = new Writer('pages-1', 'portrait', {
    title: 'One-page sample',
    chapterBreaks: false,
    headerVariants: false,
    hyphenation: false,
  });
  const st = w.styles;
  w.emit(
    w.nodes.paragraph({ style: 'Title' }, [text('A one-page sample')]),
    w.heading(1, 'Purpose'),
    w.nodes.paragraph({ style: st.bodyText }, [
      text(
        'This document gives layout and export tests a small sample that still has most constructs. It has a numbered heading, ',
      ),
      text('bold', mark.bold()),
      text(', '),
      text('italic', mark.italic()),
      text(' and '),
      text('underlined', mark.underline()),
      text(' text, a '),
      text('link', mark.link(`${WEB}/one-page`)),
      text(', inline math such as '),
      equation('a^2 + b^2 = c^2'),
      text(' and a footnote.'),
      w.nodes.footnote([text('Footnotes in the corpus are short and were written for it.')]),
      text(' Its text was written for the corpus.'),
    ]),
    ...w.bulletList(3),
    w.heading(1, 'Contents of the corpus'),
    w.tableCaption('Documents and the budgets they serve'),
    w.nodes.table({ style: st.dataTable, grid: [3000, 1800, 4226], headerRows: 1 }, [
      w.nodes.row([w.cell('Document'), w.cell('Pages'), w.cell('Used for')], { cantSplit: true }),
      w.nodes.row([w.cell('pages-1'), w.cell('1'), w.cell('Smoke tests')]),
      w.nodes.row([
        w.cell('pages-20'),
        w.cell('20'),
        w.cell('Time to interactive and export time'),
      ]),
      w.nodes.row([w.cell('pages-100'), w.cell('100'), w.cell('Typing latency and memory')]),
      w.nodes.row([w.cell('pages-300'), w.cell('300'), w.cell('The web view')]),
      w.nodes.row([w.cell('pages-1000'), w.cell('1000'), w.cell('The page view')]),
    ]),
    w.nodes.paragraph({ style: st.bodyText }, [
      text('The figure below is a small picture with a caption, and '),
      w.inlineImage('dot', 200, 'An amber dot'),
      text(' is an inline image. Page numbers are in the footer.'),
    ]),
    w.figure('gradient', { width: 2880 }),
    w.nodes.paragraph({ style: st.bodyText }, [
      text('Every test that uses this document records the corpus version it ran against.'),
    ]),
  );
  return w.envelope();
}

// ---------------------------------------------------------------------------------------------
// The form with role placeholders (feature `fields`, 12 §3)

function formFields(): BuiltDocument {
  const w = new Writer('form-fields', 'portrait', {
    title: 'Service order form',
    chapterBreaks: false,
    headerVariants: false,
    hyphenation: false,
  });
  const st = w.styles;
  const client = w.nodes.id();
  const supplier = w.nodes.id();
  const roles: RoleDefNode[] = [
    { type: 'role_def', attrs: { id: client, name: 'Client', color: '#2E75B6' } },
    { type: 'role_def', attrs: { id: supplier, name: 'Supplier', color: '#C55A11' } },
  ];
  // A rule in the form of the example in 12 §5.1.
  const rules: RuleDefNode[] = [
    {
      type: 'rule_def',
      attrs: {
        id: w.nodes.id(),
        when: { '==': [{ field: 'order.agentInvolved' }, true] },
        then: [{ show: ['agent.name'] }, { require: ['agent.name'] }],
        else: [{ hide: ['agent.name'] }],
      },
    },
  ];
  const ff = (attrs: Parameters<Nodes['formField']>[0]): InlineNode => w.nodes.formField(attrs);
  const body = (content: InlineNode[]): ParagraphNode =>
    w.nodes.paragraph({ style: st.bodyText }, content);
  const valueCell = (field: InlineNode): TableCellNode => w.cell([w.cellParagraph([field])]);
  w.emit(
    w.nodes.paragraph({ style: 'Title' }, [text('Service order')]),
    body([
      text(
        'Two roles fill this form. A field assigned to a role is filled by whoever takes that role in a workflow; the template names no person. Fields without a role are set by the author.',
      ),
    ]),
    w.heading(1, 'Client'),
    body([
      text('Name: '),
      ff({
        key: 'client.name',
        label: 'Client name',
        assignee: client,
        required: true,
        placeholder: 'Full name',
        width: 4320,
      }),
    ]),
    body([
      text('Email: '),
      ff({
        key: 'client.email',
        label: 'Client email',
        assignee: client,
        validation: { preset: 'email', maxLength: 254 },
        width: 4320,
      }),
    ]),
    body([
      text('Start date: '),
      ff({
        key: 'order.startDate',
        kind: 'date',
        label: 'Start date',
        assignee: client,
        value: '2026-12-01',
        format: { datePattern: 'd MMMM yyyy' },
      }),
    ]),
    body([
      ff({
        key: 'order.agentInvolved',
        kind: 'checkbox',
        label: 'An agent acts for the client',
        assignee: client,
        value: false,
      }),
      text(' An agent acts for the client. Agent name: '),
      ff({ key: 'agent.name', label: 'Agent name', assignee: client, width: 3600 }),
    ]),
    w.heading(1, 'Supplier'),
    w.tableCaption('Order details'),
    w.nodes.table({ style: st.dataTable, grid: [3000, 6026], headerRows: 1 }, [
      w.nodes.row([w.cell('Item'), w.cell('Value')], { cantSplit: true }),
      w.nodes.row([
        w.cell('Hours'),
        valueCell(
          ff({
            key: 'order.hours',
            kind: 'number',
            label: 'Hours',
            assignee: supplier,
            value: '40',
            format: { decimals: 0 },
            validation: { min: '1', max: '500' },
            width: 1440,
          }),
        ),
      ]),
      w.nodes.row([
        w.cell('Rate'),
        valueCell(
          ff({
            key: 'order.rate',
            kind: 'number',
            label: 'Hourly rate',
            assignee: supplier,
            value: '85.00',
            format: { decimals: 2, prefix: '€' },
            width: 1440,
          }),
        ),
      ]),
      w.nodes.row([
        w.cell('Plan'),
        valueCell(
          ff({
            key: 'order.plan',
            kind: 'choice',
            label: 'Support plan',
            assignee: supplier,
            value: 'standard',
            options: [
              { id: 'basic', label: 'Basic' },
              { id: 'standard', label: 'Standard' },
              { id: 'extended', label: 'Extended' },
            ],
          }),
        ),
      ]),
      w.nodes.row([
        w.cell('Total'),
        valueCell(
          ff({
            key: 'order.total',
            kind: 'formula',
            label: 'Total price',
            readOnly: true,
            width: 1440,
          }),
        ),
      ]),
    ]),
    w.paragraph(30, { style: st.bodyText }),
    w.heading(1, 'Signatures'),
    body([
      text('Signed for the client by '),
      field({ kind: 'formValue', target: 'field:client.name' }),
      text(': '),
      ff({
        key: 'client.signature',
        kind: 'signature',
        label: 'Client signature',
        assignee: client,
        required: true,
      }),
      text(' Initials: '),
      ff({ key: 'client.initials', kind: 'initials', label: 'Client initials', assignee: client }),
    ]),
    body([
      text('Signed for the supplier: '),
      ff({
        key: 'supplier.signature',
        kind: 'signature',
        label: 'Supplier signature',
        assignee: supplier,
        required: true,
      }),
      text(' on '),
      ff({
        key: 'supplier.dateSigned',
        kind: 'dateSigned',
        label: 'Date signed by the supplier',
        assignee: supplier,
      }),
      text('.'),
    ]),
  );
  return w.envelope(['fields'], roles, rules);
}

// ---------------------------------------------------------------------------------------------
// The recipes, in manifest order

export const RECIPES: readonly DocumentRecipe[] = [
  {
    name: 'pages-1',
    description:
      'One page: a numbered heading, marks, a link, inline math, a footnote, a bulleted list, a small table with a caption, an inline image, a figure with a caption, a header and a footer with page fields.',
    targetPages: 1,
    inRepository: true,
    build: onePage,
  },
  {
    name: 'form-fields',
    description:
      'One page with the feature `fields`: two role placeholders, form fields of every kind but `attachment` assigned to them, a `formValue` field and a rule.',
    targetPages: 1,
    inRepository: true,
    build: formFields,
  },
  {
    name: 'pages-20',
    description:
      'About 20 pages: front matter with lower-roman page numbers and three tables of contents, then chapters that hold every special case of the corpus at least once.',
    targetPages: 20,
    inRepository: true,
    build: () =>
      book({
        name: 'pages-20',
        targetPages: 20,
        title: 'Corpus document of twenty pages',
        schedule: [[...SPECIALS]],
        frontMatter: true,
        tocLevels: 3,
      }),
  },
  {
    name: 'pages-100',
    description:
      'About 100 pages of chapters; each chapter has the ordinary mix and one special case, in rotation.',
    targetPages: 100,
    inRepository: false,
    build: () =>
      book({
        name: 'pages-100',
        targetPages: 100,
        title: 'Corpus document of one hundred pages',
        schedule: [],
        frontMatter: false,
        tocLevels: 3,
      }),
  },
  {
    name: 'pages-300',
    description:
      'About 300 pages of chapters; each chapter has the ordinary mix and one special case, in rotation.',
    targetPages: 300,
    inRepository: false,
    build: () =>
      book({
        name: 'pages-300',
        targetPages: 300,
        title: 'Corpus document of three hundred pages',
        schedule: [],
        frontMatter: false,
        tocLevels: 2,
      }),
  },
  {
    name: 'pages-1000',
    description:
      'About 1,000 pages of chapters; each chapter has the ordinary mix and one special case, in rotation.',
    targetPages: 1000,
    inRepository: false,
    build: () =>
      book({
        name: 'pages-1000',
        targetPages: 1000,
        title: 'Corpus document of one thousand pages',
        schedule: [],
        frontMatter: false,
        tocLevels: 2,
      }),
  },
];
