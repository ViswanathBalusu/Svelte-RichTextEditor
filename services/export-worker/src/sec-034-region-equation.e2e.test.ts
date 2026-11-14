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
 * Finding (2026-11-13): the pixel check fails for the strongest equation. Its nested radicals are
 * typeset taller than their line and paint over the headings and paragraphs above and below
 * (`it.fails` below records the gap; the text check passes). The criterion stays unticked until the
 * class keeps an inline equation inside its line box (see the story Notes and ADR 0346).
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

/** Boxes overlap by more than half a point on both axes. */
const overlaps = (a: Word, b: Word): boolean =>
  a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5;

describe.skipIf(!ready.ok || !pdftotextAvailable())(
  `SEC-034 criterion 5: region A equation cannot hide region B (${ready.reason})`,
  () => {
    let pdf: Uint8Array;
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

    // Known gap, recorded as `it.fails`: the equation's glyphs overlap region B's words on the
    // rendered page (the text check above still passes). When the class keeps the equation inside
    // its line, this test passes and `it.fails` turns it red: then make it `it` and tick the
    // criterion.
    it.fails("keeps region B's price words free of other glyphs on the rendered page", () => {
      // pdftotext does not keep the price sentence in one run of boxes (the equation's glyphs
      // and the headings interleave with it), so the price words are taken where they occur
      // once on the page. Each has ink in its box, and no other word of the page overlaps it.
      const words = pageWords(pdf, dir);
      const unique = price
        .split(' ')
        .map((w) => words.filter((x) => x.text === w))
        .filter((hits) => hits.length === 1)
        .map((hits) => hits[0]!);
      expect(unique.length, 'price words found once on the page').toBeGreaterThanOrEqual(8);
      const img = renderPage(pdf, dir);
      for (const box of unique) {
        expect(inkInside(img, box), `ink under "${box.text}"`).toBeGreaterThan(0);
        const clash = words.find((w) => w !== box && overlaps(box, w));
        expect(clash?.text ?? null, `"${box.text}" overlapped`).toBeNull();
      }
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
  },
);
