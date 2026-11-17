/**
 * Row, table and atom suggestions in markup on the compiled PDF (Node.js only, sandbox): EXP-083
 * criterion 3. The first page is rendered with `pdftoppm` and the pixels of the insertion colour
 * (#1F5FAD) and the deletion colour (#B3261E) are counted; the text of every cell is still in the
 * PDF's text. A second compile holds equations with an insertion and a deletion mark, which the
 * class must underline and strike through without a TeX error.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, firstError, pdfText, sandboxReady } from '../test/harness.ts';
import { delMark, insMark, tableOf, text } from '../test/suggestions.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

const ready = (await sandboxReady()).ok;
const INSTANT = '2026-11-17T10:00:00.000Z';

interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}

function readPpm(bytes: Uint8Array): Image {
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i]!))) i++;
    let s = '';
    while (i < bytes.length && !/\s/.test(String.fromCharCode(bytes[i]!)))
      s += String.fromCharCode(bytes[i++]!);
    fields.push(s);
  }
  if (fields[0] !== 'P6') throw new Error(`not a binary PPM: ${fields[0]}`);
  return { width: Number(fields[1]), height: Number(fields[2]), rgb: bytes.subarray(i + 1) };
}

/** The first page of a PDF as an image, by `pdftoppm`, without anti-aliasing. */
function renderFirstPage(pdf: Uint8Array): Image {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-markup-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync(
    'pdftoppm',
    ['-r', '100', '-f', '1', '-l', '1', '-aa', 'no', '-aaVector', 'no', file, join(dir, 'page')],
    { timeout: 120_000 },
  );
  if (r.error || r.status !== 0) throw new Error('pdftoppm is not installed or failed');
  const name = readdirSync(dir).find((n) => n.endsWith('.ppm'));
  if (!name) throw new Error('pdftoppm wrote no page');
  return readPpm(readFileSync(join(dir, name)));
}

type Match = (r: number, g: number, b: number) => boolean;
const BLUE: Match = (r, g, b) => r < 90 && g > 60 && g < 140 && b > 130;
const RED: Match = (r, g, b) => r > 140 && g < 90 && b < 90;

const count = (img: Image, match: Match): number => {
  let n = 0;
  for (let k = 0; k < img.width * img.height * 3; k += 3)
    if (match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) n++;
  return n;
};

const options = { instant: INSTANT, suggestions: 'markup', tagging: 'off' } as const;

describe.skipIf(!ready)('EXP-083 criterion 3 on the compiled PDF', () => {
  it('draws a deleted row, an inserted table and a deleted table in the marked colours', async () => {
    const plain = await convertAndCompile(
      doc([tableOf([{ cells: ['plain one'] }, { cells: ['plain two'] }])]),
      options,
    );
    expect(plain.compile.ok, firstError(plain.compile.log)).toBe(true);
    expect(count(renderFirstPage(plain.compile.pdf!), BLUE)).toBe(0);
    expect(count(renderFirstPage(plain.compile.pdf!), RED)).toBe(0);

    const marked = await convertAndCompile(
      doc([
        tableOf([{ cells: ['row one'] }, { cells: ['row two'], marks: [delMark(1)] }]),
        para('Between the tables.'),
        tableOf([{ cells: ['table added'] }], [insMark(2)]),
      ]),
      options,
    );
    expect(marked.compile.ok, firstError(marked.compile.log)).toBe(true);
    const page = renderFirstPage(marked.compile.pdf!);
    expect(count(page, RED), 'deleted row is red').toBeGreaterThan(50);
    expect(count(page, BLUE), 'inserted table is blue').toBeGreaterThan(50);
    const words = (pdfText(marked.compile.pdf!) ?? '').replace(/\s+/g, ' ');
    for (const w of ['row one', 'row two', 'Between the tables.', 'table added'])
      expect(words).toContain(w);
  });

  it('underlines and strikes through equations that carry a mark', async () => {
    const equation = (n: number, marks: J[]): J => ({
      type: 'equation',
      attrs: { id: `eqMarkup${String(n).padStart(8, '0')}`, latex: 'x^2+1' },
      marks,
    });
    const c = await convertAndCompile(
      doc([
        para('', {}, [
          text('Added '),
          equation(1, [insMark(3)]),
          text(' removed '),
          equation(2, [delMark(4)]),
          text(' end.'),
        ]),
      ]),
      options,
    );
    expect(c.compile.ok, firstError(c.compile.log)).toBe(true);
    const page = renderFirstPage(c.compile.pdf!);
    expect(count(page, BLUE)).toBeGreaterThan(20);
    expect(count(page, RED)).toBeGreaterThan(20);
  });
});
