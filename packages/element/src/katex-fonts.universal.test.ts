// FE-069 criterion 3 in a browser: the KaTeX font files are registered on the page's FontFace set
// under their hash aliases (FE-061), never under their KaTeX family names, and each one loads from
// the URL the host gives. No stylesheet is involved: KaTeX's CSS is not imported anywhere in the
// element, so the only route to the page is `document.fonts`.
import { afterEach, describe, expect, it } from 'vitest';
import { katexFontFiles } from './katex-font-manifest.ts';
import { FONT_ALIAS_PREFIX, fontAlias, registerFontFiles } from './font-registration.ts';
import { pageFonts } from './font-loader.ts';

const unquoted = (family: string) => family.replace(/^["']|["']$/g, '');

/** Each KaTeX font file's URL as the test server serves it (Vite's `?url` import, eager). */
const fontUrls = import.meta.glob('../node_modules/katex/dist/fonts/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** The manifest entries, each with the URL the test server gave its file. */
function entriesWithUrls() {
  return katexFontFiles('/').map((entry) => {
    const name = entry.url.slice(1);
    const path = Object.keys(fontUrls).find((p) => p.endsWith('/' + name));
    if (!path) throw new Error(`no served file for ${name}`);
    return { ...entry, url: fontUrls[path] as string };
  });
}

const editorFaces = () =>
  Array.from(document.fonts).filter((f) => unquoted(f.family).startsWith(FONT_ALIAS_PREFIX));

// Node.js has no page, so the suite runs only where `document.fonts` exists (as the other universal suites do).
const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';

describe.skipIf(!isBrowser)('KaTeX fonts on the page (FE-069 criterion 3)', () => {
  afterEach(() => {
    for (const face of editorFaces()) document.fonts.delete(face);
  });

  it('registers each KaTeX file under its hash alias and loads it from the given URL', async () => {
    const page = pageFonts();
    expect(page).not.toBeNull();
    if (!page) return;
    const entries = entriesWithUrls();
    const aliases = registerFontFiles(entries, page.set, page.make);

    expect(aliases).toEqual(entries.map((e) => fontAlias(e.hash)));
    expect(new Set(aliases).size).toBe(entries.length);

    const faces = editorFaces();
    expect(faces.map((f) => unquoted(f.family)).sort()).toEqual([...aliases].sort());
    expect(faces.every((f) => f instanceof FontFace)).toBe(true);

    // No face is registered under a KaTeX family name: the families stay the host's to define.
    expect(Array.from(document.fonts).some((f) => unquoted(f.family).startsWith('KaTeX_'))).toBe(
      false,
    );

    // The files are real: each one loads from its URL.
    await Promise.all(faces.map((f) => f.load()));
    expect(faces.every((f) => f.status === 'loaded')).toBe(true);
  });

  it('adds nothing when a second instance registers the same files', () => {
    const page = pageFonts();
    if (!page) return;
    const entries = entriesWithUrls();
    registerFontFiles(entries, page.set, page.make);
    const before = editorFaces().length;
    registerFontFiles(entries, page.set, page.make);
    expect(editorFaces().length).toBe(before);
  });
});
