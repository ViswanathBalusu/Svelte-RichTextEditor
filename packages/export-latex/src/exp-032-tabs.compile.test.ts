/**
 * Tab stops in the compiled PDF (Node.js only, sandbox): EXP-032 criteria 1 and 2. The bundle is
 * compiled in the export worker's sandbox (Podman) through `test/harness.ts`. Word positions come
 * from `pdftotext -bbox`, in points from the top left of the page. Every paragraph starts with the
 * word `START`, which sits on the left margin, so each stop is measured from its x position.
 *
 * - Criterion 1: left, centre and right stops place text at the stop from the left margin, and the
 *   converter writes no `\tabto`. A decimal stop puts the end of the integer part on the stop (the
 *   integer widths are calibrated by the same PDF). Dot, hyphen and middle-dot leaders fill the gap
 *   to a right stop with one repeated character (read from `pdftotext -raw`); underscore and heavy
 *   leaders are rules, read from the page content stream as one line across the gap.
 * - Criterion 2: a tab after the last stop advances to the next multiple of `defaultTabStop`
 *   (720 twips = 36 pt here), both with no stops and after one stop.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
/** Tolerance in points: the stops are twips, rounded by the line breaker and by poppler. */
const TOL = 1.5;

interface Word {
  xMin: number;
  xMax: number;
  /** The vertical extent, in points from the bottom of the page (PDF user space). */
  yBottom: number;
  yTop: number;
  text: string;
}

