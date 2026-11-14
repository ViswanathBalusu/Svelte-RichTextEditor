/**
 * Small typed constructors for CDM nodes and marks (03 §4, §5). They use the attribute types that
 * `@docedit/model` generates from the definition, so a misspelt attribute fails the type check.
 * Text is normalised the way ProseMirror stores it: marks in schema order, adjacent runs with equal
 * marks merged, no empty runs.
 */
import type {
  AnchorNode,
  BodyNode,
  BreakNode,
  CaptionNode,
  CdmMark,
  EquationBlockAttrs,
  EquationBlockNode,
  EquationNode,
  FieldAttrs,
  FieldNode,
  FigureAttrs,
  FigureNode,
  FootnoteNode,
  FormFieldAttrs,
  FormFieldNode,
  ImageNode,
  InlineNode,
  ParagraphAttrs,
  ParagraphNode,
  RegionAttrs,
  RegionNode,
  SectionBreakAttrs,
  SectionBreakNode,
  TabNode,
  TableCellAttrs,
  TableCellNode,
  TableNode,
  TableAttrs,
  TableRowAttrs,
  TableRowNode,
  TextNode,
  TocAttrs,
  TocNode,
} from '@docedit/model';
import { indexDefinition } from '@docedit/model/definition';
import type { IdSource } from './random.ts';

export type CaptionInline = NonNullable<CaptionNode['content']>[number];
/** The inline content of a footnote's paragraph: a footnote holds one paragraph (CDM-001, option B). */
export type NoteInline = InlineNode;
export type BodyChild = NonNullable<BodyNode['content']>[number];
export type RegionChild = NonNullable<RegionNode['content']>[number];
export type CellChild = NonNullable<TableCellNode['content']>[number];

const markRank = indexDefinition().markRank;

function rank(m: CdmMark): number {
  return markRank.get(m.type) ?? Number.MAX_SAFE_INTEGER;
}

/** Marks (03 §5). Defaults are left out, as the canonical form does. */
export const mark = {
  bold: (): CdmMark => ({ type: 'bold' }),
  notBold: (): CdmMark => ({ type: 'bold', attrs: { value: false } }),
  italic: (): CdmMark => ({ type: 'italic' }),
  underline: (style: 'single' | 'double' | 'dotted' | 'none' = 'single'): CdmMark =>
    style === 'single' ? { type: 'underline' } : { type: 'underline', attrs: { style } },
  strike: (): CdmMark => ({ type: 'strike' }),
  smallCaps: (): CdmMark => ({ type: 'smallCaps' }),
  allCaps: (): CdmMark => ({ type: 'allCaps' }),
  hidden: (): CdmMark => ({ type: 'hidden' }),
  sup: (): CdmMark => ({ type: 'vertAlign', attrs: { value: 'super' } }),
  sub: (): CdmMark => ({ type: 'vertAlign', attrs: { value: 'sub' } }),
  font: (value: string): CdmMark => ({ type: 'fontFamily', attrs: { value } }),
  size: (twips: number): CdmMark => ({ type: 'fontSize', attrs: { value: twips } }),
  color: (value: string): CdmMark => ({ type: 'color', attrs: { value } }),
  highlight: (value: 'yellow' | 'green' | 'cyan' | 'magenta' | 'lightGray'): CdmMark => ({
    type: 'highlight',
    attrs: { value },
  }),
  lang: (value: string): CdmMark => ({ type: 'lang', attrs: { value } }),
  charStyle: (style: string): CdmMark => ({ type: 'charStyle', attrs: { style } }),
  link: (href: string, title?: string): CdmMark =>
    title === undefined
      ? { type: 'link', attrs: { href } }
      : { type: 'link', attrs: { href, title } },
};

export function text(t: string, ...marks: CdmMark[]): TextNode {
  if (t === '') throw new RangeError('empty text run');
  if (marks.length === 0) return { type: 'text', text: t };
  return { type: 'text', text: t, marks: [...marks].sort((a, b) => rank(a) - rank(b)) };
}

const sameMarks = (a: TextNode, b: TextNode): boolean =>
  JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/** Merges adjacent text runs with equal marks. */
