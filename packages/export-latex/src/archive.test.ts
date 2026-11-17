/**
 * EXP-085 (Node.js only): the `tex` archive of a bundle. Criteria covered here: 1 (the archive holds
 * main.tex, styles.tex, docedit.cls, assets/, map.json and manifest.json, and no auxiliary file or
 * log), 2 (the README lists the fonts by hash and licence and says how to obtain them), 3 (the
 * README carries the compile restrictions: no shell escape, no network, paranoid file access and
 * LuaTeX 1.17 or later), and the first half of 4 (the class's licence is named; the licence files
 * left unticked in the story: the licence manifest of the packages is not in the archive (it is in
 * the worker image, EXP-073), and criterion 5 needs a LuaLaTeX compile of the archive, which this
 * package does not run. The documents come from `test/docs.ts`; nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import { CLASS_FILES, doc, para, run } from '../test/docs.ts';
import { archiveReadme, CLASS_LICENCE, texArchive } from './archive.ts';

const PNG_SHA = 'c'.repeat(64);
const ASSETS = {
  pic1: {
    sha256: PNG_SHA,
    mediaType: 'image/png',
    status: 'ready' as const,
    bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
  },
};

/** A figure, so the archive has an asset, and the class files of `test/docs.ts`. */
async function bundle() {
  return run(
    doc([
      para('Body text.'),
      {
        type: 'figure',
        attrs: {
          id: 'fig0000000000001',
          asset: 'pic1',
          width: 1440,
          height: 1440,
          alt: 'A picture',
        },
      },
    ]),
    { assets: ASSETS, seq: 3, chainHead: 'ab'.repeat(32), classFiles: CLASS_FILES },
  );
}

/** The members of a ustar archive as read by the standard (name at 0, size in octal at 124). */
function members(archive: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let at = 0;
  while (at + 512 <= archive.length) {
    const head = archive.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const nameEnd = head.indexOf(0);
    const name = dec.decode(head.subarray(0, nameEnd < 0 || nameEnd > 100 ? 100 : nameEnd));
    const size = parseInt(dec.decode(head.subarray(124, 135)).trim(), 8);
    expect(dec.decode(head.subarray(257, 262))).toBe('ustar');
    out.set(name, archive.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('EXP-085 criterion 1: the archive holds the bundle and nothing else', () => {
  it('holds main.tex, styles.tex, docedit.cls, assets/, map.json and manifest.json', async () => {
    const names = [...members(texArchive(await bundle())).keys()];
    for (const required of ['main.tex', 'styles.tex', 'docedit.cls', 'map.json', 'manifest.json'])
      expect(names).toContain(required);
    expect(names).toContain(`assets/${PNG_SHA}.png`);
  });

  it('holds no auxiliary file and no log', async () => {
    const names = [...members(texArchive(await bundle())).keys()];
    expect(
      names.filter((n) => /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|pdf)$/i.test(n)),
    ).toEqual([]);
  });

  it('stores each member with the bytes of the bundle', async () => {
    const b = await bundle();
    const got = members(texArchive(b));
    expect(new TextDecoder().decode(got.get('main.tex'))).toBe(b.files['main.tex']);
    expect(got.get(`assets/${PNG_SHA}.png`)).toEqual(b.assets[`assets/${PNG_SHA}.png`]);
  });

  it('gives the same bytes for the same bundle (09 §9.4)', async () => {
    const b = await bundle();
    expect(texArchive(b)).toEqual(texArchive(b));
  });
});

describe('EXP-085 criterion 2: the fonts are listed by hash and licence, and how to get them', () => {
  it('lists each font file with its family, role and licence, and states how to obtain them', async () => {
    const b = await bundle();
    const readme = archiveReadme(b);
    for (const font of b.manifest.fonts)
      for (const file of font.files) {
        expect(readme).toContain(file.file);
        expect(readme).toContain(file.sha256);
      }
    expect(readme).toContain('Noto Serif (text), OFL-1.1');
    expect(readme).toContain('STIX Two Math (math), OFL-1.1');
    expect(readme).toContain('DOCEDIT_FONT_PATH');
    expect(readme).toContain('check each SHA-256 before use');
  });
});

describe('EXP-085 criterion 3: the compile notice', () => {
  it('asks for the restrictions of the service: no shell escape, no network, paranoid file access, LuaTeX 1.17 or later', async () => {
    const readme = archiveReadme(await bundle());
    expect(readme).toContain('--no-shell-escape');
    expect(readme).toContain('shell_escape=f');
    expect(readme).toContain('no network');
    expect(readme).toContain('openin_any=p, openout_any=p');
    expect(readme).toContain('LuaTeX 1.17 or later');
  });

  it('is inside the archive as README.txt', async () => {
    const b = await bundle();
    const got = members(texArchive(b));
    expect(new TextDecoder().decode(got.get('README.txt'))).toBe(archiveReadme(b));
  });
});

describe('EXP-085 criterion 4 (in part): the class licence is named', () => {
  it('names the licence of the house class, which is the one the class files carry', async () => {
    const readme = archiveReadme(await bundle());
    expect(CLASS_LICENCE).toBe('Apache-2.0');
    expect(readme).toContain(`licensed under ${CLASS_LICENCE}`);
  });
});
