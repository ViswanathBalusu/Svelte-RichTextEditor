/**
 * Column breaks in the compiled PDF (Node.js only, sandbox): EXP-031 criterion 3. The bundle is
 * compiled in the export worker's sandbox (Podman) through `test/harness.ts`, with a two-column page
 * setup. Word positions come from `pdftotext -bbox`, in points from the top left of the page.
 *
 * - Criterion 3: the material after a column break starts at the top of the next column. The test
 *   reads the first word after the break ("Top") and checks that it is in the right-hand column
 *   and that its top edge is level with the top edge of the first line of the left column.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** A4 with two columns and a 708-twip gap, in twips (the same page as EXP-017's tests). */
const TWO_COLUMNS: J = {
  type: 'page_setup',
  attrs: {
    id: 'ps1',
    width: 11906,
    height: 16838,
    marginTop: 1440,
    marginBottom: 1440,
    marginLeft: 1440,
    marginRight: 1440,
    gutter: 0,
    headerDistance: 720,
    footerDistance: 720,
    columns: 2,
    columnGap: 708,
  },
};

interface Word {
  xMin: number;
  yMin: number;
  text: string;
}

/**
 * The `pdftotext` that writes word boxes (`-bbox`). The xpdf build that Git for Windows ships has no
 * `-bbox`, so the tool is named by DOCEDIT_PDFTOTEXT when the one on the path cannot do it. Null
 * when neither can, and the tests then skip.
 */
function bboxTool(): string | null {
  for (const candidate of [process.env['DOCEDIT_PDFTOTEXT'], 'pdftotext']) {
    if (!candidate) continue;
    const r = spawnSync(candidate, ['-v'], { encoding: 'utf8', timeout: 20_000 });
    if (r.error) continue;
    const probe = spawnSync(candidate, ['-bbox', '-h'], { encoding: 'utf8', timeout: 20_000 });
    if (probe.error) continue;
    if (/Poppler|poppler/.test(`${r.stdout}${r.stderr}`)) return candidate;
  }
  return null;
}

const TOOL = bboxTool();

/** The words of the first page with their top left corners, from `pdftotext -bbox`. */
function words(pdf: Uint8Array, name: string): Word[] {
  if (TOOL === null) throw new Error('no poppler pdftotext is available (set DOCEDIT_PDFTOTEXT)');
  const dir = join(tmpdir(), 'docedit-exp-031-column-break');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync(TOOL, ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
  const out: Word[] = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g;
  for (const m of r.stdout.matchAll(re))
    out.push({ xMin: Number(m[1]), yMin: Number(m[2]), text: m[3] ?? '' });
  return out;
}

/** The first word with the given text, or a failure naming the words that were found. */
function firstWord(ws: Word[], text: string): Word {
  const w = ws.find((x) => x.text === text);
  if (!w) throw new Error(`no word "${text}" on page 1: ${ws.map((x) => x.text).join(' ')}`);
  return w;
}

async function compiledWords(body: unknown[], name: string): Promise<Word[]> {
  const c = await convertAndCompile(doc(body, { pageSetups: [TWO_COLUMNS] }), {
    profile: 'preview',
    title: `exp-031-${name}`,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  } as never);
  if (!c.compile.ok || !c.compile.pdf) {
    keep(`exp-031-${name}`, c);
    throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
  }
  return words(c.compile.pdf, name);
}

/** The page's middle, in points: column 1 lies left of it and column 2 right of it. */
const MIDDLE = 297.6;

describe.skipIf(!ready || TOOL === null)(
  'EXP-031 criterion 3: a column break starts the next column at its top',
  () => {
    it('moves the text after a column break in the same paragraph to the top of column 2', async () => {
      const p = para('', {}, [
        { type: 'text', text: 'Line one' },
        { type: 'break', attrs: { id: nid('br'), kind: 'line' } },
        { type: 'text', text: 'Line two' },
        { type: 'break', attrs: { id: nid('bc'), kind: 'column' } },
        { type: 'text', text: 'Top right' },
      ]);
      const ws = await compiledWords([p], 'mid-paragraph');
      const first = firstWord(ws, 'Line');
      const top = firstWord(ws, 'Top');
      expect(first.xMin).toBeLessThan(MIDDLE);
      expect(top.xMin).toBeGreaterThan(MIDDLE);
      expect(Math.abs(top.yMin - first.yMin)).toBeLessThan(1);
    }, 240_000);
  },
);
