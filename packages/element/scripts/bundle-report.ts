/**
 * Sizes of the library build (FE-002; 13 §9), measured from the build output: every chunk raw,
 * gzip (level 9) and Brotli (quality 11), and the set the first interactive editor needs. That set
 * is the entry, the editor chunk it loads with the first document, and the chunks both import
 * statically. Budget: at most 300 KB compressed (13 §9, a target), counted as 300,000 bytes of
 * gzip; the build fails above it. FND-008 owns the gate in CI; this is the package's own check.
 */
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ChunkInfo {
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  moduleIds: readonly string[];
  code: string;
}

export interface Size {
  raw: number;
  gzip: number;
  brotli: number;
}

export const BUDGET_GZIP_BYTES = 300_000;

export function sizeOf(data: string | Buffer): Size {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

function add(a: Size, b: Size): Size {
  return { raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli };
}

const ZERO: Size = { raw: 0, gzip: 0, brotli: 0 };

function closure(start: readonly string[], byName: Map<string, ChunkInfo>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const i of byName.get(name)?.imports ?? []) stack.push(i);
  }
  return seen;
}

/** What a chunk holds, for the report: the packages and the element's own modules in it. */
function contents(chunk: ChunkInfo): string[] {
  const out = new Set<string>();
  for (const id of chunk.moduleIds) {
    const path = id.replaceAll('\\', '/');
    // The last node_modules segment names the package (pnpm nests them under .pnpm).
    const pkg = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
    if (pkg) out.add(pkg[1]!);
    else {
      const ws = /packages\/([^/]+)\/(.*)$/.exec(path);
      if (ws) out.add(ws[1] === 'element' ? `element/${ws[2]}` : `@docedit/${ws[1]}`);
    }
  }
  return [...out].sort();
}

export interface Report {
  measuredAt: string;
  how: string;
  budgetGzipBytes: number;
  /** With a `backend` the host passes: the entry and the editor, with their static imports. */
  firstInteractive: { files: string[]; size: Size };
  /** With `endpoint` and `getToken`: the same plus the DEP client (`@docedit/backend-dep`). */
  firstInteractiveWithDep: { files: string[]; size: Size } | null;
  chunks: Array<{ file: string; kind: string; size: Size; contents: string[] }>;
  viewer: Array<{ file: string; size: Size }>;
  withinBudget: boolean;
}

export function bundleReport(chunks: readonly ChunkInfo[], viewerDir: string | null): Report {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const entry = chunks.find((c) => c.isEntry);
  if (!entry) throw new Error('no entry chunk in the build');
  const editor = chunks.find((c) =>
    c.moduleIds.some((id) => id.replaceAll('\\', '/').endsWith('/packages/element/src/editor.ts')),
  );
  if (!editor) throw new Error('no chunk holds src/editor.ts');
  const first = closure([entry.fileName, editor.fileName], byName);
  const files = [...first].sort();
  const total = (set: Iterable<string>) =>
    [...set].reduce((s, f) => add(s, sizeOf(byName.get(f)!.code)), ZERO);
  const size = total(files);
  const dep = chunks.find((c) =>
    c.moduleIds.some((id) => id.replaceAll('\\', '/').includes('/packages/backend-dep/src/')),
  );
  const withDep = dep ? closure([...files, dep.fileName], byName) : null;
  const report: Report = {
    measuredAt: new Date().toISOString(),
    how: 'Node.js zlib on the files of `vite build` (library mode, minified): gzip level 9, Brotli quality 11.',
    budgetGzipBytes: BUDGET_GZIP_BYTES,
    firstInteractive: { files, size },
    firstInteractiveWithDep: withDep ? { files: [...withDep].sort(), size: total(withDep) } : null,
    chunks: chunks.map((c) => ({
      file: c.fileName,
      kind: c.isEntry
        ? 'entry'
        : first.has(c.fileName)
          ? 'first interactive'
          : c.isDynamicEntry
            ? 'lazy'
            : 'shared',
      size: sizeOf(c.code),
      contents: contents(c),
    })),
    viewer: [],
    withinBudget: Math.max(size.gzip, withDep ? total(withDep).gzip : 0) <= BUDGET_GZIP_BYTES,
  };
  if (viewerDir) {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    for (const file of walk(viewerDir)) {
      const rel = relative(viewerDir, file).replaceAll('\\', '/');
      if (rel.startsWith('pdfjs/') || rel.endsWith('.map')) continue;
      report.viewer.push({ file: `viewer/${rel}`, size: sizeOf(readFileSync(file)) });
    }
  }
  return report;
}

const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;

export function printReport(report: Report): void {
  const rows = [...report.chunks].sort((a, b) => b.size.gzip - a.size.gzip);
  console.log(
    'chunk                                         kind               raw        gzip     brotli',
  );
  for (const r of rows)
    console.log(
      `${r.file.padEnd(46)}${r.kind.padEnd(19)}${kb(r.size.raw).padStart(10)}${kb(r.size.gzip).padStart(11)}${kb(r.size.brotli).padStart(11)}`,
    );
  for (const v of report.viewer)
    console.log(
      `${v.file.padEnd(46)}${'viewer frame'.padEnd(19)}${kb(v.size.raw).padStart(10)}${kb(v.size.gzip).padStart(11)}${kb(v.size.brotli).padStart(11)}`,
    );
  const line = (label: string, set: { files: string[]; size: Size }) =>
    console.log(
      `${label} (${set.files.length} files): ${kb(set.size.raw)} raw, ${kb(set.size.gzip)} gzip, ${kb(set.size.brotli)} brotli`,
    );
  line('first interactive editor, host backend', report.firstInteractive);
  if (report.firstInteractiveWithDep)
    line('first interactive editor, DEP client', report.firstInteractiveWithDep);
  console.log(
    `budget ${kb(report.budgetGzipBytes)} gzip: ${report.withinBudget ? 'within' : 'EXCEEDED'}`,
  );
}

export function writeReport(report: Report, file: string): void {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}
