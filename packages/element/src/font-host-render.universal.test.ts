// FE-061 criterion 2 on a real page: the host defines its own face named "Noto Serif" (a real
// font file), the editor registers a manifest entry under the same family name (a different real
// file, so an override would change the widths), and the editor loads its own alias. The host's
// text must measure exactly as before. Runs in the browser projects only (`*.universal.test.ts`).
import { afterEach, describe, expect, it } from 'vitest';
import hostFontUrl from '../../perf/fonts/files/NotoSerif-Regular.ttf?url';
import editorFontUrl from '../../perf/fonts/files/NotoSans-Regular.ttf?url';
import type { FontsPort } from '@docedit/protocol';
import { pageFonts, registerManifestFonts } from './font-loader.ts';
import { FONT_ALIAS_PREFIX, fontAlias } from './font-registration.ts';

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';

const EDITOR_HASH = 'c'.repeat(64);
const SAMPLE = 'Hamburgefonstiv 0123456789 abc WWW iii';

/** One family name, `Noto Serif`, with one face whose file is the editor's own copy. */
const manifestPort: FontsPort = {
  manifest: async () => ({
    version: '0'.repeat(64),
    defaultFamily: 'Noto Serif',
    families: [
      {
        family: 'Noto Serif',
        role: 'text',
        licence: 'OFL-1.1',
        lineHeight: null,
        faces: [
          { style: 'regular', weight: 400, italic: false, url: editorFontUrl, sha256: EDITOR_HASH },
        ],
      },
    ],
  }),
} as unknown as FontsPort;

const unquoted = (family: string) => family.replace(/^["']|["']$/g, '');

/** The rendered width of the sample in one font stack, measured by the layout engine. */
function measure(fontFamily: string): number {
  const span = document.createElement('span');
  span.textContent = SAMPLE;
  span.style.cssText = `position:absolute;white-space:pre;font-size:40px;font-family:${fontFamily};`;
  document.body.append(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

describe.skipIf(!isBrowser)(
  'host text is unchanged by the editor fonts (FE-061 criterion 2)',
  () => {
    const added: FontFace[] = [];

    afterEach(() => {
      for (const face of added.splice(0)) document.fonts.delete(face);
      for (const face of Array.from(document.fonts))
        if (unquoted(face.family).startsWith(FONT_ALIAS_PREFIX)) document.fonts.delete(face);
    });

    it('measures the host family the same before and after the editor registers and loads its alias', async () => {
      const host = new FontFace('Noto Serif', `url("${hostFontUrl}")`);
      added.push(host);
      document.fonts.add(host);
      await host.load();
      await document.fonts.ready;

      const before = measure('"Noto Serif"');
      expect(before).toBeGreaterThan(0);

      const [alias] = await registerManifestFonts(manifestPort, pageFonts());
      expect(alias).toBe(fontAlias(EDITOR_HASH));
      // The editor's own alias loads its file; the host family is not touched by it.
      await document.fonts.load(`40px "${alias}"`);
      await document.fonts.ready;

      const after = measure('"Noto Serif"');
      expect(after).toBe(before);

      // Non-vacuous: the editor's file renders the sample at another width, so a registration under
      // the family name would have changed the host's measurement.
      const editorWidth = measure(`"${alias}"`);
      expect(editorWidth).not.toBe(before);
    });
  },
);
