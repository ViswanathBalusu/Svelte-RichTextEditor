/**
 * Fonts through the real Podman sandbox (BE-048 criteria 1 and 4; BE-043 criterion 1). Needs Podman
 * and the image of scripts/build-image.ts built from this tree, and skips otherwise
 * (`sandboxReady`). The fonts are synthetic (font-fixtures.ts); the checks are those of font.test.ts,
 * run in the container under the job's limits with the same request and reply frames.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkFontFile } from '../src/font-check.ts';
import { podmanSandbox, sandboxReady } from '../src/sandbox-podman.ts';
import { sfnt, woff2 } from './font-fixtures.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(`fonts in the Podman sandbox (${ready.reason})`, () => {
  const sandbox = podmanSandbox({ limits: { wallSeconds: 60 } });

  it('reads a TrueType, an OpenType and a WOFF2 font in the container', async () => {
    expect(await checkFontFile(sandbox, sfnt({ family: 'Boxed Sans' }), 'font/ttf')).toMatchObject({
      ok: true,
      font: { family: 'Boxed Sans', format: 'truetype' },
    });
    expect(await checkFontFile(sandbox, sfnt({ outlines: 'cff' }), 'font/otf')).toMatchObject({
      ok: true,
      font: { format: 'opentype' },
    });
    expect(
      await checkFontFile(sandbox, woff2({ family: 'Boxed Packed', weight: 700 }), 'font/woff2'),
    ).toMatchObject({ ok: true, font: { family: 'Boxed Packed', format: 'woff2', bold: true } });
  });

  it('refuses in the container what it refuses in process', async () => {
    const refused = async (bytes: Uint8Array, mime: string) => {
      const r = await checkFontFile(sandbox, bytes, mime);
      expect(r.ok).toBe(false);
      return r;
    };
    expect(await refused(sfnt({ fsType: 2 }), 'font/ttf')).toMatchObject({
      reason: 'unsupported_content',
    });
    expect(await refused(sfnt({ omit: ['name'] }), 'font/ttf')).toMatchObject({
      reason: 'malformed',
    });
    expect(await refused(sfnt({}), 'font/woff2')).toMatchObject({ reason: 'type_mismatch' });
    // A WOFF2 file that claims more than the expansion limit stops before it is expanded.
    expect(await refused(woff2({}, { claimedSfnt: 33 * 1024 * 1024 }), 'font/woff2')).toMatchObject(
      { reason: 'archive_limit', code: 'too_large' },
    );
  });
});
