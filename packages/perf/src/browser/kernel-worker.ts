/**
 * Spike S10's layout worker (SPK-023): holds one text kernel, the TypeScript one (harfbuzzjs and
 * `linebreak`) or the Rust one (wasm/text-kernel), and breaks the paragraphs the page posts to it.
 * Messages are plain structured-clone data, as a real layout worker's would be.
 */
import { sha256Hex } from '@docedit/model';
import { rustKernel } from '../kernel/rust-kernel.ts';
import { tsKernel } from '../kernel/ts-kernel.ts';
import {
  linesKey,
  type KernelLine,
  type KernelParagraph,
  type TextKernel,
} from '../kernel/types.ts';
import { loadHarfbuzz } from '../shapers/harfbuzz.ts';
import { loadTextKernel } from '../shapers/harfrust.ts';

interface Scope {
  onmessage: ((e: { data: Request }) => void) | null;
  postMessage(data: unknown): void;
}

export type Request =
  | { type: 'init'; kernel: 'ts' | 'rust'; fonts: string[] }
  | { type: 'break'; paragraphs: KernelParagraph[]; digest?: boolean; cold?: boolean }
  | { type: 'stats' };

const scope = globalThis as unknown as Scope;
let kernel: TextKernel | null = null;

async function init(kind: 'ts' | 'rust', fonts: string[]): Promise<unknown> {
  const t0 = performance.now();
  let fetchMs = 0;
  let compileMs = 0;
  let instantiateMs: number;
  let importMs = 0;
  if (kind === 'ts') {
    const hb = await loadHarfbuzz();
    importMs = hb.importMs;
    instantiateMs = hb.instantiateMs;
    kernel = tsKernel(hb.shaper);
  } else {
    const tf = performance.now();
    const bytes = new Uint8Array(await (await fetch('/wasm/text-kernel.wasm')).arrayBuffer());
    fetchMs = performance.now() - tf;
    const loaded = await loadTextKernel(bytes);
    compileMs = loaded.compileMs;
    instantiateMs = loaded.instantiateMs;
    kernel = rustKernel(loaded.module);
  }
  const t1 = performance.now();
  for (const file of fonts) {
    const bytes = new Uint8Array(await (await fetch(`/fonts/${file}`)).arrayBuffer());
    kernel.loadFace(file, bytes);
  }
  const t2 = performance.now();
  return {
    name: kernel.name,
    startMs: t1 - t0,
    fontsMs: t2 - t1,
    fetchMs,
    compileMs,
    instantiateMs,
    importMs,
    memoryBytes: kernel.memoryBytes(),
  };
}

async function breakAll(
  paragraphs: KernelParagraph[],
  digest: boolean,
  cold: boolean,
): Promise<unknown> {
  const k = kernel!;
  if (cold) k.clearCache();
  const t0 = performance.now();
  const results: KernelLine[][] = [];
  for (const p of paragraphs) results.push(k.breakParagraph(p));
  const kernelMs = performance.now() - t0;
  const lines = results.reduce((s, r) => s + r.length, 0);
  const out: Record<string, unknown> = {
    kernelMs,
    lines,
    memoryBytes: k.memoryBytes(),
    stats: k.stats(),
  };
  if (digest) {
    out['digestFull'] = await sha256Hex(results.map(linesKey).join('\n'));
    out['digestBreaks'] = await sha256Hex(
      results.map((r) => r.map((l) => `${l.start}-${l.end}`).join(' ')).join('\n'),
    );
  } else out['result'] = results.length === 1 ? results[0] : null;
  return out;
}

scope.onmessage = (e) => {
  const req = e.data;
  const reply = async (): Promise<unknown> => {
    if (req.type === 'init') return init(req.kernel, req.fonts);
    if (req.type === 'break')
      return breakAll(req.paragraphs, req.digest ?? false, req.cold ?? false);
    return { stats: kernel?.stats() ?? null, memoryBytes: kernel?.memoryBytes() ?? 0 };
  };
  reply().then(
    (data) => scope.postMessage({ ok: true, data }),
    (err: unknown) =>
      scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
