/**
 * Builds the font manifest of the harness (S5, S10; 02 §6): copies the font files the
 * measurements use into `fonts/files/`, their licences into `fonts/licences/`, and writes
 * `fonts/manifest.json` with each file's family, style, version, licence and SHA-256.
 *
 * Only fonts whose `name` table states a licence the policy allows for fonts (`licences/policy.json`,
 * `allow` or `fontsOnly`) are accepted; the script fails otherwise. The sources are fonts already on
 * the development machine: the TeX Live 2025 installation (Noto, Harano Aji) and one font installed
 * in Windows (NanumGothic). Another machine passes its own paths with DOCEDIT_TEXLIVE and
 * DOCEDIT_WINDOWS_FONTS; the manifest's hashes then show whether the files are the same.
 *
 * Usage: node scripts/fonts.ts   (from packages/perf)
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, type Policy } from '../../../scripts/licence-policy.ts';
import type { FontManifest, FontManifestEntry, FontRole } from '../src/fonts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const root = resolve(pkg, '../..');
const texlive = process.env['DOCEDIT_TEXLIVE'] ?? 'E:/texlive/2025';
const winFonts = process.env['DOCEDIT_WINDOWS_FONTS'] ?? 'C:/Windows/Fonts';
const noto = `${texlive}/texmf-dist/fonts/truetype/google/noto`;
const notoLicence = `${texlive}/texmf-dist/doc/fonts/noto/LICENSE_OFL.txt`;
const harano = `${texlive}/texmf-dist/fonts/opentype/public/haranoaji`;
const haranoLicence = `${texlive}/texmf-dist/doc/fonts/haranoaji/LICENSE`;

interface Source {
  path: string;
  alias: string;
  weight: 400 | 700;
  style: 'normal' | 'italic';
  role: FontRole;
  origin: string;
  /** A licence file shipped with the font; null when the text is built from the name table. */
  licenceFile: string | null;
}

const texliveOrigin = 'TeX Live 2025 (texmf-dist)';
const sources: Source[] = [
  ...(
    [
      ['NotoSerif-Regular.ttf', 'Noto Serif', 400, 'normal'],
      ['NotoSerif-Bold.ttf', 'Noto Serif', 700, 'normal'],
      ['NotoSerif-Italic.ttf', 'Noto Serif', 400, 'italic'],
      ['NotoSerif-BoldItalic.ttf', 'Noto Serif', 700, 'italic'],
      ['NotoSans-Regular.ttf', 'Noto Sans', 400, 'normal'],
      ['NotoSans-Bold.ttf', 'Noto Sans', 700, 'normal'],
      ['NotoSans-Italic.ttf', 'Noto Sans', 400, 'italic'],
      ['NotoSans-BoldItalic.ttf', 'Noto Sans', 700, 'italic'],
      ['NotoSansMono-Regular.ttf', 'Noto Sans Mono', 400, 'normal'],
      ['NotoSansMono-Bold.ttf', 'Noto Sans Mono', 700, 'normal'],
    ] as const
  ).map(([file, alias, weight, style]): Source => ({
    path: `${noto}/${file}`,
    alias,
    weight,
    style,
    role: 'latin',
    origin: texliveOrigin,
    licenceFile: notoLicence,
  })),
  {
    path: `${harano}/HaranoAjiGothic-Regular.otf`,
    alias: 'Harano Aji Gothic',
    weight: 400,
    style: 'normal',
    role: 'cjk',
    origin: texliveOrigin,
    licenceFile: haranoLicence,
  },
  // No Hangul face: the only one on the development machine, NanumGothic 3.020 in Windows' fonts,
  // names "NHN Corporation" as its licence (name ID 13), not the OFL, so its redistribution in
  // tests is not established. Korean text is left out of the measurements (S5 report).
];

/** Fonts that were considered and refused, with the reason (kept for the report). */
export const refused = [
  {
    path: `${winFonts}/NanumGothic-Regular.ttf`,
    reason: 'name ID 13 is "NHN Corporation" (version 3.020), not a licence the policy allows',
  },
];

