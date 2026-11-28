/**
 * EXP-057 criterion 4 (Node.js only, sandbox): on the shared corpus document `pages-20`, compiled at
 * line level in the export worker's sandbox (Podman), every line start that `layout.json` reports
 * is checked against the PDF. For each reported line start, the first characters of the block text
 * from that offset must be what a line of the page that `linePages` names begins with in the text
 * that `pdftotext -raw -f n -l n` returns.
 *
 * What the check leaves out, and says so in its result: a line that starts with an atom (an
 * equation, an image or a field; its glyphs are not text), a block whose text the document does not
 * hold (a generated list), and a line whose first characters are only punctuation. Those are
 * counted as `skipped`, not as matches. A line label (a list marker or a heading number) that the
 * class prints before the words is allowed in front of the expected characters.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDocument } from '@docedit/corpus';
import type { CdmEnvelope } from '@docedit/model';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const ATOM = '￼';

/** Every block of the envelope with an id, by id. */
function blocksById(
  nodes: unknown,
  out: Map<string, Record<string, unknown>>,
  inTable: Set<string>,
  inside = false,
): void {
  if (Array.isArray(nodes)) {
    for (const n of nodes) blocksById(n, out, inTable, inside);
    return;
  }
  if (nodes && typeof nodes === 'object') {
    const o = nodes as Record<string, unknown>;
    const attrs = o['attrs'] as Record<string, unknown> | undefined;
    if (typeof attrs?.['id'] === 'string') {
      out.set(attrs['id'], o);
      if (inside) inTable.add(attrs['id']);
    }
    blocksById(o['content'], out, inTable, inside || o['type'] === 'table');
  }
}

/** The text of a block as the layout offsets count it: text runs as typed, each atom (a footnote mark too) as one unit. */
function blockText(node: Record<string, unknown>): string {
  let out = '';
  const walk = (n: unknown): void => {
    if (!Array.isArray(n)) return;
    for (const c of n as Record<string, unknown>[]) {
      if (c['type'] === 'text') out += String(c['text'] ?? '');
      else if (c['type'] === 'bookmark' || c['type'] === 'anchor') continue;
      else if (c['type'] !== 'footnote' && Array.isArray(c['content'])) walk(c['content']);
      else out += ATOM;
    }
  };
  walk(node['content']);
  return out;
}

/** A string for comparison: compatibility-normalised (ligatures), without any white space. */
const squash = (s: string): string => s.normalize('NFKC').replace(/[\s­]+/gu, '');

/** The text of one PDF page by `pdftotext -raw`, or null when the page cannot be read. */
function pageText(pdf: Uint8Array, page: number, dir: string): string | null {
  const file = join(dir, `${createHash('sha256').update(pdf).digest('hex').slice(0, 16)}.pdf`);
  writeFileSync(file, pdf);
  // One retry: poppler on Windows now and then fails on the first call after the file is written.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = spawnSync(
      'pdftotext',
      ['-enc', 'UTF-8', '-raw', '-f', String(page), '-l', String(page), file, '-'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (!r.error && r.status === 0) return r.stdout;
  }
  return null;
}

/** How many characters of a line start are compared. */
const SNIPPET = 6;
/** The longest label (list marker, heading number) that may stand before the expected characters. */
const LABEL = 12;

interface LineCheck {
  matched: number;
  skipped: number;
  mismatches: string[];
}

/**
 * The line starts that are not at the start of a line of the page in the PDF. Each message names the
 * document, the page, the block and the line.
 */
