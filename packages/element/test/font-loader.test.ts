// FE-061 production path in Node.js: the manifest body of `GET /fonts` becomes font file entries,
// `registerManifestFonts` reads the port and registers each file under its hash alias, and the
// session calls it with the backend's `fonts` port once connected. The page half (a real
// `document.fonts` and `FontFace`) is `src/font-registration.universal.test.ts`.
import type { FontsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { cssUrl, pageFonts, registerManifestFonts, type PageFonts } from '../src/font-loader.ts';
import { manifestFontFiles } from '../src/font-manifest.ts';
import { fontAlias, type FontFaceLike } from '../src/font-registration.ts';
import { Session } from '../src/session.ts';
import { coreHost } from './core-host.ts';
import { backendFor, service } from './support.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** A body as the document service serves it (`FontManifestBody`). */
const MANIFEST = {
  version: 'f'.repeat(64),
  defaultFamily: 'Noto Serif',
  families: [
    {
      family: 'Noto Serif',
      role: 'text',
      licence: 'OFL-1.1',
      lineHeight: null,
      faces: [
        {
          style: 'regular',
          weight: 400,
          italic: false,
          url: `https://f.example/fonts/${A}.ttf`,
          sha256: A,
          bytes: 1,
          format: 'truetype',
        },
        {
          style: 'italic',
          weight: 400,
          italic: true,
          url: `https://f.example/fonts/${B}.ttf`,
          sha256: B,
          bytes: 1,
          format: 'truetype',
        },
      ],
    },
  ],
};

function port(body: unknown = MANIFEST): FontsPort & { calls: number } {
  const p = {
    calls: 0,
    manifest: async () => {
      p.calls++;
      return body as Record<string, unknown>;
    },
  };
  return p;
}

function fakePage(): PageFonts & { faces: FontFaceLike[]; made: string[] } {
  const faces: FontFaceLike[] = [];
  const made: string[] = [];
  return {
    faces,
    made,
    set: { add: (f) => faces.push(f), [Symbol.iterator]: () => faces[Symbol.iterator]() },
    make: (alias, url) => {
      made.push(`${alias} ${url}`);
      return { family: alias };
    },
  };
}

describe('the manifest body (FE-061 criterion 1)', () => {
  it('lists each face with its family, style, weight, URL, hash and licence', () => {
    expect(manifestFontFiles(MANIFEST)).toEqual([
      {
        family: 'Noto Serif',
        style: 'normal',
        weight: '400',
        url: `https://f.example/fonts/${A}.ttf`,
        hash: A,
        licence: 'OFL-1.1',
      },
      {
        family: 'Noto Serif',
        style: 'italic',
        weight: '400',
        url: `https://f.example/fonts/${B}.ttf`,
        hash: B,
        licence: 'OFL-1.1',
      },
    ]);
  });

  it('leaves out faces it cannot read, and reads nothing from a malformed body', () => {
    const bad = {
      families: [
        {
          family: 'X',
          licence: 'OFL-1.1',
          faces: [
            { url: 'u', sha256: 'NOT-A-HASH', weight: 400 },
            { sha256: A, weight: 400 },
            null,
          ],
        },
        { licence: 'OFL-1.1', faces: [{ url: 'u', sha256: A, weight: 400 }] },
      ],
    };
    expect(manifestFontFiles(bad)).toEqual([]);
    for (const body of [null, 42, 'x', [], {}, { families: {} }])
      expect(manifestFontFiles(body)).toEqual([]);
  });
});

describe('registerManifestFonts', () => {
  it('registers each file of the port manifest under its hash alias', async () => {
    const page = fakePage();
    const aliases = await registerManifestFonts(port(), page);
    expect(aliases).toEqual([fontAlias(A), fontAlias(B)]);
    expect(page.faces.map((f) => f.family)).toEqual([fontAlias(A), fontAlias(B)]);
    expect(page.faces.some((f) => f.family === 'Noto Serif')).toBe(false);
  });

  it('a second instance on the same page adds nothing (criterion 3)', async () => {
    const page = fakePage();
    await registerManifestFonts(port(), page);
    await registerManifestFonts(port(), page);
    expect(page.faces).toHaveLength(2);
    expect(page.made).toHaveLength(2);
  });

  it('does nothing where there is no page (Node.js)', async () => {
    expect(pageFonts()).toBeNull();
    const p = port();
    expect(await registerManifestFonts(p)).toEqual([]);
    expect(p.calls).toBe(0);
  });

  it('writes the URL as a CSS url() source with its quotes escaped', () => {
    expect(cssUrl('https://f.example/a.ttf')).toBe('url("https://f.example/a.ttf")');
    expect(cssUrl('https://f.example/a"b\\c.ttf')).toBe('url("https://f.example/a\\"b\\\\c.ttf")');
  });
});

describe('the session registers the manifest fonts (FE-061 criterion 1)', () => {
  it('calls the registrar with the backend fonts port once connected, and loads on', async () => {
    const { service: s, docId } = service();
    const backend = backendFor(s, docId, 'editor', 'editor');
    const fonts = port();
    Object.assign(backend, { fonts });
    const seen: unknown[] = [];
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host: coreHost(),
      registerFonts: async (p) => {
        seen.push(p);
        return registerManifestFonts(p, fakePage());
      },
    });
    await session.start();
    expect(session.phase).toBe('ready');
    // The registrar gets a port derived from the backend's, whose manifest is read once.
    expect(seen.length).toBe(1);
    expect(Object.getPrototypeOf(seen[0])).toBe(fonts);
    // One read, shared by the registrar and the family lookup (FE-062 criterion 1).
    expect(fonts.calls).toBe(1);
    await session.close();
  });

  it('a manifest that cannot be read does not fail the load', async () => {
    const { service: s, docId } = service();
    const backend = backendFor(s, docId, 'editor', 'editor');
    Object.assign(backend, {
      fonts: { manifest: async () => Promise.reject(new Error('unavailable')) } satisfies FontsPort,
    });
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host: coreHost(),
      registerFonts: (p) => registerManifestFonts(p, fakePage()),
    });
    await session.start();
    expect(session.phase).toBe('ready');
    await session.close();
  });
});
