/**
 * `layout.json` from a compile (Node.js only, sandbox): EXP-055 criteria 2, 3, 4 and 6. The class's
 * Lua code writes `main.layout` in the export worker's sandbox (Podman); `test/harness.ts` parses
 * it and joins it with the converter's `map.json`, so these tests read the same object the job
 * would serve. The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here
 * (EXP-070).
 *
 * Criterion 4 is checked by the first line of each paragraph in the PDF: `pdftotext -raw` gives the
 * first word of each line, and the UTF-16 offset of that line must point at the same word in the
 * block's text. A paragraph with astral characters (each two UTF-16 units) is used, so an offset
 * that counts code points instead of code units fails.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

// Each case runs two or three LuaLaTeX passes in the sandbox. The 60 s default of the shared config is
// too short when other compiles share the machine (review of round 8), so each case gets 5 minutes.
const COMPILE_TIMEOUT_MS = 300_000;

function options(layout: 'line' | 'block', title: string): Record<string, unknown> {
  return {
    profile: 'preview',
    title,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout,
  };
}

/** A paragraph of `words` numbered words: long enough to span more than one page. */
function longPara(tag: string, words: number): J {
  return para(Array.from({ length: words }, (_v, i) => `${tag}${i}`).join(' '));
}

const OPENS = new Set(['text', 'float', 'tableHead', 'footnoteContinuation']);

describe.skipIf(!ready)(
  'EXP-055 criterion 2: each page reports its number, setup, first block start and what it opens with',
  () => {
    it(
      'reports pages 1 to n in order, and a page that opens inside a paragraph starts at that paragraph with an offset above zero',
      async () => {
        const first = para('First paragraph.');
        const long = longPara('w', 900);
        const last = para('Last paragraph.');
        const c = await convertAndCompile(
          doc([first, long, last]),
          options('line', 'exp-055-pages') as never,
          { minPasses: 2 },
        );
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-055-pages', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const layout = c.layout!;
        expect(layout.pages.length).toBeGreaterThanOrEqual(2);
        layout.pages.forEach((p, i) => {
          expect(p.n).toBe(i + 1);
          expect(OPENS.has(p.opensWith)).toBe(true);
          // The class reports a page setup by index; the job names it from the bundle's setup list.
          expect(c.bundle.map.setups).toContain(p.setup);
        });
        const firstId = (first['attrs'] as J)['id'] as string;
        const longId = (long['attrs'] as J)['id'] as string;
        expect(layout.pages[0]!.starts?.blockId).toBe(firstId);
        expect(layout.pages[0]!.starts?.offset).toBe(0);
        expect(layout.pages[1]!.starts?.blockId).toBe(longId);
        expect(layout.pages[1]!.starts!.offset).toBeGreaterThan(0);
        expect(layout.pages[1]!.opensWith).toBe('text');
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!ready)(
  'EXP-055 criterion 3: the file carries seq, classVersion and granularity, and every page has a block start',
  () => {
    it(
      'copies seq and classVersion from the job, names the granularity, and gives every page a block start',
      async () => {
        const body = [para('A.'), longPara('v', 500), para('B.')];
        const c = await convertAndCompile(
          doc(body),
          { ...options('line', 'exp-055-header'), seq: 42 } as never,
          { minPasses: 2 },
        );
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-055-header', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const layout = c.layout!;
        expect(layout.seq).toBe(42);
        expect(c.bundle.manifest.seq).toBe(42);
        expect(layout.classVersion).toBe(c.bundle.manifest.classVersion);
        expect(['line', 'block']).toContain(layout.granularity);
        expect(layout.granularity).toBe('line');
        for (const p of layout.pages) expect(p.starts).not.toBeNull();
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!ready)(
  'EXP-055 criterion 4: offsets count UTF-16 code units, and a line start points at its word',
  () => {
    it(
      'gives, for each line of a paragraph with astral characters, an offset at which the first word of that line is printed',
      async () => {
        // U+1D400 (MATHEMATICAL BOLD CAPITAL A) is outside the BMP: two UTF-16 units each.
        const astral = '\u{1D400}';
        const words = Array.from({ length: 260 }, (_v, i) =>
          i % 3 === 0 ? `${astral}k${i}` : `q${i}`,
        );
        const p = para(words.join(' '));
        const pid = (p['attrs'] as J)['id'] as string;
        const c = await convertAndCompile(doc([p]), options('line', 'exp-055-utf16') as never, {
          minPasses: 2,
        });
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-055-utf16', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const block = c.layout!.blocks[pid];
        expect(block?.lineStarts).toBeDefined();
        const starts = block!.lineStarts!;
        const text = words.join(' ');
        expect(starts[0]).toBe(0);
        for (let k = 1; k < starts.length; k++) expect(starts[k]!).toBeGreaterThan(starts[k - 1]!);
        expect(starts[starts.length - 1]!).toBeLessThan(text.length);
        // Each line's first word, from the PDF, is the word at the line's offset in the text.
        const lines = (pdfText(c.compile.pdf) ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '');
        // The astral character may be left out of the PDF text, so both sides drop leading non-ASCII-alphanumerics.
        const bare = (s: string): string => s.replace(/^[^A-Za-z0-9]+/, '');
        const firstWords = lines.map((l) => bare(l.split(/\s+/)[0]!));
        let checked = 0;
        for (let k = 1; k < Math.min(starts.length, firstWords.length); k++) {
          const w = firstWords[k]!;
          if (w === '') continue;
          const expected = bare(text.slice(starts[k]!).split(' ')[0]!);
          expect(
            expected.startsWith(w) || w.startsWith(expected),
            `line ${k}: ${w} at ${starts[k]}`,
          ).toBe(true);
          checked++;
        }
        expect(checked).toBeGreaterThan(10);
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!ready)(
  'EXP-055 criterion 6: text that imitates layout data does not change the file',
  () => {
    it(
      'still validates, and reports the real pages, when the text holds a layout.json look-alike',
      async () => {
        const imitation =
          '{"seq":99,"classVersion":"0.0.1","granularity":"block","pages":[{"n":7,"setup":"x","starts":null,"opensWith":"text"}]}';
        const body = [
          para(imitation),
          longPara('z', 900),
          para(`\\DEpage{9} \\write18{x} ${imitation}`),
        ];
        const c = await convertAndCompile(
          doc(body),
          { ...options('block', 'exp-055-imitation'), seq: 42 } as never,
          { minPasses: 2 },
        );
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-055-imitation', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const layout = c.layout!;
        expect(layout.seq).toBe(42);
        expect(layout.classVersion).not.toBe('0.0.1');
        expect(layout.pages.map((p) => p.n)).toEqual(layout.pages.map((_p, i) => i + 1));
        expect(layout.pages.length).toBeGreaterThanOrEqual(2);
        expect(layout.pages.some((p) => p.n === 7)).toBe(false);
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);
