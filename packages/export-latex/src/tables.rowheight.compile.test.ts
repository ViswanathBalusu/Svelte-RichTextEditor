/**
 * EXP-038 criterion 5, checked on the compiled PDF (Node.js only, sandbox): a row with `heightRule`
 * `exact` or `atLeast` is as tall as its height, measured from the word positions of
 * `pdftotext -bbox`.
 *
 * The rows of one table hold one word each, at the same place in every row, so the distance between
 * two words is the height of the row between them:
 * - `exact`: each row is 720 or 1440 twips (36 or 72 pt); the distance between the words of two rows
 *   is that row's height (to within half a point).
 * - `atLeast`: a row of 1440 twips (72 pt) is at least that tall, so the distance between the words
 *   of two such rows is at least 72 pt less half a point.
 *
 * Content taller than an `exact` row is not clipped; that is not checked here (see the story's Notes).
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** The yMin of a word on the first page, from `pdftotext -bbox`, or null when it is not there. */
function yOf(bbox: string, word: string): number | null {
  const m = new RegExp(`<word xMin="[^"]*" yMin="([^"]*)"[^>]*>${word}</word>`).exec(bbox);
  return m === null ? null : Number(m[1]);
}

function row(word: string, height?: number, heightRule?: string): J {
  return {
    type: 'table_row',
    attrs: { id: nid('r'), ...(height === undefined ? {} : { height, heightRule }) },
    content: [{ type: 'table_cell', attrs: { id: nid('c') }, content: [para(word)] }],
  };
}

describe.skipIf(!ready)(
  'EXP-038 criterion 5: exact and atLeast row heights are honoured in the PDF',
  () => {
    it('makes an exact row as tall as its height, and an atLeast row at least as tall', async () => {
      const exact: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [4320] },
        content: [
          row('EXACTONE', 720, 'exact'),
          row('EXACTTWO', 720, 'exact'),
          row('EXACTTHREE', 1440, 'exact'),
          row('EXACTFOUR', 720, 'exact'),
        ],
      };
      const atLeast: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [4320] },
        content: [
          row('ATLEASTONE', 1440, 'atLeast'),
          row('ATLEASTTWO', 1440, 'atLeast'),
          row('PLAINROW'),
        ],
      };
      const c = await convertAndCompile(doc([exact, atLeast]), {
        profile: 'preview',
        title: 'row-heights',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      const dir = mkdtempSync(join(tmpdir(), 'docedit-bbox-'));
      const file = join(dir, 'main.pdf');
      writeFileSync(file, c.compile.pdf);
      const r = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', timeout: 60_000 });
      if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
      const bbox = r.stdout;
      const y = (w: string): number => {
        const v = yOf(bbox, w);
        if (v === null) throw new Error(`the PDF does not show ${w}`);
        return v;
      };
      const d = {
        exactOne: y('EXACTTWO') - y('EXACTONE'),
        exactTwo: y('EXACTTHREE') - y('EXACTTWO'),
        exactThree: y('EXACTFOUR') - y('EXACTTHREE'),
        atLeast: y('ATLEASTTWO') - y('ATLEASTONE'),
      };
      // A row of the table's own separators adds the same measured overhead to every row (about 3.6 pt
      // here, font dependent), so the checks compare rows with each other and do not pin that overhead.
      const eps = 0.5;
      const info = JSON.stringify(d);
      expect(Math.abs(d.exactOne - d.exactTwo), info).toBeLessThan(eps);
      expect(Math.abs(d.exactThree - d.exactOne - 36), info).toBeLessThan(eps);
      expect(d.exactOne, info).toBeGreaterThanOrEqual(36 - eps);
      expect(d.atLeast, info).toBeGreaterThanOrEqual(72 - eps);
    }, 300_000);
  },
);
