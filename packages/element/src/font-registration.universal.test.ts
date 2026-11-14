// FE-061 criteria 1 and 3 on a real page: the production adapter (`pageFonts`, `document.fonts`
// and `new FontFace`) registers the manifest's files under hash aliases, two editor instances on
// one page leave one face per alias, and a host face with the family name stays as it was. In
// Node.js there is no page, so the suite is skipped there (`test/font-loader.test.ts` covers the
// rest without a DOM).
import type { Backend, FontsPort } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { pageFonts, registerManifestFonts } from './font-loader.ts';
import { FONT_ALIAS_PREFIX, fontAlias } from './font-registration.ts';
import { Session, type SessionHost } from './session.ts';

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';

const A = '1'.repeat(64);
const B = '2'.repeat(64);

/** The manifest of the document service's shape; the URLs are never fetched by registration. */
const fonts: FontsPort = {
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
          { style: 'regular', weight: 400, italic: false, url: `/fonts/${A}.ttf`, sha256: A },
          { style: 'bold', weight: 700, italic: false, url: `/fonts/${B}.ttf`, sha256: B },
        ],
      },
    ],
  }),
};

const unquoted = (family: string) => family.replace(/^["']|["']$/g, '');
const families = () => Array.from(document.fonts, (f) => unquoted(f.family));

describe.skipIf(!isBrowser)('fonts on the page (FE-061 criteria 1 and 3)', () => {
  afterEach(() => {
    for (const face of Array.from(document.fonts))
      if (
        unquoted(face.family).startsWith(FONT_ALIAS_PREFIX) ||
        unquoted(face.family) === 'Noto Serif'
      )
        document.fonts.delete(face);
  });

  it('registers each file on document.fonts as a FontFace under its hash alias, never the family', async () => {
    const aliases = await registerManifestFonts(fonts, pageFonts());
    expect(aliases).toEqual([fontAlias(A), fontAlias(B)]);
    const added = Array.from(document.fonts).filter((f) =>
      unquoted(f.family).startsWith(FONT_ALIAS_PREFIX),
    );
    expect(added.every((f) => f instanceof FontFace)).toBe(true);
    expect(added.map((f) => unquoted(f.family)).sort()).toEqual(
      [fontAlias(A), fontAlias(B)].sort(),
    );
    expect(added.find((f) => unquoted(f.family) === fontAlias(B))?.weight).toBe('700');
    expect(families()).not.toContain('Noto Serif');
  });

  it('two instances leave one face per alias', async () => {
    // Each instance runs the session's default path: its own pageFonts() on the shared page.
    await Promise.all([
      registerManifestFonts(fonts, pageFonts()),
      registerManifestFonts(fonts, pageFonts()),
    ]);
    await registerManifestFonts(fonts, pageFonts());
    const all = families();
    expect(all.filter((f) => f === fontAlias(A))).toHaveLength(1);
    expect(all.filter((f) => f === fontAlias(B))).toHaveLength(1);
  });

  it('keeps a host face with the same family name as it was', async () => {
    const host = new FontFace('Noto Serif', 'local("Noto Serif")');
    document.fonts.add(host);
    await registerManifestFonts(fonts, pageFonts());
    const same = Array.from(document.fonts).filter((f) => unquoted(f.family) === 'Noto Serif');
    expect(same).toEqual([host]);
  });

  it('two editor sessions with the default registrar register each file once on the page', async () => {
    // A backend with a fonts port whose content never arrives: each session stays in `loading`
    // after it started the font registration, which is all this test reads.
    let manifests = 0;
    const backend = (): Backend =>
      ({
        features: new Set<string>(),
        connect: async () => {},
        close: async () => {},
        auth: { onAuthRequired: () => () => {}, onRevoked: () => () => {} },
        sync: { loadContent: () => new Promise(() => {}) },
        fonts: {
          manifest: async () => {
            manifests++;
            return fonts.manifest();
          },
        },
      }) as unknown as Backend;
    const host: SessionHost = {
      emit: () => {},
      mount: () => Promise.reject(new Error('not mounted in this test')),
    };
    const sessions = [1, 2].map(
      (n) => new Session({ docId: `d${n}`, backend: backend(), ownsBackend: false, host }),
    );
    for (const s of sessions) void s.start();
    const deadline = Date.now() + 2000;
    while ((manifests < 2 || !families().includes(fontAlias(B))) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(manifests).toBe(2);
    const all = families();
    expect(all.filter((f) => f === fontAlias(A))).toHaveLength(1);
    expect(all.filter((f) => f === fontAlias(B))).toHaveLength(1);
    expect(all).not.toContain('Noto Serif');
    for (const s of sessions) await s.close();
  });
});
