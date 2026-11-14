import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FontManifest } from '@docedit/export-latex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFontFiles, manifestFaces } from './font-files.ts';

// EXP-047 criterion 2: a hash in the manifest with no matching file fails the job with a diagnostic,
// and no other font is put in its place.

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docedit-fonts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A manifest whose file names are the hashes of the bytes written by `bytesFor`. */
function manifestFor(names: Record<string, Uint8Array>, fallback = false): FontManifest {
  const face = (key: string) => {
    const bytes = names[key]!;
    const hash = sha(bytes);
    return { file: `${hash}.ttf`, sha256: hash };
  };
  const family = (name: string, k: string) => ({
    name,
    lineHeight: 1362,
    regular: face(`${k}-r`),
    bold: face(`${k}-b`),
    italic: face(`${k}-i`),
    boldItalic: face(`${k}-bi`),
    licence: 'OFL-1.1',
  });
  const m: FontManifest = {
    version: 1,
    families: [family('Noto Serif', 'serif')],
    math: { name: 'STIX Two Math', ...face('math'), licence: 'OFL-1.1' },
    defaultFamily: 'Noto Serif',
  };
  if (fallback) {
    m.fallback = [{ name: 'Noto Sans Symbols', ...face('fb'), licence: 'OFL-1.1' }];
  }
  return m;
}

function fontBytes(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const keys = ['serif-r', 'serif-b', 'serif-i', 'serif-bi', 'math', 'fb'];
  keys.forEach((k, i) => (out[k] = new TextEncoder().encode(`font ${i} ${k} bytes`)));
  return out;
}

async function writeAll(manifest: FontManifest, bytesByFile: Map<string, Uint8Array>) {
  for (const f of manifestFaces(manifest)) {
    const b = bytesByFile.get(f.file);
    if (b) await writeFile(join(dir, f.file), b);
  }
}

describe('EXP-047 criterion 2: font files against the manifest', () => {
  it('passes when every manifest hash has a file of that hash', async () => {
    const bytes = fontBytes();
    const m = manifestFor(bytes, true);
    const byFile = new Map(manifestFaces(m).map((f) => [f.file, bytes[keyFor(f.face)]!]));
    await writeAll(m, byFile);
    const r = await checkFontFiles(m, dir);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('reports a hash with no matching file, naming the family, and substitutes nothing', async () => {
    const bytes = fontBytes();
    const m = manifestFor(bytes);
    const byFile = new Map<string, Uint8Array>();
    for (const f of manifestFaces(m)) {
      if (f.face !== 'bold') byFile.set(f.file, bytes[keyFor(f.face)]!);
    }
    await writeAll(m, byFile);
    const r = await checkFontFiles(m, dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({
      code: 'font_file_missing',
      family: 'Noto Serif',
      face: 'bold',
    });
    // The check reads only the manifest's names: no other file of the directory is used.
    expect(r.problems[0]!.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a file whose bytes do not hash to its name as a mismatch', async () => {
    const bytes = fontBytes();
    const m = manifestFor(bytes);
    const byFile = new Map<string, Uint8Array>();
    for (const f of manifestFaces(m)) byFile.set(f.file, bytes[keyFor(f.face)]!);
    // Replace the math face's bytes with other bytes under the same name.
    const math = manifestFaces(m).find((f) => f.face === 'math')!;
    byFile.set(math.file, new TextEncoder().encode('tampered'));
    await writeAll(m, byFile);
    const r = await checkFontFiles(m, dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      expect.objectContaining({
        code: 'font_file_mismatch',
        family: 'STIX Two Math',
        face: 'math',
        file: math.file,
      }),
    ]);
  });

  it('reports every missing file, one per file, in manifest order', async () => {
    const bytes = fontBytes();
    const m = manifestFor(bytes, true);
    await writeAll(m, new Map());
    const r = await checkFontFiles(m, dir);
    expect(r.problems.map((p) => p.face)).toEqual([
      'regular',
      'bold',
      'italic',
      'boldItalic',
      'math',
      'fallback',
    ]);
    expect(r.problems.every((p) => p.code === 'font_file_missing')).toBe(true);
  });

  it('lists a shared file once', () => {
    const bytes = fontBytes();
    const m = manifestFor(bytes);
    m.fallback = [{ ...m.math, name: 'Same as math', licence: 'OFL-1.1' }];
    const files = manifestFaces(m).map((f) => f.file);
    expect(new Set(files).size).toBe(files.length);
  });
});

/** The byte key of a face: the test uses one family, so only the face name matters. */
function keyFor(face: string): string {
  if (face === 'math') return 'math';
  if (face === 'fallback') return 'fb';
  const short: Record<string, string> = {
    regular: 'r',
    bold: 'b',
    italic: 'i',
    boldItalic: 'bi',
  };
  return `serif-${short[face]}`;
}