export function normalise<T extends { type: string }>(content: readonly T[]): T[] {
  const out: T[] = [];
  for (const node of content) {
    const prev = out[out.length - 1];
    if (node.type === 'text' && prev?.type === 'text') {
      const a = prev as unknown as TextNode;
      const b = node as unknown as TextNode;
      if (sameMarks(a, b)) {
        out[out.length - 1] = { ...a, text: a.text + b.text } as unknown as T;
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

export const tab = (): TabNode => ({ type: 'tab' });
export const lineBreak = (): BreakNode => ({ type: 'break' });
export const pageBreak = (): BreakNode => ({ type: 'break', attrs: { kind: 'page' } });
export const columnBreak = (): BreakNode => ({ type: 'break', attrs: { kind: 'column' } });
export const equation = (latex: string): EquationNode => ({ type: 'equation', attrs: { latex } });
export const field = (attrs: FieldAttrs): FieldNode => ({ type: 'field', attrs });

export function image(asset: string, width: number, height: number, alt: string): ImageNode {
  return { type: 'image', attrs: { asset, width, height, alt } };
}

/** The CDM's own content model for every node type, with identifiers drawn from one source. */
export class Nodes {
  readonly ids: IdSource;

  constructor(ids: IdSource) {
    this.ids = ids;
  }

  id(): string {
    return this.ids.next();
  }

  paragraph(attrs: Omit<ParagraphAttrs, 'id'>, content: readonly InlineNode[] = []): ParagraphNode {
    const node: ParagraphNode = { type: 'paragraph', attrs: { id: this.id(), ...attrs } };
    const c = normalise(content);
    if (c.length) node.content = c;
    return node;
  }

  /** A footnote holding one paragraph in the built-in FootnoteText style (CDM-001, option B). */
  footnote(content: readonly NoteInline[]): FootnoteNode {
    const id = this.id();
    return {
      type: 'footnote',
      attrs: { id },
      content: [this.paragraph({ style: 'FootnoteText' }, content)],
    };
  }

  anchor(name: string): AnchorNode {
    return { type: 'anchor', attrs: { id: this.id(), name } };
  }

  figure(attrs: Omit<FigureAttrs, 'id'>, caption?: readonly CaptionInline[]): FigureNode {
    const node: FigureNode = { type: 'figure', attrs: { id: this.id(), ...attrs } };
    if (caption) node.content = [{ type: 'caption', content: normalise(caption) }];
    return node;
  }

  equationBlock(latex: string, numbered: boolean, label?: string): EquationBlockNode {
    const attrs: EquationBlockAttrs = { id: this.id(), latex };
    if (numbered) attrs.numbered = true;
    if (label) attrs.label = label;
    return { type: 'equation_block', attrs };
  }

  toc(attrs: Omit<TocAttrs, 'id'> = {}): TocNode {
    return { type: 'toc', attrs: { id: this.id(), ...attrs } };
  }

  table(attrs: Omit<TableAttrs, 'id'>, rows: TableRowNode[]): TableNode {
    return { type: 'table', attrs: { id: this.id(), ...attrs }, content: rows };
  }

  row(cells: TableCellNode[], attrs: Omit<TableRowAttrs, 'id'> = {}): TableRowNode {
    return { type: 'table_row', attrs: { id: this.id(), ...attrs }, content: cells };
  }

  cell(content: readonly CellChild[], attrs: Omit<TableCellAttrs, 'id'> = {}): TableCellNode {
    return { type: 'table_cell', attrs: { id: this.id(), ...attrs }, content: [...content] };
  }

  region(title: string, policy: 'inherit' | 'restricted', content: RegionChild[]): RegionNode {
    const attrs: RegionAttrs = { id: this.id(), title };
    if (policy === 'restricted') attrs.policy = 'restricted';
    return { type: 'region', attrs, content };
  }

  sectionBreak(
    pageSetup: string,
    start: 'nextPage' | 'continuous' | 'oddPage' | 'evenPage',
  ): SectionBreakNode {
    const attrs: SectionBreakAttrs = { id: this.id(), pageSetup };
    if (start !== 'nextPage') attrs.start = start;
    return { type: 'section_break', attrs };
  }

  formField(attrs: Omit<FormFieldAttrs, 'id'>): FormFieldNode {
    return { type: 'form_field', attrs: { id: this.id(), ...attrs } };
  }
}
