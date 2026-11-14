/**
 * Form field rectangles in `layout.json` (EXP-058): a compile in the export worker's sandbox (Podman)
 * and `pdftotext -bbox` on the PDF it makes. The class reports the box of each flattened form field
 * under its number; the worker joins the number with the converter's map and writes the rectangle
 * in twentieths of a point from the top-left corner of the page (the unit and origin of the schema).
 * PDF points are twentieths of a big point, so a rectangle divided by 20 is in the PDF's own units.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const COMPILE_TIMEOUT_MS = 300_000;

function options(title: string): Record<string, unknown> {
  return {
    profile: 'preview',
    title,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'line',
  };
}

/** A text form field of `width` twentieths of a point, with a value (or none). */
function field(key: string, label: string, value: string | null, width: number): J {
  return { type: 'form_field', attrs: { id: nid('ff'), key, kind: 'text', label, width, value } };
}

/** A paragraph of `words` numbered words, long enough to fill the first page and beyond. */
function longPara(tag: string, words: number): J {
  return para(Array.from({ length: words }, (_v, i) => `${tag}${i}`).join(' '));
}

interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The words of each page from `pdftotext -bbox`, page 1 first. */
function pagesOf(pdf: Uint8Array): Word[][] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-058-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
  return r.stdout
    .split('<page ')
    .slice(1)
    .map((page) =>
      [
        ...page.matchAll(
          /<word xMin="([^"]*)" yMin="([^"]*)" xMax="([^"]*)" yMax="([^"]*)">([^<]*)<\/word>/g,
        ),
      ].map((m) => ({
        x0: Number(m[1]),
        y0: Number(m[2]),
        x1: Number(m[3]),
        y1: Number(m[4]),
        text: m[5]!,
      })),
    );
}

describe.skipIf(!ready)(
  'EXP-058 criteria 1 to 3: every form field has its page and rectangle, and the value lies in it',
  () => {
    it(
      'keys each field by identifier and gives a rectangle in twentieths of a point that the printed value fills',
      async () => {
        const f1 = field('amount', 'Amount', 'Ada', 2880);
        const f2 = field('blank', 'Blank', null, 1440);
        const body = [
          para('Amount:', {}, [{ type: 'text', text: ' ' }, f1]),
          para('Blank:', {}, [{ type: 'text', text: ' ' }, f2]),
        ];
        const c = await convertAndCompile(doc(body), options('exp-058-rects') as never, {
          minPasses: 1,
        });
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-058-rects', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const layout = c.layout!;
        const id1 = (f1['attrs'] as J)['id'] as string;
        const id2 = (f2['attrs'] as J)['id'] as string;

        // Criterion 1: an entry for every form field, keyed by identifier, with page and rect.
        expect(Object.keys(layout.fields).sort()).toEqual([id1, id2].sort());
        const r1 = layout.fields[id1]!;
        expect(r1.page).toBe(1);
        expect(layout.fields[id2]!.page).toBe(1);

        // Criterion 3: the unit is twentieths of a point and the origin the top-left of the page. The
        // width of the first field is 2880 (144 points), and its left edge is where pdftotext puts it.
        const [x0, y0, x1, y1] = r1.rect;
        expect(Math.abs(x1 - x0 - 2880)).toBeLessThanOrEqual(2);
        expect(y1).toBeGreaterThan(y0);
        expect(x0).toBeGreaterThan(0);
        expect(y0).toBeGreaterThan(0);

        // Criterion 2: the printed value lies inside its rectangle (in points, a twentieth of the rect).
        const words = pagesOf(c.compile.pdf)[0]!;
        const value = words.find((w) => w.text === 'Ada');
        if (!value)
          throw new Error(`the PDF does not print the value (${keep('exp-058-rects', c)})`);
        expect(Math.abs(value.x0 - x0 / 20)).toBeLessThanOrEqual(1.5);
        expect(value.x1).toBeLessThanOrEqual(x1 / 20 + 1);
        // pdftotext's box includes the font's descent below the baseline, which the field's box does not
        // (an empty depth for these glyphs), so the vertical test is on the box's top and the centre.
        expect(value.y0).toBeGreaterThanOrEqual(y0 / 20 - 2);
        const centre = (value.y0 + value.y1) / 2;
        expect(centre).toBeGreaterThanOrEqual(y0 / 20);
        expect(centre).toBeLessThanOrEqual(y1 / 20);
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!ready)(
  'EXP-058 criterion 4: a field in a table cell reports the page of its row',
  () => {
    it(
      'gives the page on which the PDF prints the cell, not the first page',
      async () => {
        const cellField = field('cell', 'Cell', 'Lovelace', 1440);
        const cellPara = para('Cell:', {}, [{ type: 'text', text: ' ' }, cellField]);
        const table: J = {
          type: 'table',
          attrs: { id: nid('t') },
          content: [
            {
              type: 'table_row',
              attrs: { id: nid('r') },
              content: [{ type: 'table_cell', attrs: { id: nid('c') }, content: [cellPara] }],
            },
          ],
        };
        const body = [longPara('t', 900), table];
        const c = await convertAndCompile(doc(body), options('exp-058-table') as never, {
          minPasses: 1,
        });
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-058-table', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const id = (cellField['attrs'] as J)['id'] as string;
        const reported = c.layout!.fields[id];
        expect(reported).toBeDefined();
        // The page on which pdftotext finds the cell's label.
        const pages = pagesOf(c.compile.pdf);
        const printedOn = pages.findIndex((p) => p.some((w) => w.text === 'Cell:')) + 1;
        expect(printedOn).toBeGreaterThan(1);
        expect(reported!.page).toBe(printedOn);
        expect(c.layout!.pages.length).toBeGreaterThanOrEqual(printedOn);
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);