function lineMismatches(
  documentName: string,
  blocks: Record<string, { page: number; lineStarts?: number[]; linePages?: number[] }>,
  byId: Map<string, Record<string, unknown>>,
  inTable: ReadonlySet<string>,
  textOf: (page: number) => string | null,
): LineCheck {
  const result: LineCheck = { matched: 0, skipped: 0, mismatches: [] };
  const pageLines = new Map<number, string[]>();
  const linesOf = (page: number): string[] | null => {
    const known = pageLines.get(page);
    if (known) return known;
    const t = textOf(page);
    if (t === null) return null;
    const lines = t
      .split('\n')
      .map(squash)
      .filter((l) => l !== '');
    pageLines.set(page, lines);
    return lines;
  };
  for (const [id, b] of Object.entries(blocks)) {
    const node = byId.get(id);
    if (!b.lineStarts || !b.linePages) continue;
    if (!node || node['type'] === 'toc') {
      result.skipped += b.lineStarts.length;
      continue;
    }
    const text = blockText(node);
    for (let k = 0; k < b.lineStarts.length; k++) {
      const offset = b.lineStarts[k]!;
      const page = b.linePages[k] ?? b.page;
      const where = `${documentName} page ${page}, block ${id}, line ${k} (offset ${offset})`;
      const rest = text.slice(offset);
      if (rest.startsWith(ATOM)) {
        result.skipped++;
        continue;
      }
      // The characters from the offset up to the next atom, without white space.
      const expected = squash(rest.split(ATOM)[0] ?? '').slice(0, SNIPPET);
      if (expected.length < 2 || !/[\p{L}\p{N}]/u.test(expected)) {
        result.skipped++;
        continue;
      }
      const lines = linesOf(page);
      if (lines === null) {
        result.mismatches.push(`${where}: pdftotext cannot read the page`);
        continue;
      }
      // A table cell is printed inside a row, so its line starts anywhere in a line of the page text;
      // any other block starts a line of the PDF (after a label of at most LABEL characters).
      const hit = inTable.has(id)
        ? lines.some((l) => l.includes(expected))
        : lines.some((l) => {
            const at = l.indexOf(expected);
            return at >= 0 && at <= LABEL;
          });
      if (hit) result.matched++;
      else
        result.mismatches.push(
          `${where}: expected a line that begins with ${JSON.stringify(expected)} on that page`,
        );
    }
  }
  return result;
}

describe.skipIf(!ready)(
  'EXP-057 criterion 4: the line starts of layout.json equal the lines of the PDF on the corpus',
  () => {
    it('checks every reported line start of pages-20 against the page it names', async () => {
      const corpus = await loadDocument('pages-20');
      const assets: Record<string, { sha256: string; mediaType: string; bytes: Uint8Array }> = {};
      for (const a of corpus.assets)
        assets[a.entry.id] = {
          sha256: a.entry.sha256,
          mediaType: a.entry.mediaType,
          bytes: a.bytes,
        };
      const envelope: CdmEnvelope = corpus.envelope;
      const c = await convertAndCompile(
        envelope,
        {
          profile: 'final',
          title: 'exp-057-pages-20',
          assets,
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
          layout: 'line',
        } as never,
        { minPasses: 2 },
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-057-pages-20', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);
      const layout = c.layout!;
      expect(layout.granularity).toBe('line');

      const byId = new Map<string, Record<string, unknown>>();
      const inTable = new Set<string>();
      blocksById(envelope.doc, byId, inTable);
      const dir = join(tmpdir(), 'docedit-exp-057');
      mkdirSync(dir, { recursive: true });
      const pdf = c.compile.pdf;
      const result = lineMismatches('pages-20', layout.blocks, byId, inTable, (n) =>
        pageText(pdf, n, dir),
      );
      if (process.env['DOCEDIT_TEST_VERBOSE'])
        console.log(
          `exp-057 pages-20: matched ${result.matched}, skipped ${result.skipped}, mismatches ${result.mismatches.length}\n${result.mismatches.slice(0, 40).join('\n')}`,
        );
      expect(result.mismatches).toEqual([]);
      // The check is not vacuous: most of the document's lines are compared.
      expect(result.matched).toBeGreaterThan(result.skipped);

      // A wrong line page fails and names the document, the page and the block.
      const entry = Object.entries(layout.blocks).find(
        ([id, b]) => (b.lineStarts?.length ?? 0) > 2 && byId.get(id)?.['type'] === 'paragraph',
      )!;
      const bent = {
        ...layout.blocks,
        [entry[0]]: {
          ...entry[1],
          linePages: entry[1].linePages!.map((p) => (p === 1 ? 2 : 1)),
        },
      };
      const bad = lineMismatches('pages-20', bent, byId, inTable, (n) => pageText(pdf, n, dir));
      expect(bad.mismatches.length).toBeGreaterThan(0);
      expect(bad.mismatches[0]).toMatch(/^pages-20 page \d+, block /u);
    }, 900_000);
  },
);
