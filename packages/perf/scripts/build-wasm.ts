/**
 * Builds the Rust text kernel (wasm/text-kernel) for `wasm32-unknown-unknown` and copies two
 * variants into wasm/bin/: `text-kernel.wasm` (shaping, segmentation, line breaking and
 * hyphenation; S10) and `harfrust-shaper.wasm` (the shaper alone; S5). It records the build time,
 * the sizes (raw, gzip level 9, Brotli quality 11) and SHA-256 of each in wasm/bin/build.json, and
 * checks the crates' licences (scripts/cargo-licences.ts).
 *
 * Needs Rust 1.85 or later with the `wasm32-unknown-unknown` target. Cargo's target directory is
 * kept outside the repository (DOCEDIT_CARGO_TARGET, default `<tmp>/docedit-perf-cargo`), so that
 * Prettier and ESLint never see it. Build scripts and procedural macros of the dependencies are
 * compiled for the host, which on Windows needs the MSVC linker: when `link.exe` is not on the
 * path, DOCEDIT_MSVC_BIN names its directory and DOCEDIT_MSVC_LIB the library path (LIB).
 *
 * Usage: node scripts/build-wasm.ts   (from packages/perf)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { checkCargoLicences } from './cargo-licences.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const crate = join(pkg, 'wasm/text-kernel');
const bin = join(pkg, 'wasm/bin');
const target = process.env['DOCEDIT_CARGO_TARGET'] ?? join(tmpdir(), 'docedit-perf-cargo');

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: target };
  const msvcBin = process.env['DOCEDIT_MSVC_BIN'];
  if (msvcBin) e['PATH'] = `${msvcBin}${delimiter}${process.env['PATH'] ?? ''}`;
  const msvcLib = process.env['DOCEDIT_MSVC_LIB'];
  if (msvcLib) e['LIB'] = msvcLib;
  return e;
}

function cargo(args: string[]): void {
  const r = spawnSync('cargo', args, { cwd: crate, env: env(), stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error(`cargo ${args.join(' ')} failed with ${r.status}`);
}

export interface WasmBuild {
  file: string;
  features: string;
  bytes: number;
  gzip9: number;
  brotli11: number;
  sha256: string;
  buildSeconds: number;
}

function sizes(file: string): Omit<WasmBuild, 'file' | 'features' | 'buildSeconds'> {
  const b = readFileSync(file);
  return {
    bytes: b.length,
    gzip9: gzipSync(b, { level: 9 }).length,
    brotli11: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    sha256: createHash('sha256').update(b).digest('hex'),
  };
}

function main(): void {
  mkdirSync(bin, { recursive: true });
  const variants = [
    { name: 'text-kernel.wasm', args: [], features: 'kernel (default)' },
    {
      name: 'harfrust-shaper.wasm',
      args: ['--no-default-features'],
      features: 'none (shaper only)',
    },
  ];
  const builds: WasmBuild[] = [];
  for (const v of variants) {
    const started = performance.now();
    cargo(['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', ...v.args]);
    const buildSeconds = Math.round((performance.now() - started) / 100) / 10;
    const out = join(target, 'wasm32-unknown-unknown/release/docedit_text_kernel.wasm');
    copyFileSync(out, join(bin, v.name));
    builds.push({ file: v.name, features: v.features, ...sizes(join(bin, v.name)), buildSeconds });
  }
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const licences = checkCargoLicences(crate, env());
  writeFileSync(
    join(bin, 'build.json'),
    `${JSON.stringify({ rustc, target: 'wasm32-unknown-unknown', profile: 'release (opt-level 3, LTO, one codegen unit, panic abort, stripped; no wasm-opt)', builds, licences }, null, 2)}\n`,
  );
  for (const b of builds)
    console.log(
      `${b.file}: ${b.bytes} bytes, gzip ${b.gzip9}, brotli ${b.brotli11}, ${b.buildSeconds} s`,
    );
  if (licences.problems.length) {
    for (const p of licences.problems) console.error(`licence: ${p}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
