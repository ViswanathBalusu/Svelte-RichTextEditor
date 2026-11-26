/**
 * What the paragraph dialog shows and the patch it makes (UX-102 criterion 3): the same
 * `setParagraphFormat` patch the ruler's drag makes for the same values.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ParagraphFormatView } from '../src/core-api.ts';
import {
  dialogFields,
  dialogPatch,
  parseCentimetres,
  type DialogFields,
} from '../src/shell/paragraph-dialog.ts';
import { TWIPS_PER_CM, indentPatch, indentsOf, moveMarker } from '../src/shell/ruler.ts';

const view = (over: Partial<ParagraphFormatView> = {}): ParagraphFormatView => ({
  count: 1,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [],
  defaultTabStop: 720,
  page: null,
  editable: true,
  ...over,
});

describe('paragraph dialog fields', () => {
  it('shows the values in centimetres and leaves a value the paragraphs differ in blank', () => {
    const f = dialogFields(
      view({
        indentLeft: Math.round(2 * TWIPS_PER_CM),
        indentRight: null,
        tabs: [{ position: Math.round(5 * TWIPS_PER_CM), align: 'right', leader: 'dot' }],
      }),
    );
    expect(f.left).toBe('2');
    expect(f.right).toBe('');
    expect(f.tabs).toEqual([{ position: '5', align: 'right', leader: 'dot' }]);
  });

  it('reads a decimal point or comma, and refuses text', () => {
    expect(parseCentimetres('1.5')).toBe(Math.round(1.5 * TWIPS_PER_CM));
    expect(parseCentimetres('1,5')).toBe(Math.round(1.5 * TWIPS_PER_CM));
    expect(parseCentimetres('-1')).toBe(-Math.round(TWIPS_PER_CM));
    expect(parseCentimetres('')).toBeNull();
    expect(parseCentimetres('wide')).toBeNull();
    expect(parseCentimetres('1cm')).toBeNull();
  });
});

describe('paragraph dialog patch', () => {
  it('is null when nothing changed', () => {
    const f = view({ indentLeft: 720, tabs: [{ position: 1440, align: 'left', leader: 'none' }] });
    expect(dialogPatch(f, dialogFields(f)).patch).toBeNull();
  });

  it('holds only what changed', () => {
    const f = view();
    const fields = dialogFields(f);
    fields.left = '2';
    const result = dialogPatch(f, fields);
    expect(result.patch).toEqual({ indentLeft: Math.round(2 * TWIPS_PER_CM) });
    expect(result.invalid).toEqual([]);
  });

  it('keeps each value where the field is blank and the paragraphs differ, and writes it once filled', () => {
    const f = view({ indentLeft: null });
    expect(dialogPatch(f, dialogFields(f)).patch).toBeNull();
    const fields = dialogFields(f);
    fields.left = '1';
    expect(dialogPatch(f, fields).patch).toEqual({ indentLeft: Math.round(TWIPS_PER_CM) });
  });

  it('writes the tab stops whole, by position, and null for none', () => {
    const f = view({ tabs: [{ position: 1440, align: 'left', leader: 'none' }] });
    const fields = dialogFields(f);
    fields.tabs.push({ position: '1', align: 'center', leader: 'dot' });
    const result = dialogPatch(f, fields);
    const tabs = result.patch?.['tabs'] as Array<{ position: number }>;
    expect(tabs.map((t) => t.position)).toEqual([Math.round(TWIPS_PER_CM), 1440]);
    const none = dialogFields(f);
    none.tabs = [];
    expect(dialogPatch(f, none).patch).toEqual({ tabs: null });
  });

  it('names the fields that are not lengths and makes no patch', () => {
    const f = view();
    const fields: DialogFields = { ...dialogFields(f), left: 'x', tabs: [] };
    fields.tabs.push({ position: '-3', align: 'left', leader: 'none' });
    const result = dialogPatch(f, fields);
    expect(result.patch).toBeNull();
    expect(result.invalid).toEqual(['left', 'tab0']);
  });

  it('agrees with the ruler: the same indent through either gives the same patch', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (quarterCm) => {
        const f = view();
        const column = 9026;
        const twips = Math.round((quarterCm / 4) * TWIPS_PER_CM);
        const viaRuler = indentPatch(
          indentsOf(f),
          moveMarker('left', twips, indentsOf(f), column),
          f,
        );
        const fields = dialogFields(f);
        fields.left = String(quarterCm / 4);
        const viaDialog = dialogPatch(f, fields).patch;
        // Both write the same indent; the ruler also keeps the first line where it is.
        expect(viaDialog?.['indentLeft'] ?? null).toBe(viaRuler?.['indentLeft'] ?? null);
      }),
    );
  });
});
