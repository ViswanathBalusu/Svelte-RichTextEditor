/**
 * Spike S10's page (SPK-023): drives one text kernel in a layout worker (kernel-worker.ts) the way
 * a page view would, and times it from both sides of the message boundary.
 *
 * 1. Cold start: the worker fetches, compiles and instantiates its kernel, then loads the fonts.
 * 2. Background pagination: every paragraph of `pages-1000` is broken once with an empty cache,
 *    posted in batches of 200 paragraphs, as time slices would post them.
 * 3. Opening `pages-100`: every paragraph is broken once (this fills the cache, as opening does).
 * 4. Typing: keystrokes in `pages-100` paragraphs chosen by a fixed pseudo-random sequence; each
 *    inserts a letter in one paragraph, and that paragraph alone is posted and re-broken (02 §9.5:
 *    an edit marks its block dirty). A tenth of the keystrokes go to the longest paragraph.
 *
 * The page builds the paragraphs from the corpus itself (src/kernel/paragraphs.ts); building them
 * is not timed as kernel work.
 */
import { loadDocument } from '@docedit/corpus';
import { toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { fontManifest } from '../fonts.ts';
import { kernelParagraphs } from '../kernel/paragraphs.ts';
import type { KernelParagraph } from '../kernel/types.ts';
import type { Request } from './kernel-worker.ts';

interface Reply<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface BreakReply {
  kernelMs: number;
  lines: number;
  memoryBytes: number;
  stats: { shaped: number; cacheHits: number; cacheEntries: number };
  digestFull?: string;
  digestBreaks?: string;
}

function call<T>(worker: Worker, req: Request): Promise<{ data: T; roundTripMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    worker.onmessage = (e: MessageEvent<Reply<T>>) => {
      const roundTripMs = performance.now() - t0;
      if (e.data.ok) resolve({ data: e.data.data as T, roundTripMs });
      else reject(new Error(e.data.error));
    };
    worker.postMessage(req);
  });
}

/** A small deterministic generator (mulberry32), so every browser types the same keystrokes. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The paragraph with one letter inserted at `at`; runs after it shift by one. */
function insert(p: KernelParagraph, at: number, ch: string): KernelParagraph {
  return {
    ...p,
    text: p.text.slice(0, at) + ch + p.text.slice(at),
    runs: p.runs.map((r) => ({
      ...r,
      start: r.start > at ? r.start + 1 : r.start,
      end: r.end >= at ? r.end + 1 : r.end,
    })),
  };
}

async function paragraphsOf(name: string): Promise<KernelParagraph[]> {
  const d = await loadDocument(name, { verify: false });
  return kernelParagraphs(toFlow(d.envelope as unknown as CdmEnvelopeLike));
}

export interface S10Input {
  kernel: 'ts' | 'rust';
  keystrokes: number;
  hyphenate: boolean;
  /** Skip the 1,000-page pass (for a quick determinism check). */
  skipLong?: boolean;
}

async function run(input: S10Input): Promise<unknown> {
  const fonts = fontManifest.fonts.map((f) => f.file);
  const doc100 = await paragraphsOf('pages-100');
  const doc1000 = input.skipLong ? [] : await paragraphsOf('pages-1000');
  const worker = new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' });
  const withHyphens = (ps: KernelParagraph[]): KernelParagraph[] =>
    input.hyphenate ? ps.map((p) => ({ ...p, hyphenate: true })) : ps;

  const init = await call<Record<string, unknown>>(worker, {
    type: 'init',
    kernel: input.kernel,
    fonts,
  });

  // Background pagination of 1,000 pages: cold cache, batches of 200 paragraphs.
  const long: { kernelMs: number; roundTripMs: number; lines: number }[] = [];
  let longMemory = 0;
  let longStats: BreakReply['stats'] | null = null;
  if (doc1000.length) {
    const all = withHyphens(doc1000);
    for (let i = 0; i < all.length; i += 200) {
      const r = await call<BreakReply>(worker, {
        type: 'break',
        paragraphs: all.slice(i, i + 200),
        cold: i === 0,
      });
      long.push({ kernelMs: r.data.kernelMs, roundTripMs: r.roundTripMs, lines: r.data.lines });
      longMemory = r.data.memoryBytes;
      longStats = r.data.stats;
    }
  }
  const longDigest = doc1000.length
    ? await call<BreakReply>(worker, {
        type: 'break',
        paragraphs: withHyphens(doc1000),
        digest: true,
      })
    : null;

  // Opening pages-100: break everything once with an empty cache; digest for determinism.
  const open = await call<BreakReply>(worker, {
    type: 'break',
    paragraphs: withHyphens(doc100),
    cold: true,
    digest: true,
  });

  // Typing.
  const random = prng(20261106);
  const longest = doc100.reduce((a, b, i) => (b.text.length > doc100[a]!.text.length ? i : a), 0);
  const current = withHyphens(doc100).slice();
  const keys: {
    paragraph: number;
    longest: boolean;
    chars: number;
    kernelMs: number;
    roundTripMs: number;
    lines: number;
  }[] = [];
  for (let k = 0; k < input.keystrokes; k++) {
    const i = k % 10 === 9 ? longest : Math.floor(random() * current.length);
    const p = current[i]!;
    const at = Math.floor(random() * (p.text.length + 1));
    const next = insert(p, at, 'e');
    current[i] = next;
    const r = await call<BreakReply>(worker, { type: 'break', paragraphs: [next] });
    keys.push({
      paragraph: i,
      longest: i === longest,
      chars: next.text.length,
      kernelMs: r.data.kernelMs,
      roundTripMs: r.roundTripMs,
      lines: r.data.lines,
    });
  }
  const end = await call<{ memoryBytes: number; stats: unknown }>(worker, { type: 'stats' });
  worker.terminate();
  return {
    userAgent: navigator.userAgent,
    kernel: input.kernel,
    hyphenate: input.hyphenate,
    init: { ...init.data, roundTripMs: init.roundTripMs },
    paragraphs: {
      pages100: doc100.length,
      pages1000: doc1000.length,
      longestChars: doc100[longest]!.text.length,
    },
    long: {
      batches: long.length,
      kernelMs: long.reduce((s, b) => s + b.kernelMs, 0),
      roundTripMs: long.reduce((s, b) => s + b.roundTripMs, 0),
      lines: long.reduce((s, b) => s + b.lines, 0),
      maxBatchKernelMs: long.reduce((m, b) => Math.max(m, b.kernelMs), 0),
      memoryBytes: longMemory,
      stats: longStats,
      digestFull: longDigest?.data.digestFull ?? null,
      digestBreaks: longDigest?.data.digestBreaks ?? null,
      warmKernelMs: longDigest?.data.kernelMs ?? null,
    },
    open: {
      kernelMs: open.data.kernelMs,
      roundTripMs: open.roundTripMs,
      lines: open.data.lines,
      digestFull: open.data.digestFull,
      digestBreaks: open.data.digestBreaks,
    },
    keys,
    end: end.data,
  };
}

Object.assign(globalThis, { __s10: { run, ready: true } });
