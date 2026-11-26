/**
 * EXP-121 criterion 4 (Node.js only): the `tex` archive of a document with citations holds
 * `references.bib` and compiles outside the service. "Outside" is the host's own LuaLaTeX and biber,
 * in an empty directory that holds only the archive's files, with the commands of the archive's
 * README and the fonts the README lists (the local copy of the worker image's font directory). The
 * test skips when the host has no `lualatex`, no `biber` or no local fonts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readTar } from '../../../services/export-worker/src/tar.ts';
import { doc, nid, para } from '../test/docs.ts';
import { classFiles, pdfText } from '../test/harness.ts';
import { texArchive } from './archive.ts';
import type { FontManifest } from './bundle.ts';
import { convert } from './index.ts';

const fonts = fileURLToPath(
  new URL('../../../services/export-worker/out/fonts-local/', import.meta.url),
);
const has = (cmd: string): boolean =>
  spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 60_000 }).status === 0;
const ready = existsSync(join(fonts, 'fonts.json')) && has('lualatex') && has('biber');
if (!ready) console.warn('skipped: no host lualatex, biber or local fonts');

describe.skipIf(!ready)('EXP-121 criterion 4: the tex target compiles outside the service', () => {
  it('holds references.bib and builds a PDF with the commands of its README', async () => {
    const manifest = JSON.parse(readFileSync(join(fonts, 'fonts.json'), 'utf8')) as FontManifest;
    const bundle = await convert(
      doc(
        [
          para('See', {}, [
            { type: 'citation', attrs: { items: [{ source: 's1' }], mode: 'normal' } },
          ]),
          { type: 'bibliography', attrs: { id: nid('b') } },
        ],
        {
          sources: [
            {
              type: 'source_def',
              attrs: {
                id: 's1',
                kind: 'book',
                title: 'A Book',
                authors: [{ family: 'Zed', given: 'Ann' }],
                issued: '2021',
                publisher: 'Press',
              },
            },
          ],
        },
      ),
      {
        fonts: manifest,
        classFiles: classFiles(),
        instant: '2026-11-06T10:00:00.000Z',
        timeZone: 'UTC',
      },
    );
    const allow = new Set([
      ...Object.keys(bundle.files),
      ...Object.keys(bundle.assets),
      'README.txt',
      'LICENCE.txt',
      'licences.json',
    ]);
    const files = readTar(texArchive(bundle), { allow, maxFileBytes: 16 * 1024 * 1024 });
    expect([...files.keys()]).toContain('references.bib');
    const readme = new TextDecoder().decode(files.get('README.txt')!);
    expect(readme).toContain('biber main');

    const dir = mkdtempSync(join(tmpdir(), 'docedit-tex-target-'));
    for (const [name, bytes] of files) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), bytes);
    }
    const env = {
      ...process.env,
      DOCEDIT_FONT_PATH: fonts.replaceAll('\\', '/'),
      SOURCE_DATE_EPOCH: '0',
      FORCE_SOURCE_DATE: '1',
    };
    const lua = (): number | null =>
      spawnSync(
        'lualatex',
        ['--no-shell-escape', '--interaction=nonstopmode', '--halt-on-error', 'main.tex'],
        { cwd: dir, env, encoding: 'utf8', timeout: 300_000 },
      ).status;
    expect(lua()).toBe(0);
    expect(spawnSync('biber', ['main'], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);
    expect(lua()).toBe(0);
    expect(lua()).toBe(0);
    const text = pdfText(new Uint8Array(readFileSync(join(dir, 'main.pdf'))))?.replace(/\s+/g, ' ');
    if (text) {
      expect(text).toContain('(Zed 2021)');
      expect(text).toContain('Zed, Ann (2021). A Book');
    }
  });
});
