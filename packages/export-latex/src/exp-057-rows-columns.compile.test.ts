/**
 * EXP-057 in a real compile (Podman sandbox through `test/harness.ts`):
 *
 * - Criterion 2: a table that splits across pages reports the page each row starts on (`rowPages`),
 *   which is checked against the page of the PDF that prints the row text; a section in two
 *   columns reports the line that starts the second column (`columnBreaks`), which is checked
 *   against the word boxes of the PDF.
 * - Criterion 5: the compile time at line level against block level, on one document, alternately,
 *   several times. The numbers are printed and written to `cost.json` in the temporary directory
 *   (the story's Evidence names the run).
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

function options(title: string, layout: 'line' | 'block'): Record<string, unknown> {
  return {
    profile: 'preview',
    title,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout,
  };
}

const cell = (text: string): J => ({
  type: 'table_cell',
  attrs: { id: nid('c') },
  content: [para(text)],
});
const row = (...cells: J[]): J => ({ type: 'table_row', attrs: { id: nid('r') }, content: cells });

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

function failed(name: string, c: Awaited<ReturnType<typeof convertAndCompile>>): never {
  throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
}

describe.skipIf(!ready)('EXP-057 criterion 2: table rows per page', () => {
  it('reports the page each row of a table that splits across pages starts on, as the PDF prints it', async () => {
    const ROWS = 90;
    const rows = [row(cell('Head one'), cell('Head two'))];
    for (let i = 0; i < ROWS; i++)
      rows.push(row(cell(`rowtoken${String(i).padStart(3, '0')} alpha`), cell('beta gamma')));
    const tid = nid('t');
    const table: J = {
      type: 'table',
      attrs: { id: tid, width: { type: 'auto' }, grid: [4000, 4000], headerRows: 1 },
      content: rows,
    };
    const c = await convertAndCompile(
      doc([para('Before the table.'), table, para('After the table.')]),
      options('exp-057-rows', 'line') as never,
      { minPasses: 2 },
    );
    if (!c.compile.ok || !c.compile.pdf) failed('exp-057-rows', c);
    expect(c.layoutErrors).toEqual([]);
    const rowPages = c.layout!.blocks[tid]?.rowPages;
    expect(rowPages, 'the table reports rowPages').toBeDefined();
    // One entry per row of the table (the repeated head is not listed again).
    expect(rowPages!.length).toBe(ROWS + 1);
    const text = pdfText(c.compile.pdf);
    if (text === null) throw new Error('pdftotext is not available');
    const pdfPages = text.split('\f');
    const pageOf = (token: string): number => {
      const i = pdfPages.findIndex((p) => p.includes(token));
      if (i < 0) throw new Error(`${token} is not in the PDF`);
      return i + 1;
    };
    expect(rowPages![0]).toBe(pageOf('Head one'));
    const misses: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const expected = pageOf(`rowtoken${String(i).padStart(3, '0')}`);
      if (rowPages![i + 1] !== expected)
        misses.push(`row ${i + 1}: reported page ${rowPages![i + 1]}, PDF page ${expected}`);
    }
    expect(misses).toEqual([]);
    // The table does split, and the pages never go down.
    expect(new Set(rowPages).size).toBeGreaterThan(1);
    for (let i = 1; i < rowPages!.length; i++)
      expect(rowPages![i]!).toBeGreaterThanOrEqual(rowPages![i - 1]!);
  }, 300_000);
});

/** The `pdftotext` that writes word boxes (`-bbox`), or null. */
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

interface Word {
  xMin: number;
  yMin: number;
  text: string;
}

