// FRW-057 criterion 3: the whole layout.json is checked against its schema before any rectangle of it
// is used (09 section 7.1). The check is shared by the export worker, which writes the file, and the
// document service, which reads it.
import { describe, expect, it } from 'vitest';
import { validateLayoutFile } from '../src/index.ts';

const good = () => ({
  seq: 3,
  classVersion: '1.0.0',
  granularity: 'line',
  unit: 'twip',
  pages: [
    {
      n: 1,
      setup: 'main',
      starts: { blockId: 'AAAAAAAAAAAAAAAA', offset: 0, y: 720 },
      opensWith: 'text',
    },
    { n: 2, setup: null, starts: null, opensWith: 'float' },
  ],
  blocks: {
    AAAAAAAAAAAAAAAA: {
      page: 1,
      y: 720,
      lineStarts: [0, 40],
      linePages: [1, 2],
      granularity: 'block',
    },
  },
  fields: { BBBBBBBBBBBBBBBB: { page: 2, rect: [400, 3000, 2400, 3600] } },
});

describe('validateLayoutFile (FRW-057 criterion 3)', () => {
  it('accepts a file that follows the schema, with a null seq as well', () => {
    expect(validateLayoutFile(good())).toEqual([]);
    expect(validateLayoutFile({ ...good(), seq: null })).toEqual([]);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'layout'],
  ])('refuses %s', (_name, value) => {
    expect(validateLayoutFile(value)).toEqual(['not an object']);
  });

  it('names what fails: members, header, pages, blocks and fields', () => {
    const f = good() as Record<string, unknown>;
    expect(validateLayoutFile({ ...f, extra: true })).toContain('unknown member extra');
    expect(validateLayoutFile({ ...f, seq: -1 })).toContain('seq');
    expect(validateLayoutFile({ ...f, unit: 'pt' })).toContain('unit');
    expect(validateLayoutFile({ ...f, granularity: 'word' })).toContain('granularity');
    expect(validateLayoutFile({ ...f, classVersion: '1.0' })).toContain('classVersion');
    expect(validateLayoutFile({ ...f, pages: [null] })).toContain('pages[0]');
    expect(validateLayoutFile({ ...f, pages: [{ ...good().pages[1], n: 5 }] })).toContain(
      'pages[0].n',
    );
    expect(validateLayoutFile({ ...f, blocks: { short: { page: 1, y: 0 } } })).toContain(
      'blocks key short',
    );
    expect(validateLayoutFile({ ...f, blocks: { AAAAAAAAAAAAAAAA: { page: 3, y: 0 } } })).toContain(
      'blocks.AAAAAAAAAAAAAAAA',
    );
  });

  it('refuses a rectangle outside the pages of the file or of no sense', () => {
    const at = (page: unknown, rect: unknown) =>
      validateLayoutFile({ ...good(), fields: { BBBBBBBBBBBBBBBB: { page, rect } } });
    expect(at(3, [1, 2, 3, 4])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(0, [1, 2, 3, 4])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(1, [10, 2, 3, 4])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(1, [1, 20, 3, 4])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(1, [1, 2, 3])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(1, [-1, 2, 3, 4])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(1, [1, 2, 3, 2_000_000])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(at(1, [1.5, 2, 3, 4])).toEqual(['fields.BBBBBBBBBBBBBBBB']);
    expect(
      validateLayoutFile({ ...good(), fields: { short: { page: 1, rect: [1, 2, 3, 4] } } }),
    ).toEqual(['fields key short']);
    expect(validateLayoutFile({ ...good(), fields: { BBBBBBBBBBBBBBBB: null } })).toEqual([
      'fields.BBBBBBBBBBBBBBBB',
    ]);
  });
});
