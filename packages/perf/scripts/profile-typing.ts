/**
 * Where a keystroke's time goes in the web view (FE-118; UX-072): scripted typing on a corpus
 * document in `<doc-editor>`, on the reference profile of ADR 0037, measured three times over:
 *
 * 1. latency, as the harness measures it (Event Timing API, per keystroke the longest entry of its
 *    interaction, nearest-rank quantiles over all keystrokes; e2e/harness.spec.ts);
 * 2. a CPU profile (DevTools `Profiler` domain), attributed through the build's source maps to the
 *    packages and functions that spend it, with the in-page backend's work kept apart;
 * 3. a timeline trace (DevTools tracing), cut per keystroke from its `keydown` to the end of the
 *    main thread's work for the frame that shows it, and split into script, style, layout, paint
 *    and garbage collection.
 *
 * Usage, from the repository root:
 *
 *   node packages/perf/scripts/profile-typing.ts [--doc pages-100] [--keys 60]
 *     [--backend deferred|hold] [--port 4796] [--sampling-us 100] [--no-build] [--label name]
 *
 * It builds the harness's editor page without minification into test-results/profile-build (the
 * harness's own dist/ is left alone), serves it on its own port, and writes
 * test-results/profiles/<run>-<doc>-<backend>.json (the attribution) and a .cpuprofile file that
 * DevTools opens. Measurement tool only: it serves on the loopback address.
 */
import { loadDocument, serializeDocument } from '@docedit/corpus';
import { chromium, devices, type Browser, type Page } from '@playwright/test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { SourceMap } from 'node:module';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { cpuLoad, machineInfo, resultsDir, runId } from '../e2e/helpers.ts';
import { REFERENCE_PROFILE } from '../src/reference.ts';
import { censoredQuantile, summarise } from '../src/stats.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DOC = arg('--doc') ?? 'pages-100';
const KEYS = Number(arg('--keys') ?? 60);
// `control`: a plain contenteditable with the same observers and no editor, for the browser's own
// keystroke-to-paint time in this mode.
const CONTROL = DOC === 'control';
const BACKEND = CONTROL ? 'hold' : (arg('--backend') ?? 'deferred');
const PORT = Number(arg('--port') ?? 4796);
const SAMPLING_US = Number(arg('--sampling-us') ?? 100);
const LABEL = arg('--label') ?? '';
const BUILD = !process.argv.includes('--no-build');
const ONLY_LATENCY = process.argv.includes('--latency-only');
// Experiments applied in the page only, to measure what a change elsewhere would gain:
// `cv` adopts a sheet with `content-visibility: auto` on the body's blocks; `nospell` turns the
// surface's spell checking off. `--control-busy <ms>` makes the control page's input handler
// busy for that long, to find the main-thread budget of the 16 ms median in this browser mode.
const EXPERIMENTS = (arg('--experiment') ?? '').split(',').filter(Boolean);
const CONTROL_BUSY_MS = Number(arg('--control-busy') ?? 0);
const KEY_GAP_MS = 80;
const QUIET_MS = 5_000;
const TEXT = 'the quick brown fox jumps over the lazy dog while the editor keeps up ';
const buildDir = join(resultsDir, 'profile-build');

// ---------------------------------------------------------------------------------------------
// Build and serve