function words(pdf: Uint8Array, name: string): Word[] {
  const dir = join(tmpdir(), 'docedit-exp-057-columns');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync(TOOL!, ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox failed');
  const out: Word[] = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g;
  for (const m of r.stdout.matchAll(re))
    out.push({ xMin: Number(m[1]), yMin: Number(m[2]), text: m[3] ?? '' });
  return out;
}

describe.skipIf(!ready || TOOL === null)('EXP-057 criterion 2: column breaks', () => {
  it('reports the line that starts the second column, at the top of the right-hand column', async () => {
    const WORDS = 420;
    const text = Array.from({ length: WORDS }, (_, i) => `w${String(i).padStart(3, '0')}x`).join(
      ' ',
    );
    const p = para(text);
    const pid = (p['attrs'] as J)['id'] as string;
    const c = await convertAndCompile(
      doc([p], { pageSetups: [TWO_COLUMNS] }),
      options('exp-057-columns', 'line') as never,
      { minPasses: 2 },
    );
    if (!c.compile.ok || !c.compile.pdf) failed('exp-057-columns', c);
    expect(c.layoutErrors).toEqual([]);
    const block = c.layout!.blocks[pid];
    const breaks = block?.columnBreaks;
    expect(breaks, 'the paragraph reports a column break').toBeDefined();
    expect(breaks!.length).toBe(1);
    const starts = block!.lineStarts!;
    const pages = block!.linePages!;
    const k = breaks![0]!;
    expect(pages[k]).toBe(pages[k - 1]);
    // The word at the start of line k is the first word of the right-hand column, level with the
    // top of the left-hand column; the word at the start of line k-1 is in the left-hand column.
    const wordAt = (offset: number): string => text.slice(offset).split(' ')[0]!;
    const ws = words(c.compile.pdf, 'columns');
    const find = (t: string): Word => {
      const w = ws.find((x) => x.text === t);
      if (!w) throw new Error(`no word ${t} on page 1`);
      return w;
    };
    const middle = 297.6;
    const firstRight = find(wordAt(starts[k]!));
    const lastLeft = find(wordAt(starts[k - 1]!));
    const top = find(wordAt(starts[0]!));
    expect(firstRight.xMin).toBeGreaterThan(middle);
    expect(lastLeft.xMin).toBeLessThan(middle);
    expect(Math.abs(firstRight.yMin - top.yMin)).toBeLessThan(1);
  }, 300_000);
});

describe.skipIf(!ready)('EXP-057 criterion 5: the cost of line-level reporting', () => {
  it('measures the compile at line level against block level on one document', async () => {
    const paragraphs: J[] = [];
    for (let i = 0; i < 40; i++)
      paragraphs.push(
        para(
          Array.from({ length: 160 }, (_, j) => `word${String(i * 160 + j).padStart(5, '0')}`).join(
            ' ',
          ),
        ),
      );
    const envelope = doc(paragraphs);
    const RUNS = 3;
    const wall: Record<'line' | 'block', number[]> = { line: [], block: [] };
    const cpu: Record<'line' | 'block', number[]> = { line: [], block: [] };
    let lines = 0;
    let pageCount = 0;
    for (let run = 0; run < RUNS; run++)
      for (const level of ['block', 'line'] as const) {
        const t0 = performance.now();
        const c = await convertAndCompile(
          envelope,
          options(`exp-057-cost-${level}`, level) as never,
          { minPasses: 2 },
        );
        wall[level].push(performance.now() - t0);
        if (!c.compile.ok || !c.compile.pdf) failed(`exp-057-cost-${level}`, c);
        expect(c.layout!.granularity).toBe(level);
        const m = /layout report CPU (\d+) ms[^\n]*?(\d+) pages, (\d+) lines/.exec(c.compile.log);
        if (m) {
          cpu[level].push(Number(m[1]));
          pageCount = Number(m[2]);
          lines = Number(m[3]);
        }
      }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const result = {
      document: '40 paragraphs of 160 words',
      pages: pageCount,
      linesReported: lines,
      runsPerLevel: RUNS,
      wallMsBlock: wall.block.map(Math.round),
      wallMsLine: wall.line.map(Math.round),
      medianWallMsBlock: Math.round(median(wall.block)),
      medianWallMsLine: Math.round(median(wall.line)),
      layoutCpuMsBlock: cpu.block,
      layoutCpuMsLine: cpu.line,
    };
    const dir = join(tmpdir(), 'docedit-exp-057-cost');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cost.json'), JSON.stringify(result, null, 2));
    console.log(`EXP-057 cost: ${JSON.stringify(result)}`);
    expect(result.medianWallMsLine).toBeGreaterThan(0);
    expect(result.layoutCpuMsLine.length).toBe(RUNS);
  }, 900_000);
});
