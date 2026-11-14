// The font manifest (BE-047) on a font directory written by the test: a family enters the manifest
// only with a licence that permits bundling and server use, every file is published under its
// SHA-256 after its content is checked against that hash, and the ETag changes with the set.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCatalogue, fontFileHandler, fontsEtag, loadFontCatalogue } from './fonts.ts';

const BASE = 'https://docs.example.test/fonts';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const contents = new Map<string, Buffer>();

/** Writes a family whose four faces are distinct files named by their hash. */
function family(name: string, licence: string, tag: string) {
  const face = (style: string) => {
    const bytes = Buffer.from(`${tag}-${style}-bytes`);
    const hash = sha(bytes);
    contents.set(`${hash}.ttf`, bytes);
    return { file: `${hash}.ttf`, sha256: hash };
  };
  return {
    name,
    licence,
    regular: face('regular'),
    bold: face('bold'),
    italic: face('italic'),
    boldItalic: face('boldItalic'),
  };
}

async function writeDir(families: unknown[], defaultFamily?: string) {
  const d = await mkdtemp(join(tmpdir(), 'docedit-fonts-'));
  for (const [file, bytes] of contents) await writeFile(join(d, file), bytes);
  await writeFile(
    join(d, 'fonts.json'),
    JSON.stringify({ version: 1, families, ...(defaultFamily ? { defaultFamily } : {}) }),
  );
  return d;
}

const req = (method: string) => ({ method }) as unknown as IncomingMessage;

const dirs: string[] = [];
beforeAll(() => {
  contents.clear();
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('the font manifest (BE-047)', () => {
  it('lists a family only with a licence that permits bundling and server use, and records the licence (criterion 1)', async () => {
    const open = family('Serif Text', 'OFL-1.1', 'serif');
    const closed = family('Closed Sans', 'LicenseRef-Proprietary', 'closed');
    dirs.push(await writeDir([open, closed], 'Serif Text'));
    const cat = await loadFontCatalogue(dirs.at(-1)!, BASE);
    expect(cat.manifest.families.map((f) => f.family)).toEqual(['Serif Text']);
    expect(cat.manifest.families[0]!.licence).toBe('OFL-1.1');
    expect(cat.manifest.defaultFamily).toBe('Serif Text');
    expect(cat.excluded).toEqual([
      { family: 'Closed Sans', reason: 'the licence LicenseRef-Proprietary is not on the list' },
    ]);
    // A file of the excluded family is not published.
    const closedHash = sha(Buffer.from('closed-regular-bytes'));
    expect(cat.files.has(`${closedHash}.ttf`)).toBe(false);
    // The list of licences is a setting: a narrower list leaves the OFL family out too.
    const narrow = await loadFontCatalogue(dirs.at(-1)!, BASE, { licences: ['MIT'] });
    expect(narrow.manifest.families).toEqual([]);
    expect(narrow.manifest.defaultFamily).toBeNull();
  });

  it('publishes each face at its SHA-256 and refuses a file whose content does not match (criterion 2)', async () => {
    const good = family('Hashed', 'OFL-1.1', 'hashed');
    const tampered = family('Tampered', 'OFL-1.1', 'tampered');
    // The file of the tampered family's regular face is replaced by other bytes under its hash.
    const wrongHash = tampered.regular.sha256;
    contents.set(`${wrongHash}.ttf`, Buffer.from('other bytes entirely'));
    dirs.push(await writeDir([good, tampered]));
    const cat = await loadFontCatalogue(dirs.at(-1)!, BASE);
    expect(cat.manifest.families.map((f) => f.family)).toEqual(['Hashed']);
    expect(cat.excluded).toEqual([
      { family: 'Tampered', reason: 'a file does not match its SHA-256' },
    ]);
    const face = cat.manifest.families[0]!.faces[0]!;
    expect(face.url).toBe(`${BASE}/${face.sha256}.ttf`);
    expect(face.sha256).toBe(good.regular.sha256);
    expect(
      cat.files
        .get(`${good.regular.sha256}.ttf`)
        ?.bytes.equals(contents.get(`${good.regular.sha256}.ttf`)!),
    ).toBe(true);
    // The file is served by hash, immutable and readable from any origin.
    const handler = fontFileHandler(() => cat);
    const hit = await handler(req('GET'), new URL(`http://x/fonts/${good.regular.sha256}.ttf`));
    expect(hit.status).toBe(200);
    expect(hit.headers?.['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(hit.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(hit.headers?.['Content-Type']).toBe('font/ttf');
    const miss = await handler(req('GET'), new URL(`http://x/fonts/${'0'.repeat(64)}.ttf`));
    expect(miss.status).toBe(404);
    const notHash = await handler(req('GET'), new URL('http://x/fonts/regular.ttf'));
    expect(notHash.status).toBe(404);
  });

  it('changes the version and the ETag when the set changes, and keeps both when it does not (criterion 3)', async () => {
    const a = family('Stable', 'OFL-1.1', 'stable');
    dirs.push(await writeDir([a]));
    const first = await loadFontCatalogue(dirs.at(-1)!, BASE);
    const again = await loadFontCatalogue(dirs.at(-1)!, BASE);
    expect(fontsEtag(again.manifest)).toBe(fontsEtag(first.manifest));
    // A family added to the set changes the version.
    const b = family('Added', 'OFL-1.1', 'added');
    dirs.push(await writeDir([a, b]));
    const bigger = await loadFontCatalogue(dirs.at(-1)!, BASE);
    expect(bigger.manifest.version).not.toBe(first.manifest.version);
    expect(fontsEtag(bigger.manifest)).not.toBe(fontsEtag(first.manifest));
    // Only a change of a licence changes it too: the same bytes under another licence.
    const aMit = family('Stable', 'MIT', 'stable');
    dirs.push(await writeDir([aMit]));
    const relicensed = await loadFontCatalogue(dirs.at(-1)!, BASE);
    expect(relicensed.manifest.version).not.toBe(first.manifest.version);
    // The URL does not enter the version: the set names the fonts wherever they are served.
    const moved = await loadFontCatalogue(dirs.at(-1)!, 'https://elsewhere.example.test/fonts');
    expect(moved.manifest.version).toBe(relicensed.manifest.version);
    expect(fontsEtag(emptyCatalogue().manifest)).not.toBe(fontsEtag(first.manifest));
  });
});
