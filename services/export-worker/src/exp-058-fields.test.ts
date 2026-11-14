/**
 * Form field rectangles in layout.json (EXP-058), Node.js only: the parse of the class's `fields`
 * member, the join with the converter's map, and the schema checks. The compile that produces the
 * rectangles is in packages/export-latex/src/exp-058-fields.compile.test.ts (Podman).
 */
import { describe, expect, it } from 'vitest';
import { buildLayout, parseRawLayout, validateLayout, type LayoutJson } from './layout.ts';

const ID_A = 'aaaaaaaaaaaaaaa1';
const ID_B = 'bbbbbbbbbbbbbbb2';

/** Scaled points for a number of twentieths of a point (the class's units, see layout.ts). */
const sp = (twips: number): number => Math.round(twips * (65781.76 / 20));

function map(fields: Array<string | null> | undefined): Parameters<typeof buildLayout>[1] {
  const m = {
    version: 1,
    blocks: [null, ID_A],
    kinds: ['paragraph'],
    owners: [null, null],
    lines: [],
    setups: ['ps1'],
  };
  return (fields === undefined ? m : { ...m, fields }) as never;
}

function raw(fields: unknown): string {
  return JSON.stringify({
    v: 1,
    level: 2,
    pages: [
      { n: 1, start: [1, 0, sp(200)], first: [1, 1] },
      { n: 2, start: [1, 5, sp(200)], first: [1, 1] },
    ],
    blocks: { '1': [1, sp(200), 0] },
    lines: [],
    ...(fields === undefined ? {} : { fields }),
  });
}

const meta = { seq: 3, classVersion: '0.2.2', setup: 'ps1' };

describe('EXP-058: the class reports a field box under its number, joined to the field identifier', () => {
  it('builds fields keyed by identifier, with the page and the rectangle in twentieths of a point', () => {
    const r = parseRawLayout(raw({ '1': [2, sp(100), sp(300), sp(2980), sp(340)] }));
    const layout: LayoutJson = buildLayout(r, map([null, ID_A]), meta);
    expect(layout.fields).toEqual({ [ID_A]: { page: 2, rect: [100, 300, 2980, 340] } });
    expect(validateLayout(layout)).toEqual([]);
  });

  it('drops a number the map does not name, and a page the file does not have', () => {
    const r = parseRawLayout(
      raw({ '1': [2, sp(100), sp(300), sp(200), sp(340)], '2': [9, 0, 0, 1, 1] }),
    );
    const layout = buildLayout(r, map([null, ID_A, ID_B]), meta);
    expect(Object.keys(layout.fields)).toEqual([ID_A]);
    const none = buildLayout(parseRawLayout(raw({ '1': [1, 0, 0, 1, 1] })), map(undefined), meta);
    expect(none.fields).toEqual({});
  });

  it('accepts a report without a fields member (a class before EXP-058)', () => {
    const layout = buildLayout(parseRawLayout(raw(undefined)), map([null, ID_A]), meta);
    expect(layout.fields).toEqual({});
    expect(validateLayout(layout)).toEqual([]);
  });

  it('refuses a field entry of the wrong shape', () => {
    expect(() => parseRawLayout(raw({ '1': [2, 1, 2, 3] }))).toThrow(/bad field entry/);
    expect(() => parseRawLayout(raw({ x: [2, 1, 2, 3, 4] }))).toThrow(/bad field entry/);
    expect(() => parseRawLayout(raw([]))).toThrow(/bad fields/);
  });
});

describe('EXP-058 criterion 3: the schema documents the rectangle, its unit and origin', () => {
  const good = (): LayoutJson =>
    buildLayout(
      parseRawLayout(raw({ '1': [1, sp(100), sp(300), sp(2980), sp(340)] })),
      map([null, ID_A]),
      meta,
    );

  it('refuses a rectangle whose bottom-right corner is above its top-left corner', () => {
    const v = good() as unknown as { fields: Record<string, { rect: number[] }> };
    v.fields[ID_A]!.rect = [100, 300, 90, 340];
    expect(validateLayout(v).some((e) => e.startsWith(`fields.${ID_A}`))).toBe(true);
  });

  it('refuses a field whose page is not a page of the file, and an identifier of the wrong form', () => {
    const v = good() as unknown as { fields: Record<string, { page: number }> };
    v.fields[ID_A]!.page = 5;
    expect(validateLayout(v).some((e) => e.startsWith(`fields.${ID_A}`))).toBe(true);
    const w = good() as unknown as { fields: Record<string, unknown> };
    w.fields['short'] = w.fields[ID_A];
    expect(validateLayout(w)).toContain('fields key short');
  });
});
