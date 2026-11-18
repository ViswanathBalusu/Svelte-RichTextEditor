// FE-062 criteria 2 and 3: a proprietary family the manifest maps to an open one renders with the
// open file's alias; a family with no open substitute (Aptos) renders with the manifest's default
// family and is marked as reflowing; the document's family name is never changed. Node.js only,
// through the production lookup (`manifestFamilyLookup`) over a body in the shape of `GET /fonts`.
import type { FontsPort } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { manifestFamilyLookup } from '../src/font-loader.ts';
import { manifestSubstitutes, resolveFamily } from '../src/font-family-lookup.ts';
import { fontAlias } from '../src/font-registration.ts';

const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

const OPEN: Array<[string, number]> = [
  ['Carlito', 1],
  ['Caladea', 2],
  ['Liberation Sans', 3],
  ['Liberation Serif', 4],
  ['Liberation Mono', 5],
];

const SUBSTITUTES = [
  { family: 'Calibri', replacement: 'Carlito' },
  { family: 'Cambria', replacement: 'Caladea' },
  { family: 'Arial', replacement: 'Liberation Sans' },
  { family: 'Times New Roman', replacement: 'Liberation Serif' },
  { family: 'Courier New', replacement: 'Liberation Mono' },
];

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0'.repeat(64),
    defaultFamily: 'Liberation Sans',
    families: OPEN.map(([family, n]) => ({
      family,
      role: 'text',
      licence: 'OFL-1.1',
      lineHeight: null,
      faces: [
        {
          style: 'regular',
          weight: 400,
          italic: false,
          url: `/fonts/${hashOf(n)}.ttf`,
          sha256: hashOf(n),
        },
      ],
    })),
    substitutes: SUBSTITUTES,
    ...extra,
  };
}

const port = (m: unknown): FontsPort => ({ manifest: async () => m }) as unknown as FontsPort;

describe('substitutes in the manifest (FE-062 criterion 2)', () => {
  it('renders each proprietary family with the alias of its open substitute', async () => {
    const lookup = await manifestFamilyLookup(port(body()));
    const open = new Map(OPEN);
    for (const line of SUBSTITUTES) {
      const n = open.get(line.replacement) ?? 0;
      expect(lookup(line.family), line.family).toBe(fontAlias(hashOf(n)));
    }
  });

  it('keeps the document name: the lookup only returns an alias and resolveFamily names the way', () => {
    const found = resolveFamily(body(), 'Calibri');
    expect(found?.via).toBe('substitute');
    expect(found?.reflows).toBe(false);
    expect(found?.face.family).toBe('Carlito');
  });

  it('compares families without case or surrounding spaces, as Word does', async () => {
    const lookup = await manifestFamilyLookup(port(body()));
    expect(lookup('  calibri ')).toBe(fontAlias(hashOf(1)));
    expect(lookup('TIMES  NEW ROMAN')).toBe(fontAlias(hashOf(4)));
  });

  it('lets the first line that names a family decide, so a tenant line placed first wins', async () => {
    const lookup = await manifestFamilyLookup(
      port(
        body({
          substitutes: [{ family: 'Calibri', replacement: 'Caladea' }, ...SUBSTITUTES],
        }),
      ),
    );
    expect(lookup('Calibri')).toBe(fontAlias(hashOf(2)));
  });

  it('prefers a face the manifest holds under the family name over a substitute line', async () => {
    const m = body();
    (m['families'] as unknown[]).push({
      family: 'Calibri',
      role: 'text',
      licence: 'tenant',
      lineHeight: null,
      faces: [{ style: 'regular', weight: 400, italic: false, url: '/c.ttf', sha256: hashOf(9) }],
    });
    const lookup = await manifestFamilyLookup(port(m));
    expect(lookup('Calibri')).toBe(fontAlias(hashOf(9)));
  });

  it('leaves out a malformed line, and a line whose replacement has no face falls to the default', async () => {
    expect(manifestSubstitutes(body({ substitutes: [1, {}, { family: 'A' }, null] }))).toEqual([]);
    expect(manifestSubstitutes({ substitutes: 'x' })).toEqual([]);
    const lookup = await manifestFamilyLookup(
      port(body({ substitutes: [{ family: 'Calibri', replacement: 'Nowhere' }] })),
    );
    expect(lookup('Calibri')).toBe(fontAlias(hashOf(3)));
    expect(
      resolveFamily(
        body({ substitutes: [{ family: 'Calibri', replacement: 'Nowhere' }] }),
        'Calibri',
      )?.via,
    ).toBe('default');
  });
});

describe('a family with no open substitute (FE-062 criterion 3)', () => {
  it('renders Aptos with the default family and says the text reflows; nothing throws', async () => {
    const found = resolveFamily(body(), 'Aptos');
    expect(found?.via).toBe('default');
    expect(found?.reflows).toBe(true);
    expect(found?.face.family).toBe('Liberation Sans');
    const lookup = await manifestFamilyLookup(port(body()));
    expect(lookup('Aptos')).toBe(fontAlias(hashOf(3)));
  });

  it('gives nothing when the manifest has no default family either', async () => {
    const lookup = await manifestFamilyLookup(port(body({ defaultFamily: null })));
    expect(lookup('Aptos')).toBeUndefined();
    expect(lookup('Calibri')).toBe(fontAlias(hashOf(1)));
  });

  it('property: every family the lookup resolves gives a hash alias of a file the manifest lists, never the family name', async () => {
    const families = fc.oneof(
      fc.constantFrom('Calibri', 'Arial', 'Aptos', 'Carlito', 'Segoe UI', 'Courier New'),
      fc.string({ minLength: 1, maxLength: 12 }),
    );
    const lookup = await manifestFamilyLookup(port(body()));
    const aliases = new Set(OPEN.map(([, n]) => fontAlias(hashOf(n))));
    fc.assert(
      fc.property(families, (family) => {
        const alias = lookup(family);
        expect(alias).toBeDefined();
        expect(aliases.has(alias ?? '')).toBe(true);
        expect(alias).not.toBe(family);
      }),
      { numRuns: 200 },
    );
  });
});
