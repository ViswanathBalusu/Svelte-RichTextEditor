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
  /** Rendered length of each module in the chunk (after tree-shaking, before minification). */
  moduleSizes?: Readonly<Record<string, number>>;
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

/** The package a module belongs to: a dependency's name, `@docedit/<name>`, or null. */
export function packageOf(moduleId: string): string | null {
  const path = moduleId.replaceAll('\\', '/');
  const pkg = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
  if (pkg) return pkg[1]!;
  const ws = /packages\/([^/]+)\//.exec(path);
  return ws ? `@docedit/${ws[1]}` : null;
}

/** One package's part of a set of chunks (CDM-008: `@docedit/model` is listed on its own). */
export interface PackageShare {
  package: string;
  /** Bytes of the package's modules as the bundler rendered them, before minification. */
  rendered: number;
  /** `rendered` over the rendered bytes of every module in the set, 0 to 1. */
  share: number;
  /** An estimate: each chunk's gzip size split by the packages' rendered bytes in that chunk. */
  gzipEstimate: number;
}

/** Splits the chunks of a set between the packages whose modules they hold, largest first. */
export function packageShares(chunks: readonly ChunkInfo[]): PackageShare[] {
  const rendered = new Map<string, number>();
  const gzip = new Map<string, number>();
  let all = 0;
  for (const chunk of chunks) {
    const inChunk = new Map<string, number>();
    let chunkTotal = 0;
    for (const [id, length] of Object.entries(chunk.moduleSizes ?? {})) {
      const name = packageOf(id) ?? '(other)';
      inChunk.set(name, (inChunk.get(name) ?? 0) + length);
      chunkTotal += length;
    }
    if (chunkTotal === 0) continue;
    const chunkGzip = sizeOf(chunk.code).gzip;
    all += chunkTotal;
    for (const [name, length] of inChunk) {
      rendered.set(name, (rendered.get(name) ?? 0) + length);
      gzip.set(name, (gzip.get(name) ?? 0) + (chunkGzip * length) / chunkTotal);
    }
  }
  return [...rendered]
    .map(([name, length]) => ({
      package: name,
      rendered: length,
      share: length / all,
      gzipEstimate: Math.round(gzip.get(name)!),
    }))
    .sort((a, b) => b.rendered - a.rendered || a.package.localeCompare(b.package));
}

export interface Report {
  measuredAt: string;
  how: string;
  budgetGzipBytes: number;
  /** With a `backend` the host passes: the entry and the editor, with their static imports. */
  firstInteractive: { files: string[]; size: Size };
  /**
   * The first interactive editor (host backend) split by package, so that the part of each
   * workspace package, `@docedit/model` among them, is listed separately (CDM-008).
   */
  firstInteractiveByPackage: PackageShare[];
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
    how:
      'Node.js zlib on the files of `vite build` (library mode, minified): gzip level 9, Brotli quality 11. ' +
      "Per package: the bundler's rendered module lengths (before minification); the gzip figure is an " +
      "estimate, each chunk's gzip size split by those lengths.",
    budgetGzipBytes: BUDGET_GZIP_BYTES,
    firstInteractive: { files, size },
    firstInteractiveByPackage: packageShares(files.map((f) => byName.get(f)!)),
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
  console.log('first interactive editor by package (rendered before minification; gzip estimated)');
  for (const p of report.firstInteractiveByPackage)
    console.log(
      `${p.package.padEnd(46)}${kb(p.rendered).padStart(10)}${`~${kb(p.gzipEstimate)}`.padStart(11)}${`${(p.share * 100).toFixed(1)} %`.padStart(11)}`,
    );
  console.log(
    `budget ${kb(report.budgetGzipBytes)} gzip: ${report.withinBudget ? 'within' : 'EXCEEDED'}`,
  );
}

export function writeReport(report: Report, file: string): void {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}
