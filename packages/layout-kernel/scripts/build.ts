/**
 * Builds and tests the layout kernel (WASM-001). One documented command:
 *
 *   pnpm --filter @docedit/layout-kernel build:wasm
 *
 * compiles `crates/layout-kernel` to `wasm32-unknown-unknown`, passes it through wasm-bindgen and
 * wasm-opt, and writes the ES module, the WebAssembly file, the typings and `build.json` to `dist/`.
 *
 * Modes (`node scripts/build.ts <mode>`):
 *   build   the pipeline of `crates/build.sh build`, into `dist/`
 *   test    the crate's native tests, formatting, clippy and the check for system libraries
 *   verify  two builds from scratch, and a comparison of the WebAssembly files byte for byte
 *
 * The toolchain is pinned in `crates/rust-toolchain.toml`, in `crates/Containerfile` (Rust 1.89.0,
 * wasm-bindgen-cli 0.2.130, binaryen version_133) and in `crates/Cargo.lock`. By default the steps
 * run in the builder image under Podman, so that a machine needs neither Rust nor a C linker; the
 * image is built on first use. `DOCEDIT_CONTAINER_CLI` names another container CLI (default
 * `podman`). `DOCEDIT_KERNEL_NATIVE=1` runs `crates/build.sh` on this machine instead, for one that
 * has the pinned tools. `DOCEDIT_KERNEL_IMAGE` and `DOCEDIT_KERNEL_CARGO_VOLUME` rename the image
 * and the volume that caches the downloaded crates.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const crates = resolve(pkg, '../../crates');
const cli = process.env['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
const image = process.env['DOCEDIT_KERNEL_IMAGE'] ?? 'docedit-kernel-builder';
const cargoVolume = process.env['DOCEDIT_KERNEL_CARGO_VOLUME'] ?? 'docedit-kernel-cargo';
const native = process.env['DOCEDIT_KERNEL_NATIVE'] === '1';

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const r = spawnSync(command, args, { stdio: 'inherit', env: env ?? process.env });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${r.status}`);
}

/** Builds the builder image when this machine has none of that name. */
function ensureImage(): void {
  const have = spawnSync(cli, ['image', 'exists', image], { stdio: 'ignore' });
  if (have.status === 0) return;
  run(cli, ['build', '-f', join(crates, 'Containerfile'), '-t', image, crates]);
}

/** Runs `crates/build.sh <args>`, in the builder image or natively. */
function buildScript(args: string[], outDir?: string): void {
  if (native) {
    run('sh', [join(crates, 'build.sh'), ...args]);
    return;
  }
  ensureImage();
  const mounts = ['-v', `${crates}:/work/crates`, '-v', `${cargoVolume}:/usr/local/cargo/registry`];
  if (outDir) mounts.push('-v', `${outDir}:/out`);
  // `--pids-limit=0`: the Podman machine of some hosts has no `pids` cgroup controller.
  run(cli, ['run', '--rm', '--pids-limit=0', ...mounts, image, ...args]);
}

/**
 * Builds into `<dir>/dist`. In the container `dir` is mounted at /out, so the script writes
 * `/out/dist`; natively it writes `<dir>/dist` directly.
 */
function build(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'dist');
  rmSync(out, { recursive: true, force: true });
  if (native) buildScript(['build', out]);
  else buildScript(['build', '/out/dist'], dir);
  return out;
}

/** The SHA-256 of the WebAssembly file in a build folder. */
function wasmHash(dist: string): string {
  const file = join(dist, 'docedit_layout_kernel_bg.wasm');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const mode = process.argv[2] ?? 'build';
if (mode === 'build') {
  console.log(`built ${build(pkg)}`);
} else if (mode === 'test') {
  buildScript(['test']);
} else if (mode === 'verify') {
  const base = join(tmpdir(), `docedit-kernel-verify-${process.pid}`);
  const a = join(base, 'a');
  const b = join(base, 'b');
  const ha = wasmHash(build(a));
  const hb = wasmHash(build(b));
  console.log(`first  build ${ha}\nsecond build ${hb}`);
  rmSync(base, { recursive: true, force: true });
  if (ha !== hb) throw new Error('two builds of the same commit gave different WebAssembly files');
  console.log('the two WebAssembly files are byte-identical');
} else {
  throw new Error(`unknown mode ${mode}: use build, test or verify`);
}