async function buildPage(): Promise<void> {
  const started = performance.now();
  await build({
    configFile: false,
    root: pkg,
    base: '/',
    logLevel: 'warn',
    plugins: [
      svelte({
        configFile: false,
        compilerOptions: { fragments: 'tree', css: 'external' },
        emitCss: false,
      }),
    ],
    worker: { format: 'es' },
    build: {
      outDir: buildDir,
      emptyOutDir: true,
      target: 'es2022',
      modulePreload: false,
      assetsInlineLimit: 0,
      sourcemap: true,
      // Readable names in the profile; the source maps give the original files and lines.
      minify: false,
      rollupOptions: { input: { editor: join(pkg, 'pages/editor.html') } },
    },
  });
  console.log(`[profile] page built in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function within(root: string, path: string): string | null {
  const full = normalize(join(root, path));
  return full === root || full.startsWith(root + sep) ? full : null;
}

/** The control page: pages/editor.html's observers and a contenteditable of plain paragraphs. */
function controlPage(): string {
  const head = readFileSync(join(pkg, 'pages/editor.html'), 'utf8');
  const observers = /<script>[\s\S]*?<\/script>/.exec(head)?.[0] ?? '';
  const para =
    'Plain paragraph text of about the length of a corpus body paragraph, so that the line ' +
    'breaking and the paint of one paragraph cost what they cost in a document.';
  const body = Array.from({ length: 200 }, () => `<p>${para}</p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Control</title>${observers}
<style>body{margin:0}doc-editor{display:block;width:1100px}.de-editing-surface{width:624px;margin:0 auto;font:16px/1.4 serif}</style>
</head><body><doc-editor><div class="de-editing-surface" contenteditable="true"><div class="de-body">${body}</div></div></doc-editor>
<script>window.__perf.submitMs = []; window.__perf.readyAt = performance.now();
var busy = ${CONTROL_BUSY_MS};
if (busy > 0) document.querySelector('.de-editing-surface').addEventListener('input', function () {
  var until = performance.now() + busy; while (performance.now() < until) {}
});</script></body></html>`;
}

function serve(): Promise<Server> {
  const corpus = new Map<string, Promise<string>>();
  const send = (res: ServerResponse, status: number, body: string | Uint8Array, type: string) => {
    res.writeHead(status, { 'Content-Type': type, ...ISOLATION });
    res.end(body);
  };
  const file = async (res: ServerResponse, path: string | null) => {
    if (!path) return send(res, 403, 'forbidden', 'text/plain');
    try {
      send(res, 200, await readFile(path), TYPES[extname(path)] ?? 'application/octet-stream');
    } catch {
      send(res, 404, 'not found', 'text/plain');
    }
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (path === '/health') return send(res, 200, 'ok', 'text/plain');
    if (path === '/control.html') return send(res, 200, controlPage(), TYPES['.html']!);
    const doc = /^\/corpus\/([a-z0-9-]+)\.cdm\.json$/.exec(path);
    if (doc) {
      const name = doc[1]!;
      let text = corpus.get(name);
      if (!text) {
        text = loadDocument(name).then((d) => serializeDocument(d.envelope));
        corpus.set(name, text);
      }
      text.then(
        (t) => send(res, 200, t, TYPES['.json']!),
        (e: unknown) => send(res, 404, String(e), 'text/plain'),
      );
      return;
    }
    if (path.startsWith('/fonts/'))
      return void file(res, within(join(pkg, 'fonts'), path.slice('/fonts/'.length)));
    return void file(res, within(buildDir, path.slice(1)));
  });
  return new Promise((ok) => server.listen(PORT, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------------------------------------
// The page

interface PerfEntry {
  name: string;
  startTime: number;
  duration: number;
  interactionId?: number;
  processingStart?: number;
  processingEnd?: number;
}

interface PerfState {
  longTasks: PerfEntry[];
  events: PerfEntry[];
  frames: number[];
  submitMs: number[];
  readyAt?: number;
  error?: string;
}

const perfState = (page: Page): Promise<PerfState> =>
  page.evaluate(() => {
    const p = (globalThis as unknown as { __perf: PerfState }).__perf;
    return JSON.parse(JSON.stringify(p)) as PerfState;
  });

async function open(browser: Browser): Promise<Page> {
  // The harness's context: playwright.config.ts's `reference` project.
  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    viewport: REFERENCE_PROFILE.viewport,
    deviceScaleFactor: REFERENCE_PROFILE.deviceScaleFactor,
    baseURL: `http://127.0.0.1:${PORT}`,
  });
  const page = await context.newPage();
  await page.goto('/health');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: REFERENCE_PROFILE.cpuThrottlingRate });
  await page.goto(CONTROL ? '/control.html' : `/pages/editor.html?doc=${DOC}&backend=${BACKEND}`);
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as { __perf: PerfState }).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 600_000, polling: 100 },
  );
  const deadline = Date.now() + 300_000;
  for (;;) {
    const s = await perfState(page);
    if (s.error) throw new Error(s.error);
    const nowMs = await page.evaluate(() => performance.now());
    const lastEnd = Math.max(s.readyAt ?? 0, ...s.longTasks.map((t) => t.startTime + t.duration));
    if (nowMs - lastEnd >= QUIET_MS) break;
    if (Date.now() > deadline) throw new Error('the main thread never became quiet');
    await page.waitForTimeout(250);
  }
  await page.evaluate((experiments) => {
    const host = document.querySelector('doc-editor');
    const root = host?.shadowRoot;
    if (experiments.includes('cv') && root) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        '.de-body > * { content-visibility: auto; contain-intrinsic-size: auto 3em; }',
      );
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    if (experiments.includes('nospell'))
      for (const el of (root ?? document).querySelectorAll('[spellcheck]'))
        el.setAttribute('spellcheck', 'false');
  }, EXPERIMENTS);
  if (EXPERIMENTS.length) await page.waitForTimeout(2_000);
  // A body paragraph in the middle of the document, as the harness chooses it.
  const outside = page.locator('doc-editor .de-editing-surface .de-body > p');
  const paragraphs =
    (await outside.count()) > 0 ? outside : page.locator('doc-editor .de-editing-surface p');
  const count = await paragraphs.count();
  const target = paragraphs.nth(Math.floor(count / 2));
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(1_000);
  return page;
}

