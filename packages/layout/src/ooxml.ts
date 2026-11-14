/**
 * Flow blocks to a WordprocessingML package, for candidate 2 of spike S7 (Eigenpal's core), whose
 * layout entry points read only its own OOXML tree, parsed from DOCX bytes. Everything is written
 * as direct formatting, because the flow blocks are already resolved; numbering labels are literal
 * text, as 03 §7 requires of every writer.
 *
 * Alongside the bytes the projection returns, for every paragraph the engine will report, how its
 * offsets map back to CDM positions. Eigenpal names paragraphs by their structural path
 * (`/word/document.xml#0.0.7`), so the map is keyed by that path.
 */
import type {
  FlowBlock,
  FlowDocument,
  FlowFont,
  FlowInline,
  FlowPage,
  FlowParagraph,
  FlowSection,
  FlowTable,
} from './flow.ts';
import { onePixelPng, zipStored } from './zip.ts';

/** A stretch of a paragraph in the engine's offsets and in CDM positions. */
export interface Segment {
  readonly engineStart: number;
  readonly engineLength: number;
  readonly cdmStart: number;
  readonly cdmSize: number;
}

export interface ParagraphEntry {
  readonly kind: 'paragraph' | 'box' | 'carrier';
  /** The CDM block, or the box's block; empty for a carrier the projection added. */
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly generated: boolean;
  readonly segments: readonly Segment[];
  readonly engineLength: number;
}

export interface TableEntry {
  readonly table: FlowTable;
  /** Engine row path to the CDM row identifier. */
  readonly rows: ReadonlyMap<string, string>;
  /** Engine cell path to the CDM cell identifier; vertical-merge continuations are absent. */
  readonly cells: ReadonlyMap<string, string>;
}

export interface OoxmlProjection {
  readonly bytes: Uint8Array;
  readonly paragraphs: ReadonlyMap<string, ParagraphEntry>;
  readonly tables: ReadonlyMap<string, TableEntry>;
  /** Paragraphs the projection had to add (section carriers, empty cells). */
  readonly carriers: number;
}

/** Maps an engine offset inside a paragraph to a CDM offset. */
export function cdmOffset(entry: ParagraphEntry, engineOffset: number): number {
  for (const s of entry.segments) {
    if (engineOffset < s.engineStart) return s.cdmStart;
    if (engineOffset < s.engineStart + s.engineLength) {
      if (s.cdmSize === s.engineLength) return s.cdmStart + (engineOffset - s.engineStart);
      return engineOffset === s.engineStart ? s.cdmStart : s.cdmStart + s.cdmSize;
    }
  }
  return entry.end;
}

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  types: 'http://schemas.openxmlformats.org/package/2006/content-types',
} as const;
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const ROOT_NS = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}"`;
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const tw = (pt: number): number => Math.round(pt * 20);
const emu = (pt: number): number => Math.round(pt * 12700);
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface PartWriter {
  /** Relationship identifier of the shared picture, from this part. */
  readonly imageRel: string;
  usesImage: boolean;
}

class Projection {
  readonly paragraphs = new Map<string, ParagraphEntry>();
  readonly tables = new Map<string, TableEntry>();
  readonly files: [string, string | Uint8Array][] = [];
  readonly overrides: [string, string][] = [];
  readonly documentRels: [string, string, string][] = [];
  carriers = 0;
  private drawingId = 1;
  private readonly storyParts = new Map<string, { rel: string }>();
  private headerCount = 0;
  private footerCount = 0;
  private readonly doc: FlowDocument;

  constructor(doc: FlowDocument) {
    this.doc = doc;
  }

  rPr(font: FlowFont, extra = ''): string {
    const f = esc(font.family);
    return (
      `<w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>` +
      (font.bold ? '<w:b/>' : '') +
      (font.italic ? '<w:i/>' : '') +
      (font.strike ? '<w:strike/>' : '') +
      (font.color ? `<w:color w:val="${font.color.replace('#', '')}"/>` : '') +
      `<w:sz w:val="${Math.round(font.sizePt * 2)}"/>` +
      (font.underline ? '<w:u w:val="single"/>' : '') +
      (font.vertAlign
        ? `<w:vertAlign w:val="${font.vertAlign === 'super' ? 'superscript' : 'subscript'}"/>`
        : '') +
      extra +
      '</w:rPr>'
    );
  }

