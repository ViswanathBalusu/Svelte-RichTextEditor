/**
 * SEC-034 criterion 5 (lane V-SEC-033-048): a user who may edit only region A puts the strongest
 * equation the math gate accepts into region A, and the final PDF still shows region B's text.
 *
 * The check runs the real converter (`runExport`) and the real Podman sandbox of the worker image,
 * and reads the PDF two ways: the extracted text (`pdftotext -raw`), and the word boxes of
 * `pdftotext -bbox` checked against the rendered page (`pdftoppm`, 72 dpi, so one pixel is one
 * point). Each word of region B's price sentence must have ink in its box, and no other word on
 * the page may overlap it.
 *
 * Finding (2026-11-13, lane V-SEC-033-048): the equation's glyphs, nested radicals among them, were
 * typeset taller than their line and painted over the headings and paragraphs around it. Fixed
 * (lane w8, 2026-11-26): `clip_math` of the class (packages/export-latex/class/docedit.lua) cuts an
 * inline equation to the height and depth of its line, so nothing of it is painted outside the line.
 * The pixel check is a comparison with the same page set with a plain `x` for the equation: each
 * word of region B's price sentence has the ink it has there. (The text layer is not the check: the
 * boxes `pdftotext -bbox` gives for a radical sign still overlap neighbouring words after the cut,
 * though nothing is painted there.)
 *
 * The equation is placed in the document envelope, not sent over a room. The commit-time gate for
 * the same kind of equation is covered by SEC-034 criterion 1 (services/document-service and
 * tests/security/test/sec-034-production-math-gate.test.ts). Skips without Podman, the worker image
 * or the poppler tools (`sandboxReady`, `pdftotextAvailable`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mathGateReason, type FontManifest } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { demoDocument, REGION_A } from '../test/documents.ts';
import { pdftotextAvailable, pdfText, squash } from '../test/pdf-text.ts';
import { podman } from './container.ts';
import { runExport } from './pipeline.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ready = await sandboxReady();

/** A fraction nested `depth` levels, with a root in a radical at each level. */
function nested(depth: number): string {
  let f = 'x';
  for (let i = 0; i < depth; i++) f = `\\frac{${f}}{\\sqrt{${f}}}`;
  return f;
}

/**
 * The strongest equation the gate accepts that we can build: every space command at its bound
 * (2 em, 22 pt, 36 mu, ADR 0046), large delimiters, a deep fraction and a line of text.
 */
const STRONGEST =
  `\\hspace{2em}\\bigg[\\bigg(${nested(6)}\\bigg)\\bigg]^{\\hspace{22pt}}` +
  `\\mkern36mu\\text{GBP 1,000,000 per month}\\hspace{2em}`;

async function imageFonts(): Promise<FontManifest> {
  const r = await podman(
    [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--entrypoint=cat',
      IMAGE,
      '/opt/docedit/fonts/fonts.json',
    ],
    // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (sandbox-ready.ts).
    { timeoutMs: 180_000, maxStdoutBytes: 1024 * 1024 },
  );
  const why = r.timedOut ? 'timed out' : r.stderr.slice(0, 500);
  expect(r.code, `reading fonts.json: ${why}`).toBe(0);
  return JSON.parse(new TextDecoder().decode(r.stdout)) as FontManifest;
}

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

/** The demo document with `latex` in the Normal paragraph of region A and nothing else changed. */
function withEquationInRegionA(latex: string): { env: CdmEnvelope; text: string[] } {
  const demo = demoDocument();
  const env = structuredClone(demo.envelope) as unknown as { doc: { content: Node[] } };
  const body = env.doc.content.find((n) => n.type === 'body')!;
  const region = body.content!.find((n) => n.type === 'region' && n.attrs?.['id'] === REGION_A)!;
  const para = region.content!.find((n) => n.attrs?.['id'] === 'pTermsBody000001')!;
  para.content = [
    { type: 'text', text: `${demo.text[2]!} ` },
    { type: 'equation', attrs: { latex } },
    { type: 'text', text: ' ends the terms.' },
  ];
  return { env: env as unknown as CdmEnvelope, text: demo.text };
}

