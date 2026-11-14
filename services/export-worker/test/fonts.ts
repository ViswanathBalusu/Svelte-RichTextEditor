/**
 * A font manifest for tests that convert without compiling: the converter only names font files by
 * hash, so made-up hashes are enough. Compiles use the image's own manifest (src/fonts.ts).
 */
import type { FontManifest } from '@docedit/export-latex';

const face = (n: number) => {
  const sha256 = n.toString(16).padStart(2, '0').repeat(32);
  return { file: `${sha256}.ttf`, sha256 };
};

export const TEST_FONTS: FontManifest = {
  version: 1,
  families: [
    {
      name: 'Noto Serif',
      lineHeight: 1362,
      regular: face(1),
      bold: face(2),
      italic: face(3),
      boldItalic: face(4),
      licence: 'OFL-1.1',
    },
  ],
  math: { name: 'STIX Two Math', ...face(5), file: `${face(5).sha256}.otf`, licence: 'OFL-1.1' },
  defaultFamily: 'Noto Serif',
};