/** Reads the `name` table records of an sfnt file (TrueType or CFF OpenType). */
export function readNames(bytes: Uint8Array): Map<number, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4));
    if (tag === 'name') nameOffset = view.getUint32(rec + 8);
  }
  if (nameOffset < 0) throw new Error('no name table');
  const count = view.getUint16(nameOffset + 2);
  const storage = nameOffset + view.getUint16(nameOffset + 4);
  const windows = new Map<number, string>();
  const mac = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    const platform = view.getUint16(r);
    const encoding = view.getUint16(r + 2);
    const language = view.getUint16(r + 4);
    const id = view.getUint16(r + 6);
    const length = view.getUint16(r + 8);
    const offset = storage + view.getUint16(r + 10);
    if (platform === 3 && encoding === 1 && language === 0x409 && !windows.has(id)) {
      let s = '';
      for (let j = 0; j < length; j += 2) s += String.fromCharCode(view.getUint16(offset + j));
      windows.set(id, s);
    } else if (platform === 1 && encoding === 0 && language === 0 && !mac.has(id)) {
      mac.set(id, String.fromCharCode(...bytes.subarray(offset, offset + length)));
    }
  }
  for (const [id, s] of mac) if (!windows.has(id)) windows.set(id, s);
  return windows;
}

/** The SPDX identifier of the licence a font's name table describes, or null. */
export function spdxFromNames(names: Map<number, string>): string | null {
  const text = `${names.get(13) ?? ''} ${names.get(14) ?? ''}`;
  if (
    /Open Font License,?\s*Version 1\.1/i.test(text) ||
    /openfontlicense\.org|scripts\.sil\.org\/OFL/i.test(text)
  )
    return 'OFL-1.1';
  return null;
}

const OFL_BODY_START = 'This Font Software is licensed under the SIL Open Font License';

function main(): void {
  const policy = JSON.parse(readFileSync(join(root, 'licences/policy.json'), 'utf8')) as Policy;
  const filesDir = join(pkg, 'fonts/files');
  const licDir = join(pkg, 'fonts/licences');
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(licDir, { recursive: true });
  const notoText = readFileSync(notoLicence, 'utf8');
  const oflBody = notoText.slice(notoText.indexOf(OFL_BODY_START));
  const entries: FontManifestEntry[] = [];
  for (const s of sources) {
    const bytes = new Uint8Array(readFileSync(s.path));
    const names = readNames(bytes);
    const spdx = spdxFromNames(names);
    if (!spdx) throw new Error(`${s.path}: the name table states no licence the script recognises`);
    const verdict = evaluate(spdx, policy, 'font');
    if (!verdict.ok) throw new Error(`${s.path}: ${verdict.reason}`);
    const file = basename(s.path);
    copyFileSync(s.path, join(filesDir, file));
    const licenceName = s.licenceFile
      ? `${basename(dirname(s.licenceFile))}-${basename(s.licenceFile).replace(/\.txt$/i, '')}.txt`
      : `${file.replace(/\.[^.]+$/, '')}-OFL.txt`;
    if (s.licenceFile) copyFileSync(s.licenceFile, join(licDir, licenceName));
    else
      writeFileSync(
        join(licDir, licenceName),
        `${names.get(0) ?? ''}\n\nThe licence text below is the one the font's name table names (name ID 13: "${names.get(13) ?? ''}").\n\n${oflBody}`,
      );
    entries.push({
      file: `files/${file}`,
      alias: s.alias,
      family: names.get(16) ?? names.get(1) ?? '',
      subfamily: names.get(17) ?? names.get(2) ?? '',
      weight: s.weight,
      style: s.style,
      role: s.role,
      version: names.get(5) ?? '',
      copyright: names.get(0) ?? '',
      licence: spdx,
      licenceFile: `licences/${licenceName}`,
      origin: s.origin,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const manifest: FontManifest = {
    $comment:
      'Font files of the performance harness (S5, S10). Generated by scripts/fonts.ts; every licence is allowed for fonts by licences/policy.json. The files are unmodified copies.',
    fonts: entries,
  };
  writeFileSync(join(pkg, 'fonts/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const e of entries)
    console.log(`${e.file}  ${e.version}  ${e.licence}  ${e.sha256.slice(0, 12)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
