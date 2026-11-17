/**
 * The `tex` target (09 §11; EXP-085): the bundle as one archive, so the source of an export can be
 * kept with the PDF or compiled outside the service. The archive is a POSIX tar (ustar) of the
 * bundle's files and assets, with a README that lists the fonts by hash and licence (fonts are not
 * in the bundle, 09 §2), says how to obtain them, gives the compile command, and asks for the same
 * restrictions the service uses (09 §9.3 item 7). No auxiliary file or log is included: the bundle
 * holds none. Pure and universal: bytes in, bytes out.
 */
import { utf8 } from '@docedit/model';
import type { Bundle } from './bundle.ts';
import { archiveLicenceManifest, CLASS_LICENCE_TEXT } from './licences.ts';

/** The licence of the house class: the project's licence, chosen by the owner (SPK-007). */
export const CLASS_LICENCE = 'Apache-2.0';

export function archiveReadme(bundle: Bundle): string {
  const m = bundle.manifest;
  const fonts = m.fonts
    .flatMap((f) => f.files.map((x) => `  ${x.file}  ${f.family} (${f.role}), ${f.licence}`))
    .join('\n');
  return [
    'LaTeX source of a document exported by the document editor',
    '',
    `Bundle hash (SHA-256): ${m.bundleHash}`,
    `Document version (seq): ${m.seq ?? 'not given'}; history chain head: ${m.chainHead ?? 'not given'}`,
    `CDM version ${m.cdm}; house class docedit ${m.classVersion}, licensed under ${CLASS_LICENCE}.`,
    '',
    'Compile it with the same restrictions the export service uses (09 §9.3):',
    '  - LuaLaTeX from TeX Live 2026, LuaTeX 1.17 or later;',
    '  - no shell escape (shell_escape=f), no network, paranoid file access',
    '    (openin_any=p, openout_any=p);',
    '  - in an empty directory that holds only these files.',
    '',
    'Fonts are not part of the archive. Put these files, named by their SHA-256, in one directory',
    'and set DOCEDIT_FONT_PATH to it, with a final slash. The files are the fonts of TeX Live with',
    'these names, renamed; check each SHA-256 before use:',
    fonts,
    '',
    'Command (the converged result needs two to four passes; run until main.aux stops changing):',
    '  DOCEDIT_FONT_PATH=/path/to/fonts/ SOURCE_DATE_EPOCH=0 FORCE_SOURCE_DATE=1 \\',
    '    lualatex --no-shell-escape --interaction=nonstopmode --halt-on-error main.tex',
    '',
    'Licences. The class and Lua files (docedit.cls, docedit.lua) are licensed under Apache-2.0,',
    'copyright 2026 the project authors; the licence text is LICENCE.txt. licences.json is the',
    'licence manifest of the TeX Live packages the class relies on: each package it loads by name,',
    'and the ones tagging and font loading bring in, with the licence the TeX Catalogue records.',
    'The packages those load in turn are in the licence manifest of the export worker image.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// ustar

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number): void => {
    const b = utf8(s);
    h.set(b.subarray(0, Math.min(b.length, 512 - at)), at);
  };
  if (utf8(name).length > 100) throw new RangeError(`archive member name too long: ${name}`);
  put(name, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(0, 12), 136); // a fixed time keeps the archive reproducible (09 §9.4)
  put('        ', 148);
  put('0', 156);
  put('ustar\u000000', 257);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + ' ', 148);
  return h;
}

/** A tar of named files, in name order, with fixed metadata, so the same bundle gives the same bytes. */
export function tar(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const names = [...files.keys()].sort();
  let size = 1024;
  for (const n of names) size += 512 + Math.ceil(files.get(n)!.length / 512) * 512;
  const out = new Uint8Array(size);
  let at = 0;
  for (const n of names) {
    const data = files.get(n)!;
    out.set(header(n, data.length), at);
    at += 512;
    out.set(data, at);
    at += Math.ceil(data.length / 512) * 512;
  }
  return out;
}

/** The `tex` archive of a bundle. */
export function texArchive(bundle: Bundle): Uint8Array {
  const files = new Map<string, Uint8Array>();
  for (const [name, text] of Object.entries(bundle.files)) files.set(name, utf8(text));
  for (const [name, bytes] of Object.entries(bundle.assets)) files.set(name, bytes);
  files.set('README.txt', utf8(archiveReadme(bundle)));
  files.set('LICENCE.txt', utf8(CLASS_LICENCE_TEXT));
  files.set('licences.json', utf8(archiveLicenceManifest(CLASS_LICENCE)));
  return tar(files);
}
