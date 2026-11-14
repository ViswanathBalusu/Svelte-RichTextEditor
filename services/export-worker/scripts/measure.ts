/**
 * Compile-time measurement for spike S4 (SPK-017; groundwork for EXP-060).
 *
 *   node services/export-worker/scripts/measure.ts [--corpus <dir>] [--docs a,b] [--runs 3]
 *        [--env podman,local] [--tagging on,off,none,draft] [--renderer node] [--layout line]
 *        [--passes 3] [--profile final|preview] [--wall 120] [--validate]
 *
 * Reads every `*.cdm.json` of the corpus directory (default: fixtures/s4-corpus), or the ones
 * `--docs` names, validates each with @docedit/model/validate, and compiles it with exactly
 * `--passes` passes per run, in the Podman sandbox and with the local LuaLaTeX. For the shared
 * corpus of FND-006 (`--corpus packages/corpus/out`), the attached assets of each document come from
 * the corpus manifest (invariant I4), and results.json records the corpus stamp (version and
 * fingerprint). `--profile` is the converter's: `preview` logs a character no font covers and goes
 * on, `final` stops; both cost the same per pass. `--wall` raises the job's wall-clock limit for the
 * measurement only, so that a long document can be timed past the 120 s of 09 §9.3 item 4.
 * Pass times are measured inside the container (date +%s%N around each lualatex call) and around
 * each process locally; `wall` is the whole run including container start-up.
 * Writes results.json and summary.md to services/export-worker/out/measure/<stamp>/.
 */
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FontManifest, Renderer, Tagging, LayoutLevel } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { mathGate } from '@docedit/export-latex';
import { readFontManifest } from '../src/bundle-io.ts';
import { podmanInfo } from '../src/container.ts';
import { runExport } from '../src/pipeline.ts';
import { IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { validatePdf } from '../src/verapdf.ts';
import { fontManifestFromImage } from './lib.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const corpus = resolve(opt('--corpus', join(root, 'fixtures', 's4-corpus')));
const runs = Number(opt('--runs', '3'));
const envs = opt('--env', 'podman,local').split(',') as Array<'podman' | 'local'>;
const taggings = opt('--tagging', 'on,off,none').split(',') as Tagging[];
const renderers = opt('--renderer', 'node').split(',') as Renderer[];
const layouts = opt('--layout', 'line').split(',') as LayoutLevel[];
const passes = Number(opt('--passes', '3'));
const profile = opt('--profile', 'final') === 'preview' ? 'preview' : 'final';
const wallSeconds = Number(opt('--wall', '120'));
const only = argv.includes('--docs') ? new Set(opt('--docs', '').split(',')) : null;
const validateOn = argv.includes('--validate');
// --interleave runs every configuration once per round, so that slow drift of the machine
// spreads over all configurations instead of favouring the ones measured first.
const interleave = argv.includes('--interleave');
const configs = taggings.flatMap((tagging) =>
  renderers.flatMap((renderer) => layouts.map((layout) => ({ tagging, renderer, layout }))),
);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(opt('--out', join(root, 'out', 'measure', stamp)));
mkdirSync(out, { recursive: true });

interface Row {
  doc: string;
  env: string;
  tagging: string;
  renderer: string;
  layout: string;
  run: number;
  ok: boolean;
  pages: number | null;
  passMs: number[];
  wallMs: number;
  convertMs: number;
  converged: boolean;
  pdfBytes: number | null;
}

const docs = readdirSync(corpus)
  .filter((f) => f.endsWith('.cdm.json') && (!only || only.has(f.replace(/\.cdm\.json$/, ''))))
  .sort();
// The shared corpus (FND-006) lists each document's attached assets and its own stamp.
const corpusManifest = existsSync(join(corpus, 'manifest.json'))
  ? (JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')) as {
      corpus?: string;
      version?: number;
      fingerprint?: string;
      documents?: Array<{ name: string; assets?: string[]; documentHash?: string }>;
    })
  : null;
const corpusStamp = corpusManifest?.corpus
  ? {
      corpus: corpusManifest.corpus,
      version: corpusManifest.version ?? null,
      fingerprint: corpusManifest.fingerprint ?? null,
    }
  : null;
const attachedOf = (name: string): Set<string> =>
  new Set(corpusManifest?.documents?.find((d) => d.name === name)?.assets ?? []);
const ready = envs.includes('podman') ? await sandboxReady() : null;
if (ready && !ready.ok)
  console.warn(`Podman sandbox unavailable (${ready.reason}); Podman runs skipped`);

const machine = {
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCpus: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  localTeX: (() => {
    try {
      return execFileSync('lualatex', ['--version'], { encoding: 'utf8' }).split('\n')[0];
    } catch {
      return 'unavailable';
    }
  })(),
  podman: podmanInfo(),
  podmanRoute: ready?.reason ?? 'not used',
  image: IMAGE,
};

const fontsLocal = envs.includes('local')
  ? readFontManifest(join(root, 'out', 'fonts-local', 'fonts.json'))
  : null;
const fontsImage: FontManifest | null = ready?.ok ? await fontManifestFromImage() : null;
const rows: Row[] = [];
const validations: unknown[] = [];

