/**
 * The page-guide inputs of the element (FE-068 criteria 1 and 2; lane V-FE-065-080, round 3 fix):
 * the `layout.json` reader (`parseLayoutReport`, `loadLayoutReport`) and the config switch
 * (`pageGuidesFrom`). Pure functions, so these run in Node.js. The drawing is in
 * packages/engine/src/view/fe-068-page-guides.universal.test.ts and the mount in e2e/fe-068-page-guides.spec.ts.
 *
 * The reports are real ones: `fixtures/fe-068-worker-pages-20.layout.json` is the `layout.json` the
 * export worker wrote for the corpus document pages-20 (19 pages) in a Podman compile with LuaLaTeX
 * on 2026-11-06 (copied unchanged from
 * services/export-worker/out/measure/corpus-v2/pages-20-podman-on-node.layout.json; the run is
 * described in that directory's summary.md), and `workerLayoutJson` builds one with the worker's own
 * code (fe-068-worker-layout.ts). Both pass the worker's schema check (`validateLayout`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateLayout } from '../../../services/export-worker/src/layout.ts';
import { normaliseConfig } from '../src/config.ts';
import { loadLayoutReport, pageGuideBlockIds, parseLayoutReport } from '../src/page-guides.ts';
import { workerLayoutJson } from './fe-068-worker-layout.ts';

const compiled: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/fe-068-worker-pages-20.layout.json', import.meta.url), 'utf8'),
);

describe('the pageGuides config switch (FE-068 criterion 1)', () => {
  it('turns guides on only for the boolean true; guides are off by default', () => {
    expect(normaliseConfig(null).pageGuides).toBe(false);
    expect(normaliseConfig({}).pageGuides).toBe(false);
    expect(normaliseConfig({ pageGuides: false }).pageGuides).toBe(false);
    for (const value of ['true', 1, 'yes', {}, []]) {
      expect(normaliseConfig({ pageGuides: value }).pageGuides).toBe(false);
    }
    expect(normaliseConfig({ pageGuides: true }).pageGuides).toBe(true);
  });

  it('draws nothing from a real report while guides are off', () => {
    expect(pageGuideBlockIds(parseLayoutReport(compiled), false)).toEqual([]);
  });
});

describe('parseLayoutReport on the layout.json of a real compile (FE-068 criterion 2)', () => {
  it('is a file the export worker serves (its schema check passes)', () => {
    expect(validateLayout(compiled)).toEqual([]);
  });

  it('reads one start per page, in page order', () => {
    const report = parseLayoutReport(compiled);
    expect(report).not.toBeNull();
    expect(report?.seq).toBeNull();
    expect(report?.starts).toHaveLength(19);
    expect(report?.starts[0]).toEqual({ blockId: '20SFmBcv8qrt9ox2', offset: 0 });
    expect(report?.starts[2]).toEqual({ blockId: 'O7LcqiSt41ZrMMGj', offset: 995 });
  });

  it('draws a guide before each block a page starts at, and none for a page that starts inside a paragraph', () => {
    const guides = pageGuideBlockIds(parseLayoutReport(compiled), true);
    // Pages 1, 2, 6 to 9 and 17 to 19 start at a block (offset 0); pages 6 and 7 open with a table head.
    expect(guides).toEqual([
      '20SFmBcv8qrt9ox2',
      'e7Ah2L5tvw_80tK3',
      'HCsif0rB_L-Uw-S6',
      'v_ih92cFPu1mGSJy',
      'L2LWo4PDZ2FK9gaT',
      'J__N7zWMFA3Ezn6s',
      'm1HsAxJ4_Qo5ttUX',
      'nqivBP8H_o6rNJQH',
      'vqrSZKkgRDqHcrPf',
    ]);
    // Pages 3 to 5 and 10 to 16 start inside a paragraph: no guide for those blocks.
    for (const inside of [
      'O7LcqiSt41ZrMMGj',
      'I6dkEOJfAAQkwRJi',
      'cSw8qwRQsEzyPDL-',
      'GxgADp3ireGWFPWQ',
    ])
      expect(guides).not.toContain(inside);
  });
});

describe('parseLayoutReport on reports built by the worker and on the spec example (FE-068 criterion 2)', () => {
  it('reads a report the worker builds from the class sidecar file and its map', () => {
    const layout = workerLayoutJson(
      ['pFirst0000000001', 'pSecond000000001', 'pThird0000000001'],
      [
        { block: 0, offset: 0 },
        { block: 1, offset: 37 },
        { block: 2, offset: 0 },
      ],
      12,
    );
    const report = parseLayoutReport(JSON.parse(JSON.stringify(layout)));
    expect(report).toEqual({
      seq: 12,
      starts: [
        { blockId: 'pFirst0000000001', offset: 0 },
        { blockId: 'pSecond000000001', offset: 37 },
        { blockId: 'pThird0000000001', offset: 0 },
      ],
    });
    expect(pageGuideBlockIds(report, true)).toEqual(['pFirst0000000001', 'pThird0000000001']);
  });

  it('reads the example of 09 §7.1', () => {
    const report = parseLayoutReport({
      seq: 416,
      classVersion: '1.3.0',
      granularity: 'line',
      pages: [
        {
          n: 1,
          setup: 'ps1',
          starts: { blockId: 'p3Jq8sLw0aZx1VbN', offset: 0 },
          opensWith: 'text',
        },
        {
          n: 2,
          setup: 'ps1',
          starts: { blockId: 'pA1b2C3d4E5f6G7h', offset: 412 },
          opensWith: 'tableHead',
        },
      ],
      blocks: { pA1b2C3d4E5f6G7h: { lineStarts: [0, 96, 188, 301, 412, 498] } },
      fields: { fQ2x8Lm0aZx1VbN7: { page: 2, rect: [1440, 9020, 3360, 9300] } },
    });
    expect(report?.seq).toBe(416);
    expect(pageGuideBlockIds(report, true)).toEqual(['p3Jq8sLw0aZx1VbN']);
  });

  it('leaves out a page whose start the worker could not name (starts null)', () => {
    const report = parseLayoutReport({
      seq: null,
      pages: [
        { n: 1, setup: null, starts: null, opensWith: 'float' },
        {
          n: 2,
          setup: null,
          starts: { blockId: 'pA1b2C3d4E5f6G7h', offset: 0, y: 1639 },
          opensWith: 'text',
        },
      ],
    });
    expect(report).toEqual({ seq: null, starts: [{ blockId: 'pA1b2C3d4E5f6G7h', offset: 0 }] });
  });

  it('gives null, and so no guide, for a malformed report', () => {
    const page = (starts: unknown, n = 1) => ({ n, setup: null, starts, opensWith: 'text' });
    const good = { blockId: 'pA1b2C3d4E5f6G7h', offset: 0 };
    for (const value of [
      null,
      'x',
      3,
      [],
      { seq: 1 },
      { pages: [] },
      { seq: '1', pages: [] },
      { seq: -1, pages: [] },
      { seq: 1, pages: {} },
      // The shape the first version of this reader expected, which no compile writes.
      { seq: 1, starts: [good] },
      { seq: 1, pages: [page(good, 2)] },
      { seq: 1, pages: [page({ blockId: 7, offset: 0 })] },
      { seq: 1, pages: [page({ blockId: '', offset: 0 })] },
      { seq: 1, pages: [page({ blockId: 'p', offset: 1.5 })] },
      { seq: 1, pages: [page({ blockId: 'p', offset: -1 })] },
      { seq: 1, pages: [page(good), page('x', 2)] },
      { seq: 1, pages: [page(good), null] },
    ]) {
      expect(parseLayoutReport(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('loadLayoutReport (FE-068 criterion 2)', () => {
  it('fetches the signed URL without credentials and reads the report', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fake = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(compiled), { status: 200 }));
    };
    const report = await loadLayoutReport('https://store.invalid/layout.json', fake);
    expect(report?.starts).toHaveLength(19);
    expect(seen[0]?.url).toBe('https://store.invalid/layout.json');
    expect(seen[0]?.init?.credentials).toBe('omit');
  });

  it('gives null on a failed response or a network error, and draws nothing', async () => {
    const notOk = () => Promise.resolve(new Response('{}', { status: 403 }));
    const broken = () => Promise.reject(new TypeError('network'));
    expect(await loadLayoutReport('https://store.invalid/a.json', notOk)).toBeNull();
    expect(await loadLayoutReport('https://store.invalid/a.json', broken)).toBeNull();
  });
});

describe('page guides after an edit since the compile seq (FE-068 criterion 4; owner decision 179)', () => {
  it('keeps the guides of the compile when the document has changed since its seq', () => {
    // The owner's answer (docs/owner-decisions-2026-11-15.md, row 179): guides are kept and `seq`
    // is not compared. The element holds the report from the last compile and clears it only when a
    // session opens (doc-editor.ts), so an edit leaves the same starts to draw.
    const report = parseLayoutReport({ ...(compiled as Record<string, unknown>), seq: 3 });
    expect(report?.seq).toBe(3);
    const guides = pageGuideBlockIds(report, true);
    expect(guides).toHaveLength(9);
    expect(pageGuideBlockIds(report, true)).toEqual(guides);
  });
});
