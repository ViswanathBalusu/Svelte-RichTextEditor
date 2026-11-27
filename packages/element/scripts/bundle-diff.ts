/**
 * FND-008 criterion 4: compares the bundle report of a pull request with the report of its base
 * branch and writes a Markdown summary, so that every pull request that changes the size of a
 * chunk shows the change. CI attaches the summary to the pull request.
 *
 * Usage: node scripts/bundle-diff.ts <base report | -> <head report> [summary.md]
 * `-` means the base has no report (an older base, or a build that failed).
 *
 * Chunk file names carry a content hash; the comparison names a chunk by its name without the
 * hash, and sums the chunks that share a name.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Size {
  raw: number;
  gzip: number;
  brotli: number;
}

/** The parts of a bundle report that the comparison reads. Older reports may lack some. */
export interface ReportLike {
  budgetGzipBytes?: number;
  firstInteractive?: { size: Size };
  firstInteractiveWithDep?: { size: Size } | null;
  chunks?: Array<{ file: string; kind: string; size: Size }>;
  lazy?: Array<{ file: string; size: Size }>;
  lazyByFeature?: Array<{ feature: string; files: number; size: Size }>;
}

export interface Row {
  name: string;
  /** Null when the base has no such chunk. */
  base: number | null;
  /** Null when the head has no such chunk. */
  head: number | null;
  delta: number;
}

export interface Diff {
  /** Gzip bytes of the first interactive editor, host backend and with the DEP client. */
  totals: Row[];
  /** The chunks and lazy files whose gzip size differs, largest change first. */
  chunks: Row[];
  /** The features of `lazyByFeature` whose gzip size differs. */
  features: Row[];
  /** True when any total, chunk or feature changed. */
  changed: boolean;
  budgetGzipBytes: number | null;
}

/** `chunks/engine-BL-BrZ41.js` becomes `chunks/engine.js`: the hash is the last dash group. */
export function stableName(file: string): string {
  return file.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z]+$)/, '');
}

function sums(
  entries: ReadonlyArray<{ file: string; size: Size }> | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries ?? []) {
    const name = stableName(e.file);
    out.set(name, (out.get(name) ?? 0) + e.size.gzip);
  }
  return out;
}

function rowsOf(base: ReadonlyMap<string, number>, head: ReadonlyMap<string, number>): Row[] {
  const names = new Set([...base.keys(), ...head.keys()]);
  return [...names]
    .map((name): Row => {
      const b = base.get(name) ?? null;
      const h = head.get(name) ?? null;
      return { name, base: b, head: h, delta: (h ?? 0) - (b ?? 0) };
    })
    .filter((r) => r.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
}

/** The base is null when the base branch has no report; then every row is new. */
export function diffReports(base: ReportLike | null, head: ReportLike): Diff {
  const baseReport = base ?? {};
  const total = (r: ReportLike, key: 'firstInteractive' | 'firstInteractiveWithDep') =>
    r[key]?.size.gzip ?? null;
  const totals: Row[] = (
    [
      ['first interactive editor, host backend', 'firstInteractive'],
      ['first interactive editor, DEP client', 'firstInteractiveWithDep'],
    ] as const
  ).map(([name, key]) => {
    const b = total(baseReport, key);
    const h = total(head, key);
    return { name, base: b, head: h, delta: (h ?? 0) - (b ?? 0) };
  });
  const files = (r: ReportLike) => [...(r.chunks ?? []), ...(r.lazy ?? [])];
  const chunks = rowsOf(sums(files(baseReport)), sums(files(head)));
  const featureMap = (r: ReportLike) =>
    new Map((r.lazyByFeature ?? []).map((f) => [f.feature, f.size.gzip]));
  const features = rowsOf(featureMap(baseReport), featureMap(head));
  return {
    totals,
    chunks,
    features,
    changed: totals.some((t) => t.delta !== 0) || chunks.length > 0 || features.length > 0,
    budgetGzipBytes: head.budgetGzipBytes ?? null,
  };
}

function kb(bytes: number | null): string {
  return bytes === null ? 'none' : `${(bytes / 1000).toFixed(1)} kB`;
}

function signed(bytes: number): string {
  const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '';
  return `${sign}${(Math.abs(bytes) / 1000).toFixed(1)} kB`;
}

function table(title: string, rows: readonly Row[]): string[] {
  if (rows.length === 0) return [];
  return [
    `### ${title}`,
    '',
    '| Name | Base (gzip) | This change (gzip) | Change |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${kb(r.base)} | ${kb(r.head)} | ${signed(r.delta)} |`),
    '',
  ];
}

/** The Markdown that CI attaches. It is the same text for a step summary and a comment. */
export function renderMarkdown(diff: Diff, baseMissing = false): string {
  const lines = ['## Bundle size (FND-008)', ''];
  if (baseMissing)
    lines.push('The base branch has no bundle report, so every size below is new.', '');
  lines.push(
    diff.changed ? 'This change alters the size of at least one chunk.' : 'No chunk changes size.',
    '',
    ...table(
      'First interactive editor',
      diff.totals.filter((t) => t.head !== null || t.base !== null),
    ),
  );
  const budget = diff.budgetGzipBytes;
  if (budget !== null)
    lines.push(`Budget: ${kb(budget)} gzip for the first interactive editor (13 §9).`, '');
  lines.push(...table('Chunks and lazy files', diff.chunks.slice(0, 40)));
  if (diff.chunks.length > 40)
    lines.push(`${diff.chunks.length - 40} smaller changes are not listed.`, '');
  lines.push(...table('Lazy features', diff.features));
  lines.push(
    'Sizes are gzip level 9, counted in bytes of 1000 per kB, as `scripts/build.ts` measures them. A chunk is named without its content hash.',
    '',
  );
  return lines.join('\n');
}

function readReport(path: string): ReportLike {
  return JSON.parse(readFileSync(path, 'utf8')) as ReportLike;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [basePath, headPath, outPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error(
      'usage: node scripts/bundle-diff.ts <base report | -> <head report> [summary.md]',
    );
    process.exit(2);
  }
  const base = basePath === '-' ? null : readReport(basePath);
  const markdown = renderMarkdown(diffReports(base, readReport(headPath)), base === null);
  if (outPath) writeFileSync(outPath, markdown);
  else console.log(markdown);
}
