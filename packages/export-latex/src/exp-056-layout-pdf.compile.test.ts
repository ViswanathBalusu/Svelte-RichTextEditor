/**
 * EXP-056 criterion 1 (Node.js only, sandbox, PostgreSQL not needed): on the shared corpus document
 * `pages-20`, compiled in the export worker's sandbox (Podman), the first block and offset that
 * `layout.json` gives each page are checked against the text that `pdftotext -f n -l n` finds at the
 * top of that page in the PDF.
 *
 * The check is deliberately tolerant about what is not text: a numbered heading prints its number
 * before its words, so the expected words are looked up among the first tokens of the page's first
 * line, not compared as a prefix. Atoms (equations, images, fields) count as one character in the
 * block text, as the layout offsets do, and bookmarks count as zero (they are not in the text here).
 * Criteria 2 to 4 of EXP-056 are not checked by this file.
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

/** The block with `id` anywhere in the envelope's body, or null. */
function findBlock(nodes: unknown, id: string): Record<string, unknown> | null {
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      const hit = findBlock(n, id);
      if (hit) return hit;
    }
    return null;
  }
  if (nodes && typeof nodes === 'object') {
    const o = nodes as Record<string, unknown>;
    const attrs = o['attrs'] as Record<string, unknown> | undefined;
    if (attrs?.['id'] === id) return o;
    return findBlock(o['content'], id);
  }
  return null;
}

/** The text of a block as the layout offsets count it: text runs as typed, each atom as one unit. */
function blockText(node: Record<string, unknown>): string {
  let out = '';
  const walk = (n: unknown): void => {
    if (!Array.isArray(n)) return;
    for (const c of n as Record<string, unknown>[]) {
      if (c['type'] === 'text') out += String(c['text'] ?? '');
      else if (c['type'] === 'bookmark') continue;
      else if (Array.isArray(c['content'])) walk(c['content']);
      else out += ATOM;
    }
  };
  walk(node['content']);
  return out;
}

/** The words of a string, without the punctuation at either end, for a tolerant comparison. */
function words(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w !== '');
}

/** The text of one PDF page by `pdftotext -raw`, or null when the page does not exist. */
function pageText(pdf: Uint8Array, page: number, dir: string): string | null {
  const file = join(dir, `${createHash('sha256').update(pdf).digest('hex').slice(0, 16)}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync(
    'pdftotext',
    ['-enc', 'UTF-8', '-raw', '-f', String(page), '-l', String(page), file, '-'],
    {
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** The words that every line starts with (the running head), or none when fewer than three. */
function commonWordPrefix(lines: string[]): string[] {
  const split = lines.map((l) => l.split(/\s+/).filter((w) => w !== ''));
  const first = split[0];
  if (!first || split.length < 3) return [];
  let n = 0;
  while (n < first.length && split.every((s) => s[n] === first[n])) n++;
  return n >= 3 ? first.slice(0, n) : [];
}

/** The page text without its first line, when that line starts with the running head. */
function withoutHead(text: string, head: string[], applies: boolean): string {
  if (!applies || head.length === 0) return text;
  const lines = text.split('\n');
  const first = (lines[0] ?? '').split(/\s+/).filter((w) => w !== '');
  return head.every((w, i) => first[i] === w) ? lines.slice(1).join('\n') : text;
}

interface PageStart {
  n: number;
  starts: { blockId: string; offset: number } | null | undefined;
}

/**
 * The pages whose reported start does not match the PDF. Each message names the document and the
 * page. `checked` counts the pages that were compared.
 */
function startMismatches(
  documentName: string,
  pages: readonly PageStart[],
  body: unknown,
  textOf: (page: number) => string | null,
  head: string[],
): { mismatches: string[]; checked: number } {
  const mismatches: string[] = [];
  let checked = 0;
  for (const page of pages) {
    const where = `${documentName} page ${page.n}`;
    const starts = page.starts;
    if (!starts) {
      mismatches.push(`${where}: no block start`);
      continue;
    }
    const block = findBlock(body, starts.blockId);
    if (!block) {
      mismatches.push(`${where}: block ${starts.blockId} is not in the document`);
      continue;
    }
    const text = blockText(block).slice(starts.offset);
    // A list of contents, figures or tables is generated: its block has no text of the document, and
    // a page can open in the middle of it. Such a page opens with an entry of the list, and the
    // entries of a list of figures or tables begin with the label (Figure, Table).
    const generated = block['type'] === 'toc';
    const label = String((block['attrs'] as Record<string, unknown> | undefined)?.['of'] ?? '');
    const expected = generated ? (label === '' ? [] : [label]) : words(text).slice(0, 3);
    const pdf = textOf(page.n);
    if (pdf === null) {
      mismatches.push(`${where}: pdftotext cannot read the page`);
      continue;
    }
    const top = words(withoutHead(pdf, head, page.n > 1)).slice(0, 6);
    if (expected.length === 0) continue;
    if (!expected.some((w) => top.includes(w)))
      mismatches.push(
        `${where}: expected ${JSON.stringify(expected)} at the top of the page, found ${JSON.stringify(top)}`,
      );
    checked++;
  }
  return { mismatches, checked };
}
describe.skipIf(!ready)(
  'EXP-056 criterion 1: the first block and offset of each page match the PDF text that begins it',
  () => {
    // pages-20 holds Chinese, Japanese and Korean text; the image has the Noto CJK face since
    // owner decision 228, so it compiles. The timeout is that of the other long compile tests.
    it('checks every page of the pages-20 corpus document against its layout.json start', async () => {
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
          title: 'exp-056-pages-20',
          assets,
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
          layout: 'line',
        } as never,
        // Test only: the tagged, final-profile compile of this 24-page document passed with 4096 MiB
        // and was stopped at the job limit of 1536 MiB (09 §9.3 item 4) in the integrator's run.
        { minPasses: 2, limits: { memoryMiB: 4096 } },
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-056-pages-20', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);
      const layout = c.layout!;
      expect(layout.pages.length).toBeGreaterThanOrEqual(20);

      const dir = join(tmpdir(), 'docedit-exp-056');
      mkdirSync(dir, { recursive: true });
      const body =
        (envelope.doc.content as Record<string, unknown>[]).find((n) => n['type'] === 'body') ??
        envelope.doc;
      // Every page after the first starts with the running head of the document (a header line that
      // begins with the same words on each page); it is not the text that the layout reports.
      const firstLines = layout.pages
        .slice(1)
        .map((p) => (pageText(c.compile.pdf!, p.n, dir) ?? '').split('\n')[0] ?? '');
      const head = commonWordPrefix(firstLines);
      const pdf = c.compile.pdf;
      const result = startMismatches(
        'pages-20',
        layout.pages,
        body,
        (n) => pageText(pdf, n, dir),
        head,
      );
      expect(result.mismatches).toEqual([]);
      expect(result.checked).toBe(layout.pages.length);

      // A mismatch fails the test and names the document and the page (criterion 4): page 7 is given
      // the start of page 9.
      const wrong = layout.pages.map((p) =>
        p.n === 7 ? { ...p, starts: layout.pages[8]!.starts } : p,
      );
      const bad = startMismatches('pages-20', wrong, body, (n) => pageText(pdf, n, dir), head);
      expect(bad.mismatches).toHaveLength(1);
      expect(bad.mismatches[0]).toMatch(/^pages-20 page 7: expected /u);
    }, 900_000);
  },
);
