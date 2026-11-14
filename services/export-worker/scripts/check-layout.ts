/**
 * Checks layout.json against the PDF's own text (spike S4; groundwork for EXP-056). For every
 * reported page start and line start, the block's text from the reported offset must begin a line
 * of that page in the PDF, as extracted by pdftotext (xpdf, shipped with TeX Live for Windows).
 *
 *   node services/export-worker/scripts/check-layout.ts <try output directory> <file.cdm.json>
 *
 * Prints counts of matches and mismatches by block kind, and the first mismatches.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceMap } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import type { LayoutJson } from '../src/layout.ts';

const [dir, cdmFile] = process.argv.slice(2);
if (!dir || !cdmFile) {
  console.error('usage: check-layout.ts <try output directory> <file.cdm.json>');
  process.exit(2);
}

/** The block's text as layout offsets count it: UTF-16, inline atoms as one unit, anchors as none. */
function blockTexts(env: CdmEnvelope): Map<string, string> {
  const out = new Map<string, string>();
  const inline = (nodes: unknown[] | undefined): string => {
    let s = '';
    for (const raw of nodes ?? []) {
      const n = raw as { type: string; text?: string };
      if (n.type === 'text') s += n.text ?? '';
      else if (n.type !== 'anchor') s += OBJ;
    }
    return s;
  };
  const walk = (nodes: unknown[] | undefined): void => {
    for (const raw of nodes ?? []) {
      const n = raw as { type: string; attrs?: { id?: string }; content?: unknown[] };
      if (n.type === 'paragraph' && n.attrs?.id) out.set(n.attrs.id, inline(n.content));
      if (n.type === 'footnote' && n.attrs?.id) out.set(n.attrs.id, inline(n.content));
      if (n.content) walk(n.content);
    }
  };
  walk(env.doc.content);
  return out;
}

const NBSP = String.fromCharCode(0xa0);
/** The object replacement character stands for an inline atom in the block text. */
const OBJ = String.fromCharCode(0xfffc);
const norm = (s: string): string => s.split(NBSP).join(' ').replace(/\s+/g, ' ').trim();

// -raw keeps the content stream's order and does not join a line that ends in a hyphen with the
// next one, which pdftotext's default mode does (it would turn "---" + "stay" into "--stay").
function pageLines(pdf: string, page: number): string[] {
  const r = spawnSync(
    'pdftotext',
    ['-raw', '-enc', 'UTF-8', '-f', String(page), '-l', String(page), pdf, '-'],
    { encoding: 'utf8' },
  );
  return r.stdout
    .split(/\r?\n/)
    .map(norm)
    .filter((l) => l.length > 0);
}

const env = JSON.parse(readFileSync(cdmFile, 'utf8')) as CdmEnvelope;
const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as LayoutJson;
const map = JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8')) as SourceMap;
const kinds = new Map<string, string>();
map.blocks.forEach((id, i) => {
  if (id) kinds.set(id, map.kinds[i] ?? '?');
});
const texts = blockTexts(env);
const pdf = join(dir, 'main.pdf');
const cache = new Map<number, string[]>();
const lines = (p: number): string[] => {
  if (!cache.has(p)) cache.set(p, pageLines(pdf, p));
  return cache.get(p)!;
};

/** Where the line after `offset` starts, from the block's own line starts. */
function lineEnd(id: string, offset: number): number {
  const starts = layout.blocks[id]?.lineStarts ?? [];
  return starts.filter((s) => s > offset).sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
}

/** The probe: the next characters of the block's text from `offset`, up to an atom or the line's end. */
function probe(id: string, text: string, offset: number, length = 14): string | null {
  const rest = text.slice(offset, lineEnd(id, offset));
  const cut = rest.indexOf(OBJ);
  const s = norm(cut >= 0 ? rest.slice(0, cut) : rest).slice(0, length);
  return s.length >= 4 ? s : null;
}

const stats = new Map<string, { match: number; miss: number; skipped: number }>();
const bump = (kind: string, key: 'match' | 'miss' | 'skipped'): void => {
  const s = stats.get(kind) ?? { match: 0, miss: 0, skipped: 0 };
  s[key]++;
  stats.set(kind, s);
};
const misses: string[] = [];

function check(kind: string, id: string, offset: number, page: number, what: string): void {
  const text = texts.get(id);
  const p = text === undefined ? null : probe(id, text, offset);
  if (!p) return bump(kind, 'skipped');
  // A list item's first line starts with its label (at most a few characters), which is not part
  // of the block's text. Cells of one row share a text line in pdftotext's output, so a cell
  // line may start after other cells' text on the same baseline.
  const ok = lines(page).some((l) => {
    const at = l.indexOf(p);
    if (at < 0) return false;
    if (at === 0) return true;
    if (kind.includes('listItem')) return at <= 6;
    if (kind.includes('cellParagraph')) return l[at - 1] === ' ';
    return false;
  });
  bump(kind, ok ? 'match' : 'miss');
  if (!ok && misses.length < 15) misses.push(`${what} p${page} ${kind} ${id}@${offset}: "${p}"`);
}

for (const pg of layout.pages) {
  if (pg.starts)
    check(
      `page start (${kinds.get(pg.starts.blockId) ?? '?'})`,
      pg.starts.blockId,
      pg.starts.offset,
      pg.n,
      'page',
    );
}
for (const [id, b] of Object.entries(layout.blocks)) {
  const kind = kinds.get(id) ?? '?';
  (b.lineStarts ?? []).forEach((off, i) => {
    if (off === 0) return;
    check(`line (${kind})`, id, off, b.linePages?.[i] ?? b.page, 'line');
  });
}

console.log(`pages: ${layout.pages.length}, granularity: ${layout.granularity}`);
for (const [kind, s] of [...stats.entries()].sort()) {
  const n = s.match + s.miss;
  console.log(
    `${kind.padEnd(28)} match ${String(s.match).padStart(5)}  miss ${String(s.miss).padStart(4)}  skipped ${String(s.skipped).padStart(4)}  ${n ? ((100 * s.match) / n).toFixed(1) : '-'}%`,
  );
}
if (misses.length) console.log('first mismatches:\n  ' + misses.join('\n  '));