for (const file of docs) {
  const name = file.replace(/\.cdm\.json$/, '');
  const env = JSON.parse(readFileSync(join(corpus, file), 'utf8')) as CdmEnvelope;
  const v = validate(env, {
    attachedAssets: attachedOf(name),
    retiredRegionIds: new Set(),
    mathGate: (latex, display) => {
      const r = mathGate(latex, display);
      return r.ok ? null : r.reason;
    },
  });
  if (!v.valid) {
    console.warn(`${name}: not valid CDM, skipped (${v.violations[0]?.message ?? ''})`);
    continue;
  }
  for (const where of envs) {
    if (where === 'podman' && !ready?.ok) continue;
    const fonts = where === 'podman' ? fontsImage! : fontsLocal!;
    const order = interleave
      ? Array.from({ length: runs }, (_, i) => configs.map((c) => ({ ...c, run: i + 1 }))).flat()
      : configs.flatMap((c) => Array.from({ length: runs }, (_, i) => ({ ...c, run: i + 1 })));
    for (const { tagging, renderer, layout, run } of order) {
      {
        const r = await runExport(
          env,
          fonts,
          {
            tagging,
            renderer,
            layout,
            pdfStandard: tagging === 'on' ? 'ua-2+a-4f' : 'none',
            profile,
            title: name,
            date: '6 November 2026',
          },
          where === 'podman'
            ? {
                kind: 'sandbox',
                options: {
                  minPasses: passes,
                  maxPasses: passes,
                  limits: { wallSeconds },
                  passTimeoutSeconds: wallSeconds - 10,
                },
              }
            : {
                kind: 'local',
                options: {
                  workRoot: join(root, 'out', 'local-jobs'),
                  fontPath: join(root, 'out', 'fonts-local'),
                  minPasses: passes,
                  maxPasses: passes,
                },
              },
        );
        const row: Row = {
          doc: name,
          env: where,
          tagging,
          renderer,
          layout,
          run,
          ok: r.compile.ok,
          pages: r.layout?.pages.length ?? null,
          passMs: r.compile.passes.map((p) => p.ms),
          wallMs: Math.round(r.compile.wallMs),
          convertMs: Math.round(r.convertMs),
          converged: r.compile.converged,
          pdfBytes: r.compile.pdf?.length ?? null,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
        if (run === 1 && r.compile.pdf) {
          const stem = `${name}-${where}-${tagging}-${renderer}${layout === 'line' ? '' : `-${layout}`}`;
          writeFileSync(join(out, `${stem}.pdf`), r.compile.pdf);
          if (r.layout) writeFileSync(join(out, `${stem}.layout.json`), JSON.stringify(r.layout));
          writeFileSync(join(out, `${stem}.map.json`), r.bundle.files['map.json'] ?? '');
        }
        if (validateOn && run === 1 && tagging === 'on' && r.compile.pdf) {
          for (const flavour of ['ua2', '4f'] as const) {
            const res = await validatePdf(r.compile.pdf, flavour);
            validations.push({
              doc: name,
              env: where,
              renderer,
              flavour,
              compliant: res.compliant,
              passedChecks: res.passedChecks,
              failedChecks: res.failedChecks,
              failures: res.failures.slice(0, 10),
              error: res.error,
            });
            console.log(
              `  veraPDF ${flavour}: ${res.compliant ? 'compliant' : 'NOT compliant'} (${res.passedChecks} passed, ${res.failedChecks} failed)`,
            );
          }
        }
      }
    }
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const fmt = (ms: number): string => (Number.isNaN(ms) ? '–' : (ms / 1000).toFixed(2));

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.doc}|${r.env}|${r.tagging}|${r.renderer}|${r.layout}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const lines = [
  `# Spike S4 measurement, ${stamp}`,
  '',
  `Machine: ${machine.cpu}, ${machine.logicalCpus} logical CPUs, ${machine.memoryGiB} GiB; ${machine.platform}; Node ${machine.node}.`,
  `Local TeX: ${machine.localTeX}. Podman: ${machine.podman ? `${machine.podman.version}, rootless ${machine.podman.rootless}, ${machine.podman.ociRuntime}, kernel ${machine.podman.kernel}` : 'unavailable'}; route: ${machine.podmanRoute}.`,
  `Runs per cell: ${runs}; passes per run: ${passes}; seconds, median (min to max).`,
  `Corpus: ${corpusStamp ? `${corpusStamp.corpus} version ${corpusStamp.version} (fingerprint ${corpusStamp.fingerprint})` : corpus}; converter profile ${profile}; job wall limit ${wallSeconds} s.`,
  `Command: node services/export-worker/scripts/measure.ts ${argv.join(' ')}`,
  '',
  '| Document | Pages | Where | Tagging | Renderer | Layout | Pass 1 | Pass 2 | Pass 3 | Wall | OK |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const [, g] of groups) {
  const first = g[0]!;
  const cell = (i: number): string => {
    const xs = g.map((r) => r.passMs[i]).filter((x): x is number => typeof x === 'number');
    return xs.length ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})` : '–';
  };
  const walls = g.map((r) => r.wallMs);
  lines.push(
    `| ${first.doc} | ${first.pages ?? '–'} | ${first.env} | ${first.tagging} | ${first.renderer} | ${first.layout} | ${cell(0)} | ${cell(1)} | ${cell(2)} | ${fmt(median(walls))} (${fmt(Math.min(...walls))}–${fmt(Math.max(...walls))}) | ${g.every((r) => r.ok) ? 'yes' : 'no'} |`,
  );
}
writeFileSync(
  join(out, 'results.json'),
  JSON.stringify(
    {
      machine,
      corpus,
      corpusStamp,
      command: `node services/export-worker/scripts/measure.ts ${argv.join(' ')}`,
      profile,
      wallSeconds,
      runs,
      passes,
      rows,
      validations,
    },
    null,
    2,
  ),
);
writeFileSync(join(out, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`results: ${out}`);
