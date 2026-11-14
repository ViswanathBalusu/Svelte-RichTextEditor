/**
 * S10 prototype 2: one Rust module compiled to WebAssembly (wasm/text-kernel) for shaping
 * (HarfRust 0.15.0), UAX #14 segmentation (`unicode-linebreak` 0.1.5, Unicode 15.0), first-fit
 * line breaking and TeX-pattern hyphenation (`hypher` 0.1.8, English). A paragraph crosses the
 * boundary once: runs, width and text in, lines out. Segment widths are cached inside the module.
 */
import type { FontKey, LineMetrics } from '@docedit/layout';
import { resolveFace } from '../fonts.ts';
import type { TextKernelModule } from '../shapers/harfrust.ts';
import { faceMetrics, type FaceMetrics } from './metrics.ts';
import type { KernelLine, KernelParagraph, KernelStats, TextKernel } from './types.ts';

export function rustKernel(
  module: TextKernelModule,
  name = 'rust-kernel (HarfRust 0.15.0, unicode-linebreak 0.1.5, hypher 0.1.8)',
): TextKernel {
  const metrics = new Map<string, FaceMetrics>();
  const handle = (font: FontKey): { h: number; upem: number } => {
    const file = resolveFace(font).file;
    return { h: module.handle(file), upem: metrics.get(file)!.upem };
  };
  if (!module.exports.tk_break) throw new Error('the module was built without the kernel feature');
  const tkBreak = module.exports.tk_break.bind(module.exports);
  return {
    id: name,
    name,
    loadFace(file, bytes) {
      module.loadFont(file, bytes);
      metrics.set(file, faceMetrics(bytes));
    },
    advance(font, text) {
      const { h, upem } = handle(font);
      module.inputText(text);
      return (module.exports.tk_width(h) * font.sizePt) / upem;
    },
    advances(font, text) {
      const { h, upem } = handle(font);
      module.inputText(text);
      const n = module.exports.tk_shape(h, 0);
      const out = new Array<number>(text.length).fill(0);
      const view = module.output();
      const scale = font.sizePt / upem;
      for (let i = 0; i < n; i++) {
        const cluster = view.getUint32(i * 16 + 4, true);
        out[cluster] = (out[cluster] ?? 0) + view.getInt32(i * 16 + 8, true) * scale;
      }
      return out;
    },
    lineMetrics(font): LineMetrics {
      const m = metrics.get(resolveFace(font).file)!;
      const s = font.sizePt / m.upem;
      return { ascent: m.ascender * s, descent: m.descender * s, lineGap: m.lineGap * s };
    },
    breakParagraph(p: KernelParagraph): KernelLine[] {
      const n = p.runs.length;
      const len = 16 + n * 16 + p.text.length * 2;
      // Written straight into the module's input buffer (one copy); the view is taken after
      // `tk_input`, which may grow the memory.
      const ptr = module.exports.tk_input(len);
      const v = new DataView(module.memory.buffer, ptr, len);
      v.setUint32(0, n, true);
      v.setUint32(4, p.text.length, true);
      v.setFloat32(8, p.widthPt, true);
      v.setUint32(12, p.hyphenate ? 1 : 0, true);
      p.runs.forEach((r, i) => {
        const at = 16 + i * 16;
        v.setUint32(at, handle(r.font).h, true);
        v.setFloat32(at + 4, r.font.sizePt, true);
        v.setUint32(at + 8, r.start, true);
        v.setUint32(at + 12, r.end, true);
      });
      const textAt = 16 + n * 16;
      for (let i = 0; i < p.text.length; i++)
        v.setUint16(textAt + i * 2, p.text.charCodeAt(i), true);
      const count = tkBreak();
      const out = module.output();
      const lines: KernelLine[] = [];
      for (let i = 0; i < count; i++) {
        const flags = out.getUint32(i * 16 + 12, true);
        lines.push({
          start: out.getUint32(i * 16, true),
          end: out.getUint32(i * 16 + 4, true),
          widthPt: out.getFloat32(i * 16 + 8, true),
          hyphenated: (flags & 1) !== 0,
          mandatory: (flags & 2) !== 0,
        });
      }
      return lines;
    },
    clearCache: () => module.exports.tk_cache_clear(),
    stats(): KernelStats {
      module.exports.tk_stats();
      const v = module.output();
      return {
        shaped: v.getUint32(0, true),
        cacheHits: v.getUint32(4, true),
        cacheEntries: v.getUint32(8, true),
      };
    },
    memoryBytes: () => module.memory.buffer.byteLength,
  };
}
