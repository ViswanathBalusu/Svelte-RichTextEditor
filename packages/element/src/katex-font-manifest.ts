/**
 * The KaTeX font files as manifest entries, for registration under hash aliases (FE-069 criterion 3;
 * 02 §6; FE-061).
 *
 * The files are the `.woff2` files of the pinned `katex@0.19.1` package. Each hash is the SHA-256 of
 * that file's bytes; `katex-font-manifest.test.ts` recomputes them from `node_modules` and fails if a
 * file changes. KaTeX's own stylesheet (which carries `@font-face` rules) is never imported, so the
 * fonts reach the page only through `document.fonts` and the hash alias.
 *
 * The licence is recorded as unverified: the installed package does not state the font licence, and
 * the licence check is not made here (BE's rules, FE-061).
 */
import type { FontFileEntry } from './font-registration.ts';

const LICENCE = 'unverified (not stated in katex@0.19.1)';

/** One KaTeX font file: its file name (without the directory), family, style, weight and hash. */
interface KatexFontRow {
  readonly file: string;
  readonly family: string;
  readonly style: 'normal' | 'italic';
  readonly weight: '400' | '700';
  readonly hash: string;
}

/** The package ships twenty `.woff2` files; each is listed once. */
export const KATEX_FONT_ROWS: readonly KatexFontRow[] = [
  {
    file: 'KaTeX_AMS-Regular.woff2',
    family: 'KaTeX_AMS',
    style: 'normal',
    weight: '400',
    hash: '0cdd387c9590a1a9f9794560022dbb59654a7d86f187aa0c81495ad42d3a7308',
  },
  {
    file: 'KaTeX_Caligraphic-Bold.woff2',
    family: 'KaTeX_Caligraphic',
    style: 'normal',
    weight: '700',
    hash: 'de7701e42cf1f4cf0b766c03fb27977207eee2f4fd5d76fa82188406da43ea4c',
  },
  {
    file: 'KaTeX_Caligraphic-Regular.woff2',
    family: 'KaTeX_Caligraphic',
    style: 'normal',
    weight: '400',
    hash: '5d53e70ad607c2352162dec9e0923fb54ecdafaccbf604cd8dcf7d00facb989b',
  },
  {
    file: 'KaTeX_Fraktur-Bold.woff2',
    family: 'KaTeX_Fraktur',
    style: 'normal',
    weight: '700',
    hash: '74444efd593c005e3f4573b44524704c0af0a937fe911cca9e94068d0d140d3f',
  },
  {
    file: 'KaTeX_Fraktur-Regular.woff2',
    family: 'KaTeX_Fraktur',
    style: 'normal',
    weight: '400',
    hash: '51814d270d06ff0255dba0799994fa4d8c84d11f09951d47595f4abb1f3602dc',
  },
  {
    file: 'KaTeX_Main-Bold.woff2',
    family: 'KaTeX_Main',
    style: 'normal',
    weight: '700',
    hash: '0f60d1b897938ec918c8ce073092411baf9438f6739465693ff18b0f9d20b021',
  },
  {
    file: 'KaTeX_Main-BoldItalic.woff2',
    family: 'KaTeX_Main',
    style: 'italic',
    weight: '700',
    hash: '99cd42a3c072d918f2f44984a807cf7aa16e13545fd0875fc07c6c65f99e715b',
  },
  {
    file: 'KaTeX_Main-Italic.woff2',
    family: 'KaTeX_Main',
    style: 'italic',
    weight: '400',
    hash: '97479ca6cce906abc961ecac96faa5f9ca2e61b8e7670d475826bcdee9a7c267',
  },
  {
    file: 'KaTeX_Main-Regular.woff2',
    family: 'KaTeX_Main',
    style: 'normal',
    weight: '400',
    hash: 'c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866',
  },
  {
    file: 'KaTeX_Math-BoldItalic.woff2',
    family: 'KaTeX_Math',
    style: 'italic',
    weight: '700',
    hash: 'dc47344dbb6cb5b655c8460d561f4df5f501b90c804ad3c6cec65fe322351ab1',
  },
  {
    file: 'KaTeX_Math-Italic.woff2',
    family: 'KaTeX_Math',
    style: 'italic',
    weight: '400',
    hash: '7af58c5ec8f132a2ddde9027c6d7814decce4d3b822a11192a42a20e2e973264',
  },
  {
    file: 'KaTeX_SansSerif-Bold.woff2',
    family: 'KaTeX_SansSerif',
    style: 'normal',
    weight: '700',
    hash: 'e99ae51144bf1232efcc1bfe5add36262c6866b0faab24fa75740e1b98577a62',
  },
  {
    file: 'KaTeX_SansSerif-Italic.woff2',
    family: 'KaTeX_SansSerif',
    style: 'italic',
    weight: '400',
    hash: '00b26ac825e2095056396e0553b8ac26d3f8ad158c3826e28b4c45b385c4714a',
  },
  {
    file: 'KaTeX_SansSerif-Regular.woff2',
    family: 'KaTeX_SansSerif',
    style: 'normal',
    weight: '400',
    hash: '68e8c73ef42afd3ccec58bf0fba302cce448938e7fc020a5e31f8a952eee1342',
  },
  {
    file: 'KaTeX_Script-Regular.woff2',
    family: 'KaTeX_Script',
    style: 'normal',
    weight: '400',
    hash: '036d4e95149b69ff9bcc0cd55771efeb25ffa3947293e69acd78d5ac328c684b',
  },
  {
    file: 'KaTeX_Size1-Regular.woff2',
    family: 'KaTeX_Size1',
    style: 'normal',
    weight: '400',
    hash: '6b47c40166b6dbe21a5dfca7718413f2147fd2399be1ba605d8ad39cedf25dfe',
  },
  {
    file: 'KaTeX_Size2-Regular.woff2',
    family: 'KaTeX_Size2',
    style: 'normal',
    weight: '400',
    hash: 'd04c54219f9eaec6d4d4fd42dfb28785975a4794d6b2fc71e566b9cd6db842dd',
  },
  {
    file: 'KaTeX_Size3-Regular.woff2',
    family: 'KaTeX_Size3',
    style: 'normal',
    weight: '400',
    hash: '73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995',
  },
  {
    file: 'KaTeX_Size4-Regular.woff2',
    family: 'KaTeX_Size4',
    style: 'normal',
    weight: '400',
    hash: 'a4af7d414440a1c1790825cfb700cf9cf43b0f2c4b04f0ebc523011ad9853ec0',
  },
  {
    file: 'KaTeX_Typewriter-Regular.woff2',
    family: 'KaTeX_Typewriter',
    style: 'normal',
    weight: '400',
    hash: '71d517d67827787cfabdf186914cc3358eda539e37931941f2b2fd4a21f68c0b',
  },
];

/**
 * The KaTeX font entries, with each URL formed from `baseUrl` (the directory the host serves the
 * files from, ending in `/`) and the file name. Where the host serves them from is the host's choice;
 * no default location is assumed here.
 */
export function katexFontFiles(baseUrl: string): FontFileEntry[] {
  return KATEX_FONT_ROWS.map((row) => ({
    family: row.family,
    style: row.style,
    weight: row.weight,
    url: baseUrl + row.file,
    hash: row.hash,
    licence: LICENCE,
  }));
}
