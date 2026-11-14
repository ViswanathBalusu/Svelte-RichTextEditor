/**
 * Spike S5 analysis: how each browser turns shaped advances into painted line widths. For every
 * Latin line measured by e2e/s5.spec.ts (test-results/s5/lines/<project>.json), it recomputes the
 * width from harfbuzzjs's advances with each glyph's advance rounded to a step (exact, 1/64 px,
 * 1/60 px, 1/16 px) and compares that with the painted width, and it breaks the canvas-minus-
 * painted difference down by font size. Writes test-results/s5/quantisation.json.
 *
 * Usage: node scripts/s5-quantisation.ts   (from packages/perf, after the S5 spec has run)
 */
import { loadDocument } from '@docedit/corpus';
import { toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontManifest } from '../src/fonts.ts';
import { sampleLines } from '../src/lines.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { summarise } from '../src/stats.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hb = await loadHarfbuzz();
for (const f of fontManifest.fonts)
  hb.shaper.loadFont(f.file, new Uint8Array(readFileSync(join(pkg, 'fonts', f.file))));
const lines = [
  ...sampleLines(
    toFlow((await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike),
    'pages-20',
  ),
  ...sampleLines(
    toFlow((await loadDocument('pages-100')).envelope as unknown as CdmEnvelopeLike),
    'pages-100',
  ).slice(0, 1500),
];
const byId = new Map(lines.map((l) => [l.id, l]));

interface Measured {
  id: string;
  role: string;
  canvas: Record<string, number>;
  painted: Record<string, number>;
}

const steps: [string, number][] = [
  ['exact', 0],
  ['1/64 px', 1 / 64],
  ['1/60 px', 1 / 60],
  ['1/16 px', 1 / 16],
];
const out: Record<string, unknown> = {};
for (const project of ['chromium', 'msedge', 'firefox', 'webkit']) {
  const file = join(pkg, `test-results/s5/lines/${project}.json`);
  if (!existsSync(file)) continue;
  const measured = (JSON.parse(readFileSync(file, 'utf8')) as Measured[]).filter(
    (m) => m.role === 'latin',
  );
  const result: Record<string, unknown> = {};
  for (const [name, step] of steps) {
    const d = measured.map((m) => {
      let w = 0;
      for (const s of byId.get(m.id)!.segments) {
        const scale = s.sizePx / hb.shaper.upem(s.face);
        for (const g of hb.shaper.shape(s.face, s.text)) {
          const a = g.advance * scale;
          w += step ? Math.round(a / step) * step : a;
        }
      }
      return Math.abs(w - m.painted['default']!);
    });
    result[`painted vs advances rounded per glyph to ${name}`] = summarise(d);
  }
  const bySize = new Map<string, number[]>();
  for (const m of measured) {
    const sizes = [...new Set(byId.get(m.id)!.segments.map((s) => s.sizePx.toFixed(3)))].join('+');
    const list = bySize.get(sizes) ?? [];
    list.push(m.canvas['default']! - m.painted['default']!);
    bySize.set(sizes, list);
  }
  result['canvas − painted by font size (px)'] = Object.fromEntries(
    [...bySize.entries()].filter(([, v]) => v.length >= 10).map(([k, v]) => [k, summarise(v)]),
  );
  out[project] = result;
}
writeFileSync(join(pkg, 'test-results/s5/quantisation.json'), `${JSON.stringify(out, null, 2)}\n`);
for (const [project, r] of Object.entries(out))
  for (const [k, v] of Object.entries(
    r as Record<string, { median?: number; p95?: number; max?: number }>,
  ))
    if (v.median !== undefined)
      console.log(
        `${project}: ${k}: median ${v.median.toFixed(4)}, p95 ${v.p95!.toFixed(4)}, max ${v.max!.toFixed(4)}`,
      );
