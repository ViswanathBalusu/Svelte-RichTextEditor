/**
 * FE-129 criterion 6: the paragraph dialog reaches every option of the paragraph format (alignment,
 * spacing, line spacing and its rule, keep rules, widow control, borders, shading) besides indents
 * and tab stops, and makes the `setParagraphFormat` patch for them. No DOM: the fields and the
 * patch. The keyboard run in a browser is packages/ui/e2e/fe-129-paragraph-dialog.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ParagraphFormatView, ParagraphOptionsView } from '../src/core-api.ts';
import {
  convertLineSpacing,
  dialogFields,
  dialogPatch,
  type DialogFields,
} from '../src/shell/paragraph-dialog.ts';

const options = (over: Partial<ParagraphOptionsView> = {}): ParagraphOptionsView => ({
  align: 'start',
  spaceBefore: 0,
  spaceAfter: 0,
  lineSpacing: 1000,
  lineRule: 'multiple',
  keepNext: false,
  keepLines: false,
  pageBreakBefore: false,
  widowControl: true,
  contextualSpacing: false,
  borders: {},
  shading: null,
  mixed: [],
  ...over,
});

const view = (over: Partial<ParagraphOptionsView> = {}): ParagraphFormatView => ({
  count: 1,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [],
  defaultTabStop: 720,
  page: null,
  editable: true,
  options: options(over),
});

/** The fields of `format`, changed by `edit`, and the patch they make. */
function patchOf(
  format: ParagraphFormatView,
  edit: (f: Required<DialogFields>['options']) => void,
) {
  const fields = dialogFields(format);
  edit(fields.options!);
  return dialogPatch(format, fields);
}

describe('the option fields of the paragraph dialog', () => {
  it('are absent when the core gives no options', () => {
    const { options: _gone, ...bare } = view();
    expect(dialogFields(bare).options).toBeUndefined();
  });

  it('show points, lines and the CDM defaults, and make no patch when nothing changed', () => {
    const f = view({ spaceBefore: 120, spaceAfter: 30, lineSpacing: 1500, align: 'justify' });
    const o = dialogFields(f).options!;
    expect(o).toMatchObject({
      align: 'justify',
      spaceBefore: '6',
      spaceAfter: '1.5',
      lineRule: 'multiple',
      lineSpacing: '1.5',
      keepNext: false,
      widowControl: true,
      shading: '',
    });
    expect(o.borders.top).toEqual({ style: 'none', width: '', color: '', space: '' });
    expect(dialogPatch(f, dialogFields(f)).patch).toBeNull();
  });

  it('leave a value the paragraphs differ in blank, or unchecked-and-unset for a check box', () => {
    const f = view({
      align: 'center',
      spaceBefore: 40,
      keepNext: true,
      mixed: ['align', 'spaceBefore', 'keepNext'],
    });
    const o = dialogFields(f).options!;
    expect(o).toMatchObject({ align: '', spaceBefore: '', keepNext: 'mixed' });
    expect(dialogPatch(f, dialogFields(f)).patch).toBeNull();
  });
});

describe('the patch of the option fields', () => {
  it('holds only what changed', () => {
    const r = patchOf(view(), (o) => {
      o.align = 'center';
      o.spaceBefore = '6';
      o.spaceAfter = '1,5';
    });
    expect(r.invalid).toEqual([]);
    expect(r.patch).toEqual({ align: 'center', spaceBefore: 120, spaceAfter: 30 });
  });

  it('reads the line spacing in lines under multiple, and in points under the other rules', () => {
    expect(patchOf(view(), (o) => (o.lineSpacing = '1.5')).patch).toEqual({ lineSpacing: 1500 });
    expect(
      patchOf(view(), (o) => {
        o.lineRule = 'exact';
        o.lineSpacing = '14';
      }).patch,
    ).toEqual({ lineRule: 'exact', lineSpacing: 280 });
    expect(
      patchOf(view({ lineRule: 'atLeast', lineSpacing: 240 }), (o) => {
        o.lineRule = 'multiple';
        o.lineSpacing = '1';
      }).patch,
    ).toEqual({ lineRule: 'multiple', lineSpacing: 1000 });
  });

  it('converts the typed spacing when the rule changes, so that the same space stays', () => {
    expect(convertLineSpacing('1', 'multiple', 'exact')).toBe('12');
    expect(convertLineSpacing('24', 'exact', 'multiple')).toBe('2');
    expect(convertLineSpacing('12', 'exact', 'atLeast')).toBe('12');
    expect(convertLineSpacing('', 'multiple', 'exact')).toBe('');
  });

  it('writes check boxes that changed, and none left in the mixed state', () => {
    const r = patchOf(view(), (o) => {
      o.keepNext = true;
      o.keepLines = true;
      o.pageBreakBefore = true;
      o.widowControl = false;
      o.contextualSpacing = true;
    });
    expect(r.patch).toEqual({
      keepNext: true,
      keepLines: true,
      pageBreakBefore: true,
      widowControl: false,
      contextualSpacing: true,
    });
    const mixed = view({ keepNext: false, mixed: ['keepNext', 'keepLines'] });
    expect(patchOf(mixed, () => {}).patch).toBeNull();
    // Once the box is set, it is written, even to the value the first paragraph has.
    expect(patchOf(mixed, (o) => (o.keepNext = false)).patch).toEqual({ keepNext: false });
  });

  it('writes the borders whole, in the CDM units, and clears them with none', () => {
    const r = patchOf(view(), (o) => {
      o.borders.top = { style: 'single', width: '0.5', color: '#ff0000', space: '2' };
      o.borders.left = { style: 'dashed', width: '', color: '', space: '' };
    });
    expect(r.invalid).toEqual([]);
    expect(r.patch).toEqual({
      borders: {
        top: { style: 'single', width: 4, color: '#FF0000', space: 40 },
        left: { style: 'dashed' },
      },
    });
    const had = view({
      borders: { top: { style: 'single', width: 4, color: '#FF0000', space: 40 } },
    });
    expect(dialogPatch(had, dialogFields(had)).patch).toBeNull();
    expect(patchOf(had, (o) => (o.borders.top.style = 'none')).patch).toEqual({ borders: null });
  });

  it('writes the shading fill, and clears it when the field is emptied', () => {
    expect(patchOf(view(), (o) => (o.shading = '#fff2cc')).patch).toEqual({
      shading: { fill: '#FFF2CC' },
    });
    expect(patchOf(view({ shading: '#FFF2CC' }), (o) => (o.shading = '')).patch).toEqual({
      shading: null,
    });
  });

  it('names a field that is not a value the CDM can store, and makes no patch', () => {
    const r = patchOf(view(), (o) => {
      o.spaceBefore = 'wide';
      o.spaceAfter = '-1';
      o.lineSpacing = '0';
      o.shading = 'red';
      o.borders.bottom = { style: 'single', width: '31', color: '', space: '' };
    });
    expect(r.patch).toBeNull();
    expect(r.invalid).toEqual(
      expect.arrayContaining([
        'spaceBefore',
        'spaceAfter',
        'lineSpacing',
        'shading',
        'border:bottom',
      ]),
    );
  });
});
