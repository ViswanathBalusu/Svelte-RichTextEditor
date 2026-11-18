/**
 * Spike S7 (SPK-020): both candidate layout cores driven from the same CDM flow blocks, measured by
 * the same deterministic stubs. Runs in Node.js and, as a universal test, in Chromium, Firefox and
 * WebKit, where it must reproduce the results recorded in Node.js.
 */
import { loadDocument } from '@docedit/corpus';
import example from '@docedit/model/fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '@docedit/model/fixtures/kitchen-sink.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import {
  advanceTableMeasurer,
  checkCoverage,
  digestText,
  fixedWidthMeasurer,
  layoutWithDocen,
  summarise,
  toFlow,
  treeDigest,
  type CdmEnvelopeLike,
  type FlowDocument,
  type LayoutPage,
  type TextMeasurer,
} from './index.ts';
import { layoutWithEigenpal } from './eigenpal.ts';

const documents: Record<string, () => Promise<CdmEnvelopeLike>> = {
  'example-03-12': () => Promise.resolve(example as CdmEnvelopeLike),
  'kitchen-sink': () => Promise.resolve(kitchenSink as CdmEnvelopeLike),
  'pages-1': async () => (await loadDocument('pages-1')).envelope as unknown as CdmEnvelopeLike,
  'form-fields': async () =>
    (await loadDocument('form-fields')).envelope as unknown as CdmEnvelopeLike,
  'pages-20': async () => (await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike,
};

const measurers: Record<string, () => TextMeasurer> = {
  fixed: () => fixedWidthMeasurer(),
  table: () => advanceTableMeasurer(),
};

/**
 * The inputs the results below were recorded from (digest of each envelope's JSON). The corpus and
 * the model fixtures belong to other packages and may change; a result is compared with its
 * recording only while its input is unchanged, and is otherwise only logged.
 */
const INPUTS: Record<string, string> = {
  'example-03-12': 'fd024285',
  'kitchen-sink': 'a8448393',
  'pages-1': '8b494b25',
  'form-fields': '7f7bebb7',
  'pages-20': '9592dabc',
};

/**
 * Results recorded in Node.js 22.18 on 2026-11-06: [pages, body lines, digest of the tree]. A null
 * digest marks a result that depends on the environment even with a deterministic measurer:
 * Docen's pretext corrects the advance of bold CJK text from a hidden DOM span in the browser's own
 * font, which no injected measurer reaches. In `pages-20` one Japanese heading line comes out 132.0,
 * 126.6 and 130.1 points wide in Node.js, Chromium and Firefox (spike report §3.2).
 */
const EXPECTED: Record<string, [number, number, string | null]> = {
  'docen/example-03-12/fixed': [1, 3, 'c42af32c'],
  'eigenpal/example-03-12/fixed': [1, 3, '30fd3133'],
  'docen/example-03-12/table': [1, 3, '9e8f5930'],
  'eigenpal/example-03-12/table': [1, 3, 'eb7e36be'],
  'docen/kitchen-sink/fixed': [2, 13, '04ff9e3e'],
  'eigenpal/kitchen-sink/fixed': [2, 13, '1518cdaf'],
  'docen/kitchen-sink/table': [2, 13, '79921907'],
  'eigenpal/kitchen-sink/table': [2, 13, '17987143'],
  'docen/pages-1/fixed': [1, 33, 'c538cac6'],
  'eigenpal/pages-1/fixed': [1, 33, '6e80d21b'],
  'docen/pages-1/table': [1, 32, 'd26d4fa5'],
  'eigenpal/pages-1/table': [1, 32, '280408ef'],
  // Re-recorded on 2026-11-17 (Node.js 22.18) when a form field without a width became a box of the
  // default width of its kind (FRW-080 criterion 3), where it had been laid out as its value.
  'docen/form-fields/fixed': [1, 29, '121e5bdf'],
  // Re-recorded on 2026-11-13 (Node.js 22.18, Chromium, Firefox and WebKit gave the same digests)
  // when the flow took the larger-of gap and per-side contextual spacing (CDM-043, ADR 0032).
  'eigenpal/form-fields/fixed': [1, 29, '92d2dc1d'],
  'docen/form-fields/table': [1, 26, 'b50aa8f3'],
  'eigenpal/form-fields/table': [1, 26, 'bf37668f'],
  'docen/pages-20/fixed': [18, 966, '318703cc'],
  'eigenpal/pages-20/fixed': [17, 1026, 'e5f435dd'],
  'docen/pages-20/table': [19, 919, null],
  'eigenpal/pages-20/table': [19, 971, '7d5bc829'],
};

const flows = new Map<string, Promise<{ flow: FlowDocument; unchanged: boolean }>>();
const flowOf = (name: string): Promise<{ flow: FlowDocument; unchanged: boolean }> => {
  let f = flows.get(name);
  if (!f) {
    f = documents[name]!().then((env) => {
      const input = digestText(JSON.stringify(env));
      console.info(`[S7] input ${name}: ${input}`);
      return { flow: toFlow(env), unchanged: INPUTS[name] === input };
    });
    flows.set(name, f);
  }
  return f;
};

const environment = typeof navigator === 'undefined' ? 'node' : navigator.userAgent;

describe.each(Object.keys(documents))('%s', (name) => {
  describe.each(Object.keys(measurers))('measured by the %s stub', (measurerName) => {
    it('Docen lays out every block with lines covering its CDM range, deterministically', async () => {
      const { flow, unchanged } = await flowOf(name);
      const tree = layoutWithDocen(flow, { measurer: measurers[measurerName]!() });
      expect(checkCoverage(flow, tree)).toEqual([]);
      expect(tree.pages.length).toBeGreaterThan(0);
      const again = layoutWithDocen(flow, { measurer: measurers[measurerName]!() });
      expect(treeDigest(again)).toBe(treeDigest(tree));
      expect(Object.isFrozen(tree.pages[0])).toBe(true);
      expect(() => (tree.pages as LayoutPage[]).push(tree.pages[0]!)).toThrow();
      const s = summarise(tree);
      const key = `docen/${name}/${measurerName}`;
      const expected = EXPECTED[key];
      console.info(
        `[S7] ${environment} ${key}: ${JSON.stringify([s.pages, s.bodyLines, treeDigest(tree)])}`,
      );
      if (expected && unchanged)
        expect([s.pages, s.bodyLines, expected[2] === null ? null : treeDigest(tree)]).toEqual(
          expected,
        );
    });

    it('Eigenpal lays out every block with lines covering its CDM range, deterministically', async () => {
      const { flow, unchanged } = await flowOf(name);
      const report = await layoutWithEigenpal(flow, measurers[measurerName]!());
      expect(report.unknownParagraphs).toEqual([]);
      expect(report.lengthMismatches).toEqual([]);
      expect(checkCoverage(flow, report.tree)).toEqual([]);
      const again = await layoutWithEigenpal(flow, measurers[measurerName]!());
      expect(treeDigest(again.tree)).toBe(treeDigest(report.tree));
      const s = summarise(report.tree);
      const key = `eigenpal/${name}/${measurerName}`;
      const expected = EXPECTED[key];
      console.info(
        `[S7] ${environment} ${key}: ${JSON.stringify([s.pages, s.bodyLines, treeDigest(report.tree)])}`,
      );
      if (expected && unchanged)
        expect([s.pages, s.bodyLines, treeDigest(report.tree)]).toEqual(expected);
    });
  });
});
