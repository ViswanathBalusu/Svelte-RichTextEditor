// The editor's font files on the page (FE-061): registration under hash-derived aliases, the host
// page's faces left alone, one alias per file for every instance, tenant entries registered like
// the others, and no @font-face rule in the component CSS. Runs in Node.js with a fake font set.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FONT_ALIAS_PREFIX,
  fontAlias,
  registerFontFiles,
  type FontFaceLike,
  type FontFaceSetLike,
  type FontFileEntry,
} from '../src/font-registration.ts';

/** A stand-in for a FontFaceSet: a list of faces, one of them added with `add`. */
function fakeSet(initial: FontFaceLike[] = []): FontFaceSetLike & { faces: FontFaceLike[] } {
  const faces = [...initial];
  return {
    faces,
    add(face) {
      faces.push(face);
      return undefined;
    },
    [Symbol.iterator]() {
      return faces[Symbol.iterator]();
    },
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = '0123456789abcdef'.repeat(4);

/** Any lowercase SHA-256 hex digest. */
const hashArb = fc
  .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 })
  .map((chars) => chars.join(''));

function entry(
  family: string,
  hash: string,
  url = `https://fonts.example/${hash}.woff2`,
): FontFileEntry {
  return { family, style: 'normal', weight: '400', url, hash, licence: 'OFL-1.1' };
}

/** Records what the factory was asked to build, and returns a face named after the alias. */
function recordingFactory(): {
  make: (alias: string, url: string, style: string, weight: string) => FontFaceLike;
  calls: { alias: string; url: string; style: string; weight: string }[];
} {
  const calls: { alias: string; url: string; style: string; weight: string }[] = [];
  return {
    calls,
    make(alias, url, style, weight) {
      calls.push({ alias, url, style, weight });
      return { family: alias };
    },
  };
}

describe('the alias of a font file (FE-061 criterion 1)', () => {
  it('is the prefix and the file hash, and never the family name', () => {
    expect(fontAlias(HASH_A)).toBe(`${FONT_ALIAS_PREFIX}${HASH_A}`);
    expect(fontAlias(HASH_A)).not.toBe('Noto Serif');
  });

  it('is derived from the hash only: the same file under another family gets the same alias', () => {
    const family = fc.string({ minLength: 1, maxLength: 30 });
    fc.assert(
      fc.property(hashArb, family, family, (hash, f1, f2) => {
        const a = registerFontFiles([entry(f1, hash)], fakeSet(), recordingFactory().make);
        const b = registerFontFiles([entry(f2, hash)], fakeSet(), recordingFactory().make);
        expect(a).toEqual(b);
        expect(a[0]).not.toBe(f1);
        expect(a[0]).toBe(fontAlias(hash));
      }),
    );
  });

  it('refuses a hash that is not a lowercase SHA-256 digest', () => {
    expect(() => fontAlias('Noto Serif')).toThrow(TypeError);
    expect(() => fontAlias('A'.repeat(64))).toThrow(TypeError);
    expect(() => fontAlias('a'.repeat(63))).toThrow(TypeError);
  });

  it('registers the face under the alias with the manifest URL and descriptors', () => {
    const set = fakeSet();
    const factory = recordingFactory();
    registerFontFiles(
      [entry('Noto Serif', HASH_A, 'https://f.example/a.woff2')],
      set,
      factory.make,
    );
    expect(factory.calls).toEqual([
      {
        alias: fontAlias(HASH_A),
        url: 'https://f.example/a.woff2',
        style: 'normal',
        weight: '400',
      },
    ]);
    expect(set.faces).toEqual([{ family: fontAlias(HASH_A) }]);
  });
});

describe('the host page keeps its own fonts (FE-061 criterion 2)', () => {
  it('does not add or replace a host face of the same family name', () => {
    const hostFace = { family: 'Noto Serif' };
    const set = fakeSet([hostFace]);
    registerFontFiles([entry('Noto Serif', HASH_A)], set, recordingFactory().make);
    expect(set.faces[0]).toBe(hostFace);
    expect(set.faces.filter((f) => f.family === 'Noto Serif')).toHaveLength(1);
    expect(set.faces.map((f) => f.family)).toEqual(['Noto Serif', fontAlias(HASH_A)]);
  });
});

describe('two instances or versions share one alias per file (FE-061 criterion 3)', () => {
  it('adds a file once when a second instance registers it on the same set', () => {
    const set = fakeSet();
    const factory = recordingFactory();
    const first = registerFontFiles([entry('Noto Serif', HASH_A)], set, factory.make);
    const second = registerFontFiles([entry('Noto Serif', HASH_A)], set, factory.make);
    expect(first).toEqual(second);
    expect(factory.calls).toHaveLength(1);
    expect(set.faces).toHaveLength(1);
  });

  it('keeps two different files under two aliases', () => {
    const set = fakeSet();
    const aliases = registerFontFiles(
      [entry('Noto Serif', HASH_A), entry('Noto Serif', HASH_B)],
      set,
      recordingFactory().make,
    );
    expect(new Set(aliases).size).toBe(2);
    expect(set.faces).toHaveLength(2);
  });
});

describe('tenant fonts (FE-061 criterion 5)', () => {
  it('registers a tenant font in the manifest like any other', () => {
    const set = fakeSet();
    const factory = recordingFactory();
    const [alias] = registerFontFiles([entry('Acme Sans', HASH_B)], set, factory.make);
    expect(alias).toBe(fontAlias(HASH_B));
    expect(factory.calls[0]?.alias).toBe(fontAlias(HASH_B));
  });
});

describe('the component CSS has no @font-face rule (FE-061 criterion 4, first part)', () => {
  it('contains no @font-face in any stylesheet of the element', () => {
    const dir = new URL('../src/styles/', import.meta.url);
    const css = readdirSync(dir).filter((name) => name.endsWith('.css'));
    expect(css.length).toBeGreaterThan(0);
    for (const name of css) {
      expect(readFileSync(new URL(name, dir), 'utf8')).not.toMatch(/@font-face/i);
    }
  });
});
