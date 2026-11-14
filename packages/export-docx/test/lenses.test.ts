/**
 * The two rules of props.ts on single property containers: the import self-check keeps an
 * original lexical form the writer would not produce, and on an edit the writer keeps unmodelled
 * attributes but drops the ones that would override the edited value in Word (SR-M12).
 */
import { describe, expect, it } from 'vitest';
import { utf8 } from '@docedit/model';
import { NS } from '../src/ooxml.ts';
import { type LensContext, PPR, RPR, isRaw, mergeContainer, readContainer } from '../src/props.ts';
import { canonicalTree } from '../src/tree.ts';
import { canonical, elements, parseXml } from '../src/xml.ts';

const ctx: LensContext = {
  styleToCdm: (id) => (id === 'Heading1' ? 'Heading1' : null),
  styleToWord: (id) => id,
  storyForRel: () => null,
  relForStory: () => null,
};

function container(xml: string) {
  const doc = parseXml(utf8(`<w:x xmlns:w="${NS.w}">${xml}</w:x>`));
  return elements(elements(doc.root)[0]!);
}

const text = (items: ReturnType<typeof mergeContainer>): string =>
  items.map((m) => (isRaw(m) ? m.raw : canonicalTree(m))).join('');

describe('property lenses', () => {
  it('round-trips a container exactly, keeping only what the model does not represent', () => {
    const kids = container(
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:b/><w:color w:val="FF0000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>',
    );
    const read = readContainer(RPR, kids, ctx);
    expect(read.full).toBe(false);
    expect(read.values).toMatchObject({
      fontFamily: 'Calibri',
      bold: true,
      color: '#FF0000',
      fontSize: 240,
    });
    expect(read.residue.map((r) => r.name)).toEqual(['w:rFonts', 'w:szCs']);
    expect(text(mergeContainer(RPR, read.values, read.residue, ctx, []))).toBe(
      kids.map((k) => canonical(k)).join(''),
    );
  });

  it('keeps an original lexical form while the value is unchanged, and writes the new value when it changes', () => {
    const kids = container('<w:pPr><w:jc w:val="start"/></w:pPr>');
    const read = readContainer(PPR, kids, ctx);
    expect(read.values['align']).toBe('start');
    // The writer would write "left"; the self-check keeps the original element.
    expect(read.full).toBe(true);
    expect(text(mergeContainer(PPR, read.values, read.residue, ctx, []))).toContain(
      'w:val="start"',
    );
    expect(
      text(mergeContainer(PPR, { ...read.values, align: 'center' }, read.residue, ctx, [])),
    ).toContain('"center"');
  });

  it('keeps unmodelled attributes of an edited element and drops the ones that override it', () => {
    const kids = container(
      '<w:rPr><w:color w:val="000000" w:themeColor="text1" w:themeTint="BF"/><w:u w:val="single" w:color="FF0000"/></w:rPr>',
    );
    const read = readContainer(RPR, kids, ctx);
    const edited = text(
      mergeContainer(
        RPR,
        { ...read.values, color: '#00FF00', underline: 'double' },
        read.residue,
        ctx,
        [],
      ),
    );
    expect(edited).toContain('00FF00');
    expect(edited).not.toContain('themeColor');
    expect(edited).not.toContain('themeTint');
    // The underline's colour is not a precedence attribute: it stays.
    expect(edited).toContain('w:color="FF0000"');
    expect(edited).toContain('"double"');
  });
});
