/**
 * Definitions shared by the corpus documents (03 §4.1): settings, every built-in style, named
 * styles with `basedOn` chains of three and four styles, numbering definitions, page setups, and
 * header and footer stories.
 *
 * Built-in styles use their reserved identifiers. Every other definition gets a random identifier
 * from the document's own identifier stream, as the editor would give it (03 §4.1; ADR 0018), and
 * carries a readable `name`.
 *
 * Every document defines all 37 built-in styles of ADR 0018, whether it uses them or not. ADR 0018
 * reads "present in every document" (03 §4.1) as "available"; story CDM-016 expects them to be
 * present. Defining them all keeps the corpus valid under either reading.
 */
import type {
  FieldAttrs,
  InlineNode,
  NumberingDefAttrs,
  NumberingDefNode,
  PageSetupAttrs,
  PageSetupNode,
  SettingsAttrs,
  StoryNode,
  StyleDefAttrs,
  StyleDefNode,
} from '@docedit/model';
import { field, image, mark, text, tab, type Nodes } from './cdm.ts';
import { imageByKey } from './images.ts';

/** A4 in twips, with 2.54 cm (1 inch) margins: the text block is 9,026 by 13,958 twips. */
export const A4 = { width: 11906, height: 16838, margin: 1440 } as const;
export const TEXT_WIDTH = A4.width - 2 * A4.margin;

export const FONT = {
  serif: 'Noto Serif',
  sans: 'Noto Sans',
  mono: 'Noto Sans Mono',
} as const;

const NAVY = '#1F3864';
const BORDER = { style: 'single' as const, width: 4, color: null, space: 0 };

export type LevelAttrs = NonNullable<NumberingDefAttrs['levels']>[number];

export interface Styles {
  headingBase: string;
  bodyText: string;
  bodyIndent: string;
  abstract: string;
  note: string;
  codeBlock: string;
  cjkBody: string;
  code: string;
  codeKeyword: string;
  term: string;
  dataTable: string;
  plainTable: string;
}

export interface Numbering {
  outline: string;
  /** The list instance every numbered heading belongs to. */
  outlineList: string;
  list: string;
  bullets: string;
  articles: string;
}

export interface PageSetups {
  /** A4 portrait; with header variants, a different first page and even pages. */
  portrait: string;
  /** Front matter: lower-roman page numbers starting at i. */
  front: string;
  /** Main text after front matter: decimal page numbers starting at 1. */
  main: string;
  /** A4 portrait that continues the page numbers, for the sections after a landscape or two-column section. */
  continued: string;
  landscape: string;
  twoColumn: string;
}

export interface Definitions {
  settings: SettingsAttrs;
  styleDefs: StyleDefNode[];
  numberingDefs: NumberingDefNode[];
  pageSetupDefs: PageSetupNode[];
  stories: StoryNode[];
  styles: Styles;
  numbering: Numbering;
  pageSetups: PageSetups;
}

export interface DefinitionOptions {
  /** Document title printed in the header. */
  title: string;
  /** Headings of level 1 start a new page (chapters). */
  chapterBreaks: boolean;
  /** Use first-page and even-page headers and footers. */
  headerVariants: boolean;
  hyphenation: boolean;
}

function style(attrs: StyleDefAttrs): StyleDefNode {
  return { type: 'style_def', attrs };
}

function headerStory(nodes: Nodes, kind: 'header' | 'footer', content: InlineNode[]): StoryNode {
  return {
    type: 'story',
    attrs: { id: nodes.id(), kind },
    content: [nodes.paragraph({ style: kind === 'header' ? 'Header' : 'Footer' }, content)],
  };
}

