/**
 * Exports one CDM document end to end and keeps every artefact (spike S4).
 *
 *   node services/export-worker/scripts/try-export.ts <file.cdm.json> [--local] [--tagging on]
 *        [--renderer node|harf] [--validate] [--out <dir>]
 *
 * Writes the bundle, main.pdf, main.log, main.layout, layout.json and the veraPDF results to
 * services/export-worker/out/try/<name>/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CdmEnvelope } from '@docedit/model';
import type { Renderer, Tagging } from '@docedit/export-latex';
import { readFontManifest } from '../src/bundle-io.ts';
import { fontManifestFromImage } from './lib.ts';
import { runExport } from '../src/pipeline.ts';
import { validatePdf } from '../src/verapdf.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a) => a.endsWith('.json'));
if (!file) {
  console.error(
    'usage: try-export.ts <file.cdm.json> [--local] [--tagging on|draft|off|none] [--renderer node|harf] [--validate]',
  );
  process.exit(2);
}
const local = args.includes('--local');
const tagging = (flag('--tagging') ?? 'on') as Tagging;
const renderer = (flag('--renderer') ?? 'node') as Renderer;
const name = basename(file).replace(/\.(cdm\.)?json$/, '');
const out = resolve(
  flag('--out') ??
    join(root, 'out', 'try', `${name}-${local ? 'local' : 'podman'}-${tagging}-${renderer}`),
);
mkdirSync(out, { recursive: true });

const envelope = JSON.parse(readFileSync(file, 'utf8')) as CdmEnvelope;
const fonts = local
  ? readFontManifest(join(root, 'out', 'fonts-local', 'fonts.json'))
  : await fontManifestFromImage();
const result = await runExport(
  envelope,
  fonts,
  {
    tagging,
    renderer,
    pdfStandard: tagging === 'on' ? 'ua-2+a-4f' : 'none',
    layout: 'line',
    title: name,
    date: '6 November 2026',
  },
  local
    ? {
        kind: 'local',
        options: {
          workRoot: join(root, 'out', 'local-jobs'),
          fontPath: join(root, 'out', 'fonts-local'),
        },
      }
    : { kind: 'sandbox', options: {} },
);
for (const [n, c] of Object.entries(result.bundle.files)) writeFileSync(join(out, n), c);
if (result.compile.pdf) writeFileSync(join(out, 'main.pdf'), result.compile.pdf);
writeFileSync(join(out, 'main.log'), result.compile.log);
if (result.compile.layoutRaw) writeFileSync(join(out, 'main.layout'), result.compile.layoutRaw);
if (result.layout) writeFileSync(join(out, 'layout.json'), JSON.stringify(result.layout, null, 2));
const summary: Record<string, unknown> = {
  ok: result.compile.ok,
  exitCode: result.compile.exitCode,
  timedOut: result.compile.timedOut,
  passes: result.compile.passes,
  converged: result.compile.converged,
  wallMs: Math.round(result.compile.wallMs),
  convertMs: Math.round(result.convertMs),
  pages: result.layout?.pages.length ?? null,
  layoutErrors: result.layoutErrors,
  diagnostics: result.bundle.diagnostics,
  stderr: result.compile.stderr.slice(0, 2000),
};
if (args.includes('--validate') && result.compile.pdf) {
  summary['verapdf'] = [];
  for (const f of tagging === 'on' ? (['ua2', '4f'] as const) : (['4f'] as const)) {
    (summary['verapdf'] as unknown[]).push(await validatePdf(result.compile.pdf, f));
  }
}
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`artefacts: ${out}`);
