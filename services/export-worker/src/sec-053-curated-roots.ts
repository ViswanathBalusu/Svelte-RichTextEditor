/**
 * The TeX Live packages that hold the files of the house class's fixed list (09 §9.3 item 5;
 * tests/security/test/tex-package-list.test.ts), and a file of each to look up in the image. The
 * list of roots the image keeps is `image/curated-roots.txt`; `sec-053-curated-roots.test.ts`
 * checks that it covers these.
 */

/** TeX Live package names (not the class's package names: `array` is in `tools`). */
export const CLASS_PACKAGES: readonly string[] = [
  'amsmath',
  'babel',
  'colortbl',
  'fontspec',
  'geometry',
  'graphics',
  'hyperref',
  'lua-ul',
  'luacolor',
  'tools',
  'unicode-math',
  'xcolor',
  'luahbtex',
  'luaotfload',
  'latex',
  'biblatex',
  'biber',
];

/** One file of each package of the fixed list, as kpathsea finds it. */
export const FIXED_LIST_FILES: readonly string[] = [
  'amsmath.sty',
  'array.sty',
  'babel.sty',
  'colortbl.sty',
  'fontspec.sty',
  'geometry.sty',
  'graphicx.sty',
  'hyperref.sty',
  'longtable.sty',
  'lua-ul.sty',
  'luacolor.sty',
  'multicol.sty',
  'unicode-math.sty',
  'xcolor.sty',
  'article.cls',
  'biblatex.sty',
];
