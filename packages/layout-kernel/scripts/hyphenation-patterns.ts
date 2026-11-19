/**
 * Copies the TeX hyphenation patterns the kernel can load (WASM-009) from the hyph-utf8 package of a
 * TeX Live installation into `patterns/`, with the notice of each file and a manifest.
 *
 *   node scripts/hyphenation-patterns.ts <.../tex/generic/hyph-utf8/patterns>
 *
 * Only languages whose patterns are permissively licensed are bundled (borrow list, section 11):
 * the licence is read from the file's own header and checked against the one this table claims, so
 * a file that changes its licence in a later hyph-utf8 release fails here instead of shipping.
 * Languages whose files are copyleft (Slovak: GPL-2.0-or-later; Hungarian: MPL-1.1, GPL-2.0 or
 * LGPL-2.1) are listed in `REFUSED` and are never copied. Files under LPPL only (Dutch, Russian,
 * Swedish and others) wait for counsel (borrow list, section 11) and are not in the table.
 *
 * Each language gives three files: `hyph-<tag>.pat.txt` (the patterns, byte for byte),
 * `hyph-<tag>.hyp.txt` (the exceptions, byte for byte, where hyph-utf8 has them) and
 * `hyph-<tag>.notice.txt` (the header of the TeX source: copyright, licence and its text, which the
 * licences ask us to keep next to the patterns). `patterns/manifest.json` lists them with their
 * SHA-256, the licence, and the hyphen minimums (the house class's, and the file's own header's).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the table claims about a language's licence, as SPDX where one exists. */
export interface Choice {
  readonly tag: string;
  /** The hyph-utf8 name: `hyph-<source>`. */
  readonly source: string;
  /** Other tags that stand for it (BCP 47, lowercase). */
  readonly aliases: readonly string[];
  /** The licence the kernel takes the file under. */
  readonly licence: string;
  /** A regular expression the file's header must match, for that licence. */
  readonly header: RegExp;
  /** When the file offers several licences, the one taken. */
  readonly choice?: string;
  /**
   * The minimum characters before and after a hyphen that the house class gets: babel's setting
   * for the language when the class loads it through its ini file. It is not always the file's own
   * (French: the file says 2 and 2, babel sets 2 and 3). `test/hyphenation-reference.json` records
   * what LuaLaTeX sets, and the kernel's tests compare these numbers with it.
   */
  readonly left: number;
  readonly right: number;
}

export const BUNDLED: readonly Choice[] = [
  {
    tag: 'en-us',
    source: 'en-us',
    aliases: ['en'],
    licence: 'LicenseRef-hyph-utf8-notice-preserved',
    header:
      /Copying and distribution of this file, with or without modification,\s*%\s*are permitted in any medium without royalty provided the copyright\s*%\s*notice and this notice are preserved/,
    left: 2,
    right: 3,
  },
  {
    tag: 'en-gb',
    source: 'en-gb',
    aliases: [],
    licence: 'MIT',
    header: /name:\s*MIT/,
    left: 2,
    right: 3,
  },
  {
    tag: 'de-1996',
    source: 'de-1996',
    aliases: ['de'],
    licence: 'MIT',
    header: /name:\s*MIT/,
    left: 2,
    right: 2,
  },
  {
    tag: 'fr',
    source: 'fr',
    aliases: [],
    licence: 'MIT',
    header: /name:\s*MIT/,
    left: 2,
    right: 3,
  },
  {
    tag: 'es',
    source: 'es',
    aliases: [],
    licence: 'MIT',
    header: /name:\s*MIT/,
    left: 2,
    right: 2,
  },
  {
    tag: 'it',
    source: 'it',
    aliases: [],
    licence: 'MIT',
    choice: 'LPPL-1.3c-or-later or MIT; MIT taken',
    header: /name:\s*MIT/,
    left: 2,
    right: 2,
  },
];

/** Languages the kernel does not bundle, and why (borrow list, section 11). */
export const REFUSED: Readonly<Record<string, string>> = {
  sk: 'GPL-2.0-or-later: copyleft',
  hu: 'MPL-1.1, GPL-2.0 or LGPL-2.1: every option is copyleft',
};

