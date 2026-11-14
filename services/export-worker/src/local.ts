/**
 * Local compiles without a sandbox, for the measurement's comparison only (spike S4). The engine
 * settings match the image: no shell escape, paranoid file access, fonts by path and hash. A local
 * compile is never a production path.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LIMITS, LOG_LINE_UNWRAPPED, type CompileResult, type Pass } from './sandbox.ts';

export interface LocalOptions {
  /** Directory under which a fresh job directory is made (and removed unless `keep`). */
  workRoot: string;
  /** The hash-named font directory (services/export-worker/image/fonts.lua). */
  fontPath: string;
  minPasses?: number;
  maxPasses?: number;
  passTimeoutSeconds?: number;
  sourceDateEpoch?: number;
  keep?: boolean;
}

function auxHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of ['main.aux', 'main.toc', 'main.out']) {
    const p = join(dir, f);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest('hex');
}

function lualatex(
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      'lualatex',
      [
        '--interaction=nonstopmode',
        '--halt-on-error',
        '--no-shell-escape',
        '--file-line-error',
        'main.tex',
      ],
      { cwd, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut });
    });
  });
}

export async function compileLocally(
  files: Readonly<Record<string, string | Uint8Array>>,
  opts: LocalOptions,
): Promise<CompileResult> {
  const dir = join(opts.workRoot, `job-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (!/^(assets\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name))
      throw new RangeError(`refused name ${name}`);
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    shell_escape: 'f',
    // Paranoid reading breaks luaotfload on Windows: kpse.find_file returns nil for files in the
    // TeX tree (absolute drive paths), so luaotfload-multiscript fails. The image uses `p`.
    openin_any: process.platform === 'win32' ? 'a' : 'p',
    openout_any: 'p',
    DOCEDIT_FONT_PATH: opts.fontPath.replace(/\\/g, '/').replace(/\/?$/, '/'),
    SOURCE_DATE_EPOCH: String(opts.sourceDateEpoch ?? 1_788_000_000),
    FORCE_SOURCE_DATE: '1',
    max_print_line: String(LOG_LINE_UNWRAPPED),
  };
  const min = opts.minPasses ?? 2;
  const max = opts.maxPasses ?? 4;
  const passes: Pass[] = [];
  let converged = false;
  let prev = '';
  let exitCode: number | null = 0;
  let timedOut = false;
  const started = performance.now();
  for (let pass = 1; pass <= max; pass++) {
    const t0 = performance.now();
    const res = await lualatex(dir, env, (opts.passTimeoutSeconds ?? 110) * 1000);
    passes.push({ pass, rc: res.code ?? -1, ms: Math.round(performance.now() - t0) });
    if (res.code !== 0) {
      exitCode = res.code;
      timedOut = res.timedOut;
      break;
    }
    const cur = auxHash(dir);
    if (pass >= min && cur === prev) {
      converged = true;
      break;
    }
    prev = cur;
  }
  const read = (n: string): Uint8Array | null =>
    existsSync(join(dir, n)) ? new Uint8Array(readFileSync(join(dir, n))) : null;
  const pdf = read('main.pdf');
  const layout = read('main.layout');
  const result: CompileResult = {
    ok: exitCode === 0 && pdf !== null,
    exitCode,
    timedOut,
    outputOverflow: false,
    cancelled: false,
    name: dir,
    limits: { ...LIMITS },
    passTimeoutSeconds: opts.passTimeoutSeconds ?? 110,
    passes,
    converged,
    pdf,
    log: new TextDecoder().decode(read('main.log') ?? new Uint8Array()),
    layoutRaw: layout ? new TextDecoder().decode(layout) : null,
    stderr: '',
    wallMs: performance.now() - started,
    stdout: new Uint8Array(),
  };
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  return result;
}
