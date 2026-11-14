/**
 * EXP-101 follow-up (lane export-docx-2, round 2): borders set in a table style (`w:tblPr` inside
 * `w:style w:type="table"`, for example `TableGrid`) are read into the style's `borders` attribute,
 * as a table's own direct borders are. The rest of the style's `w:tblPr` stays in the residue.
 */
import { describe, expect, it } from 'vitest';
import { utf8 } from '@docedit/model';
import { NS, w } from '../src/ooxml.ts';
import { type LensContext, isRaw, mergeContainer, readContainer, styleSpec } from '../src/props.ts';
import { canonicalTree } from '../src/tree.ts';
import { canonical, elements, parseXml } from '../src/xml.ts';

const ctx: LensContext = {
  styleToCdm: () => null,
  styleToWord: (id) => id,
  storyForRel: () => null,
  relForStory: () => null,
};

/** The children of a `w:style` element, parsed from their XML text. */
const styleChildren = (xml: string) => {
  const doc = parseXml(utf8(`<w:x xmlns:w="${NS.w}"><w:style>${xml}</w:style></w:x>`));
  return elements(elements(doc.root)[0]!);
};

const text = (items: ReturnType<typeof mergeContainer>): string =>
  items.map((m) => (isRaw(m) ? m.raw : canonicalTree(m))).join('');

const TABLE_GRID =
  '<w:name w:val="Table Grid"/>' +
  '<w:basedOn w:val="TableNormal"/>' +
  '<w:uiPriority w:val="59"/>' +
  '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
  '<w:tblPr>' +
  '<w:tblInd w:w="0" w:type="dxa"/>' +
  '<w:tblBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
  '</w:tblBorders>' +
  '<w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>' +
  '</w:tblPr>';

// The sides say `auto` for their colour, which the model reads as no colour.
const SINGLE = { style: 'single', width: 10, space: 0 };

describe('a table style reads its borders into the style_def attribute', () => {
  it('reads the sides of the style tblPr as the borders of the style', () => {
    const read = readContainer(styleSpec('table'), styleChildren(TABLE_GRID), ctx);
    expect(read.values['borders']).toEqual({
      top: SINGLE,
      left: SINGLE,
      bottom: SINGLE,
      right: SINGLE,
      insideH: SINGLE,
      insideV: SINGLE,
    });
  });

  it('keeps the other children of the style tblPr in the residue', () => {
    const read = readContainer(styleSpec('table'), styleChildren(TABLE_GRID), ctx);
    const tblPr = read.residue.find((r) => r.name === w('tblPr'));
    expect(tblPr, 'a residue holder for tblPr').toBeDefined();
    const names = (tblPr?.children ?? []).flatMap((c) => ('name' in c ? [c.name] : []));
    expect(names).toContain(w('tblInd'));
    expect(names).toContain(w('tblCellMar'));
  });

  it('a style without tblBorders reads no borders', () => {
    const read = readContainer(
      styleSpec('table'),
      styleChildren('<w:name w:val="Plain"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/></w:tblPr>'),
      ctx,
    );
    expect(read.values['borders']).toBeNull();
  });

  it('an unedited style border is written back as the original element', () => {
    const kids = styleChildren(TABLE_GRID);
    const read = readContainer(styleSpec('table'), kids, ctx);
    const tblPrWritten = text(
      mergeContainer(styleSpec('table'), read.values, read.residue, ctx, []),
    );
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
      expect(tblPrWritten).toMatch(new RegExp(`<w:${side} [^>]*w:val="single"`));
    }
    expect(tblPrWritten).toContain('w:tblInd');
    expect(tblPrWritten).toContain('w:tblCellMar');
  });

  it('an edited style border is written with the new value and the rest unchanged', () => {
    const read = readContainer(styleSpec('table'), styleChildren(TABLE_GRID), ctx);
    const borders = read.values['borders'] as Record<string, unknown>;
    const edited = text(
      mergeContainer(
        styleSpec('table'),
        {
          ...read.values,
          borders: { ...borders, top: { style: 'double', width: 15, color: '#FF0000' } },
        },
        read.residue,
        ctx,
        [],
      ),
    );
    expect(edited).toContain('w:val="double"');
    expect(edited).toContain('w:color="FF0000"');
    expect(edited).toContain('w:tblInd');
    // A side that was not edited keeps its original value.
    expect(edited).toMatch(/<w:insideH [^>]*w:val="single"/);
  });

  it('the canonical form of an unedited style tblPr equals the original one', () => {
    const kids = styleChildren(TABLE_GRID);
    const tblPrOriginal = kids.find((k) => k.local === 'tblPr')!;
    const read = readContainer(styleSpec('table'), kids, ctx);
    const holder = read.residue.find((r) => r.name === w('tblPr'));
    expect(holder, 'a residue holder for tblPr').toBeDefined();
    const back = text(mergeContainer(styleSpec('table'), read.values, [holder!], ctx, []));
    // The style's name comes from the values; the table properties are the original element.
    expect(back).toContain(canonical(tblPrOriginal));
  });
});