  drawing(width: number, height: number, part: PartWriter): string {
    part.usesImage = true;
    const id = this.drawingId++;
    const cx = emu(width);
    const cy = emu(height);
    return (
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${id}" name="Picture ${id}"/><a:graphic xmlns:a="${NS.a}"><a:graphicData uri="${NS.pic}">` +
      `<pic:pic xmlns:pic="${NS.pic}"><pic:nvPicPr><pic:cNvPr id="${id}" name="picture-${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${part.imageRel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
    );
  }

  /** Runs for a paragraph's inlines, appending segments as the engine will count them. */
  runs(
    inlines: readonly FlowInline[],
    segments: Segment[],
    start: number,
    part: PartWriter,
  ): { xml: string; length: number } {
    let xml = '';
    let e = start;
    const seg = (engineLength: number, cdmStart: number, cdmSize: number): void => {
      segments.push({ engineStart: e, engineLength, cdmStart, cdmSize });
      e += engineLength;
    };
    for (const i of inlines) {
      switch (i.kind) {
        case 'text':
          if (i.role === 'noteRef') {
            xml += `<w:r>${this.rPr(i.font)}<w:footnoteReference w:id="${this.noteNumber(i.ref ?? '')}"/></w:r>`;
            seg(1, i.offset, i.size);
          } else if (i.role === 'field' && (i.ref === 'page' || i.ref === 'pageCount')) {
            xml += `<w:fldSimple w:instr=" ${i.ref === 'page' ? 'PAGE' : 'NUMPAGES'} "><w:r>${this.rPr(i.font)}<w:t>${esc(i.text)}</w:t></w:r></w:fldSimple>`;
            seg(1, i.offset, i.size);
          } else {
            xml += `<w:r>${this.rPr(i.font)}<w:t xml:space="preserve">${esc(i.text)}</w:t></w:r>`;
            seg(i.text.length, i.offset, i.size);
          }
          break;
        case 'tab':
          xml += `<w:r>${this.rPr(i.font)}<w:tab/></w:r>`;
          seg(1, i.offset, i.size);
          break;
        case 'lineBreak':
          xml += `<w:r>${this.rPr(i.font)}<w:br/></w:r>`;
          seg(1, i.offset, i.size);
          break;
        case 'box':
          xml += `<w:r>${this.rPr(i.font)}${this.drawing(i.width, i.height, part)}</w:r>`;
          seg(1, i.offset, i.size);
          break;
      }
    }
    return { xml, length: e - start };
  }

  noteNumber(id: string): number {
    return this.doc.notes.get(id)?.number ?? 0;
  }

  pPr(p: FlowParagraph, last: FlowParagraph, sectPr: string): string {
    const tabs = p.tabs.length
      ? `<w:tabs>${p.tabs.map((t) => `<w:tab w:val="${t.align}" w:leader="${t.leader}" w:pos="${tw(t.position)}"/>`).join('')}</w:tabs>`
      : '';
    const line =
      p.line.rule === 'multiple'
        ? `w:line="${Math.round(p.line.factor * 240)}" w:lineRule="auto"`
        : `w:line="${tw(p.line.pt)}" w:lineRule="${p.line.rule}"`;
    const first =
      p.indentFirstLine < 0
        ? `w:hanging="${tw(-p.indentFirstLine)}"`
        : `w:firstLine="${tw(p.indentFirstLine)}"`;
    const jc = {
      left: 'left',
      center: 'center',
      right: 'right',
      justify: 'both',
      distribute: 'distribute',
    }[p.align];
    return (
      '<w:pPr>' +
      (last.keepNext ? '<w:keepNext/>' : '') +
      (p.keepLines ? '<w:keepLines/>' : '') +
      (p.pageBreakBefore ? '<w:pageBreakBefore/>' : '') +
      (p.widowControl ? '<w:widowControl/>' : '<w:widowControl w:val="0"/>') +
      tabs +
      `<w:spacing w:before="${tw(p.spaceBefore)}" w:after="${tw(last.spaceAfter)}" ${line}/>` +
      `<w:ind w:left="${tw(p.indentLeft)}" w:right="${tw(p.indentRight)}" ${first}/>` +
      `<w:jc w:val="${jc}"/>` +
      this.rPr(p.markFont) +
      sectPr +
      '</w:pPr>'
    );
  }

  /** One w:p for a paragraph and the parts that page or column breaks split it into. */
  paragraph(
    path: string,
    parts: readonly FlowParagraph[],
    breaks: readonly ('page' | 'column')[],
    sectPr: string,
    part: PartWriter,
  ): string {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!first || !last) return '';
    const segments: Segment[] = [];
    let body = '';
    let length = 0;
    parts.forEach((p, k) => {
      const r = this.runs(p.inlines, segments, length, part);
      body += r.xml;
      length += r.length;
      const brk = breaks[k];
      if (brk) {
        body += `<w:r><w:br w:type="${brk}"/></w:r>`;
        segments.push({ engineStart: length, engineLength: 1, cdmStart: p.end - 1, cdmSize: 1 });
        length += 1;
      }
    });
    this.paragraphs.set(path, {
      kind: 'paragraph',
      blockId: first.id,
      start: first.start,
      end: last.end,
      generated: first.generated,
      segments,
      engineLength: length,
    });
    return `<w:p>${this.pPr(first, last, sectPr)}${body}</w:p>`;
  }

  boxParagraph(
    path: string,
    b: Extract<FlowBlock, { kind: 'box' }>,
    width: number,
    sectPr: string,
    part: PartWriter,
  ): string {
    this.paragraphs.set(path, {
      kind: 'box',
      blockId: b.id,
      start: 0,
      end: 1,
      generated: false,
      segments: [],
      engineLength: 1,
    });
    const jc = { left: 'left', center: 'center', right: 'right' }[b.align];
    return (
      `<w:p><w:pPr>${b.keepNext ? '<w:keepNext/>' : ''}<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${jc}"/>${sectPr}</w:pPr>` +
      `<w:r>${this.drawing(b.width > 0 ? b.width : width, b.height, part)}</w:r></w:p>`
    );
  }

