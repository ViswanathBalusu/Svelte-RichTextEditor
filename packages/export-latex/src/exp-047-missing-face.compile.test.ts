/**
 * EXP-047 criterion 2, checked by a sandboxed compile (Node.js only, sandbox; lane U-EXP-033-048):
 * a font that a manifest names by a hash with no file behind it fails the job with a diagnostic, and
 * no other font is put in its place.
 *
 * The bundle is converted from the image's own manifest, except that the default family's regular
 * face names a file that the image does not hold. The worker's sandbox runs fontspec on the bundle:
 * fontspec cannot find the file and the compile fails. The test checks the failure, that the log
 * names the missing file, and that no PDF comes out. A PDF would mean another font was used.
 *
 * The job's own check of the host's font files (font-files.ts) is a separate path (see
 * exp-047-fonts.job.test.ts). This test shows the sandbox side: the compile of an image with a
 * missing face does not substitute a font.
 *
 * Skipped when sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para } from '../test/docs.ts';
import { classFiles, compileBundle, imageFonts, keep, sandboxReady } from '../test/harness.ts';
import { convert, type FontManifest } from '../src/index.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const MISSING = 'e0'.repeat(32); // 64 hex digits; no file in the image has this name

describe.skipIf(!ready)(
  'EXP-047 criterion 2: a face with no file fails the compile and is not substituted',
  () => {
    it('fails with a diagnostic naming the missing file and produces no PDF', async () => {
      const real = await imageFonts();
      const fonts: FontManifest = structuredClone(real);
      const family = fonts.families.find((f) => f.name === fonts.defaultFamily);
      if (!family)
        throw new Error(`the image manifest has no default family ${fonts.defaultFamily}`);
      family.regular = { file: `${MISSING}.ttf`, sha256: MISSING } as typeof family.regular;

      const bundle = await convert(doc([para('A paragraph in the default family.')]), {
        fonts,
        classFiles: classFiles(),
        profile: 'final',
        title: 'exp-047-missing-face',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      const c = await compileBundle(bundle);

      if (c.compile.ok || c.compile.pdf) {
        throw new Error(
          `the compile should fail for a missing face (${keep('exp-047-missing-face', c)})`,
        );
      }
      // The log names the file it could not find, so the diagnostic is not generic.
      expect(c.compile.log, 'the log names the missing file').toContain(MISSING);
      expect(c.compile.pdf ?? null).toBeNull();
    }, 600_000);
  },
);
