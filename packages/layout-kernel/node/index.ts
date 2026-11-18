/**
 * The layout kernel in Node.js (WASM-010; 02 §9.1, §14). The same WebAssembly file that the
 * browsers load starts here from its bytes, with no browser and no worker, so that the layout
 * engine's unit tests and the golden outputs of WASM-011 run against one artefact.
 *
 * Node.js only: this file reads the build in `dist/` and the manifest's font files by path. The
 * universal part of the package is `src/`; this folder is reached as `@docedit/layout-kernel/node`.
 *
 * Fonts arrive as the manifest says: a file name relative to the manifest's folder and the
 * SHA-256 of its bytes. The alias is `de-font-<sha256>`, as in the editor (02 §6). A file whose
 * bytes do not hash to the manifest's value is refused here, before the kernel sees it, with the
 * path in the message; the kernel checks the hash a second time (`hash_mismatch`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KERNEL_FILES, createKernel, type KernelGlue, type LayoutKernel } from '../src/index.ts';

/** The build of the kernel: `pnpm --filter @docedit/layout-kernel build:wasm` writes it. */
export const KERNEL_DIST = resolve(import.meta.dirname, '../dist');

/** True when `dist/` holds a build (a clone that has not run `build:wasm` has none). */
export function kernelIsBuilt(dist: string = KERNEL_DIST): boolean {
  return (
    existsSync(resolve(dist, KERNEL_FILES.wasm)) && existsSync(resolve(dist, KERNEL_FILES.module))
  );
}

/** The WebAssembly file's bytes, exactly as a browser would fetch them. */
export function readKernelWasm(dist: string = KERNEL_DIST): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm)));
}

/**
 * Starts a kernel from the build. Each call imports a fresh copy of the generated module, so the
 * kernels of two calls share nothing (the glue keeps its instance in module scope).
 */
export async function loadNodeKernel(dist: string = KERNEL_DIST): Promise<LayoutKernel> {
  if (!kernelIsBuilt(dist))
    throw new Error(`the layout kernel is not built in ${dist}: run build:wasm first`);
  const href = `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?instance=${nextInstance++}`;
  const glue = (await import(href)) as KernelGlue;
  return createKernel(glue, readKernelWasm(dist));
}
let nextInstance = 0;

/** One face of a font manifest, as far as the kernel needs it. */
export interface ManifestFace {
  /** Path of the font file, relative to the manifest's folder. */
  readonly file: string;
  /** The SHA-256 of the file's bytes, lowercase hexadecimal. */
  readonly sha256: string;
}

/** The alias the editor gives a face of the manifest. */
export const faceAlias = (face: Pick<ManifestFace, 'sha256'>): string => `de-font-${face.sha256}`;

/** The SHA-256 of bytes as lowercase hexadecimal. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What `loadManifestFaces` did. */
export interface LoadedFaces {
  /** Aliases of the faces now held, in manifest order. */
  readonly aliases: string[];
  /** How many of them were new to the kernel. */
  readonly added: number;
}

/**
 * Loads the faces of a manifest into a kernel, by path and hash: each file is read from `folder`,
 * hashed, compared with the manifest's value and handed to the kernel under its alias. Throws on
 * the first file that is missing or differs.
 */
export function loadManifestFaces(
  kernel: LayoutKernel,
  faces: readonly ManifestFace[],
  folder: string,
  owner = '',
): LoadedFaces {
  const aliases: string[] = [];
  let added = 0;
  for (const face of faces) {
    const path = resolve(folder, face.file);
    const bytes = new Uint8Array(readFileSync(path));
    const actual = sha256Hex(bytes);
    if (actual !== face.sha256)
      throw new Error(`${path} hashes to ${actual}, the manifest says ${face.sha256}`);
    const alias = faceAlias(face);
    if (kernel.faces.load(owner, alias, face.sha256, bytes) === 'new') added++;
    aliases.push(alias);
  }
  return { aliases, added };
}
