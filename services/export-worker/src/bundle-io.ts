/**
 * Builds a bundle from a CDM document on the worker side (spike S4): reads the house class from
 * `@docedit/export-latex/class/` and the font manifest, then calls the pure converter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLASS_FILES,
  convert,
  type Bundle,
  type ConvertOptions,
  type FontManifest,
} from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';

export function classFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CLASS_FILES) {
    const url = import.meta.resolve(`@docedit/export-latex/class/${name}`);
    out[name] = readFileSync(fileURLToPath(url), 'utf8');
  }
  return out;
}

export function readFontManifest(path: string): FontManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as FontManifest;
}

export type BuildOptions = Omit<ConvertOptions, 'classFiles' | 'fonts'> & { fonts: FontManifest };

/**
 * `files`: the class files to write into the bundle. The export handler passes the files it pinned
 * when it started, so the bundle it verifies against them is built from the same bytes even when
 * the class on disk changes between the two reads. Without it the class is read from disk now.
 */
export function buildBundle(
  envelope: CdmEnvelope,
  options: BuildOptions,
  files: Readonly<Record<string, string>> = classFiles(),
): Promise<Bundle> {
  return convert(envelope, { ...options, classFiles: files });
}

/** The files that go into the sandbox: everything the converter wrote. */
export function compileFiles(bundle: Bundle): Record<string, string> {
  return { ...bundle.files };
}