interface Word {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The words of page 1 in reading order, with their boxes in points from the top left. */
function pageWords(pdf: Uint8Array, dir: string): Word[] {
  const file = join(dir, 'words.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  expect(r.status, String(r.stderr)).toBe(0);
  const words: Word[] = [];
  for (const m of r.stdout.matchAll(
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g,
  )) {
    words.push({
      x0: Number(m[1]),
      y0: Number(m[2]),
      x1: Number(m[3]),
      y1: Number(m[4]),
      text: decode(m[5]!),
    });
  }
  return words;
}

interface Pixels {
  w: number;
  h: number;
  data: Buffer;
}

/** Page 1 at 72 dpi as a binary PPM (P6), parsed without a dependency. */
function renderPage(pdf: Uint8Array, dir: string): Pixels {
  const file = join(dir, 'render.pdf');
  writeFileSync(file, pdf);
  const prefix = join(dir, 'page');
  // Without a format flag pdftoppm writes PPM (P6), one file per page.
  const r = spawnSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', file, prefix], {
    timeout: 60_000,
    windowsHide: true,
  });
  expect(r.status, String(r.stderr)).toBe(0);
  const ppm = readdirSync(dir).find((f) => f.startsWith('page') && f.endsWith('.ppm'))!;
  const buf = readFileSync(join(dir, ppm));
  let pos = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    let s = '';
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]!))) {
      s += String.fromCharCode(buf[pos]!);
      pos++;
    }
    tokens.push(s);
  }
  pos++; // one white space after the maximum value
  expect(tokens[0]).toBe('P6');
  return { w: Number(tokens[1]), h: Number(tokens[2]), data: buf.subarray(pos) };
}

/** Dark pixels (red channel under 128) inside the box of a word, clipped to the page. */
function inkInside(img: Pixels, b: Word): number {
  let ink = 0;
  const x0 = Math.max(0, Math.floor(b.x0));
  const x1 = Math.min(img.w, Math.ceil(b.x1));
  const y0 = Math.max(0, Math.floor(b.y0));
  const y1 = Math.min(img.h, Math.ceil(b.y1));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (img.data[(y * img.w + x) * 3]! < 128) ink++;
  return ink;
}

describe.skipIf(!ready.ok || !pdftotextAvailable())(
  `SEC-034 criterion 5: region A equation cannot hide region B (${ready.reason})`,
  () => {
    let pdf: Uint8Array;
    /** The same page with `x` for the equation: what region B looks like without the attack. */
    let control: Uint8Array;
    let price: string;
    let flat: string;
    let dir: string;
    let log = '';

    beforeAll(async () => {
      const { env, text } = withEquationInRegionA(STRONGEST);
      price = squash(text[4]!);
      const fonts = await imageFonts();
      const r = await runExport(
        env,
        fonts,
        { tagging: 'off', pdfStandard: 'none', layout: 'block' },
        { kind: 'sandbox' },
      );
      log = r.compile.log.slice(-2000);
      if (r.compile.ok) pdf = r.compile.pdf!;
      const c = await runExport(
        withEquationInRegionA('x').env,
        fonts,
        { tagging: 'off', pdfStandard: 'none', layout: 'block' },
        { kind: 'sandbox' },
      );
      if (c.compile.ok) control = c.compile.pdf!;
      if (pdf) flat = squash(pdfText(pdf, { first: 1, last: 1 }) ?? '');
      dir = mkdtempSync(join(tmpdir(), 'docedit-sec034-'));
    }, 300_000);

    it('gives the strongest equation the gate accepts, within the length limit', () => {
      expect(STRONGEST.length).toBeLessThan(4000);
      expect(mathGateReason(STRONGEST, false)).toBeNull();
    });

    it("compiles, and the extracted text holds the equation and region B's price sentence", () => {
      expect(pdf, log).toBeDefined();
      expect(flat).toContain('GBP 1,000,000 per month');
      expect(flat).toContain(price);
    });

    // The pixel half. Each word of the price sentence that occurs once on the page has ink in its
    // box, and the same ink as on the page set with a plain `x`: nothing is painted over it, and
    // nothing of it is hidden. The words are matched by their text, since the equation may change
    // where the line breaks fall.
    it("shows region B's price words with the ink they have without the equation", () => {
      expect(control, 'the control compiled').toBeDefined();
      const attackWords = pageWords(pdf, dir);
      const controlWords = pageWords(control, dir);
      const attackImg = renderPage(pdf, dir);
      const controlImg = renderPage(control, dir);
      const once = (words: Word[], t: string): Word | null => {
        const hits = words.filter((x) => x.text === t);
        return hits.length === 1 ? hits[0]! : null;
      };
      let compared = 0;
      for (const t of price.split(' ')) {
        const a = once(attackWords, t);
        const c = once(controlWords, t);
        if (!a || !c) continue;
        compared++;
        const inkA = inkInside(attackImg, a);
        const inkC = inkInside(controlImg, c);
        expect(inkC, `ink under "${t}" in the control`).toBeGreaterThan(0);
        expect(inkA, `ink under "${t}"`).toBeGreaterThan(0);
        expect(Math.abs(inkA - inkC), `ink under "${t}": ${inkA} against ${inkC}`).toBeLessThanOrEqual(
          Math.max(3, Math.round(inkC * 0.1)),
        );
      }
      expect(compared, 'price words found once on both pages').toBeGreaterThanOrEqual(8);
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
  },
);
