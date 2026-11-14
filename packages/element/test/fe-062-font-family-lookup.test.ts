// FE-062 criterion 1 (lookup half): a run's family is looked up in the font manifest and renders
// with the alias of the file that serves it; the family name is unchanged. Node.js only. The
// substitute table, the fallback and the wiring into the engine's view are not covered here.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { faceForFamily, familyAlias } from '../src/font-family-lookup.ts';
import { FONT_ALIAS_PREFIX, fontAlias } from '../src/font-registration.ts';

const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

function manifest(faces: Array<{ family: string; weight: number; italic: boolean; n: number }>) {
  const byFamily = new Map<string, unknown[]>();
  for (const f of faces) {
    const list = byFamily.get(f.family) ?? [];
    list.push({
      url: `https://fonts.example/${f.n}.woff2`,
      sha256: hashOf(f.n),
      weight: f.weight,
      italic: f.italic,
    });
    byFamily.set(f.family, list);
  }
  return {
    families: [...byFamily].map(([family, list]) => ({ family, licence: 'OFL-1.1', faces: list })),
  };
}

describe('FE-062 family lookup', () => {
  it('returns the alias of the normal, weight 400 face of the family', () => {
    const m = manifest([
      { family: 'Noto Serif', weight: 700, italic: false, n: 1 },
      { family: 'Noto Serif', weight: 400, italic: false, n: 2 },
      { family: 'Noto Serif', weight: 400, italic: true, n: 3 },
    ]);
    expect(familyAlias(m, 'Noto Serif')).toBe(fontAlias(hashOf(2)));
    expect(faceForFamily(m, 'Noto Serif')?.url).toBe('https://fonts.example/2.woff2');
  });

  it('falls back to the first face in manifest order when no normal 400 face exists', () => {
    const m = manifest([
      { family: 'Mono X', weight: 700, italic: false, n: 4 },
      { family: 'Mono X', weight: 400, italic: true, n: 5 },
    ]);
    expect(familyAlias(m, 'Mono X')).toBe(fontAlias(hashOf(4)));
  });

  it('returns undefined for a family the manifest does not list, and for a non-manifest value', () => {
    const m = manifest([{ family: 'Noto Serif', weight: 400, italic: false, n: 1 }]);
    expect(familyAlias(m, 'Aptos')).toBeUndefined();
    expect(familyAlias(undefined, 'Noto Serif')).toBeUndefined();
    expect(familyAlias('not a manifest', 'Noto Serif')).toBeUndefined();
  });

  it('matches the family name exactly, without case folding', () => {
    const m = manifest([{ family: 'Noto Serif', weight: 400, italic: false, n: 1 }]);
    expect(familyAlias(m, 'noto serif')).toBeUndefined();
  });

  it('property: every alias is the prefix plus a hash the manifest lists, and the name is not used as alias', () => {
    const familyArb = fc.constantFrom('Alpha', 'Beta', 'Gamma', 'Delta');
    const faceArb = fc.record({
      family: familyArb,
      weight: fc.constantFrom(100, 400, 700),
      italic: fc.boolean(),
      n: fc.integer({ min: 1, max: 500 }),
    });
    fc.assert(
      fc.property(
        fc.array(faceArb, { minLength: 1, maxLength: 12 }),
        familyArb,
        (faces, family) => {
          const m = manifest(faces);
          const alias = familyAlias(m, family);
          if (alias === undefined) {
            expect(faces.some((f) => f.family === family)).toBe(false);
            return;
          }
          expect(alias.startsWith(FONT_ALIAS_PREFIX)).toBe(true);
          expect(alias).not.toBe(family);
          const hashes = faces
            .filter((f) => f.family === family)
            .map((f) => fontAlias(hashOf(f.n)));
          expect(hashes).toContain(alias);
        },
      ),
      { numRuns: 200 },
    );
  });
});