/** The words of the first page with their extents, from `pdftotext -bbox`. */
function words(pdf: Uint8Array, name: string): Word[] {
  const dir = join(tmpdir(), 'docedit-exp-032-tabs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
  // pdftotext measures y from the top of the page; the content stream measures it from the bottom.
  const height = Number(/<page width="[\d.]+" height="([\d.]+)"/.exec(r.stdout)?.[1] ?? Number.NaN);
  const out: Word[] = [];
  const re =
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  for (const m of r.stdout.matchAll(re))
    out.push({
      xMin: Number(m[1]),
      xMax: Number(m[3]),
      yBottom: height - Number(m[4]),
      yTop: height - Number(m[2]),
      text: m[5] ?? '',
    });
  return out;
}

/** A horizontal mark of the page: a stroked line or a filled rectangle, in points. */
interface Mark {
  x0: number;
  x1: number;
  /** The centre line, from the bottom of the page. */
  y: number;
  /** The thickness: the line width of a stroke, the height of a rectangle. */
  t: number;
}

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/**
 * The horizontal marks of the page content streams. Every stream that inflates and has a text
 * object is read as page content (object streams and fonts have none). The reader follows the
 * graphics state (`q`, `Q`, `cm`, `w`), collects the path (`m`, `l`, `re`), and records it when it
 * is stroked (`S`, `s`) or filled (`f`, `F`, `f*`, `B`, `b`). Text objects are skipped. Then
 * marks of the same thickness on the same line that touch are merged, so a leader is one mark
 * whether LuaTeX draws one long rule or a row of short ones.
 */
function horizontalMarks(pdf: Uint8Array): Mark[] {
  const text = Buffer.from(pdf).toString('latin1');
  const marks: Mark[] = [];
  let at = 0;
  for (;;) {
    const s = text.indexOf('stream', at);
    if (s < 0) break;
    const end = text.indexOf('endstream', s);
    if (end < 0) break;
    let start = s + 'stream'.length;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    at = end + 'endstream'.length;
    let plain: string;
    try {
      plain = inflateSync(Buffer.from(text.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue; // not a Flate stream
    }
    if (!/\bBT\b/.test(plain)) continue;
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    let lineWidth = 1;
    const stack: Array<{ ctm: Matrix; lineWidth: number }> = [];
    let operands: number[] = [];
    let inText = false;
    let point: [number, number] | null = null;
    let path: Array<{
      kind: 'line' | 'rect';
      a: [number, number];
      b: [number, number];
      h: number;
    }> = [];
    const apply = (x: number, y: number): [number, number] => [
      ctm[0] * x + ctm[2] * y + ctm[4],
      ctm[1] * x + ctm[3] * y + ctm[5],
    ];
    const scale = (): number => Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
    const tokens =
      /\((?:\\[^]|[^\\)])*\)|<<|>>|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/[\]()<>{}%]*|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+/g;
    for (const m of plain.matchAll(tokens)) {
      const tok = m[0];
      if (/^[-+]?(?:\d|\.\d)/.test(tok)) {
        operands.push(Number(tok));
        continue;
      }
      if (!/^[A-Za-z'"*]+$/.test(tok)) continue; // strings, names, arrays: operands we do not need
      const o = operands;
      operands = [];
      if (tok === 'BT') inText = true;
      else if (tok === 'ET') inText = false;
      if (inText) continue;
      switch (tok) {
        case 'q':
          stack.push({ ctm, lineWidth });
          break;
        case 'Q': {
          const g = stack.pop();
          if (g) ({ ctm, lineWidth } = g);
          break;
        }
        case 'cm':
          if (o.length >= 6) ctm = multiply(o.slice(-6) as Matrix, ctm);
          break;
        case 'w':
          if (o.length >= 1) lineWidth = o[o.length - 1]!;
          break;
        case 'm':
          if (o.length >= 2) point = apply(o[o.length - 2]!, o[o.length - 1]!);
          break;
        case 'l':
          if (o.length >= 2 && point) {
            const next = apply(o[o.length - 2]!, o[o.length - 1]!);
            path.push({ kind: 'line', a: point, b: next, h: lineWidth * scale() });
            point = next;
          }
          break;
        case 're':
          if (o.length >= 4) {
            const [x, y, w, h] = o.slice(-4) as [number, number, number, number];
            const a = apply(Math.min(x, x + w), y + h / 2);
            const b = apply(Math.max(x, x + w), y + h / 2);
            path.push({ kind: 'rect', a, b, h: Math.abs(h) * scale() });
          }
          break;
        case 'S':
        case 's':
          for (const p of path) if (p.kind === 'line') marks.push(toMark(p.a, p.b, p.h));
          path = [];
          break;
        case 'f':
        case 'F':
        case 'f*':
        case 'B':
        case 'B*':
        case 'b':
        case 'b*':
          for (const p of path) if (p.kind === 'rect') marks.push(toMark(p.a, p.b, p.h));
          path = [];
          break;
        case 'n':
          path = [];
          break;
        default:
          break;
      }
    }
  }
  return mergeMarks(marks.filter((k) => Number.isFinite(k.y)));
}

/** A horizontal mark from two points; a line that is not horizontal gets a NaN y and is dropped. */
function toMark(a: [number, number], b: [number, number], t: number): Mark {
  if (Math.abs(a[1] - b[1]) > 0.01) return { x0: 0, x1: 0, y: Number.NaN, t };
  return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y: a[1], t };
}

/** Merges marks of one thickness on one line that touch or overlap (within 0.05 pt). */
function mergeMarks(marks: Mark[]): Mark[] {
  const sorted = [...marks].sort((p, q) => p.t - q.t || p.y - q.y || p.x0 - q.x0);
  const out: Mark[] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.t - k.t) < 0.05 &&
      Math.abs(last.y - k.y) < 0.05 &&
      k.x0 <= last.x1 + 0.05
    )
      last.x1 = Math.max(last.x1, k.x1);
    else out.push({ ...k });
  }
  return out;
}

const word = (ws: Word[], text: string): Word => {
  const found = ws.find((w) => w.text === text);
  if (!found) throw new Error(`the word ${text} is not in the PDF`);
  return found;
};

const tabLine = (text: string, tabs: J[]): J =>
  para('', { tabs }, [{ type: 'text', text: 'START' }, { type: 'tab' }, { type: 'text', text }]);

