/**
 * Sizes of the library build (FE-002; 13 §9), measured from the build output: every chunk raw,
 * gzip (level 9) and Brotli (quality 11), and the set the first interactive editor needs. That set
 * is the entry, the editor chunk it loads with the first document, and the chunks both import
 * statically. Budget: at most 320 KB compressed (13 §9, a target; owner decision 32, 2026-11-17), counted as 320,000 bytes of
 * gzip; the build fails above it. FND-008 owns the gate in CI; this is the package's own check.
 *
 * FND-008 also asks for every lazy file by feature (`lazy`, `lazyByFeature`) and for a build that
 * fails when a WebAssembly module is in the first interactive set or is inlined as base64 in any
 * chunk (`wasmViolations`; ADR 0016).
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

/** A file the bundler emitted that is not a chunk: a WebAssembly module, a worker, a font. */
export interface AssetInfo {
  fileName: string;
  source: string | Uint8Array;
}

/**
 * The lazy features FND-008 names, in the order of the story, and the rest. A feature with no file
 * is still in `lazyByFeature`, with zero files, so that the report says the build has none.
 */
export const LAZY_FEATURES = [
  'pdf viewer',
  'pdf worker',
  'math editor',
  'panes',
  'proofing',
  'assistant',
  'webassembly',
  'dep client',
  'other',
] as const;
export type LazyFeature = (typeof LAZY_FEATURES)[number];

export interface LazyFile {
  file: string;
  feature: LazyFeature;
  size: Size;
}

export const BUDGET_GZIP_BYTES = 320_000;

/**
 * Budgets for single lazy modules (WASM-012 criterion 1; ADR 0016), counted as gzip level 9 bytes
 * of the file. The build fails when a file that `match` names is larger. Proposed, not decided by
 * the owner: the figure is S10's measurement of the whole Rust prototype (shaping, line breaking
 * and hyphenation), 419,844 bytes of gzip at `opt-level = 3` without wasm-opt
 * (docs/spikes/2026-11-06-s10-text-kernel.md, section 3.3), rounded up to 420,000. The kernel in
 * the repository is far smaller now (WASM-001 is the toolchain only); the budget is what the
 * finished kernel may grow to, so that it never costs more than the prototype the owner chose on.
 */
export const MODULE_BUDGETS: ReadonlyArray<{
  name: string;
  match: RegExp;
  gzipBytes: number;
  source: string;
}> = [
  {
    name: 'layout kernel',
    match: /(^|\/)docedit_layout_kernel_bg[^/]*\.wasm$/,
    gzipBytes: 420_000,
    source: 'S10 report section 3.3: the Rust prototype was 419,844 bytes of gzip',
  },
];

/** The lazy files over their module budget, as sentences for the build's output. Empty when none. */
export function moduleBudgetViolations(lazy: readonly LazyFile[]): string[] {
  const out: string[] = [];
  for (const file of lazy)
    for (const budget of MODULE_BUDGETS)
      if (budget.match.test(file.file) && file.size.gzip > budget.gzipBytes)
        out.push(
          `${file.file} is ${file.size.gzip} bytes of gzip, over the ${budget.name} budget of ${budget.gzipBytes} (${budget.source})`,
        );
  return out;
}

const isWasm = (name: string) => /\.wasm(\?.*)?$/.test(name);