export function buildDefinitions(nodes: Nodes, o: DefinitionOptions): Definitions {
  const styles: Styles = {
    headingBase: nodes.id(),
    bodyText: nodes.id(),
    bodyIndent: nodes.id(),
    abstract: nodes.id(),
    note: nodes.id(),
    codeBlock: nodes.id(),
    cjkBody: nodes.id(),
    code: nodes.id(),
    codeKeyword: nodes.id(),
    term: nodes.id(),
    dataTable: nodes.id(),
    plainTable: nodes.id(),
  };
  const numbering: Numbering = {
    outline: nodes.id(),
    outlineList: nodes.id(),
    list: nodes.id(),
    bullets: nodes.id(),
    articles: nodes.id(),
  };
  const pageSetups: PageSetups = {
    portrait: nodes.id(),
    front: nodes.id(),
    main: nodes.id(),
    continued: nodes.id(),
    landscape: nodes.id(),
    twoColumn: nodes.id(),
  };

  const headingSizes = [320, 280, 260, 240, 240, 220, 220, 220, 220];
  const headingSpace = [480, 360, 240, 240, 200, 200, 160, 160, 160];
  const headings: StyleDefNode[] = headingSizes.map((size, i) => {
    const level = i + 1;
    const attrs: StyleDefAttrs = {
      id: `Heading${level}`,
      kind: 'paragraph',
      name: `Heading ${level}`,
      builtIn: true,
      basedOn: styles.headingBase,
      next: 'Normal',
      outlineLevel: level,
      fontSize: size,
      spaceBefore: headingSpace[i]!,
    };
    if (level <= 4)
      attrs.numbering = { numberingId: numbering.outline, level: i, listId: numbering.outlineList };
    if (level === 1 && o.chapterBreaks) attrs.pageBreakBefore = true;
    if (level === 4) attrs.italic = true;
    return style(attrs);
  });

  const toc: StyleDefNode[] = Array.from({ length: 9 }, (_, i) => {
    const attrs: StyleDefAttrs = {
      id: `TOC${i + 1}`,
      kind: 'paragraph',
      name: `TOC ${i + 1}`,
      builtIn: true,
      basedOn: 'Normal',
      next: 'Normal',
      spaceAfter: 60,
      tabs: [{ position: TEXT_WIDTH, align: 'right', leader: 'dot' }],
    };
    if (i > 0) attrs.indentLeft = i * 220;
    if (i === 0) attrs.bold = true;
    return style(attrs);
  });

  const styleDefs: StyleDefNode[] = [
    style({
      id: 'Normal',
      kind: 'paragraph',
      name: 'Normal',
      builtIn: true,
      next: 'Normal',
      fontFamily: FONT.serif,
      fontSize: 220,
      spaceAfter: 160,
      lineSpacing: 1150,
      lineRule: 'multiple',
      widowControl: true,
    }),
    style({
      id: styles.headingBase,
      kind: 'paragraph',
      name: 'Heading Base',
      basedOn: 'Normal',
      next: 'Normal',
      fontFamily: FONT.sans,
      bold: true,
      color: NAVY,
      keepNext: true,
      keepLines: true,
      spaceAfter: 120,
    }),
    ...headings,
    style({
      id: 'Title',
      kind: 'paragraph',
      name: 'Title',
      builtIn: true,
      basedOn: 'Normal',
      next: 'Subtitle',
      fontFamily: FONT.sans,
      fontSize: 560,
      color: NAVY,
      align: 'center',
      spaceAfter: 240,
    }),
    style({
      id: 'Subtitle',
      kind: 'paragraph',
      name: 'Subtitle',
      builtIn: true,
      basedOn: 'Title',
      next: 'Normal',
      fontSize: 320,
      italic: true,
      spaceAfter: 480,
    }),
    style({
      id: 'Quote',
      kind: 'paragraph',
      name: 'Quote',
      builtIn: true,
      basedOn: 'Normal',
      next: 'Normal',
      italic: true,
      color: '#404040',
      indentLeft: 720,
      indentRight: 720,
    }),
    style({
      id: 'IntenseQuote',
      kind: 'paragraph',
      name: 'Intense Quote',
      builtIn: true,
      basedOn: 'Quote',
      next: 'Normal',
      bold: true,
      color: NAVY,
      borders: {
        top: { style: 'single', width: 8, color: NAVY, space: 4 },
        bottom: { style: 'single', width: 8, color: NAVY, space: 4 },
      },
    }),
    style({
      id: 'ListParagraph',
      kind: 'paragraph',
      name: 'List Paragraph',
      builtIn: true,
      basedOn: 'Normal',
      indentLeft: 720,
      contextualSpacing: true,
    }),
    style({
      id: 'NoSpacing',
      kind: 'paragraph',
      name: 'No Spacing',
      builtIn: true,
      basedOn: 'Normal',
      spaceAfter: 0,
      lineSpacing: 1000,
      lineRule: 'multiple',
    }),
    style({
      id: 'Caption',
      kind: 'paragraph',
      name: 'Caption',
      builtIn: true,
      basedOn: 'Normal',
      next: 'Normal',
      fontSize: 180,
      italic: true,
      color: '#44546A',
      spaceAfter: 200,
      keepNext: true,
    }),
    style({
      id: 'FootnoteText',
      kind: 'paragraph',
      name: 'Footnote Text',
      builtIn: true,
      basedOn: 'Normal',
      fontSize: 180,
      spaceAfter: 0,
      lineSpacing: 1000,
      lineRule: 'multiple',
    }),
    style({
      id: 'Header',
      kind: 'paragraph',
      name: 'Header',
      builtIn: true,
      basedOn: 'Normal',
      fontSize: 180,
      spaceAfter: 0,
      tabs: [
        { position: TEXT_WIDTH / 2, align: 'center', leader: 'none' },
        { position: TEXT_WIDTH, align: 'right', leader: 'none' },
      ],
    }),
    style({ id: 'Footer', kind: 'paragraph', name: 'Footer', builtIn: true, basedOn: 'Header' }),
    style({
      id: 'TOCHeading',
      kind: 'paragraph',
      name: 'TOC Heading',
      builtIn: true,
      basedOn: styles.headingBase,
      next: 'Normal',
      fontSize: 320,
      spaceBefore: 240,
    }),
    ...toc,
    style({
      id: styles.bodyText,
      kind: 'paragraph',
      name: 'Body Text',
      basedOn: 'Normal',
      next: styles.bodyText,
      align: 'justify',
      spaceAfter: 120,
    }),
    style({
      id: styles.bodyIndent,
      kind: 'paragraph',
      name: 'Body Text Indent',
      basedOn: styles.bodyText,
      next: styles.bodyIndent,
      indentFirstLine: 360,
    }),
    style({
      id: styles.abstract,
      kind: 'paragraph',
      name: 'Abstract',
      basedOn: styles.bodyIndent,
      next: 'Normal',
      italic: true,
      fontSize: 200,
      indentLeft: 720,
      indentRight: 720,
    }),
    style({
      id: styles.note,
      kind: 'paragraph',
      name: 'Note',
      basedOn: styles.bodyText,
      next: 'Normal',
      indentLeft: 240,
      shading: { fill: '#F2F2F2' },
      borders: { left: { style: 'thick', width: 24, color: '#ED7D31', space: 4 } },
    }),
    style({
      id: styles.codeBlock,
      kind: 'paragraph',
      name: 'Code Block',
      basedOn: 'NoSpacing',
      fontFamily: FONT.mono,
      fontSize: 180,
      shading: { fill: '#F2F2F2' },
    }),
    style({
      id: styles.cjkBody,
      kind: 'paragraph',
      name: 'CJK Body',
      basedOn: styles.bodyText,
      align: 'distribute',
      lineSpacing: 1250,
      lineRule: 'multiple',
    }),
    style({
      id: 'DefaultParagraphFont',
      kind: 'character',
      name: 'Default Paragraph Font',
      builtIn: true,
    }),
    style({
      id: 'FootnoteReference',
      kind: 'character',
      name: 'Footnote Reference',
      builtIn: true,
      basedOn: 'DefaultParagraphFont',
      vertAlign: 'super',
    }),
    style({
      id: 'Hyperlink',
      kind: 'character',
      name: 'Hyperlink',
      builtIn: true,
      basedOn: 'DefaultParagraphFont',
      color: '#0563C1',
      underline: 'single',
    }),
    style({
      id: 'Strong',
      kind: 'character',
      name: 'Strong',
      builtIn: true,
      basedOn: 'DefaultParagraphFont',
      bold: true,
    }),
    style({
      id: 'Emphasis',
      kind: 'character',
      name: 'Emphasis',
      builtIn: true,
      basedOn: 'DefaultParagraphFont',
      italic: true,
    }),
    style({
      id: styles.code,
      kind: 'character',
      name: 'Code',
      basedOn: 'DefaultParagraphFont',
      fontFamily: FONT.mono,
      fontSize: 200,
    }),
    style({
      id: styles.codeKeyword,
      kind: 'character',
      name: 'Code Keyword',
      basedOn: styles.code,
      bold: true,
      color: '#7030A0',
    }),
    style({
      id: styles.term,
      kind: 'character',
      name: 'Term',
      basedOn: 'Emphasis',
      smallCaps: true,
    }),
    style({
      id: 'TableNormal',
      kind: 'table',
      name: 'Normal Table',
      builtIn: true,
      cellMargins: { top: 0, bottom: 0, left: 108, right: 108 },
    }),
    style({
      id: 'TableGrid',
      kind: 'table',
      name: 'Table Grid',
      builtIn: true,
      basedOn: 'TableNormal',
      borders: {
        top: BORDER,
        bottom: BORDER,
        left: BORDER,
        right: BORDER,
        insideH: BORDER,
        insideV: BORDER,
      },
    }),
    style({
      id: styles.dataTable,
      kind: 'table',
      name: 'Data Table',
      basedOn: 'TableGrid',
      fontSize: 200,
      cellMargins: { top: 40, bottom: 40, left: 108, right: 108 },
      headerRowShading: { fill: '#D9E2F3' },
      bandedRows: true,
    }),
    style({
      id: styles.plainTable,
      kind: 'table',
      name: 'Plain Table',
      basedOn: 'TableNormal',
      borders: {
        top: { style: 'single', width: 12, color: NAVY, space: 0 },
        bottom: { style: 'single', width: 12, color: NAVY, space: 0 },
      },
    }),
  ];

  const indent = (level: number): Pick<LevelAttrs, 'indentLeft' | 'hanging'> => ({
    indentLeft: 720 + level * 360,
    hanging: 360,
  });
  const numberingDefs: NumberingDefNode[] = [
    {
      type: 'numbering_def',
      attrs: {
        id: numbering.outline,
        name: 'Outline numbering',
        levels: Array.from({ length: 9 }, (_, i) => ({
          format: 'decimal',
          text: Array.from({ length: i + 1 }, (_, k) => `%${k + 1}`).join('.'),
          start: 1,
          indentLeft: 0,
          hanging: 0,
        })),
      },
    },
    {
      type: 'numbering_def',
      attrs: {
        id: numbering.list,
        name: 'Numbered list',
        levels: [
          { format: 'decimal', text: '%1.', start: 1, ...indent(0) },
          { format: 'lowerLetter', text: '%2)', start: 1, ...indent(1) },
          { format: 'lowerRoman', text: '(%3)', start: 1, ...indent(2), align: 'end' },
          { format: 'upperLetter', text: '%4.', start: 1, ...indent(3) },
          { format: 'decimal', text: '%1.%2.%3.%4.%5', start: 1, legal: true, ...indent(4) },
        ],
      },
    },
    {
      type: 'numbering_def',
      attrs: {
        id: numbering.bullets,
        name: 'Bullets',
        levels: [
          {
            format: 'bullet',
            text: '',
            start: 1,
            bulletChar: '•',
            ...indent(0),
            runProps: { color: NAVY },
          },
          { format: 'bullet', text: '', start: 1, bulletChar: '◦', ...indent(1) },
          { format: 'bullet', text: '', start: 1, bulletChar: '▪', ...indent(2) },
          { format: 'bullet', text: '', start: 1, bulletChar: '–', ...indent(3) },
        ],
      },
    },
    {
      type: 'numbering_def',
      attrs: {
        id: numbering.articles,
        name: 'Articles',
        levels: [
          {
            format: 'upperRoman',
            text: '§ %1.',
            start: 1,
            indentLeft: 0,
            hanging: 0,
            runProps: { bold: true },
          },
          {
            format: 'decimal',
            text: '%1.%2',
            start: 1,
            legal: true,
            indentLeft: 720,
            hanging: 720,
          },
          {
            format: 'lowerLetter',
            text: '(%3)',
            start: 1,
            restartAfter: 0,
            indentLeft: 1440,
            hanging: 720,
          },
        ],
      },
    },
  ];

  // Header and footer stories (03 §4.1), with page fields (03 §4.4).
  const logo = imageByKey('logo');
  const headerDefault = headerStory(nodes, 'header', [
    image(logo.id, 480, 240, 'Corpus mark'),
    text(` ${o.title}`),
    tab(),
    tab(),
    field({ kind: 'styleRef', target: 'style:Heading1' }),
  ]);
  const footerDefault = headerStory(nodes, 'footer', [
    tab(),
    text('Page '),
    field({ kind: 'page' }),
    text(' of '),
    field({ kind: 'pageCount' }),
  ]);
  const stories: StoryNode[] = [headerDefault, footerDefault];
  const slots: PageSetupAttrs = {
    headerDefault: headerDefault.attrs!.id!,
    footerDefault: footerDefault.attrs!.id!,
  };
  if (o.headerVariants) {
    const dateField: FieldAttrs = { kind: 'date', format: 'yyyy-MM-dd' };
    const headerFirst = headerStory(nodes, 'header', [
      text('Layout and export test document', mark.smallCaps()),
      tab(),
      tab(),
      field(dateField),
    ]);
    const footerFirst = headerStory(nodes, 'footer', [tab(), field({ kind: 'title' })]);
    const headerEven = headerStory(nodes, 'header', [
      field({ kind: 'styleRef', target: 'style:Heading1' }),
      tab(),
      tab(),
      text(o.title, mark.italic()),
    ]);
    const footerEven = headerStory(nodes, 'footer', [
      text('Page '),
      field({ kind: 'page' }),
      text(' of '),
      field({ kind: 'pageCount' }),
    ]);
    stories.push(headerFirst, footerFirst, headerEven, footerEven);
    Object.assign(slots, {
      headerFirst: headerFirst.attrs!.id!,
      footerFirst: footerFirst.attrs!.id!,
      headerEven: headerEven.attrs!.id!,
      footerEven: footerEven.attrs!.id!,
    });
  }
  const variants: PageSetupAttrs = o.headerVariants
    ? { differentFirstPage: true, differentOddEven: true }
    : {};
  const page = (attrs: PageSetupAttrs): PageSetupNode => ({ type: 'page_setup', attrs });
  const pageSetupDefs: PageSetupNode[] = [
    page({
      id: pageSetups.portrait,
      width: A4.width,
      height: A4.height,
      marginTop: A4.margin,
      marginRight: A4.margin,
      marginBottom: A4.margin,
      marginLeft: A4.margin,
      ...variants,
      ...slots,
    }),
    page({
      id: pageSetups.front,
      ...variants,
      ...slots,
      pageNumberStart: 1,
      pageNumberFormat: 'lowerRoman',
    }),
    page({ id: pageSetups.main, ...slots, pageNumberStart: 1 }),
    page({ id: pageSetups.continued, ...slots }),
    page({
      id: pageSetups.landscape,
      width: A4.height,
      height: A4.width,
      orientation: 'landscape',
      marginTop: 1080,
      marginRight: 1080,
      marginBottom: 1080,
      marginLeft: 1080,
      ...slots,
    }),
    page({ id: pageSetups.twoColumn, columns: 2, columnGap: 720, ...slots }),
  ];

  const settings: SettingsAttrs = {
    lang: 'en-GB',
    defaultTabStop: 720,
    defaultParagraphStyle: 'Normal',
  };
  if (o.hyphenation) settings.hyphenation = true;
  return {
    settings,
    styleDefs,
    numberingDefs,
    pageSetupDefs,
    stories,
    styles,
    numbering,
    pageSetups,
  };
}
