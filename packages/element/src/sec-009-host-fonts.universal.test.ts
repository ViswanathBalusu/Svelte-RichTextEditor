// SEC-009 criterion 1 in a browser (10 §3.1 "global side effects"; 02 §3): the host page has its
// own font under a family name that a document also uses. The component registers the document's
// fonts the way a session does (`registerManifestFonts` over the backend's `fonts` port,
// session.ts), and afterwards every face it added is under a hash alias, the host's family still
// holds only the host's face, and the host's text has the width it had before.
//
// The host's family is `KaTeX_Main`, backed here by the KaTeX typewriter file, so that a face
// registered under the same name by the component would change the width of the host's text. The
// manifest the component reads names the same family, `KaTeX_Main`, with the real KaTeX main file.
import { afterEach, describe, expect, it } from 'vitest';
import type { FontsPort } from '@docedit/protocol';
import { katexFontFiles } from './katex-font-manifest.ts';
import { FONT_ALIAS_PREFIX, fontAlias } from './font-registration.ts';
import { cssUrl, registerManifestFonts } from './font-loader.ts';

const FAMILY = 'KaTeX_Main';
const SAMPLE = 'Host text: iiii WWWW mmmm 0123456789';

const unquoted = (family: string) => family.replace(/^["']|["']$/g, '');

const fontUrls = import.meta.glob('../node_modules/katex/dist/fonts/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function served(file: string): string {
  const path = Object.keys(fontUrls).find((p) => p.endsWith('/' + file));
  if (!path) throw new Error(`no served file for ${file}`);
  return fontUrls[path] as string;
}

/** The width of the sample in the given font family, in a host element outside any shadow root. */
function widthIn(family: string): number {
  const span = document.createElement('span');
  span.style.cssText = `font: 32px ${family}, monospace; white-space: nowrap; position: absolute;`;
  span.textContent = SAMPLE;
  document.body.append(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';

describe.skipIf(!isBrowser)('the host page’s fonts are left alone (SEC-009 criterion 1)', () => {
  const added: FontFace[] = [];
  afterEach(() => {
    for (const face of Array.from(document.fonts))
      if (added.includes(face) || unquoted(face.family).startsWith(FONT_ALIAS_PREFIX))
        document.fonts.delete(face);
    added.length = 0;
  });

  it('registers a document family the host also defines under a hash alias, and the host’s text keeps its width', async () => {
    // The host's own font, under the family name the document will also use.
    const hostFace = new FontFace(FAMILY, cssUrl(served('KaTeX_Typewriter-Regular.woff2')));
    added.push(hostFace);
    document.fonts.add(await hostFace.load());
    const hostWidth = widthIn(FAMILY);
    expect(hostWidth, 'the host font is in effect').not.toBe(widthIn('no-such-family'));

    // The document's font of the same family name, as the backend's manifest gives it.
    const main = katexFontFiles('/').find(
      (f) => f.family === FAMILY && f.style === 'normal' && f.weight === '400',
    );
    expect(main).toBeDefined();
    if (!main) return;
    const port: FontsPort = {
      manifest: async () => ({
        families: [
          {
            family: FAMILY,
            licence: main.licence,
            faces: [
              {
                url: served('KaTeX_Main-Regular.woff2'),
                sha256: main.hash,
                weight: 400,
                italic: false,
              },
            ],
          },
        ],
      }),
    } as unknown as FontsPort;
    const before = new Set(Array.from(document.fonts));

    const aliases = await registerManifestFonts(port);

    // The component added one face, under the hash alias, not under the family name.
    const alias = fontAlias(main.hash);
    expect(aliases).toEqual([alias]);
    expect(alias.startsWith(FONT_ALIAS_PREFIX)).toBe(true);
    const fresh = Array.from(document.fonts).filter((f) => !before.has(f));
    expect(fresh.map((f) => unquoted(f.family))).toEqual([alias]);
    await Promise.all(fresh.map((f) => f.load()));
    expect(fresh.every((f) => f.status === 'loaded')).toBe(true);

    // The host's family still holds the host's face alone, and its text is drawn as before.
    const underName = Array.from(document.fonts).filter((f) => unquoted(f.family) === FAMILY);
    expect(underName).toEqual([hostFace]);
    expect(widthIn(FAMILY)).toBe(hostWidth);

    // The control: the document's file does draw differently, so an override would have shown.
    expect(widthIn(`"${alias}"`), 'the alias draws with the document’s file').not.toBe(hostWidth);
  });
});