/** Types `n` keystrokes with the harness's pacing; each starts on an idle main thread. */
async function typeKeys(page: Page, n: number, offset: number): Promise<void> {
  const submits = (): Promise<number> =>
    page.evaluate(() => (globalThis as unknown as { __perf: PerfState }).__perf.submitMs.length);
  for (let i = 0; i < n; i++) {
    const ch = TEXT[(offset + i) % TEXT.length]!;
    const before = BACKEND === 'deferred' ? await submits() : 0;
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    if (BACKEND === 'deferred')
      await page
        .waitForFunction(
          (k) => (globalThis as unknown as { __perf: PerfState }).__perf.submitMs.length > k,
          before,
          { timeout: 10_000, polling: 10 },
        )
        .catch(() => undefined);
    await page.waitForTimeout(KEY_GAP_MS);
  }
  await page.waitForTimeout(1_000);
}

async function latency(page: Page): Promise<Record<string, unknown>> {
  const before = await perfState(page);
  await typeKeys(page, KEYS, 0);
  const after = await perfState(page);
  const entries = after.events
    .slice(before.events.length)
    .filter((e) => (e.interactionId ?? 0) > 0);
  const byInteraction = new Map<number, PerfEntry>();
  for (const e of entries) {
    const known = byInteraction.get(e.interactionId!);
    if (!known || e.duration > known.duration) byInteraction.set(e.interactionId!, e);
  }
  const reported = [...byInteraction.values()].map((e) => e.duration);
  const p50 = censoredQuantile(reported, KEYS, 0.5, 16);
  const p95 = censoredQuantile(reported, KEYS, 0.95, 16);
  const longest = [...byInteraction.values()];
  return {
    keystrokes: KEYS,
    reportedAtOrOver16: reported.length,
    p50: p50.below ? '< 16' : p50.value,
    p95: p95.below ? '< 16' : p95.value,
    durations: summarise(reported),
    // Of the reported entries: event to processing start, processing, processing end to paint.
    inputDelay: summarise(longest.map((e) => (e.processingStart ?? e.startTime) - e.startTime)),
    processing: summarise(
      longest.map((e) => (e.processingEnd ?? e.startTime) - (e.processingStart ?? e.startTime)),
    ),
    presentationDelay: summarise(
      longest.map((e) => e.startTime + e.duration - (e.processingEnd ?? e.startTime)),
    ),
    longestEntryTypes: countBy(longest.map((e) => e.name)),
    frames: summarise(after.frames.slice(before.frames.length)),
    backendSubmitMs: summarise(after.submitMs.slice(before.submitMs.length)),
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------------------------
// CPU profile attribution

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

interface Origin {
  pkg: string;
  file: string;
  line: number;
  fn: string;
}

const maps = new Map<string, SourceMap | null>();

function sourceMapFor(url: string): SourceMap | null {
  if (maps.has(url)) return maps.get(url)!;
  let map: SourceMap | null = null;
  try {
    const path = new URL(url).pathname.slice(1);
    const full = join(buildDir, `${path}.map`);
    if (existsSync(full)) map = new SourceMap(JSON.parse(readFileSync(full, 'utf8')));
  } catch {
    map = null;
  }
  maps.set(url, map);
  return map;
}

/** The package of an original source path, relative to the repository. */
function packageOf(path: string): { pkg: string; file: string } {
  const p = path.replaceAll('\\', '/');
  const nm = p.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const rest = p.slice(nm + 'node_modules/'.length).split('/');
    const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
    return { pkg: name, file: rest.slice(name.split('/').length).join('/') };
  }
  const m = /^(packages|services|apps)\/([^/]+)\/(.*)$/.exec(p);
  if (m) return { pkg: `@docedit/${m[2]!}`, file: m[3]! };
  return { pkg: '(other)', file: p };
}

const originCache = new Map<number, Origin>();

function originOf(node: ProfileNode): Origin {
  const cached = originCache.get(node.id);
  if (cached) return cached;
  const f = node.callFrame;
  let origin: Origin;
  if (!f.url) origin = { pkg: '(native)', file: '', line: 0, fn: f.functionName || '(anonymous)' };
  else {
    const map = sourceMapFor(f.url);
    const entry = map?.findEntry(f.lineNumber, f.columnNumber) as
      { originalSource?: string; originalLine?: number } | undefined;
    if (entry?.originalSource) {
      const abs = entry.originalSource.startsWith('file:')
        ? fileURLToPath(entry.originalSource)
        : resolve(dirname(join(buildDir, new URL(f.url).pathname.slice(1))), entry.originalSource);
      const { pkg: name, file } = packageOf(relative(repo, abs));
      origin = { pkg: name, file, line: (entry.originalLine ?? 0) + 1, fn: f.functionName };
    } else {
      origin = { pkg: '(unmapped)', file: f.url, line: f.lineNumber + 1, fn: f.functionName };
    }
  }
  if (!origin.fn) origin = { ...origin, fn: '(anonymous)' };
  originCache.set(node.id, origin);
  return origin;
}

const keyOf = (o: Origin): string => `${o.pkg} ${o.fn} ${o.file}:${o.line}`;

/** Named parts of a keystroke's work, by a function on the stack (the innermost match wins). */
const PARTS: ReadonlyArray<{ part: string; test: (o: Origin) => boolean }> = [
  { part: 'guard: diffScopes (authority)', test: (o) => o.fn === 'diffScopes' },
  { part: 'guard: other', test: (o) => o.file === 'src/guard.ts' },
  { part: 'paragraph after a region (regions.ts)', test: (o) => o.file === 'src/regions.ts' },
  { part: 'identifier plugin (ids.ts)', test: (o) => o.file === 'src/ids.ts' },
  { part: 'body guard (body.ts)', test: (o) => o.file === 'src/body.ts' },
  {
    part: 'footnote numbers (footnote-view.ts)',
    test: (o) => o.file === 'src/view/footnote-view.ts',
  },
  { part: 'presence (presence.ts)', test: (o) => o.file === 'src/presence.ts' },
  {
    part: 'steps and sync queue (steps.ts, sync/)',
    test: (o) => o.file === 'src/steps.ts' || o.file.startsWith('src/sync/'),
  },
  {
    part: 'read views: publish (core.ts #publish)',
    test: (o) =>
      o.pkg === '@docedit/engine' && /publish|accessSummary|summary|queryCommand|query$/.test(o.fn),
  },
  { part: 'outline and styles (styles.ts)', test: (o) => o.file === 'src/styles.ts' },
  { part: 'view hub notifications (read-value.ts)', test: (o) => o.file === 'src/read-value.ts' },
];

interface Attribution {
  busyMs: number;
  idleMs: number;
  backendMs: number;
  byPackageSelf: Array<[string, number]>;
  byRoot: Array<[string, number]>;
  parts: Array<[string, number]>;
  topSelf: Array<[string, number]>;
  topInclusive: Array<[string, number]>;
  docEditInclusive: Array<[string, number]>;
}

function attribute(profile: CpuProfile): Attribution {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const pkgSelf = new Map<string, number>();
  const roots = new Map<string, number>();
  const parts = new Map<string, number>();
  let busy = 0;
  let idle = 0;
  let backend = 0;
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (let i = 0; i < samples.length; i++) {
    // A sample's time runs to the next sample.
    const us = deltas[i + 1] ?? deltas[i] ?? 0;
    const ms = us / 1000;
    const leaf = byId.get(samples[i]!)!;
    const name = leaf.callFrame.functionName;
    if (name === '(idle)') {
      idle += ms;
      continue;
    }
    busy += ms;
    const stack: ProfileNode[] = [];
    for (let id: number | undefined = leaf.id; id !== undefined; id = parent.get(id)) {
      const n = byId.get(id)!;
      if (n.callFrame.functionName !== '(root)') stack.push(n);
    }
    const origins = stack.map(originOf);
    if (origins.some((o) => o.pkg === '@docedit/backend-mock')) {
      backend += ms;
      add(roots, 'in-page backend (backend-mock; not the client)', ms);
      continue;
    }
    const leafOrigin = origins[0]!;
    add(self, keyOf(leafOrigin), ms);
    add(pkgSelf, leafOrigin.pkg === '(native)' ? `(native) ${leafOrigin.fn}` : leafOrigin.pkg, ms);
    for (const k of new Set(origins.map(keyOf))) add(inclusive, k, ms);
    const outer = origins[origins.length - 1];
    add(roots, outer ? keyOf(outer) : '(none)', ms);
    const part = origins
      .map((o) => PARTS.find((p) => p.test(o))?.part)
      .find((p) => p !== undefined);
    if (part) add(parts, part, ms);
    else {
      const pkgs = new Set(origins.map((o) => o.pkg));
      const rest =
        pkgs.has('svelte') || pkgs.has('@docedit/ui')
          ? 'shell (svelte, @docedit/ui)'
          : pkgs.has('prosemirror-view')
            ? 'prosemirror-view (DOM observer, view update)'
            : pkgs.has('prosemirror-state') ||
                pkgs.has('prosemirror-transform') ||
                pkgs.has('prosemirror-model') ||
                pkgs.has('prosemirror-history')
              ? 'prosemirror state, transform, model, history'
              : pkgs.has('@docedit/engine')
                ? 'engine: other'
                : pkgs.has('@docedit/element')
                  ? 'element'
                  : `other: ${leafOrigin.pkg} ${leafOrigin.fn}`;
      add(parts, rest, ms);
    }
  }
  const sorted = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]): [string, number] => [k, Math.round(v * 100) / 100]);
  return {
    busyMs: Math.round(busy * 100) / 100,
    idleMs: Math.round(idle * 100) / 100,
    backendMs: Math.round(backend * 100) / 100,
    byPackageSelf: sorted(pkgSelf, 30),
    byRoot: sorted(roots, 25),
    parts: sorted(parts, 40),
    topSelf: sorted(self, 40),
    topInclusive: sorted(inclusive, 60),
    docEditInclusive: sorted(
      new Map(
        [...inclusive].filter(([k]) => k.startsWith('@docedit/') || k.startsWith('prosemirror-')),
      ),
      80,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Trace attribution

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { type?: string } & Record<string, unknown> };
}

