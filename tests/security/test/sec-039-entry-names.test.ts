/**
 * SEC-039 criterion 6: an entry name that climbs out of the package is refused with the file.
 *
 * The zip reader (`readZip` of packages/export-docx/src/zip.ts) reads the central directory of an
 * archive. A name that is absolute, has a drive letter, has a backslash, or has a `..` segment is a
 * refusal (`ZipError`), so the importer never sees it. The properties build archives with the real
 * writer and read them back with the real reader. Node.js only (vitest, fast-check). No network.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readZip, writeZip } from '../../../packages/export-docx/src/index.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);

const enc = new TextEncoder();
const archiveOf = (name: string): Uint8Array => writeZip([{ name, data: enc.encode('<x/>') }]);

const SEGMENT = fc.stringMatching(/^[a-zA-Z0-9_]{1,8}$/);
const SAFE_NAME = fc
  .array(SEGMENT, { minLength: 1, maxLength: 4 })
  .map((s) => `${s.join('/')}.xml`);

describe('SEC-039 criterion 6: entry names inside the package are read', () => {
  it('reads every name made of plain segments', () => {
    fc.assert(
      fc.property(SAFE_NAME, (name) => {
        const zip = readZip(archiveOf(name));
        expect(zip.byName.has(name)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SEC-039 criterion 6: entry names that leave the package are refused', () => {
  it('refuses a `..` segment at any position of a name', () => {
    fc.assert(
      fc.property(
        fc.array(SEGMENT, { minLength: 0, maxLength: 3 }),
        fc.array(SEGMENT, { minLength: 0, maxLength: 3 }),
        (before, after) => {
          const name = [...before, '..', ...after, 'f.xml'].join('/');
          expect(() => readZip(archiveOf(name))).toThrow(/outside the package/);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it.each([
    '../escape.xml',
    'word/../../escape.xml',
    '/absolute.xml',
    'C:/windows/win.xml',
    'word\\..\\x.xml',
  ])('refuses the name %j', (name) => {
    expect(() => readZip(archiveOf(name))).toThrow(/outside the package/);
  });

  it('keeps a name that only contains dots inside a segment', () => {
    const zip = readZip(archiveOf('word/a..b.xml'));
    expect(zip.byName.has('word/a..b.xml')).toBe(true);
  });
});
