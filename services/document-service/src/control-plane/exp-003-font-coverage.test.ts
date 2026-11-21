// EXP-003 (the service's half of criterion 2): the font manifest of `GET /fonts` carries the
// character coverage of each face when the font set's own manifest records it, so that the editor's
// export preflight checks characters against the same coverage as the converter, which reads the
// same `fonts.json`. A font directory is written by the test; the files are not real fonts.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadFontCatalogue } from './fonts.ts';

const BASE = 'https://docs.example.test/fonts';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

interface Face {
  file: string;
  sha256: string;
  coverage?: unknown;
}

/** Writes a font directory; each face's bytes are made from its tag, and named by their hash. */
async function fontDir(
  coverageOf: (tag: string) => unknown,
): Promise<{ dir: string; face: (tag: string) => Face }> {
  const dir = await mkdtemp(join(tmpdir(), 'docedit-exp-003-fonts-'));
  dirs.push(dir);
  const files: Array<[string, Buffer]> = [];
  const face = (tag: string): Face => {
    const bytes = Buffer.from(`exp-003-${tag}`);
    const hash = sha(bytes);
    files.push([`${hash}.ttf`, bytes]);
    const coverage = coverageOf(tag);
    return { file: `${hash}.ttf`, sha256: hash, ...(coverage === undefined ? {} : { coverage }) };
  };
  const manifest = {
    version: 1,
    families: [
      {
        name: 'Serif Text',
        lineHeight: 1362,
        licence: 'OFL-1.1',
        regular: face('regular'),
        bold: face('bold'),
        italic: face('italic'),
        boldItalic: face('boldItalic'),
      },
    ],
    math: { ...face('math'), name: 'Math', licence: 'OFL-1.1' },
    fallback: [{ ...face('fallback'), name: 'Symbols', licence: 'OFL-1.1' }],
    defaultFamily: 'Serif Text',
  };
  for (const [name, bytes] of files) await writeFile(join(dir, name), bytes);
  await writeFile(join(dir, 'fonts.json'), JSON.stringify(manifest));
  return { dir, face };
}

describe('EXP-003 the font manifest carries the coverage the font set records', () => {
  it('publishes the ranges of every face, the math face and the fallback faces', async () => {
    const ranges: Record<string, Array<[number, number]>> = {
      regular: [
        [0x20, 0x7e],
        [0xa0, 0xff],
      ],
      bold: [[0x20, 0x7e]],
      italic: [[0x20, 0x7e]],
      boldItalic: [[0x20, 0x7e]],
      math: [[0x2200, 0x22ff]],
      fallback: [[0x2700, 0x27bf]],
    };
    const { dir } = await fontDir((tag) => ranges[tag]);
    const { manifest } = await loadFontCatalogue(dir, BASE);
    const text = manifest.families.find((f) => f.role === 'text')!;
    expect(text.faces.map((f) => [f.style, f.coverage])).toEqual([
      ['regular', ranges['regular']],
      ['bold', ranges['bold']],
      ['italic', ranges['italic']],
      ['boldItalic', ranges['boldItalic']],
    ]);
    expect(manifest.families.find((f) => f.role === 'math')!.faces[0]!.coverage).toEqual(
      ranges['math'],
    );
    expect(manifest.families.find((f) => f.role === 'fallback')!.faces[0]!.coverage).toEqual(
      ranges['fallback'],
    );
  });

  it('publishes no coverage for a set that records none', async () => {
    const { dir } = await fontDir(() => undefined);
    const { manifest } = await loadFontCatalogue(dir, BASE);
    for (const family of manifest.families)
      for (const face of family.faces) expect('coverage' in face).toBe(false);
  });

  it('leaves out a coverage that is not sorted pairs of code points, and keeps the face', async () => {
    const bad: Record<string, unknown> = {
      regular: 'all',
      bold: [[0x7e, 0x20]],
      italic: [[0x20, 0x110000]],
      boldItalic: [[0x20]],
      math: [[1.5, 2]],
      fallback: [[0x20, 0x7e]],
    };
    const { dir } = await fontDir((tag) => bad[tag]);
    const { manifest, excluded } = await loadFontCatalogue(dir, BASE);
    expect(excluded).toEqual([]);
    const text = manifest.families.find((f) => f.role === 'text')!;
    expect(text.faces).toHaveLength(4);
    for (const face of text.faces) expect(face.coverage).toBeUndefined();
    expect(manifest.families.find((f) => f.role === 'math')!.faces[0]!.coverage).toBeUndefined();
    expect(manifest.families.find((f) => f.role === 'fallback')!.faces[0]!.coverage).toEqual([
      [0x20, 0x7e],
    ]);
  });

  it('keeps the manifest version: the coverage follows from the files, which the version names', async () => {
    const withRanges = await fontDir(() => [[0x20, 0x7e]]);
    const without = await fontDir(() => undefined);
    const a = await loadFontCatalogue(withRanges.dir, BASE);
    const b = await loadFontCatalogue(without.dir, BASE);
    expect(a.manifest.version).toBe(b.manifest.version);
  });
});