const CATEGORY: ReadonlyArray<[RegExp, string]> = [
  [/^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|StyleInvalidator.*)$/, 'style'],
  [/^(Layout|UpdateLayerTree|IntersectionObserverController::computeIntersections)$/, 'layout'],
  [
    /^(PrePaint|Paint|PaintImage|Layerize|UpdateLayer|Commit|CompositeLayers|ScrollLayer)$/,
    'paint and commit',
  ],
  [/^(MinorGC|MajorGC|V8\.GC.*|BlinkGC.*|ThreadState::.*|CppGC.*)$/, 'garbage collection'],
  [
    /^(EventDispatch|FunctionCall|TimerFire|FireAnimationFrame|RunMicrotasks|V8\.Execute|v8\.callFunction|v8\.run|EvaluateScript|HandlePostMessage|FireIdleCallback|v8\.compile|V8\.Compile.*|v8\.parseOnBackground)$/,
    'script',
  ],
  [/^(HitTest|ScheduleStyleRecalculation|InvalidateLayout|UpdateCounters)$/, 'other rendering'],
];

const categoryOf = (name: string): string => CATEGORY.find(([re]) => re.test(name))?.[1] ?? 'other';

interface Slice {
  e: TraceEvent;
  start: number;
  end: number;
  self: number;
  depth: number;
}

