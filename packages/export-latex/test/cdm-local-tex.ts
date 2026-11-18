/**
 * A local compile harness for the LaTeX tests of lane V-CDM-028-053 (Node.js only). It does what
 * `test/harness.ts` does, but runs `lualatex` on this machine instead of in the export worker's
 * sandbox: that sandbox cannot start under the Podman machine of this host (its cgroup limits fail,
 * EXP-070). Only bundles that the converter wrote from fixture documents are compiled here. The
 * fonts are the local copies of the worker's font directory, checked against their SHA-256 like
 * `imageFonts()` does. The binary comes from `DOCEDIT_LUALATEX` (default `lualatex` on the PATH);
 * the tests skip when it cannot be started.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CdmEnvelope } from '@docedit/model';
import {
  CLASS_FILES,
  convert,
  fontCoverage,
  type Bundle,
  type ConvertOptions,
  type FontManifest,
} from '../src/index.ts';

const FONT_DIR = fileURLToPath(
  new URL('../../../services/export-worker/out/fonts-local/', import.meta.url),
);
const CLASS_DIR = fileURLToPath(new URL('../class/', import.meta.url));
const LUALATEX = process.env['DOCEDIT_LUALATEX'] ?? 'lualatex';

/** The font manifest of the local font directory, with the coverage of each face that verifies. */
export function localFonts(): FontManifest {
  const m = JSON.parse(readFileSync(join(FONT_DIR, 'fonts.json'), 'utf8')) as FontManifest;
  const cover = (face: { file: string; sha256: string; coverage?: unknown } | undefined): void => {
    if (!face) return;
    const path = join(FONT_DIR, face.file);
    if (!existsSync(path)) return;
    const bytes = new Uint8Array(readFileSync(path));
    if (createHash('sha256').update(bytes).digest('hex') !== face.sha256) return;
    face.coverage = fontCoverage(bytes);
  };
  for (const f of m.families) {
    cover(f.regular);
    cover(f.bold);
    cover(f.italic);
    cover(f.boldItalic);
  }
  cover(m.math);
  return m;
}

/** Converts an envelope with the local fonts and the class of this package. */
export async function convertLocal(
  envelope: CdmEnvelope,
  options: Omit<ConvertOptions, 'fonts' | 'classFiles'> = {},
): Promise<Bundle> {
  const classFiles: Record<string, string> = {};
  for (const name of CLASS_FILES) classFiles[name] = readFileSync(join(CLASS_DIR, name), 'utf8');
  return convert(envelope, { fonts: localFonts(), classFiles, ...options } as ConvertOptions);
}

export interface LocalCompiled {
  ok: boolean;
  pdf: Uint8Array | null;
  log: string;
  /** The layout report (`main.layout`), as written by the class. */
  layout: string | null;
  dir: string;
}

/**
 * Whether a local compile can run here: `lualatex` starts, and the local font directory exists.
 * That directory is generated (services/export-worker/out, not committed), so a fresh checkout or
 * worktree has none, and the tests skip there instead of failing on the missing manifest.
 */
export function lualatexAvailable(): boolean {
  if (!existsSync(join(FONT_DIR, 'fonts.json'))) return false;
  const r = spawnSync(LUALATEX, ['--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return !r.error && r.status === 0;
}

/**
 * Writes the bundle to a fresh directory and runs two passes of `lualatex` there, as the worker's
 * image does (without shell escape). The directory is kept for inspection.
 */
export function compileLocal(bundle: Bundle, name: string): LocalCompiled {
  const dir = mkdtempSync(
    join(tmpdir(), `docedit-v-cdm-028-053-${name.replace(/[^a-z0-9-]/gi, '-')}-`),
  );
  for (const [file, text] of Object.entries(bundle.files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  for (const [file, bytes] of Object.entries(bundle.assets)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
  }
  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: '1788000000',
    FORCE_SOURCE_DATE: '1',
    DOCEDIT_FONT_PATH: `${FONT_DIR.replace(/\\/g, '/')}`,
    DOCEDIT_MAX_PAGES: '200',
    max_print_line: '1048576',
  };
  let log = '';
  let ok = true;
  for (let pass = 0; pass < 2 && ok; pass++) {
    const r = spawnSync(
      LUALATEX,
      [
        '--interaction=nonstopmode',
        '--halt-on-error',
        '--no-shell-escape',
        '--file-line-error',
        'main.tex',
      ],
      {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
      },
    );
    log = (r.stdout ?? '') + (r.stderr ?? '');
    if (r.error || r.status !== 0) ok = false;
  }
  const pdfPath = join(dir, 'main.pdf');
  const layoutPath = join(dir, 'main.layout');
  const logPath = join(dir, 'main.log');
  if (existsSync(logPath)) log = readFileSync(logPath, 'utf8');
  return {
    ok: ok && existsSync(pdfPath),
    pdf: existsSync(pdfPath) ? new Uint8Array(readFileSync(pdfPath)) : null,
    log,
    layout: existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : null,
    dir,
  };
}

/**
 * The same as `compileLocal`, without blocking the test process, so a test can compile several
 * documents at once (EXP-115). It runs the two passes one after the other for each bundle.
 */
export async function compileLocalAsync(bundle: Bundle, name: string): Promise<LocalCompiled> {
  const dir = mkdtempSync(join(tmpdir(), `docedit-exp-115-${name.replace(/[^a-z0-9-]/gi, '-')}-`));
  for (const [file, text] of Object.entries(bundle.files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  for (const [file, bytes] of Object.entries(bundle.assets)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
  }
  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: '1788000000',
    FORCE_SOURCE_DATE: '1',
    DOCEDIT_FONT_PATH: `${FONT_DIR.replace(/\\/g, '/')}`,
    DOCEDIT_MAX_PAGES: '200',
    max_print_line: '1048576',
  };
  let ok = true;
  for (let pass = 0; pass < 2 && ok; pass++) {
    ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        LUALATEX,
        [
          '--interaction=nonstopmode',
          '--halt-on-error',
          '--no-shell-escape',
          '--file-line-error',
          'main.tex',
        ],
        { cwd: dir, env, windowsHide: true, stdio: 'ignore' },
      );
      const timer = setTimeout(() => child.kill(), 300_000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }
  const pdfPath = join(dir, 'main.pdf');
  const layoutPath = join(dir, 'main.layout');
  const logPath = join(dir, 'main.log');
  return {
    ok: ok && existsSync(pdfPath),
    pdf: existsSync(pdfPath) ? new Uint8Array(readFileSync(pdfPath)) : null,
    log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
    layout: existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : null,
    dir,
  };
}