  carrier(path: string, sectPr: string): string {
    this.carriers++;
    this.paragraphs.set(path, {
      kind: 'carrier',
      blockId: '',
      start: 0,
      end: 0,
      generated: false,
      segments: [],
      engineLength: 0,
    });
    return `<w:p>${sectPr ? `<w:pPr>${sectPr}</w:pPr>` : ''}</w:p>`;
  }

  table(path: string, t: FlowTable, part: PartWriter): string {
    const rows = new Map<string, string>();
    const cells = new Map<string, string>();
    const edge = (name: string): string =>
      `<w:${name} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
    const borders = t.bordered
      ? `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge).join('')}</w:tblBorders>`
      : '';
    const m = t.cellMargins;
    let xml =
      `<w:tbl><w:tblPr><w:tblW w:w="${tw(t.columnWidths.reduce((a, b) => a + b, 0))}" w:type="dxa"/>` +
      (t.align !== 'left' ? `<w:jc w:val="${t.align}"/>` : '') +
      borders +
      '<w:tblLayout w:type="fixed"/>' +
      `<w:tblCellMar><w:top w:w="${tw(m.top)}" w:type="dxa"/><w:left w:w="${tw(m.left)}" w:type="dxa"/><w:bottom w:w="${tw(m.bottom)}" w:type="dxa"/><w:right w:w="${tw(m.right)}" w:type="dxa"/></w:tblCellMar>` +
      `</w:tblPr><w:tblGrid>${t.columnWidths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid>`;
    // Vertical spans still open: grid column to rows left and the span's width.
    const open = new Map<number, { rows: number; span: number }>();
    t.rows.forEach((row, r) => {
      const rowPath = `${path}.${2 + r}`;
      rows.set(rowPath, row.id);
      xml +=
        '<w:tr><w:trPr>' +
        (row.cantSplit ? '<w:cantSplit/>' : '') +
        (row.height !== null && row.heightRule !== 'auto'
          ? `<w:trHeight w:val="${tw(row.height)}" w:hRule="${row.heightRule}"/>`
          : '') +
        (row.header ? '<w:tblHeader/>' : '') +
        '</w:trPr>';
      let col = 0;
      let tc = 0;
      const queue = [...row.cells];
      const width = (from: number, span: number): number =>
        t.columnWidths.slice(from, from + span).reduce((a, b) => a + b, 0);
      while (queue.length > 0 || [...open.keys()].some((c) => c >= col)) {
        const spanning = open.get(col);
        const cellPath = `${rowPath}.${1 + tc}`;
        if (spanning) {
          xml += `<w:tc><w:tcPr><w:tcW w:w="${tw(width(col, spanning.span))}" w:type="dxa"/>${spanning.span > 1 ? `<w:gridSpan w:val="${spanning.span}"/>` : ''}<w:vMerge/></w:tcPr>${this.carrier(`${cellPath}.1`, '')}</w:tc>`;
          spanning.rows -= 1;
          if (spanning.rows <= 0) open.delete(col);
          col += spanning.span;
          tc++;
          continue;
        }
        const cell = queue.shift();
        if (!cell) break;
        cells.set(cellPath, cell.id);
        const cm = cell.margins;
        xml +=
          `<w:tc><w:tcPr><w:tcW w:w="${tw(width(col, cell.colspan))}" w:type="dxa"/>` +
          (cell.colspan > 1 ? `<w:gridSpan w:val="${cell.colspan}"/>` : '') +
          (cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '') +
          `<w:tcMar><w:top w:w="${tw(cm.top)}" w:type="dxa"/><w:left w:w="${tw(cm.left)}" w:type="dxa"/><w:bottom w:w="${tw(cm.bottom)}" w:type="dxa"/><w:right w:w="${tw(cm.right)}" w:type="dxa"/></w:tcMar>` +
          (cell.vAlign !== 'top' ? `<w:vAlign w:val="${cell.vAlign}"/>` : '') +
          '</w:tcPr>' +
          this.blocks(
            cellPath,
            1,
            cell.blocks,
            '',
            width(col, cell.colspan) - cm.left - cm.right,
            part,
            true,
          ) +
          '</w:tc>';
        if (cell.rowspan > 1) open.set(col, { rows: cell.rowspan - 1, span: cell.colspan });
        col += cell.colspan;
        tc++;
      }
      xml += '</w:tr>';
    });
    this.tables.set(path, { table: t, rows, cells });
    return `${xml}</w:tbl>`;
  }

  /**
   * Block XML for a container (body, cell, story, note). Children are numbered from `first`; the
   * last paragraph carries `sectPr`, and a carrier paragraph is added when the last block is not one.
   */
  blocks(
    path: string,
    first: number,
    blocks: readonly FlowBlock[],
    sectPr: string,
    width: number,
    part: PartWriter,
    needParagraph: boolean,
  ): string {
    const units: ((sect: string) => string)[] = [];
    let lastIsParagraph = false;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b) continue;
      const index = first + units.length;
      const child = `${path}.${index}`;
      if (b.kind === 'paragraph') {
        const parts: FlowParagraph[] = [b];
        const breaks: ('page' | 'column')[] = [];
        for (;;) {
          const brk = blocks[i + 1];
          const next = blocks[i + 2];
          if (
            (brk?.kind === 'pageBreak' || brk?.kind === 'columnBreak') &&
            next?.kind === 'paragraph' &&
            next.id === b.id
          ) {
            breaks.push(brk.kind === 'pageBreak' ? 'page' : 'column');
            parts.push(next);
            i += 2;
          } else break;
        }
        units.push((sect) => this.paragraph(child, parts, breaks, sect, part));
        lastIsParagraph = true;
      } else if (b.kind === 'table') {
        units.push(() => this.table(child, b, part));
        lastIsParagraph = false;
      } else if (b.kind === 'box') {
        units.push((sect) => this.boxParagraph(child, b, width, sect, part));
        lastIsParagraph = true;
      } else {
        // A break with no paragraph around it: a paragraph holding only the break.
        const kind = b.kind === 'pageBreak' ? 'page' : 'column';
        units.push((sect) => {
          this.carriers++;
          this.paragraphs.set(child, {
            kind: 'carrier',
            blockId: '',
            start: 0,
            end: 0,
            generated: false,
            segments: [],
            engineLength: 1,
          });
          return `<w:p>${sect ? `<w:pPr>${sect}</w:pPr>` : ''}<w:r><w:br w:type="${kind}"/></w:r></w:p>`;
        });
        lastIsParagraph = true;
      }
    }
    let xml = units
      .map((u, k) => u(k === units.length - 1 && lastIsParagraph ? sectPr : ''))
      .join('');
    if ((sectPr && !lastIsParagraph) || (needParagraph && !lastIsParagraph))
      xml += this.carrier(`${path}.${first + units.length}`, sectPr);
    return xml;
  }

  storyRel(kind: 'header' | 'footer', id: string | null): string | null {
    if (!id) return null;
    const key = `${kind}:${id}`;
    const known = this.storyParts.get(key);
    if (known) return known.rel;
    const blocks = this.doc.stories.get(id);
    if (!blocks) return null;
    const n = kind === 'header' ? ++this.headerCount : ++this.footerCount;
    const name = `${kind}${n}.xml`;
    const rel = `rId${kind === 'header' ? 'H' : 'F'}${n}`;
    const writer: PartWriter = { imageRel: 'rIdImg', usesImage: false };
    const root = kind === 'header' ? 'w:hdr' : 'w:ftr';
    const width = 451.3; // stories are laid out at the column width; only box paragraphs read this
    const body = this.blocks(`/word/${name}#0`, 0, blocks, '', width, writer, true);
    this.files.push([`word/${name}`, `${XML_DECL}<${root} ${ROOT_NS}>${body}</${root}>`]);
    if (writer.usesImage)
      this.files.push([
        `word/_rels/${name}.rels`,
        `${XML_DECL}<Relationships xmlns="${NS.rel}"><Relationship Id="rIdImg" Type="${REL}/image" Target="media/image1.png"/></Relationships>`,
      ]);
    this.overrides.push([`/word/${name}`, `${CT}.${kind}+xml`]);
    this.documentRels.push([rel, `${REL}/${kind}`, name]);
    this.storyParts.set(key, { rel });
    return rel;
  }

  sectPr(section: FlowSection, index: number): string {
    const p: FlowPage = section.page;
    const refs: string[] = [];
    const ref = (
      kind: 'header' | 'footer',
      type: 'default' | 'first' | 'even',
      id: string | null,
    ): void => {
      const rel = this.storyRel(kind, id);
      if (rel) refs.push(`<w:${kind}Reference w:type="${type}" r:id="${rel}"/>`);
    };
    ref('header', 'default', p.headers.default);
    if (p.differentFirstPage) ref('header', 'first', p.headers.first);
    if (p.differentOddEven) ref('header', 'even', p.headers.even);
    ref('footer', 'default', p.footers.default);
    if (p.differentFirstPage) ref('footer', 'first', p.footers.first);
    if (p.differentOddEven) ref('footer', 'even', p.footers.even);
    const fmt = p.pageNumberFormat ? ` w:fmt="${p.pageNumberFormat}"` : '';
    const start = p.pageNumberStart !== null ? ` w:start="${p.pageNumberStart}"` : '';
    return (
      '<w:sectPr>' +
      refs.join('') +
      (index > 0 ? `<w:type w:val="${section.start}"/>` : '') +
      `<w:pgSz w:w="${tw(p.width)}" w:h="${tw(p.height)}"${p.width > p.height ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(p.marginTop)}" w:right="${tw(p.marginRight)}" w:bottom="${tw(p.marginBottom)}" w:left="${tw(p.marginLeft)}" w:header="${tw(p.headerDistance)}" w:footer="${tw(p.footerDistance)}" w:gutter="0"/>` +
      (fmt || start ? `<w:pgNumType${start}${fmt}/>` : '') +
      `<w:cols w:num="${p.columns}" w:space="${tw(p.columnGap)}"/>` +
      (p.differentFirstPage ? '<w:titlePg/>' : '') +
      '</w:sectPr>'
    );
  }

  build(): OoxmlProjection {
    const doc = this.doc;
    const part: PartWriter = { imageRel: 'rIdImg', usesImage: false };
    let body = '';
    let index = 0;
    doc.sections.forEach((section, s) => {
      const last = s === doc.sections.length - 1;
      const width = section.page.width - section.page.marginLeft - section.page.marginRight;
      // The last section's properties sit at the end of the body; earlier ones in their last paragraph.
      const xml = this.blocks(
        '/word/document.xml#0.0',
        index,
        section.blocks,
        last ? '' : this.sectPr(section, s),
        width,
        part,
        !last,
      );
      body += xml;
      index += countChildren(xml);
      if (last) body += this.sectPr(section, s);
    });
    if (doc.notes.size > 0) {
      const writer: PartWriter = { imageRel: 'rIdImg', usesImage: false };
      let footnotes =
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
      let j = 2;
      for (const note of doc.notes.values()) {
        footnotes += `<w:footnote w:id="${note.number}">${this.blocks(`/word/footnotes.xml#0.${j}`, 0, note.blocks, '', 451.3, writer, true)}</w:footnote>`;
        j++;
      }
      this.files.push([
        'word/footnotes.xml',
        `${XML_DECL}<w:footnotes ${ROOT_NS}>${footnotes}</w:footnotes>`,
      ]);
      this.overrides.push(['/word/footnotes.xml', `${CT}.footnotes+xml`]);
      this.documentRels.push(['rIdNotes', `${REL}/footnotes`, 'footnotes.xml']);
      if (writer.usesImage) part.usesImage = true;
    }
    const evenOdd = doc.sections.some((s) => s.page.differentOddEven);
    const settings = `${XML_DECL}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="${tw(doc.defaultTabStop)}"/>${evenOdd ? '<w:evenAndOddHeaders/>' : ''}</w:settings>`;
    this.documentRels.push(['rIdSettings', `${REL}/settings`, 'settings.xml']);
    this.documentRels.push(['rIdImg', `${REL}/image`, 'media/image1.png']);
    const files: [string, string | Uint8Array][] = [
      [
        '[Content_Types].xml',
        `${XML_DECL}<Types xmlns="${NS.types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
          `<Override PartName="/word/document.xml" ContentType="${CT}.document.main+xml"/>` +
          `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>` +
          this.overrides
            .map(([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`)
            .join('') +
          '</Types>',
      ],
      [
        '_rels/.rels',
        `${XML_DECL}<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ],
      [
        'word/document.xml',
        `${XML_DECL}<w:document ${ROOT_NS}><w:body>${body}</w:body></w:document>`,
      ],
      [
        'word/_rels/document.xml.rels',
        `${XML_DECL}<Relationships xmlns="${NS.rel}">${this.documentRels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`,
      ],
      ['word/settings.xml', settings],
      ['word/media/image1.png', onePixelPng()],
      ...this.files,
    ];
    return {
      bytes: zipStored(files),
      paragraphs: this.paragraphs,
      tables: this.tables,
      carriers: this.carriers,
    };
  }
}

/** Counts the top-level elements of a run of block XML (paragraphs and tables). */
function countChildren(xml: string): number {
  let depth = 0;
  let count = 0;
  const re = /<(\/?)w:(p|tbl)([ >/])/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const closing = m[1] === '/';
    const selfClosing =
      !closing && xml.slice(m.index, xml.indexOf('>', m.index) + 1).endsWith('/>');
    if (closing) depth--;
    else {
      if (depth === 0) count++;
      if (!selfClosing) depth++;
    }
  }
  return count;
}

/** Projects a flow document to DOCX bytes and the offset map back to CDM positions. */
export function projectToOoxml(doc: FlowDocument): OoxmlProjection {
  return new Projection(doc).build();
}
