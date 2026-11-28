/**
 * The TeX Live packages that hold the files of the house class's fixed list (09 §9.3 item 5;
 * tests/security/test/tex-package-list.test.ts), and a file of each to look up in the image. The
 * list of roots the image keeps is `image/curated-roots.txt`; `sec-053-curated-roots.test.ts`
 * checks that it covers these.
 */

/**
 * TeX Live package names (not the class's package names: `array` is in `tools`). `amsfonts` is not
 * on the fixed list; it holds the metrics (cmmib7) that bold math needs, which the math allow-list
 * uses (EXP-049 criterion 5). The first curated image left it out.
 */
export const CLASS_PACKAGES: readonly string[] = [
  'amsmath',
  'amsfonts',
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
  'cmmib7.tfm',
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
