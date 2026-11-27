/**
 * Compile harness for the converter's typesetting tests (Node.js only). It compiles bundles in the
 * export worker's sandbox, through the worker's own modules (services/export-worker/src, used read
 * only), and adds what the worker does not do yet: the bundle's assets go into the job's tar, and
 * the font manifest gets the coverage of each face (from the same files, checked by SHA-256), so
 * the converter's glyph check runs.
 *
 * Tests that need the sandbox skip when `sandboxReady()` reports that it cannot run.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CdmEnvelope } from '@docedit/model';
import { podman } from '../../../services/export-worker/src/container.ts';
import {
  buildLayout,
  parseRawLayout,
  validateLayout,
} from '../../../services/export-worker/src/layout.ts';
import {
  compileInSandbox,
  IMAGE,
  type CompileResult,
} from '../../../services/export-worker/src/sandbox.ts';
import { sandboxReady } from '../../../services/export-worker/src/sandbox-ready.ts';
import {
  validatePdf,
  type Flavour,
  type Validation,
} from '../../../services/export-worker/src/verapdf.ts';
import {
  CLASS_FILES,
  convert,
  fontCoverage,
  type Bundle,
  type ConvertOptions,
  type FontManifest,
} from '../src/index.ts';

export { sandboxReady, validatePdf, type Flavour, type Validation };

const classDir = fileURLToPath(new URL('../class/', import.meta.url));

export function classFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CLASS_FILES) out[name] = readFileSync(join(classDir, name), 'utf8');
  return out;
}

/** The local copy of the image's font directory, built by the worker's fonts.lua (spike S4). */
const localFonts = fileURLToPath(
  new URL('../../../services/export-worker/out/fonts-local/', import.meta.url),
);

let manifest: FontManifest | undefined;

/** The image's font manifest, with the coverage of every face whose file is available locally. */
export async function imageFonts(): Promise<FontManifest> {
  if (manifest) return manifest;
  const r = await podman(
    [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--entrypoint=cat',
      IMAGE,
      '/opt/docedit/fonts/fonts.json',
    ],
    // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (sandbox-ready.ts in the
    // export worker; lane V-EXP-017-032, 2026-11-13). With 60 s this call failed in a full run
    // while other jobs used the same Podman machine, and compile tests failed with an empty
    // reason; the same tests passed afterwards (7 files, 143 s).
    { timeoutMs: 180_000, maxStdoutBytes: 1024 * 1024 },
  );
  if (r.code !== 0)
    throw new Error(
      `cannot read the font manifest of ${IMAGE}: ${r.timedOut ? 'timed out' : r.stderr}`,
    );
  const m = JSON.parse(new TextDecoder().decode(r.stdout)) as FontManifest;
  const cover = (face: { file: string; sha256: string; coverage?: unknown }): void => {
    const path = join(localFonts, face.file);
    if (!existsSync(path)) return;
    const bytes = new Uint8Array(readFileSync(path));
    if (createHash('sha256').update(bytes).digest('hex') !== face.sha256) return;
    face.coverage = fontCoverage(bytes);
  };
  for (const f of m.families)
    for (const face of [f.regular, f.bold, f.italic, f.boldItalic]) cover(face);
  cover(m.math);
  // The fallback chain: the glyph check needs the coverage of every face of it (EXP-026).
  for (const f of m.fallback ?? []) cover(f);
  manifest = m;
  return m;
}

export interface Compiled {
  bundle: Bundle;
  compile: CompileResult;
  raw: ReturnType<typeof parseRawLayout> | null;
  layout: ReturnType<typeof buildLayout> | null;
  layoutErrors: string[];
}

export async function compileBundle(
  bundle: Bundle,
  options: {
    maxPasses?: number;
    minPasses?: number;
    /** Tests only: the limits of a long document (09 §9.3 item 4 sets 120 s for a job). */
    limits?: { wallSeconds?: number };
  } = {},
): Promise<Compiled> {
  const files: Record<string, string | Uint8Array> = { ...bundle.files, ...bundle.assets };
  const result = await compileInSandbox(files, {
    ...(options.maxPasses !== undefined ? { maxPasses: options.maxPasses } : {}),
    ...(options.minPasses !== undefined ? { minPasses: options.minPasses } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  // compileInSandbox starts a container that never reached TeX once more. Print the first failure,
  // so that the cause stays on record even when the second start worked.
  if (result.stderr.startsWith('[first start failed')) console.warn(result.stderr.split('\n')[0]);
  // A job that leaves no log (the runtime refused it, or killed it) would fail a test that prints
  // the log with no reason. Say what the sandbox reported.
  const compile =
    !result.ok && result.log === ''
      ? {
          ...result,
          log:
            `[the sandbox wrote no log: exit code ${result.exitCode}, timed out ${result.timedOut}, ` +
            `cancelled ${result.cancelled}, wall ${result.wallMs} ms, stderr: ${result.stderr.slice(-1500)}]`,
        }
      : result;
  let raw: Compiled['raw'] = null;
  let layout: Compiled['layout'] = null;
  let layoutErrors: string[] = [];
  if (compile.layoutRaw) {
    try {
      raw = parseRawLayout(compile.layoutRaw);
      layout = buildLayout(raw, bundle.map, {
        seq: bundle.manifest.seq,
        classVersion: bundle.manifest.classVersion,
        setup: null,
      });
      layoutErrors = validateLayout(layout);
    } catch (e) {
      layoutErrors = [String(e)];
    }
  }
  return { bundle, compile, raw, layout, layoutErrors };
}

export async function convertAndCompile(
  envelope: CdmEnvelope,
  options: Omit<ConvertOptions, 'fonts' | 'classFiles'> = {},
  compileOptions: {
    maxPasses?: number;
    minPasses?: number;
    limits?: { wallSeconds?: number };
  } = {},
): Promise<Compiled> {
  const bundle = await convert(envelope, {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    ...options,
  });
  return compileBundle(bundle, compileOptions);
}

/** The text of a PDF by poppler's or xpdf's `pdftotext -raw`, or null when it is not installed. */
export function pdfText(pdf: Uint8Array, mode: '-raw' | '-layout' = '-raw'): string | null {
  const dir = join(tmpdir(), `docedit-pdftext-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash('sha256').update(pdf).digest('hex').slice(0, 16)}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-enc', 'UTF-8', mode, file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** Writes a compile's artefacts for inspection when a test fails. */
export function keep(name: string, c: Compiled): string {
  const dir = join(tmpdir(), 'docedit-export-latex-tests', name);
  mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(c.bundle.files)) writeFileSync(join(dir, n), t);
  for (const [n, b] of Object.entries(c.bundle.assets)) {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, n), b);
  }
  if (c.compile.pdf) writeFileSync(join(dir, 'main.pdf'), c.compile.pdf);
  writeFileSync(join(dir, 'main.log'), c.compile.log);
  if (c.compile.layoutRaw) writeFileSync(join(dir, 'main.layout'), c.compile.layoutRaw);
  return dir;
}

/** The first error of a TeX log, with a few lines of context. */
export function firstError(log: string): string {
  const lines = log.split('\n');
  const i = lines.findIndex((l) => /^!|^\.\/main\.tex:\d+:|\]:\d+:|^\.\/styles\.tex:\d+:/.test(l));
  return i < 0 ? log.slice(-1500) : lines.slice(Math.max(0, i - 4), i + 12).join('\n');
}
