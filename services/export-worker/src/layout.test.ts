import { describe, expect, it } from 'vitest';
import type { SourceMap } from '@docedit/export-latex';
import { buildLayout, LayoutError, parseRawLayout, validateLayout } from './layout.ts';

const map: SourceMap = {
  version: 1,
  blocks: [null, 'p3Jq8sLw0aZx1VbN', 'pA1b2C3d4E5f6G7h', 'fnAAAAAAAAAAAAAA'],
  kinds: ['', 'heading', 'paragraph', 'footnote'],
  owners: [null, null, null, null],
  lines: [],
  setups: ['ps1'],
};
const SP = 65781.76 / 20; // scaled points per twip

const raw = JSON.stringify({
  v: 1,
  level: 2,
  pages: [
    { n: 1, w: 39159881, h: 55381663, start: [1, 0, Math.round(1440 * SP)], first: [1, 1] },
    { n: 2, w: 39159881, h: 55381663, start: [2, 412, Math.round(1500 * SP)], first: [2, 3] },
  ],
  blocks: {
    '1': [1, Math.round(1440 * SP), 0],
    '2': [1, Math.round(2000 * SP), 0],
    '3': [1, Math.round(15000 * SP), 0],
  },
  lines: [
    [1, 0, 1, Math.round(1440 * SP)],
    [2, 0, 1, Math.round(2000 * SP)],
    [2, 96, 1, Math.round(2300 * SP)],
    [2, 412, 2, Math.round(1500 * SP)],
  ],
});

describe('layout.json (09 §7.1)', () => {
  it('joins the raw report with map.json and validates', () => {
    const layout = buildLayout(parseRawLayout(raw), map, {
      seq: 416,
      classVersion: '0.1.0-s4',
      setup: 'ps1',
    });
    expect(validateLayout(layout)).toEqual([]);
    expect(layout.granularity).toBe('line');
    expect(layout.pages[0]).toEqual({
      n: 1,
      setup: 'ps1',
      starts: { blockId: 'p3Jq8sLw0aZx1VbN', offset: 0, y: 1440 },
      opensWith: 'text',
    });
    expect(layout.pages[1]?.opensWith).toBe('tableHead');
    expect(layout.pages[1]?.starts).toEqual({ blockId: 'pA1b2C3d4E5f6G7h', offset: 412, y: 1500 });
    expect(layout.blocks['pA1b2C3d4E5f6G7h']).toEqual({
      page: 1,
      y: 2000,
      lineStarts: [0, 96, 412],
      linePages: [1, 1, 2],
    });
  });

  it('rejects malformed or hostile raw data', () => {
    for (const bad of [
      'not json',
      '{"v":2,"level":2,"pages":[],"blocks":{},"lines":[]}',
      '{"v":1,"level":2,"pages":[{"n":2}],"blocks":{},"lines":[]}',
      '{"v":1,"level":2,"pages":[],"blocks":{"x":[1,2,3]},"lines":[]}',
      '{"v":1,"level":2,"pages":[],"blocks":{},"lines":[[1,2,3]]}',
      '{"v":1,"level":2,"pages":[],"blocks":{},"lines":[[1,2,3,1e300]]}',
      '{"v":1,"level":2,"pages":[{"n":1,"start":"<script>"}],"blocks":{},"lines":[]}',
    ])
      expect(() => parseRawLayout(bad), bad).toThrow(LayoutError);
  });

  it('refuses a report with extra members, oversized data or too many pages (SEC-036 criterion 3)', () => {
    // Extra members at the top and in a page are refused, not ignored.
    expect(() => parseRawLayout(raw.replace('"v":1', '"v":1,"script":"x"'))).toThrow(
      'unknown member script',
    );
    expect(() =>
      parseRawLayout('{"v":1,"level":1,"pages":[{"n":1,"x":1}],"blocks":{},"lines":[]}'),
    ).toThrow('unknown member x');
    expect(() =>
      parseRawLayout('{"v":1,"level":1,"pages":[{"n":1,"w":1.5}],"blocks":{},"lines":[]}'),
    ).toThrow(LayoutError);
    // Oversized data is refused before it is parsed, and a page count over the limit too.
    expect(() => parseRawLayout(raw, { maxBytes: 100, maxPages: 2000 })).toThrow('too large');
    expect(() => parseRawLayout(raw, { maxBytes: 1_000_000, maxPages: 1 })).toThrow('bad pages');
    // The report the class writes (with w and h on each page) is still accepted.
    expect(parseRawLayout(raw).pages).toHaveLength(2);
  });

  it("names each page's setup from map.json when the class reports its index", () => {
    const r = parseRawLayout(
      '{"v":1,"level":1,"pages":[{"n":1,"s":0,"start":[1,0,0]},{"n":2,"s":7}],"blocks":{},"lines":[]}',
    );
    const layout = buildLayout(r, map, { seq: null, classVersion: '0.2.0', setup: null });
    expect(layout.pages.map((p) => p.setup)).toEqual(['ps1', null]);
    expect(() =>
      parseRawLayout('{"v":1,"level":1,"pages":[{"n":1,"s":"x"}],"blocks":{},"lines":[]}'),
    ).toThrow(LayoutError);
  });

  it('drops block numbers the converter never issued', () => {
    const r = parseRawLayout(
      '{"v":1,"level":1,"pages":[{"n":1,"start":[99,0,0]}],"blocks":{"99":[1,0,0]},"lines":[]}',
    );
    const layout = buildLayout(r, map, { seq: null, classVersion: '0.1.0-s4', setup: null });
    expect(layout.pages[0]?.starts).toBeNull();
    expect(layout.blocks).toEqual({});
    expect(validateLayout(layout)).toEqual([]);
  });

  it('catches schema violations', () => {
    const layout = buildLayout(parseRawLayout(raw), map, {
      seq: 1,
      classVersion: '0.1.0-s4',
      setup: null,
    });
    expect(validateLayout({ ...layout, extra: 1 })).toContain('unknown member extra');
    expect(validateLayout({ ...layout, granularity: 'glyph' })).toContain('granularity');
    expect(validateLayout({ ...layout, blocks: { short: { page: 1, y: 0 } } })).toContain(
      'blocks key short',
    );
  });
});
