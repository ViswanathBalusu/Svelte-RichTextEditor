// FE-069 criterion 3 in a browser, through the production path: `loadKatexFonts` registers the KaTeX
// files on `document.fonts` under hash aliases, `drawEquation` draws into a shadow root, and the
// drawn glyphs resolve to the alias faces. No `@font-face` rule is used, in the shadow root or on
// the document, and no face is registered under a `KaTeX_*` name.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_ALIAS_PREFIX } from './font-registration.ts';
import { KATEX_FONT_ROWS } from './katex-font-manifest.ts';
import { loadKatexFonts } from './katex-fonts.ts';
import { drawEquation } from './math-display.ts';

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';

const unquoted = (family: string) => family.trim().replace(/^["']|["']$/g, '');

/** Each KaTeX font file's URL as the test server serves it. */
const fontUrls = import.meta.glob('../node_modules/katex/dist/fonts/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** The directory the test server serves the KaTeX files from, as a host would give it. */
function servedBaseUrl(): string {
  const urls = Object.values(fontUrls);
  const first = urls[0];
  if (first === undefined) throw new Error('the test server serves no KaTeX font');
  const base = first.slice(0, first.lastIndexOf('/') + 1);
  // Every file sits in that one directory under its own name.
  for (const row of KATEX_FONT_ROWS) expect(urls).toContain(base + row.file);
  return base;
}

const weightOf = (w: string) => (w === 'normal' ? '400' : w === 'bold' ? '700' : w);

function faceOf(alias: string, style: string, weight: string): FontFace | undefined {
  return Array.from(document.fonts).find(
    (f) => unquoted(f.family) === alias && f.style === style && weightOf(f.weight) === weight,
  );
}

describe.skipIf(!isBrowser)('KaTeX fonts for a drawn equation (FE-069 criterion 3)', () => {
  const hosts: HTMLElement[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) host.remove();
    for (const face of Array.from(document.fonts))
      if (unquoted(face.family).startsWith(FONT_ALIAS_PREFIX)) document.fonts.delete(face);
  });

  function shadowBox(): { root: ShadowRoot; box: HTMLElement } {
    const host = document.createElement('div');
    document.body.append(host);
    hosts.push(host);
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('span');
    box.style.fontSize = '32px';
    root.append(box);
    return { root, box };
  }

  it('draws an equation whose glyphs resolve to de-font-<hash> faces, loaded on use', async () => {
    const fonts = await loadKatexFonts(servedBaseUrl());
    expect(fonts).not.toBeNull();
    if (!fonts) return;

    // Twenty faces, all under aliases, none under a KaTeX family name.
    expect(fonts.faces).toHaveLength(KATEX_FONT_ROWS.length);
    expect(fonts.faces.every((f) => unquoted(f.family).startsWith(FONT_ALIAS_PREFIX))).toBe(true);
    expect(Array.from(document.fonts).some((f) => unquoted(f.family).startsWith('KaTeX_'))).toBe(
      false,
    );

    const { root, box } = shadowBox();
    expect(drawEquation(box, 'x+\\mathbf{y}', false)).toEqual({ status: 'drawn' });

    // The shadow root holds the aliased sheet, with no @font-face rule.
    const rules = root.adoptedStyleSheets.flatMap((s) => Array.from(s.cssRules));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r instanceof CSSFontFaceRule)).toBe(false);
    expect(rules.some((r) => r.cssText.includes('KaTeX_'))).toBe(false);

    const mathAlias = fonts.aliases.get('KaTeX_Math');
    const mainAlias = fonts.aliases.get('KaTeX_Main');
    const frakturAlias = fonts.aliases.get('KaTeX_Fraktur');
    if (!mathAlias || !mainAlias || !frakturAlias) throw new Error('missing KaTeX alias');

    // The italic x (`.mathnormal`) and the bold y (`.mathbf`) compute to their family aliases.
    const x = box.querySelector('.mathnormal');
    const y = box.querySelector('.mathbf');
    if (!x || !y) throw new Error('KaTeX drew no .mathnormal or .mathbf');
    const xs = getComputedStyle(x);
    const ys = getComputedStyle(y);
    expect(unquoted(xs.fontFamily.split(',')[0] ?? '')).toBe(mathAlias);
    expect(xs.fontStyle).toBe('italic');
    expect(unquoted(ys.fontFamily.split(',')[0] ?? '')).toBe(mainAlias);
    expect(weightOf(ys.fontWeight)).toBe('700');

    // Laying the equation out makes the browser fetch exactly the faces its glyphs use.
    box.getBoundingClientRect();
    await vi.waitFor(
      () => {
        expect(faceOf(mathAlias, 'italic', '400')?.status).toBe('loaded');
        expect(faceOf(mainAlias, 'normal', '700')?.status).toBe('loaded');
        expect(faceOf(mainAlias, 'normal', '400')?.status).toBe('loaded');
      },
      { timeout: 10_000, interval: 50 },
    );
    // A family the equation does not use is registered but never fetched.
    expect(faceOf(frakturAlias, 'normal', '400')?.status).toBe('unloaded');
    expect(document.fonts.check(`italic 32px "${mathAlias}"`, 'x')).toBe(true);
  });

  it('adds no face on a second load and leaves a host face named KaTeX_Main alone', async () => {
    const hostFace = new FontFace('KaTeX_Main', 'local("Host Serif Not Installed")');
    document.fonts.add(hostFace);
    try {
      const base = servedBaseUrl();
      const first = await loadKatexFonts(base);
      const count = Array.from(document.fonts).length;
      const second = await loadKatexFonts(base);
      expect(Array.from(document.fonts).length).toBe(count);
      expect(second?.aliases).toEqual(first?.aliases);
      expect(Array.from(document.fonts)).toContain(hostFace);

      const { box } = shadowBox();
      drawEquation(box, '1+1', false);
      const katexRoot = box.querySelector('.katex');
      if (!katexRoot) throw new Error('KaTeX drew nothing');
      const family = unquoted(getComputedStyle(katexRoot).fontFamily.split(',')[0] ?? '');
      expect(family).toBe(first?.aliases.get('KaTeX_Main'));
    } finally {
      document.fonts.delete(hostFace);
    }
  });
});