function traceAttribution(raw: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(raw.toString('utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  const mains = new Set(
    events
      .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map((e) => `${e.pid}:${e.tid}`),
  );
  const dispatchCount = new Map<string, number>();
  for (const e of events)
    if (e.name === 'EventDispatch') {
      const k = `${e.pid}:${e.tid}`;
      if (mains.has(k)) dispatchCount.set(k, (dispatchCount.get(k) ?? 0) + 1);
    }
  const main = [...dispatchCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return { error: 'no renderer main thread with events' };
  const onMain = events.filter((e) => `${e.pid}:${e.tid}` === main);
  // Complete events, and B/E pairs folded into complete ones.
  const slices: Slice[] = [];
  const open = new Map<string, TraceEvent[]>();
  for (const e of onMain) {
    if (e.ph === 'X' && e.dur !== undefined)
      slices.push({ e, start: e.ts, end: e.ts + e.dur, self: e.dur, depth: 0 });
    else if (e.ph === 'B') {
      const list = open.get(e.name) ?? [];
      list.push(e);
      open.set(e.name, list);
    } else if (e.ph === 'E') {
      const b = open.get(e.name)?.pop();
      if (b) slices.push({ e: b, start: b.ts, end: e.ts, self: e.ts - b.ts, depth: 0 });
    }
  }
  slices.sort((a, b) => a.start - b.start || b.end - a.end);
  const stack: Slice[] = [];
  for (const s of slices) {
    while (stack.length && stack[stack.length - 1]!.end <= s.start) stack.pop();
    const top = stack[stack.length - 1];
    if (top && s.end <= top.end) {
      top.self -= s.end - s.start;
      s.depth = top.depth + 1;
    }
    stack.push(s);
  }
  const keydowns = slices.filter(
    (s) => s.e.name === 'EventDispatch' && s.e.args?.data?.type === 'keydown',
  );
  const perKey: Array<Record<string, number>> = [];
  const perKeyNames: Array<Record<string, number>> = [];
  for (let k = 0; k < keydowns.length; k++) {
    const t0 = keydowns[k]!.start;
    const next = keydowns[k + 1]?.start ?? Number.POSITIVE_INFINITY;
    const inWindow = slices.filter((s) => s.start >= t0 && s.start < next);
    // The text reaches the document in the keypress (or input) dispatch; the frame that shows it
    // ends with the first main-thread Commit after that.
    const typed = inWindow.filter(
      (s) =>
        s.e.name === 'EventDispatch' &&
        ['keypress', 'textInput', 'beforeinput', 'input'].includes(s.e.args?.data?.type ?? ''),
    );
    const lastInput = typed.length ? Math.max(...typed.map((s) => s.end)) : keydowns[k]!.end;
    const commit = inWindow.find((s) => s.e.name === 'Commit' && s.start >= lastInput);
    const end = commit ? commit.end : lastInput;
    const row: Record<string, number> = { toFrameEndMs: (end - t0) / 1000 };
    const names: Record<string, number> = {};
    let busy = 0;
    for (const s of inWindow) {
      if (s.start >= end) continue;
      const name =
        s.e.name === 'EventDispatch' ? `EventDispatch ${s.e.args?.data?.type ?? '?'}` : s.e.name;
      const cat = s.e.name === 'EventDispatch' ? 'script' : categoryOf(s.e.name);
      row[cat] = (row[cat] ?? 0) + s.self / 1000;
      names[name] = (names[name] ?? 0) + s.self / 1000;
      busy += s.self / 1000;
    }
    row['busyMs'] = busy;
    perKey.push(row);
    perKeyNames.push(names);
  }
  // Skip the first keystroke of the pass: its frame may include the tracing's own start.
  const stats = (list: ReadonlyArray<Record<string, number>>) => {
    const keys = new Set(list.flatMap((r) => Object.keys(r)));
    const out: Array<[string, { mean: number; median: number; p95: number }]> = [];
    for (const k of keys) {
      const s = summarise(list.map((r) => r[k] ?? 0));
      const r2 = (v: number) => Math.round(v * 100) / 100;
      out.push([k, { mean: r2(s.mean), median: r2(s.median), p95: r2(s.p95) }]);
    }
    return Object.fromEntries(out.sort((a, b) => b[1].mean - a[1].mean).slice(0, 30));
  };
  return {
    keystrokes: perKey.length - 1,
    method:
      'renderer main thread, per keystroke from the start of its keydown dispatch to the end of the first Commit after its keypress or input dispatch; self time of each trace slice (its duration less its children), summed per keystroke; mean, median and 95th percentile over keystrokes',
    byCategoryMs: stats(perKey.slice(1)),
    byNameMs: stats(perKeyNames.slice(1)),
  };
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (BUILD || !existsSync(join(buildDir, 'pages/editor.html'))) await buildPage();
  const server = await serve();
  // As the reference profile runs it: Playwright's Chromium in its new headless mode
  // (`channel: 'chromium'`), not the headless shell, whose frames are produced differently.
  const browser = await chromium.launch({
    headless: REFERENCE_PROFILE.headless,
    channel: 'chromium',
  });
  const id = runId();
  const out: Record<string, unknown> = {
    runId: id,
    label: LABEL,
    doc: DOC,
    backend: BACKEND,
    keystrokes: KEYS,
    experiments: EXPERIMENTS,
    controlBusyMs: CONTROL_BUSY_MS,
    samplingUs: SAMPLING_US,
    machine: machineInfo(),
    browser: { name: 'chromium', version: browser.version() },
    profile: REFERENCE_PROFILE,
  };
  try {
    const load = cpuLoad();
    const page = await open(browser);
    out['dom'] = await page.evaluate(() => {
      const host = document.querySelector('doc-editor');
      const root: ParentNode = host?.shadowRoot ?? host ?? document;
      const surface = root.querySelector('.de-editing-surface');
      return {
        elements: root.querySelectorAll('*').length,
        surfaceElements: surface?.querySelectorAll('*').length ?? null,
        surfaceParagraphs: surface?.querySelectorAll('p').length ?? null,
        bodyChildren: surface?.querySelector('.de-body')?.children.length ?? null,
      };
    });
    out['latency'] = await latency(page);
    out['latencyMachineBusy'] = load.stop();
    console.log(`[profile] ${DOC} latency:`, JSON.stringify(out['latency']));
    if (!ONLY_LATENCY) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLING_US });
      const profLoad = cpuLoad();
      await cdp.send('Profiler.start');
      await typeKeys(page, KEYS, KEYS);
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile };
      out['profileMachineBusy'] = profLoad.stop();
      out['cpu'] = attribute(profile);
      mkdirSync(join(resultsDir, 'profiles'), { recursive: true });
      writeFileSync(
        join(
          resultsDir,
          'profiles',
          `${id}-${DOC}-${BACKEND}${LABEL ? `-${LABEL}` : ''}.cpuprofile`,
        ),
        JSON.stringify(profile),
      );

      const traceLoad = cpuLoad();
      await browser.startTracing(page, {
        categories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'disabled-by-default-devtools.timeline.frame',
          'toplevel',
          'blink.user_timing',
          'v8.execute',
        ],
      });
      await typeKeys(page, KEYS, 2 * KEYS);
      const trace = await browser.stopTracing();
      out['traceMachineBusy'] = traceLoad.stop();
      out['trace'] = traceAttribution(trace);
    }
    await page.context().close();
  } finally {
    await browser.close();
    server.close();
  }
  mkdirSync(join(resultsDir, 'profiles'), { recursive: true });
  const file = join(
    resultsDir,
    'profiles',
    `${id}-${DOC}-${BACKEND}${LABEL ? `-${LABEL}` : ''}.json`,
  );
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[profile] wrote ${file}`);
}

await main();
