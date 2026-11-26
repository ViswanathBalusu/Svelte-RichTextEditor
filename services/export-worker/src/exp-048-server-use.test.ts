/**
 * EXP-048 criterion 3 (owner decision 62): the worker neither requires nor mounts the files of a
 * family that is not permitted for server-side use. The converter's side is
 * `packages/export-latex/src/tenant-fonts.serveruse.test.ts`.
 */
import type { FontFamily } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import { manifestFaces } from './font-files.ts';
import { TEST_FONTS } from '../test/fonts.ts';

const hash = (c: string): string => c.repeat(64);
const tenant = (serverUse?: boolean): FontFamily => ({
  name: 'Acme Brand Serif',
  lineHeight: 1200,
  regular: { file: `${hash('5')}.ttf`, sha256: hash('5') },
  bold: { file: `${hash('6')}.ttf`, sha256: hash('6') },
  italic: { file: `${hash('7')}.ttf`, sha256: hash('7') },
  boldItalic: { file: `${hash('4')}.ttf`, sha256: hash('4') },
  licence: 'Proprietary-tenant-licence',
  ...(serverUse === undefined ? {} : { serverUse }),
});

describe('EXP-048 the font files of a job leave out a family not permitted for server use', () => {
  it('lists the files of a permitted family and not those of a screen-only one', () => {
    const base = manifestFaces(TEST_FONTS).map((f) => f.file);
    for (const flag of [true, undefined]) {
      const files = manifestFaces({
        ...TEST_FONTS,
        families: [...TEST_FONTS.families, tenant(flag)],
      }).map((f) => f.file);
      expect(files).toContain(`${hash('5')}.ttf`);
    }
    const files = manifestFaces({
      ...TEST_FONTS,
      families: [...TEST_FONTS.families, tenant(false)],
    }).map((f) => f.file);
    expect(files).toEqual(base);
  });
});
