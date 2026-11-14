/**
 * EXP-056 criterion 1, Latin stand-in (lane U-EXP-049-064, round 9): a generated multi-page document
 * with no CJK text, compiled in the export worker's sandbox (Podman). For each page, the first block
 * and offset that `layout.json` gives the page are checked against the words that `pdftotext -f n -l n`
 * prints at the top of that page. This shows the start mechanism against a real PDF while the
 * `pages-20` corpus stays skipped (no CJK face in the sandbox image, EXP-026). It is not the corpus
 * check of criterion 1, and EXP-056 stays unticked on that criterion.
 *
 * The words are unique to each paragraph (`p<k>w<i>`), so a page's first words identify its start.
 * Criteria 2 to 4 are not checked here.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const COMPILE_TIMEOUT_MS = 300_000;
const PARAGRAPHS = 30;
const WORDS_PER_PARAGRAPH = 120;
const OPENS = new Set(['text', 'float', 'tableHead', 'footnoteContinuation']);

/** The text of paragraph `k`: `WORDS_PER_PARAGRAPH` words that appear nowhere else in the document. */
function paragraphText(k: number): string {
  return Array.from({ length: WORDS_PER_PARAGRAPH }, (_v, i) => `p${k}w${i}`).join(' ');
}

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

/** The text of a block as the layout offsets count it (plain text only here). */
function blockText(node: Record<string, unknown>): string {
  let out = '';
  for (const c of (node['content'] as Record<string, unknown>[] | undefined) ?? []) {
    if (c['type'] === 'text') out += String(c['text'] ?? '');
  }
  return out;
}

/** The words of a string, without the punctuation at either end. */
function words(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w !== '');
}

/** The words `pdftotext -raw` prints on page `page`, or null when it cannot be read. */
function pageWords(pdf: Uint8Array, page: number, dir: string): string[] | null {
  const file = join(dir, `page-${page}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync(
    'pdftotext',
    ['-enc', 'UTF-8', '-raw', '-f', String(page), '-l', String(page), file, '-'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (r.error || r.status !== 0) return null;
  return words(r.stdout);
}

describe.skipIf(!ready)(
  'EXP-056 criterion 1, Latin stand-in: page starts match the PDF text',
  () => {
    it(
      'checks every page of a generated multi-page document against its layout.json start',
      async () => {
        const body: J[] = [];
        for (let k = 0; k < PARAGRAPHS; k++) body.push(para(paragraphText(k)));
        const envelope = doc(body);
        const c = await convertAndCompile(
          envelope,
          {
            profile: 'final',
            title: 'exp-056-latin',
            instant: INSTANT,
            timeZone: 'Europe/London',
            suggestions: 'accept',
            layout: 'line',
          } as never,
          { minPasses: 2 },
        );
        if (!c.compile.ok || !c.compile.pdf)
          throw new Error(
            `the compile failed (${keep('exp-056-latin', c)}):\n${c.compile.log.slice(-1500)}`,
          );
        expect(c.layoutErrors).toEqual([]);
        const layout = c.layout!;
        expect(layout.pages.length).toBeGreaterThanOrEqual(4);

        const bodyNode = envelope.doc.content.find((n) => (n as J)['type'] === 'body') as J;
        const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-056-latin-'));
        const mismatches: string[] = [];
        let checked = 0;
        layout.pages.forEach((page, i) => {
          if (page.n !== i + 1)
            mismatches.push(`page ${page.n}: numbered out of order (expected ${i + 1})`);
          if (!page.opensWith || !OPENS.has(page.opensWith))
            mismatches.push(
              `page ${page.n}: opensWith ${JSON.stringify(page.opensWith)} is not one of the four values`,
            );
        });
        for (const page of layout.pages) {
          const starts = page.starts;
          if (!starts) {
            mismatches.push(`page ${page.n}: no block start`);
            continue;
          }
          const block = findBlock(bodyNode, starts.blockId);
          if (!block) {
            mismatches.push(`page ${page.n}: block ${starts.blockId} is not in the document`);
            continue;
          }
          const expected = words(blockText(block).slice(starts.offset)).slice(0, 3);
          const top = pageWords(c.compile.pdf, page.n, dir);
          if (top === null) {
            mismatches.push(`page ${page.n}: pdftotext cannot read the page`);
            continue;
          }
          const found = expected.some((w) => top.slice(0, 6).includes(w));
          if (!found)
            mismatches.push(
              `page ${page.n}: expected ${JSON.stringify(expected)} at the top of the page, found ${JSON.stringify(top.slice(0, 6))}`,
            );
          checked++;
        }
        expect(mismatches).toEqual([]);
        expect(checked).toBe(layout.pages.length);
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);