/** The feature a lazy file belongs to, from its name and the modules in it. */
export function lazyFeatureOf(fileName: string, moduleIds: readonly string[] = []): LazyFeature {
  const ids = moduleIds.map((id) => id.replaceAll('\\', '/'));
  const any = (test: RegExp) => ids.some((id) => test.test(id));
  if (isWasm(fileName) || any(/\/layout-kernel\/dist\/|\/element\/src\/features\/layout-kernel/))
    return 'webassembly';
  if (/pdf\.worker/.test(fileName)) return 'pdf worker';
  if (fileName.startsWith('viewer/') || any(/\/element\/src\/pdf\//)) return 'pdf viewer';
  if (any(/node_modules\/(katex|mathlive)\//) || any(/\/element\/src\/katex-/))
    return 'math editor';
  if (any(/\/proofing\//) || any(/node_modules\/(nspell|hunspell[^/]*)\//)) return 'proofing';
  if (any(/\/assistant\//)) return 'assistant';
  if (/(^|\/)[A-Z][A-Za-z]*Pane-/.test(fileName) || any(/\/ui\/src\/.*Pane\.svelte/))
    return 'panes';
  if (any(/\/packages\/(backend-dep|protocol)\/src\//)) return 'dep client';
  return 'other';
}

/**
 * A WebAssembly module as base64 starts with the bytes `\0asm` and the version, which encode to
 * this text. It is looked for at the start of a string literal or of a data URI's payload only:
 * the same letters can occur by chance inside other base64 data (a font, for one).
 */
const INLINED_WASM = /data:application\/wasm|(?:["'`]|base64,)AGFzbQEAAAA/;

/**
 * Why the build must fail for WebAssembly (FND-008 criterion 3; ADR 0016): a module in the first
 * interactive set, or one inlined as base64 in any chunk. Empty when there is none.
 */
export function wasmViolations(
  chunks: readonly ChunkInfo[],
  firstInteractive: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (firstInteractive.has(chunk.fileName)) {
      for (const id of chunk.moduleIds)
        if (isWasm(id))
          out.push(
            `${chunk.fileName} is needed for the first interactive editor and holds the WebAssembly module ${id.replaceAll('\\', '/')}`,
          );
    }
    if (INLINED_WASM.test(chunk.code))
      out.push(`${chunk.fileName} holds a WebAssembly module inlined as base64`);
  }
  return out;
}

/**
 * The shape of the library build that FE-002 criterion 1 asks for (02 §2; ADR 0039 §2 and §3; owner
 * decision 18 for the stylesheet), read from the build output. `violations` is empty when the build
 * has it; the build fails otherwise.
 */
export interface Structure {
  /** The entry files. One ES module, `doc-editor.js`. */
  entries: string[];
  /** Each pane of the shell that is in the build, with the lazy chunk that holds it and no other pane. */
  panes: Array<{ pane: string; file: string }>;
  /** The PDF viewer: the chunk of its controller and the files of its frame's page, without the worker. */
  pdfViewer: string[];
  /** The PDF viewer's worker, a file of its own that only the viewer's frame loads. */
  pdfWorker: string[];
  /** The math editor: the chunks that hold MathLive and the module that mounts its field. */
  mathEditor: string[];
  /** Stylesheet files the library build emitted for the component. None (ADR 0039 §3). */
  stylesheetFiles: string[];
  /** The chunks that carry the component's CSS as a string; all are in the first interactive set. */
  cssChunks: string[];
  violations: string[];
}

const PANE_MODULE = /\/packages\/ui\/src\/panes\/([A-Za-z0-9]+)\.svelte(\?.*)?$/;
const COMPONENT_CSS = /\/packages\/(element|ui)\/src\/styles\/[^/]+\.css\?inline$/;
const MATHLIVE = /\/node_modules\/mathlive\//;
const MATH_FIELD = /\/packages\/element\/src\/math-field\.ts$/;
const VIEWER_CONTROLLER = /\/packages\/element\/src\/pdf\/viewer-frame\.ts$/;
const PDFJS = /\/node_modules\/pdfjs-dist\//;
const PROTOCOL_DEFINITION = /\/packages\/protocol\/src\/definition\//;

/**
 * Reads the shape of the build. `first` is the first interactive set of a host backend (the entry,
 * the editor chunk and their static imports); `viewerFiles` are the files of the viewer frame's
 * page, as `viewer/<path>`.
 */
export function structureOf(
  chunks: readonly ChunkInfo[],
  first: ReadonlySet<string>,
  viewerFiles: readonly string[],
  assets: readonly AssetInfo[] = [],
): Structure {
  const violations: string[] = [];
  const idsOf = (chunk: ChunkInfo) => chunk.moduleIds.map((id) => id.replaceAll('\\', '/'));
  const holding = (test: RegExp) => chunks.filter((c) => idsOf(c).some((id) => test.test(id)));
  const names = (list: readonly ChunkInfo[]) => list.map((c) => c.fileName).sort();
  /** A part that must load on demand: none of its chunks may be needed for the first editor. */
  const lazyOnly = (part: string, list: readonly ChunkInfo[]) => {
    for (const c of list)
      if (first.has(c.fileName))
        violations.push(`${part}: ${c.fileName} is needed for the first interactive editor`);
  };

  const entries = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
  if (entries.length !== 1 || entries[0] !== 'doc-editor.js')
    violations.push(
      `the build must have one entry, doc-editor.js; it has ${entries.length === 0 ? 'none' : entries.join(', ')}`,
    );

  const panes: Structure['panes'] = [];
  for (const c of chunks) {
    const inChunk = idsOf(c).flatMap((id) => PANE_MODULE.exec(id)?.[1] ?? []);
    if (inChunk.length === 0) continue;
    if (inChunk.length > 1)
      violations.push(`panes: ${c.fileName} holds more than one pane (${inChunk.join(', ')})`);
    if (first.has(c.fileName))
      violations.push(
        `panes: ${c.fileName} holds ${inChunk.join(', ')} and is needed for the first interactive editor`,
      );
    else if (!c.isDynamicEntry)
      violations.push(
        `panes: ${c.fileName} holds ${inChunk.join(', ')} and is not loaded on demand`,
      );
    for (const pane of inChunk) panes.push({ pane, file: c.fileName });
  }
  panes.sort((a, b) => a.pane.localeCompare(b.pane));
  if (panes.length === 0) violations.push('panes: the build has no pane chunk');

  const mathEditor = [...new Set([...holding(MATHLIVE), ...holding(MATH_FIELD)])];
  lazyOnly('math editor', mathEditor);
  if (holding(MATHLIVE).length === 0)
    violations.push('math editor: the build has no chunk with MathLive');

  const controller = holding(VIEWER_CONTROLLER);
  lazyOnly('pdf viewer', [...controller, ...holding(PDFJS)]);
  if (controller.length === 0)
    violations.push('pdf viewer: the build has no chunk with the viewer frame’s controller');
  const pdfWorker = viewerFiles.filter((f) => /pdf\.worker/.test(f)).sort();
  const page = viewerFiles.filter((f) => !/pdf\.worker/.test(f)).sort();
  if (!page.some((f) => f.endsWith('.html')) || !page.some((f) => /\.m?js$/.test(f)))
    violations.push('pdf viewer: the page of the viewer frame and its script are missing');
  if (pdfWorker.length === 0)
    violations.push('pdf worker: the viewer has no worker file of its own');

  // The component's CSS is a string in the editor's chunks, adopted into one constructable sheet
  // (ADR 0039 §3; owner decision 18). The viewer frame's page has its own stylesheet file; that is
  // the frame document's, not the component's, and is listed with the viewer.
  const stylesheetFiles = assets
    .map((a) => a.fileName)
    .filter((f) => /\.css$/.test(f))
    .sort();
  for (const f of stylesheetFiles)
    violations.push(
      `stylesheet: the library build emitted ${f}; the component CSS ships as a string`,
    );
  const css = holding(COMPONENT_CSS);
  if (css.length === 0)
    violations.push('stylesheet: no chunk carries the component CSS as a string');
  for (const c of css)
    if (!first.has(c.fileName))
      violations.push(
        `stylesheet: ${c.fileName} carries the component CSS and does not load with the editor`,
      );

  // The protocol definition as data is read by the DEP client only. A host that passes its own
  // backend must not pay for it (13 §9); the element repeats the few names it needs.
  for (const c of holding(PROTOCOL_DEFINITION))
    if (first.has(c.fileName))
      violations.push(
        `first interactive editor: ${c.fileName} holds the protocol definition, which only the DEP client reads`,
      );

  return {
    entries,
    panes,
    pdfViewer: [...names(controller), ...page],
    pdfWorker,
    mathEditor: names(mathEditor),
    stylesheetFiles,
    cssChunks: names(css),
    violations,
  };
}

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
  /**
   * Every file the first interactive editor does not need (FND-008 criterion 2): the lazy and
   * shared chunks, the assets, and the viewer frame's files with pdf.js's WebAssembly modules.
   */
  lazy: LazyFile[];
  /** `lazy` summed by feature; every feature of `LAZY_FEATURES` is present. */
  lazyByFeature: Array<{ feature: LazyFeature; files: number; size: Size }>;
  /** Empty, or why the build fails for WebAssembly (FND-008 criterion 3). */
  wasmViolations: string[];
  /** Empty, or the lazy modules over their own budget (WASM-012 criterion 1). */
  moduleBudgetViolations: string[];
  /** The shape of the build (FE-002 criterion 1); its `violations` fail the build. */
  structure: Structure;
  withinBudget: boolean;
}

export function bundleReport(
  chunks: readonly ChunkInfo[],
  viewerDir: string | null,
  assets: readonly AssetInfo[] = [],
): Report {
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
    lazy: [],
    lazyByFeature: [],
    wasmViolations: wasmViolations(chunks, withDep ?? first),
    moduleBudgetViolations: [],
    structure: structureOf(chunks, first, [], assets),
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
      if (rel.endsWith('.map')) continue;
      const entryOf = { file: `viewer/${rel}`, size: sizeOf(readFileSync(file)) };
      // pdf.js's character maps and standard fonts are data, fetched one at a time, and are not
      // listed; its WebAssembly modules are (ADR 0016).
      if (rel.startsWith('pdfjs/')) {
        if (isWasm(rel)) report.lazy.push({ ...entryOf, feature: 'webassembly' });
        continue;
      }
      report.viewer.push(entryOf);
      report.lazy.push({ ...entryOf, feature: lazyFeatureOf(entryOf.file) });
    }
    report.structure = structureOf(
      chunks,
      first,
      report.viewer.map((v) => v.file),
      assets,
    );
  }
  for (const c of chunks)
    if (!first.has(c.fileName))
      report.lazy.push({
        file: c.fileName,
        feature: lazyFeatureOf(c.fileName, c.moduleIds),
        size: sizeOf(c.code),
      });
  for (const a of assets)
    if (!a.fileName.endsWith('.map'))
      report.lazy.push({
        file: a.fileName,
        feature: lazyFeatureOf(a.fileName),
        size: sizeOf(typeof a.source === 'string' ? a.source : Buffer.from(a.source)),
      });
  report.lazy.sort(
    (a, b) =>
      LAZY_FEATURES.indexOf(a.feature) - LAZY_FEATURES.indexOf(b.feature) ||
      a.file.localeCompare(b.file),
  );
  report.lazyByFeature = LAZY_FEATURES.map((feature) => {
    const files = report.lazy.filter((f) => f.feature === feature);
    return { feature, files: files.length, size: files.reduce((s, f) => add(s, f.size), ZERO) };
  });
  report.moduleBudgetViolations = moduleBudgetViolations(report.lazy);
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
  console.log('lazy files by feature (FND-008)');
  for (const f of report.lazyByFeature)
    console.log(
      `${f.feature.padEnd(46)}${`${f.files} files`.padEnd(19)}${kb(f.size.raw).padStart(10)}${kb(f.size.gzip).padStart(11)}${kb(f.size.brotli).padStart(11)}`,
    );
  const s = report.structure;
  console.log(
    `shape (FE-002): ${s.entries.length} entry, ${s.panes.length} pane chunks, ` +
      `${s.mathEditor.length} math editor chunks, ${s.pdfViewer.length} viewer files, ` +
      `${s.pdfWorker.length} worker files, ${s.stylesheetFiles.length} stylesheet files, ` +
      `CSS as a string in ${s.cssChunks.join(', ') || 'no chunk'}`,
  );
  for (const v of s.violations) console.log(`Shape: ${v}`);
  for (const v of report.wasmViolations) console.log(`WebAssembly: ${v}`);
  for (const v of report.moduleBudgetViolations) console.log(`Module budget: ${v}`);
  console.log(
    `budget ${kb(report.budgetGzipBytes)} gzip: ${report.withinBudget ? 'within' : 'EXCEEDED'}`,
  );
}

export function writeReport(report: Report, file: string): void {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}
