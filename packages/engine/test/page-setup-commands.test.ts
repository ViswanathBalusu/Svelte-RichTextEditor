/**
 * Page setup commands (FE-137 criteria 1, 3 and 6). Criterion 2 (header and footer stories), 4 (page
 * number fields follow the start and format) and 5 (the PDF prints the watermark) are not tested
 * here: they need stories, page fields and the export pipeline.
 */
import { CDM1 } from '@docedit/model/definition';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import {
  PAGE_NUMBER_FORMATS,
  PAPER_SIZES,
  invalidField,
  pageSetupPos,
  setPageSetup,
  type PageSetupChanges,
} from '../src/page-setup-commands.ts';
import { authoringState } from './authoring-doc.ts';

const always = () => true;

function pageSetupAttrs(doc: Node, id: string): Record<string, unknown> {
  let attrs: Record<string, unknown> | null = null;
  doc.firstChild!.forEach((child) => {
    if (child.type.name === 'page_setup' && child.attrs['id'] === id) attrs = child.attrs;
  });
  if (!attrs) throw new Error(`no page setup ${id}`);
  return attrs;
}

/** Applies a change and returns the resulting attributes, or the refusal. */
function apply(changes: PageSetupChanges, writable = always) {
  const state = authoringState();
  const out: { state: typeof state | null } = { state: null };
  const result = setPageSetup(state, 'ps1', changes, { writable }, (tr) => {
    out.state = state.apply(tr);
  });
  return { result, attrs: out.state ? pageSetupAttrs(out.state.doc, 'ps1') : null };
}

describe('paper size, orientation and margins (FE-137 criterion 1)', () => {
  it('stores A4 and US Letter in twentieths of a point', () => {
    expect(apply({ paperSize: 'A4' }).attrs).toMatchObject({ width: 11906, height: 16838 });
    expect(apply({ paperSize: 'Letter' }).attrs).toMatchObject({ width: 12240, height: 15840 });
    expect(PAPER_SIZES.Letter).toEqual({ width: 12240, height: 15840 });
  });

  it('stores the orientation and the four margins as given', () => {
    const { result, attrs } = apply({
      orientation: 'landscape',
      marginTop: 1134,
      marginRight: 1134,
      marginBottom: 1440,
      marginLeft: 2268,
    });
    expect(result.ok).toBe(true);
    expect(attrs).toMatchObject({
      orientation: 'landscape',
      marginTop: 1134,
      marginRight: 1134,
      marginBottom: 1440,
      marginLeft: 2268,
    });
  });

  it('property: any margin in the CDM range is stored exactly, in twips', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 31680 }),
        fc.integer({ min: 0, max: 31680 }),
        (top, left) => {
          const { attrs } = apply({ marginTop: top, marginLeft: left });
          expect(attrs!['marginTop']).toBe(top);
          expect(attrs!['marginLeft']).toBe(left);
        },
      ),
    );
  });
});

describe('header and footer distances, gutter and columns (FE-137 criterion 3)', () => {
  it('stores the distances, the gutter and the column settings', () => {
    const { result, attrs } = apply({
      headerDistance: 567,
      footerDistance: 851,
      gutter: 284,
      columns: 2,
      columnGap: 720,
    });
    expect(result.ok).toBe(true);
    expect(attrs).toMatchObject({
      headerDistance: 567,
      footerDistance: 851,
      gutter: 284,
      columns: 2,
      columnGap: 720,
    });
  });
});

describe('page numbering and watermark stored with the setup (FE-137 criteria 4 and 5, storage only)', () => {
  it('stores the first page number, the format and the watermark text', () => {
    const { attrs } = apply({
      pageNumberStart: 3,
      pageNumberFormat: 'lowerRoman',
      watermark: 'DRAFT',
    });
    expect(attrs).toMatchObject({
      pageNumberStart: 3,
      pageNumberFormat: 'lowerRoman',
      watermark: 'DRAFT',
    });
    expect(apply({ pageNumberStart: null, watermark: null }).attrs).toMatchObject({
      pageNumberStart: null,
      watermark: null,
    });
  });

  it('the format list is the CDM one', () => {
    const def = CDM1.nodes.find((n) => n.name === 'page_setup');
    const json = JSON.stringify(def);
    for (const format of PAGE_NUMBER_FORMATS) expect(json).toContain(`"${format}"`);
    expect(PAGE_NUMBER_FORMATS).toHaveLength(5);
  });
});

describe('refusals (FE-137 criteria 1 and 6)', () => {
  it('refuses values the CDM does not allow, names the field, and changes nothing', () => {
    const bad: Array<[PageSetupChanges, string]> = [
      [{ width: 100 }, 'width'],
      [{ height: 40000 }, 'height'],
      [{ marginTop: -1 }, 'marginTop'],
      [{ gutter: 1.5 }, 'gutter'],
      [{ orientation: 'upside' as never }, 'orientation'],
      [{ columns: 0 }, 'columns'],
      [{ paperSize: 'B5' as never }, 'paperSize'],
      [{ pageNumberFormat: 'hebrew' as never }, 'pageNumberFormat'],
      [{ pageNumberStart: 40000 }, 'pageNumberStart'],
      [{ watermark: '' }, 'watermark'],
      [{ watermark: 'x'.repeat(256) }, 'watermark'],
      [{ differentFirstPage: 'yes' as never }, 'differentFirstPage'],
      [{ headerFirst: 'story1' } as never, 'headerFirst'],
    ];
    for (const [changes, field] of bad) {
      const { result, attrs } = apply(changes);
      expect(result).toEqual({ ok: false, reason: 'invalid-value', field });
      expect(attrs).toBeNull();
    }
  });

  it('refuses a change to a page setup that does not exist', () => {
    const state = authoringState();
    expect(
      setPageSetup(state, 'missing', { orientation: 'landscape' }, { writable: always }),
    ).toEqual({
      ok: false,
      reason: 'no-page-setup',
    });
  });

  it('a region-only editor cannot change a page setup definition (07 §5.3, PRM-012)', () => {
    const state = authoringState();
    let checked = -1;
    const result = setPageSetup(
      state,
      'ps1',
      { orientation: 'landscape' },
      {
        writable: (pos) => {
          checked = pos;
          return false;
        },
      },
    );
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    // The check is made on the definition's own position, not on the body text.
    expect(checked).toBe(pageSetupPos(state.doc, 'ps1'));
  });

  it('invalidField passes an empty change set', () => {
    expect(invalidField({})).toBeNull();
  });
});
