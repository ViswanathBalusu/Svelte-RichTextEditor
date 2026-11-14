// FE-061 criterion 5 (Node.js): a font a tenant adds to the manifest is registered like any other
// file, and a document family that names it resolves to the alias it was registered under. The
// page half (a real `document.fonts`) is not covered here; the set is a fake, as in
// `font-loader.test.ts`. The engine's view does not yet call the family lookup (FE-062 criterion 1),
// so the lookup is tested directly.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { registerManifestFonts, type PageFonts } from '../src/font-loader.ts';
import { familyAlias } from '../src/font-family-lookup.ts';
import { fontAlias, type FontFaceLike } from '../src/font-registration.ts';
import type { FontsPort } from '@docedit/protocol';

const hex = (n: number): string => n.toString(16).padStart(64, '0');
const BASE = hex(1);

/** A manifest body as `GET /fonts` serves it, with one tenant family added after the base family. */
function manifestWithTenant(tenantHash: string, tenantFamily: string) {
  return {
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
            url: `https://f.example/fonts/${BASE}.ttf`,
            sha256: BASE,
            bytes: 1,
            format: 'truetype',
          },
        ],
      },
      {
        family: tenantFamily,
        role: 'text',
        licence: 'Tenant-EULA',
        lineHeight: null,
        faces: [
          {
            style: 'regular',
            weight: 400,
            italic: false,
            url: `https://f.example/fonts/${tenantHash}.ttf`,
            sha256: tenantHash,
            bytes: 1,
            format: 'truetype',
          },
        ],
      },
    ],
  };
}

function portOf(body: unknown): FontsPort {
  return { manifest: async () => body as Record<string, unknown> } as FontsPort;
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

describe('a tenant font in the manifest (FE-061 criterion 5)', () => {
  it('is registered under its hash alias like the editor fonts', async () => {
    const tenant = hex(2);
    const page = fakePage();
    const aliases = await registerManifestFonts(
      portOf(manifestWithTenant(tenant, 'Tenant Serif')),
      page,
    );
    expect(aliases).toEqual([fontAlias(BASE), fontAlias(tenant)]);
    expect(page.made).toContain(`${fontAlias(tenant)} https://f.example/fonts/${tenant}.ttf`);
    expect(page.made.every((m) => !m.startsWith('Tenant Serif '))).toBe(true);
  });

  it('a document family that names the tenant font renders with the alias it was registered under', async () => {
    const tenant = hex(3);
    const body = manifestWithTenant(tenant, 'Tenant Serif');
    const page = fakePage();
    const aliases = await registerManifestFonts(portOf(body), page);
    expect(familyAlias(body, 'Tenant Serif')).toBe(fontAlias(tenant));
    expect(aliases).toContain(familyAlias(body, 'Tenant Serif'));
  });

  it('property: any tenant hash and family name is registered once and found by its family', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 2 ** 30 }),
        fc.stringMatching(/^[A-Z][a-z]{2,10}( [A-Z][a-z]{2,10})?$/),
        async (n, family) => {
          fc.pre(family !== 'Noto Serif');
          const tenant = hex(n);
          const body = manifestWithTenant(tenant, family);
          const page = fakePage();
          await registerManifestFonts(portOf(body), page);
          const tenantFaces = page.faces.filter((f) => f.family === fontAlias(tenant));
          expect(tenantFaces).toHaveLength(1);
          expect(familyAlias(body, family)).toBe(fontAlias(tenant));
        },
      ),
      { numRuns: 100 },
    );
  });
});