describe.skipIf(!ready)(
  'EXP-032 criterion 1 (part): left, centre and right stops are measured from the margin',
  () => {
    it('places each word at its stop, and writes no tabto', async () => {
      const body = [
        tabLine('LEFTW', [{ position: 2880, align: 'left', leader: 'none' }]),
        tabLine('CENTREWORD', [{ position: 4320, align: 'center', leader: 'none' }]),
        tabLine('RIGHTW', [{ position: 5760, align: 'right', leader: 'none' }]),
      ];
      const c = await convertAndCompile(doc(body, { settings: { defaultTabStop: 720 } }), {
        profile: 'preview',
        title: 'exp-032-stops',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-032-stops', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.bundle.files['main.tex']).not.toContain('\\tabto');

      const ws = words(c.compile.pdf, 'exp-032-stops');
      const left = word(ws, 'START').xMin;
      const leftW = word(ws, 'LEFTW');
      expect(Math.abs(leftW.xMin - left - 144)).toBeLessThan(TOL);

      const centre = word(ws, 'CENTREWORD');
      expect(Math.abs((centre.xMin + centre.xMax) / 2 - left - 216)).toBeLessThan(TOL);

      const right = word(ws, 'RIGHTW');
      expect(Math.abs(right.xMax - left - 288)).toBeLessThan(TOL);
    }, 300_000);
  },
);

describe.skipIf(!ready)(
  'EXP-032 criterion 2: a tab after the last stop advances to a multiple of defaultTabStop',
  () => {
    it('moves to 36 pt with no stops, and to the next 36 pt multiple after one stop', async () => {
      // Line 1: no stops, so the tab goes to the first multiple of 36 pt.
      // Line 2: one stop at 72 pt. The second tab is after that stop, so the default rule applies
      // from the end of YYY.
      const body = [
        para('', {}, [
          { type: 'text', text: 'START' },
          { type: 'tab' },
          { type: 'text', text: 'BB' },
        ]),
        para('', { tabs: [{ position: 1440, align: 'left', leader: 'none' }] }, [
          { type: 'text', text: 'START' },
          { type: 'tab' },
          { type: 'text', text: 'YYY' },
          { type: 'tab' },
          { type: 'text', text: 'ZZ' },
        ]),
      ];
      const c = await convertAndCompile(doc(body, { settings: { defaultTabStop: 720 } }), {
        profile: 'preview',
        title: 'exp-032-default',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-032-default', c)}):\n${c.compile.log.slice(-1500)}`,
        );

      const ws = words(c.compile.pdf, 'exp-032-default');
      const left = word(ws, 'START').xMin;
      expect(Math.abs(word(ws, 'BB').xMin - left - 36)).toBeLessThan(TOL);

      const yEnd = word(ws, 'YYY').xMax - left;
      const expected = (Math.floor(yEnd / 36) + 1) * 36;
      expect(Math.abs(word(ws, 'ZZ').xMin - left - expected)).toBeLessThan(TOL);
    }, 300_000);
  },
);

describe.skipIf(!ready)(
  'EXP-032 criterion 1 (decimal and leaders): the point sits on a decimal stop, and dots fill a leader',
  () => {
    it('puts the decimal point of each number on the stop, and fills the gap to a right stop with dot leaders', async () => {
      // Calibration: the same integer parts set at the margin give the width of each integer part.
      // A decimal stop at 216 pt puts the end of the integer part at 216 pt from the margin.
      const body = [
        para('12'),
        para('345'),
        tabLine('12.5', [{ position: 4320, align: 'decimal', leader: 'none' }]),
        tabLine('345.25', [{ position: 4320, align: 'decimal', leader: 'none' }]),
        tabLine('LEADEND', [{ position: 5760, align: 'right', leader: 'dot' }]),
        // One right stop per leader kind after the first; each line ends with its own END word.
        tabLine('END1', [{ position: 6480, align: 'right', leader: 'hyphen' }]),
        tabLine('END2', [{ position: 7200, align: 'right', leader: 'underscore' }]),
        tabLine('END3', [{ position: 7920, align: 'right', leader: 'middleDot' }]),
        tabLine('END4', [{ position: 8640, align: 'right', leader: 'heavy' }]),
      ];
      const c = await convertAndCompile(doc(body, { settings: { defaultTabStop: 720 } }), {
        profile: 'preview',
        title: 'exp-032-decimal',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-032-decimal', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.bundle.files['main.tex']).not.toContain('\\tabto');

      const ws = words(c.compile.pdf, 'exp-032-decimal');
      const left = word(ws, 'START').xMin;
      const width = (text: string): number => {
        const w = word(ws, text);
        return w.xMax - w.xMin;
      };
      for (const [integer, whole] of [
        ['12', '12.5'],
        ['345', '345.25'],
      ] as const) {
        const w = word(ws, whole);
        // The integer part ends where the point is, and the point is on the stop.
        expect(Math.abs(w.xMin + width(integer) - left - 216)).toBeLessThan(TOL);
        // A decimal stop is not a left stop: the number starts before the stop.
        expect(w.xMin).toBeLessThan(left + 216 - 5);
      }

      // The right stop at 288 pt: the leader fills the gap between START and LEADEND with dots.
      const raw = (pdfText(c.compile.pdf) ?? '').split('\n');
      const leaderLine = raw.find((l) => l.includes('LEADEND')) ?? '';
      const dots = /START(\.+)LEADEND/.exec(leaderLine.replace(/\s+/g, ''));
      expect(dots?.[1]?.length ?? 0).toBeGreaterThanOrEqual(10);
      expect(Math.abs(word(ws, 'LEADEND').xMax - left - 288)).toBeLessThan(TOL);

      // Hyphen and middle-dot leaders are characters, so pdftotext shows them: each fills its gap with
      // one repeated character, and the stop is where the word ends. (Underscore and heavy leaders are
      // rules; the rule test below checks them.)
      for (const [end, stop] of [
        ['END1', 324],
        ['END3', 396],
      ] as const) {
        expect(Math.abs(word(ws, end).xMax - left - stop), `stop of ${end}`).toBeLessThan(TOL);
        const line = (raw.find((l) => l.includes(end)) ?? '').replace(/\s+/g, '');
        const fill = new RegExp(`START(.+)${end}`).exec(line)?.[1] ?? '';
        expect(fill.length, `leader before ${end} in "${line}"`).toBeGreaterThanOrEqual(10);
        expect(new Set(fill).size, `one leader character before ${end}`).toBe(1);
      }
      expect(Math.abs(word(ws, 'END2').xMax - left - 360), 'stop of END2').toBeLessThan(TOL);
      expect(Math.abs(word(ws, 'END4').xMax - left - 432), 'stop of END4').toBeLessThan(TOL);
    }, 300_000);
  },
);

describe.skipIf(!ready)(
  'EXP-032 criterion 1 (rule leaders): underscore and heavy leaders reach the page',
  () => {
    // `make_leader` in docedit.lua puts the rule of an underscore (0.4 pt) or heavy (0.9 pt) leader
    // in a 1 pt box and repeats it across the gap. The test does not count the repeats: it merges the
    // marks of the page into lines (see `horizontalMarks`), so it holds whether LuaTeX writes one long
    // rule or a row of short ones, and checks that each leader is one line from START to its end word.
    it('draws one line across the gap of an underscore or a heavy leader, at the leader thickness', async () => {
      const body = [
        tabLine('UEND', [{ position: 7200, align: 'right', leader: 'underscore' }]),
        tabLine('HEND', [{ position: 8640, align: 'right', leader: 'heavy' }]),
      ];
      const c = await convertAndCompile(doc(body, { settings: { defaultTabStop: 720 } }), {
        profile: 'preview',
        title: 'exp-032-rules',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-032-rules', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      const ws = words(c.compile.pdf, 'exp-032-rules');
      const starts = ws.filter((w) => w.text === 'START');
      expect(starts).toHaveLength(2);
      const marks = horizontalMarks(c.compile.pdf);
      for (const [end, thickness] of [
        ['UEND', 0.4],
        ['HEND', 0.9],
      ] as const) {
        const last = word(ws, end);
        // The START word of the same line: the one whose vertical extent overlaps the end word's.
        const first = starts.find((w) => w.yBottom < last.yTop && last.yBottom < w.yTop);
        if (!first) throw new Error(`no START word on the line of ${end}`);
        const lines = marks.filter((k) => Math.abs(k.t - thickness) < 0.05);
        expect(lines, `one ${thickness} pt line for ${end}: ${JSON.stringify(marks)}`).toHaveLength(
          1,
        );
        const line = lines[0]!;
        // The line fills the gap: it starts where START ends and stops where the end word starts. The
        // leader boxes are 1 pt wide and aligned to the line, so each end may fall up to 1 pt short.
        expect(Math.abs(line.x0 - first.xMax), `start of the ${end} leader`).toBeLessThan(TOL);
        expect(Math.abs(line.x1 - last.xMin), `end of the ${end} leader`).toBeLessThan(TOL);
        // The line is on the text line (between the words' bottom and top), not on another line.
        expect(line.y, `height of the ${end} leader`).toBeGreaterThan(first.yBottom);
        expect(line.y, `height of the ${end} leader`).toBeLessThan(first.yTop);
      }
      // Each gap ends at its stop: the underscore at 360 pt, the heavy leader at 432 pt.
      const left = starts[0]!.xMin;
      expect(Math.abs(word(ws, 'UEND').xMax - left - 360)).toBeLessThan(TOL);
      expect(Math.abs(word(ws, 'HEND').xMax - left - 432)).toBeLessThan(TOL);
    }, 300_000);
  },
);
