/**
 * Workers compile only bundles the converter wrote (09 §9.3 item 1; EXP-067).
 *
 * Two checks run before the engine starts:
 *
 * - **Provenance.** Right after the converter returns, the worker seals the bundle: an HMAC-SHA256,
 *   under a key that never leaves the worker process, of the job's identifier and the bundle hash.
 *   The compile step refuses a bundle whose seal does not verify, so a bundle that did not come out
 *   of the converter for this job, for example one carried by a job's payload, never reaches the
 *   engine. 09 leaves open how a worker knows a bundle came from the converter; this is the answer
 *   ADR 0045 proposes.
 * - **Content.** The bundle holds exactly the converter's files; every file has the SHA-256 that
 *   `manifest.json` lists and the bundle hash is right; the class files are byte for byte the pinned
 *   ones of `@docedit/export-latex/class/` and the class version is the pinned version; and neither
 *   `main.tex` nor `styles.tex` loads a package or a class, inputs a file other than `styles.tex`,
 *   runs Lua or changes category codes. The converter writes user text only through its emitters,
 *   which escape every backslash, so these commands can only come from someone other than the
 *   converter.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { bundleHashInput, canonicalJson, type Diagnostic } from '@docedit/export-latex';
import { diagnostic } from './diagnostics.ts';

/** The files of a bundle (09 §2; the house class has a Lua half, S4 §8). Assets come with EXP-028. */
export const BUNDLE_FILES: readonly string[] = [
  'docedit.cls',
  'docedit.lua',
  'main.tex',
  'manifest.json',
  'map.json',
  'styles.tex',
];

export interface Pinned {
  /** The class files the worker trusts, by name. */
  classFiles: Readonly<Record<string, string>>;
  classVersion: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Commands no converter output contains (in main.tex and styles.tex). */
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [
    /\\(usepackage|RequirePackage|RequirePackageWithOptions|LoadClass|LoadClassWithOptions)\b/,
    'loads a package or a class',
  ],
  [/\\(directlua|latelua|luaexec|luadirect|luacode)\b/, 'runs Lua'],
  [/\\(catcode|endlinechar|scantokens|csname)\b/, 'changes how TeX reads'],
  [/\\(openin|openout|immediate|write18|special)\b/, 'opens files or writes out'],
  [/\\(include|InputIfFileExists|IfFileExists)\b/, 'inputs a file'],
];

/** An asset of a bundle: named by the SHA-256 of its bytes (09 §2), one of the types of 06 §4.4. */
const ASSET = /^assets\/([0-9a-f]{64})\.(png|jpg|jpeg|pdf)$/;

const sha256Bytes = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * The problems of a bundle; empty when it may be compiled. `files` are its text files, `assets`
 * its binary files (`assets/<sha256>.<ext>`).
 */
export function verifyBundle(
  files: Readonly<Record<string, string>>,
  pinned: Pinned,
  assets: Readonly<Record<string, Uint8Array>> = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const refuse = (why: string) => out.push(diagnostic('bundle_refused', null, why));
  const names = Object.keys(files).sort();
  for (const n of names)
    if (!BUNDLE_FILES.includes(n)) refuse(`It holds a file the converter never writes: ${n}`);
  for (const n of BUNDLE_FILES) if (!(n in files)) refuse(`It lacks ${n}.`);
  for (const [n, bytes] of Object.entries(assets)) {
    const m = ASSET.exec(n);
    if (!m) refuse(`It holds a file the converter never writes: ${n}`);
    else if (sha256Bytes(bytes) !== m[1]) refuse(`The asset ${n} is not the file its name names.`);
  }
  if (out.length) return out;

  let manifest: {
    bundleVersion?: unknown;
    classVersion?: unknown;
    files?: Record<string, unknown>;
    bundleHash?: unknown;
    options?: unknown;
  };
  try {
    manifest = JSON.parse(files['manifest.json']!) as typeof manifest;
  } catch {
    refuse('Its manifest is not JSON.');
    return out;
  }
  if (manifest.bundleVersion !== 1) refuse('Its manifest has another bundle version.');
  if (manifest.classVersion !== pinned.classVersion)
    refuse(
      `It names class version ${String(manifest.classVersion).slice(0, 40)}, not the pinned one.`,
    );
  const listed = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  const hashes: Record<string, string> = {};
  for (const n of names) {
    if (n === 'manifest.json') continue;
    hashes[n] = sha256(files[n]!);
    if (listed[n] !== hashes[n]) refuse(`The hash of ${n} is not the one its manifest lists.`);
  }
  for (const [n, bytes] of Object.entries(assets)) {
    hashes[n] = sha256Bytes(bytes);
    if (listed[n] !== hashes[n]) refuse(`The hash of ${n} is not the one its manifest lists.`);
  }
  for (const n of Object.keys(listed))
    if (!(n in hashes)) refuse(`Its manifest lists a file it does not hold.`);
  // The options join the hash (EXP-005 criterion 6), as the converter computes it.
  const bundleHash = sha256(bundleHashInput(hashes, sha256(canonicalJson(manifest.options))));
  if (manifest.bundleHash !== bundleHash) refuse('Its bundle hash is wrong.');
  for (const [n, content] of Object.entries(pinned.classFiles))
    if (sha256(files[n] ?? '') !== sha256(content))
      refuse(`Its ${n} is not the pinned class file.`);

  for (const n of ['main.tex', 'styles.tex']) {
    const text = files[n]!;
    for (const [re, what] of FORBIDDEN) if (re.test(text)) refuse(`Its ${n} ${what}.`);
    for (const m of text.matchAll(/\\input\s*\{([^}]*)\}/g))
      if (n !== 'main.tex' || m[1] !== 'styles.tex') refuse(`Its ${n} inputs a file.`);
  }
  const classes = [...files['main.tex']!.matchAll(/\\documentclass(\[[^\]]*\])?\{([^}]*)\}/g)];
  if (classes.length !== 1 || classes[0]![2] !== 'docedit')
    refuse('Its main.tex does not load the house class exactly once.');
  if (/\\documentclass/.test(files['styles.tex']!)) refuse('Its styles.tex loads a class.');
  return out;
}

/** The seal of a bundle for one job (provenance; EXP-067 criterion 4). */
export function sealBundle(key: Uint8Array, job: string, bundleHash: string): string {
  return createHmac('sha256', key).update(`docedit-bundle\n${job}\n${bundleHash}`).digest('hex');
}

/** Whether `seal` is the seal of this job and bundle hash. */
export function checkSeal(key: Uint8Array, job: string, bundleHash: string, seal: string): boolean {
  const want = Buffer.from(sealBundle(key, job, bundleHash), 'hex');
  const got = /^[0-9a-f]{64}$/.test(seal) ? Buffer.from(seal, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(want, got) && /^[0-9a-f]{64}$/.test(seal);
}

/** The bundle hash its manifest records (after verifyBundle, it is the true one). */
export function bundleHashOf(files: Readonly<Record<string, string>>): string {
  try {
    const h = (JSON.parse(files['manifest.json'] ?? '{}') as { bundleHash?: unknown }).bundleHash;
    return typeof h === 'string' ? h : '';
  } catch {
    return '';
  }
}