export interface ManifestEntry {
  readonly tag: string;
  readonly aliases: readonly string[];
  readonly patterns: { readonly file: string; readonly sha256: string; readonly bytes: number };
  readonly exceptions: {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
  } | null;
  readonly notice: string;
  readonly licence: string;
  readonly choice?: string;
  /** The minimums that the house class gets (see `Choice`). */
  readonly left: number;
  readonly right: number;
  /** The same as the file's own `typesetting` header gives them. */
  readonly fileMinimums: { readonly left: number; readonly right: number };
  readonly source: string;
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** The comment block at the top of a hyph-utf8 TeX file: up to the first line of `=` characters. */
export function headerOf(tex: string): string {
  const lines = tex.split(/\r?\n/);
  const end = lines.findIndex((l) => /^%\s*={5,}/.test(l));
  return lines.slice(0, end === -1 ? 0 : end).join('\n') + '\n';
}

/** The `typesetting` minimums of the header's `hyphenmins` block. */
export function hyphenMins(header: string): { left: number; right: number } {
  const block = /hyphenmins:[\s\S]*?typesetting:\s*%\s*left:\s*(\d+)\s*%\s*right:\s*(\d+)/.exec(
    header.replace(/\r?\n%/g, '\n%'),
  );
  if (!block) throw new Error('no typesetting hyphenmins in the header');
  return { left: Number(block[1]), right: Number(block[2]) };
}

export function build(from: string, out: string): ManifestEntry[] {
  mkdirSync(out, { recursive: true });
  const entries: ManifestEntry[] = [];
  for (const c of BUNDLED) {
    if (c.tag in REFUSED) throw new Error(`${c.tag} is refused: ${REFUSED[c.tag]}`);
    const tex = readFileSync(resolve(from, 'tex', `hyph-${c.source}.tex`), 'utf8');
    const header = headerOf(tex);
    if (!c.header.test(header))
      throw new Error(
        `hyph-${c.source}.tex no longer states the licence ${c.licence} in its header`,
      );
    const fileMinimums = hyphenMins(header);
    const pat = readFileSync(resolve(from, 'txt', `hyph-${c.source}.pat.txt`));
    writeFileSync(resolve(out, `hyph-${c.tag}.pat.txt`), pat);
    const hypPath = resolve(from, 'txt', `hyph-${c.source}.hyp.txt`);
    const hyp = existsSync(hypPath) ? readFileSync(hypPath) : null;
    if (hyp) writeFileSync(resolve(out, `hyph-${c.tag}.hyp.txt`), hyp);
    const notice = header.replace(/\r\n/g, '\n');
    writeFileSync(resolve(out, `hyph-${c.tag}.notice.txt`), notice);
    entries.push({
      tag: c.tag,
      aliases: c.aliases,
      patterns: { file: `hyph-${c.tag}.pat.txt`, sha256: sha256(pat), bytes: pat.length },
      exceptions: hyp
        ? { file: `hyph-${c.tag}.hyp.txt`, sha256: sha256(hyp), bytes: hyp.length }
        : null,
      notice: `hyph-${c.tag}.notice.txt`,
      licence: c.licence,
      ...(c.choice ? { choice: c.choice } : {}),
      left: c.left,
      right: c.right,
      fileMinimums,
      source: `hyph-utf8 patterns/tex/hyph-${c.source}.tex, patterns/txt/hyph-${c.source}.pat.txt`,
    });
  }
  writeFileSync(
    resolve(out, 'manifest.json'),
    JSON.stringify(
      {
        $comment:
          'Hyphenation patterns the kernel can load (WASM-009), copied by scripts/hyphenation-patterns.ts from hyph-utf8 (TeX Live 2025). Each language is loaded when a document needs it; the patterns are not part of the WebAssembly file. Licences are those of the files, recorded in the borrow list (docs/research/2026-11-06-borrow-list.md, section 11); the notice file of each language is the file header that its licence asks to be kept.',
        refused: REFUSED,
        languages: entries,
      },
      null,
      2,
    ) + '\n',
  );
  return entries;
}

if (import.meta.main) {
  const from = process.argv[2];
  if (!from) throw new Error('usage: node scripts/hyphenation-patterns.ts <hyph-utf8/patterns>');
  const out = resolve(import.meta.dirname, '../patterns');
  for (const e of build(resolve(from), out)) console.log(e.tag, e.left, e.right, e.licence);
}
