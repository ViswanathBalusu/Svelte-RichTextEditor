/**
 * SEC-054 criterion 3 (10 §3.8; FE-061): when the editor loads fonts, they come from the font
 * manifest of the service, not from a public font service. Lane U-SEC-049-064. Node.js only: the
 * page's font set is a fake that records each FontFace the loader builds.
 *
 * The manifest is the shape the document service serves (`FontManifestBody`, fonts.ts). The
 * service writes each face as `${fontsBaseUrl}/${file}`, with fontsBaseUrl defaulting to its public
 * URL (config.ts). The test checks the element's side: each face the loader registers is one the
 * manifest lists, on the origin the manifest names, and no public font host or CDN appears in the
 * element's or the UI's sources.
 *
 * Run: pnpm vitest run tests/security/test/sec-054-font-origins.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  registerManifestFonts,
  type PageFonts,
} from '../../../packages/element/src/font-loader.ts';
import type { FontFaceLike } from '../../../packages/element/src/font-registration.ts';

const ORIGIN = 'https://docs.example.test';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const MANIFEST = {
  families: [
    {
      family: 'Sample Serif',
      licence: 'OFL-1.1',
      faces: [
        {
          url: `${ORIGIN}/fonts/sample-400.woff2`,
          sha256: 'a'.repeat(64),
          weight: 400,
          italic: false,
        },
        {
          url: `${ORIGIN}/fonts/sample-700i.woff2`,
          sha256: 'b'.repeat(64),
          weight: 700,
          italic: true,
        },
      ],
    },
  ],
};

/** Hosts of public font services and public script CDNs (10 §3.8: no third-party code at run time). */
const PUBLIC_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'use.typekit.net',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'code.jquery.com',
  'cdn.tailwindcss.com',
];

/** Each URL of the manifest's faces, as the loader was asked to register it. */
function registeredUrls(manifest: unknown): Promise<{ urls: string[]; faces: FontFaceLike[] }> {
  const faces: FontFaceLike[] = [];
  const set = {
    add: (f: FontFaceLike) => {
      faces.push(f);
      return set;
    },
    [Symbol.iterator]: () => faces[Symbol.iterator](),
  };
  const make: PageFonts['make'] = (alias, url, style, weight) => {
    const face: FontFaceLike = { family: `"${alias}"`, url, style, weight } as FontFaceLike & {
      url: string;
    };
    return face;
  };
  const port = { manifest: async () => manifest } as unknown as Parameters<
    typeof registerManifestFonts
  >[0];
  return registerManifestFonts(port, { set, make } as PageFonts).then(() => ({
    urls: faces.map((f) => (f as FontFaceLike & { url: string }).url),
    faces,
  }));
}

/** The URLs whose host is not the given origin's host. */
function offOrigin(urls: string[], origin: string): string[] {
  const host = new URL(origin).host;
  return urls.filter((u) => new URL(u).host !== host);
}

/** Every source file under a directory, excluding tests, as paths relative to the repository root. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .map((p) => String(p).replace(/\\/g, '/'))
    .filter((p) => /\.(ts|svelte|css|html)$/.test(p) && !/\.test\.ts$/.test(p))
    .filter((p) => !p.split('/').includes('dist') && !p.split('/').includes('node_modules'))
    .map((p) => `${dir}/${p}`);
}

describe('SEC-054 criterion 3: fonts come from the service manifest, not a public font service', () => {
  it('registers exactly the faces the manifest lists', async () => {
    const { urls } = await registeredUrls(MANIFEST);
    expect(urls).toEqual(MANIFEST.families[0]!.faces.map((f) => f.url));
  });

  it('every registered font is on the origin the manifest names', async () => {
    const { urls } = await registeredUrls(MANIFEST);
    expect(urls.length).toBe(2);
    expect(offOrigin(urls, ORIGIN)).toEqual([]);
  });

  it('no registered font is on a public font service or CDN', async () => {
    const { urls } = await registeredUrls(MANIFEST);
    const hosts = urls.map((u) => new URL(u).host);
    for (const h of hosts) expect(PUBLIC_HOSTS).not.toContain(h);
  });

  it('control: the origin check reports a face that a manifest names on a public service', async () => {
    const bad = {
      families: [
        {
          family: 'Sample Serif',
          licence: 'OFL-1.1',
          faces: [
            {
              url: 'https://fonts.googleapis.com/s/sample.woff2',
              sha256: 'c'.repeat(64),
              weight: 400,
              italic: false,
            },
          ],
        },
      ],
    };
    const { urls } = await registeredUrls(bad);
    expect(offOrigin(urls, ORIGIN)).toEqual(['https://fonts.googleapis.com/s/sample.woff2']);
  });

  it('no source of the element or the UI names a public font service or CDN', () => {
    const files = [...sourceFiles('packages/element/src'), ...sourceFiles('packages/ui/src')];
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8');
      for (const h of PUBLIC_HOSTS)
        if (text.includes(h)) found.push(`${relative('.', f)} names ${h}`);
    }
    expect(found).toEqual([]);
  });
});
