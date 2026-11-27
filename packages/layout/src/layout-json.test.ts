/**
 * The typesetter's `layout.json` is read and validated before anything uses it (FE-100 criterion 6;
 * 09 §7.1; EXP-055). The example is the one in 09 §7.1.
 */
import { describe, expect, it } from 'vitest';
import { validateLayoutJson } from './layout-json.ts';
import { adoptablePins } from './reconcile.ts';

function example(): Record<string, unknown> {
  return {
    seq: 416,
    classVersion: '1.3.0',
    granularity: 'line',
    pages: [
      {
        n: 1,
        setup: 'ps1',
        starts: { blockId: 'p3Jq8sLw0aZx1VbN', offset: 0 },
        opensWith: 'text',
      },
      {
        n: 2,
        setup: 'ps1',
        starts: { blockId: 'pA1b2C3d4E5f6G7h', offset: 412 },
        opensWith: 'tableHead',
      },
    ],
    blocks: { pA1b2C3d4E5f6G7h: { lineStarts: [0, 96, 188, 301, 412, 498] } },
    fields: { fQ2x8Lm0aZx1VbN7: { page: 2, rect: [1440, 9020, 3360, 9300] } },
  };
}

function problemsOf(value: unknown): readonly string[] {
  const check = validateLayoutJson(value);
  if (check.ok) throw new Error('expected the file to be refused');
  return check.problems;
}

describe('validateLayoutJson (FE-100 criterion 6)', () => {
  it('accepts the example of 09 section 7.1 and keeps its fields', () => {
    const check = validateLayoutJson(example());
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.layout.seq).toBe(416);
    expect(check.layout.granularity).toBe('line');
    expect(check.layout.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(check.layout.pages[1]?.starts).toEqual({ blockId: 'pA1b2C3d4E5f6G7h', offset: 412 });
    expect(check.layout.blocks['pA1b2C3d4E5f6G7h']?.lineStarts).toEqual([
      0, 96, 188, 301, 412, 498,
    ]);
    expect(check.layout.fields['fQ2x8Lm0aZx1VbN7']?.rect).toEqual([1440, 9020, 3360, 9300]);
  });

  it('accepts a block-granularity file with no blocks and no fields', () => {
    const value = { ...example(), granularity: 'block' };
    delete (value as Record<string, unknown>)['blocks'];
    delete (value as Record<string, unknown>)['fields'];
    const check = validateLayoutJson(value);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.layout.blocks).toEqual({});
  });

  it('refuses a value that is not an object', () => {
    expect(problemsOf(null)).toEqual(['the file must be a JSON object']);
    expect(problemsOf([])).toEqual(['the file must be a JSON object']);
    expect(problemsOf('layout')).toEqual(['the file must be a JSON object']);
  });

  it('refuses an unknown key at the top level and inside a page, and names its path', () => {
    const value = example();
    value['extra'] = 1;
    const pages = value['pages'] as Record<string, unknown>[];
    pages[0]!['surprise'] = true;
    const problems = problemsOf(value);
    expect(problems).toContain('$: unknown key "extra"');
    expect(problems).toContain('pages[0]: unknown key "surprise"');
  });

  it('refuses a bad seq, class version or granularity', () => {
    const value = { ...example(), seq: -1, classVersion: '', granularity: 'word' };
    const problems = problemsOf(value);
    expect(problems).toContain('seq: must be a non-negative integer');
    expect(problems).toContain('classVersion: must be a non-empty string');
    expect(problems.some((p) => p.startsWith('granularity: must be one of'))).toBe(true);
  });

  it('refuses an empty pages list and pages that are not numbered from 1 in order', () => {
    expect(problemsOf({ ...example(), pages: [] })).toContain('pages: must be a non-empty array');
    const value = example();
    (value['pages'] as Record<string, unknown>[])[1]!['n'] = 3;
    expect(problemsOf(value)).toContain(
      'pages[1].n: must be 2, pages are numbered from 1 in order',
    );
  });

  it('refuses a page whose opensWith is not one of the four values of 09 section 7.1', () => {
    const value = example();
    (value['pages'] as Record<string, unknown>[])[0]!['opensWith'] = 'picture';
    expect(problemsOf(value).some((p) => p.startsWith('pages[0].opensWith: must be one of'))).toBe(
      true,
    );
  });

  it('refuses a start with a negative or fractional offset and an empty block identifier', () => {
    const value = example();
    const pages = value['pages'] as Array<{ starts: Record<string, unknown> }>;
    pages[0]!.starts['offset'] = -1;
    pages[1]!.starts['blockId'] = '';
    expect(problemsOf(value)).toEqual([
      'pages[0].starts.offset: must be a non-negative integer',
      'pages[1].starts.blockId: must be a non-empty string',
    ]);
    const fractional = example();
    (fractional['pages'] as Array<{ starts: Record<string, unknown> }>)[0]!.starts['offset'] = 1.5;
    expect(problemsOf(fractional)).toEqual([
      'pages[0].starts.offset: must be a non-negative integer',
    ]);
  });

  it('refuses line starts that decrease', () => {
    const value = example();
    value['blocks'] = { pA1b2C3d4E5f6G7h: { lineStarts: [0, 96, 50] } };
    expect(problemsOf(value)).toEqual(['blocks.pA1b2C3d4E5f6G7h.lineStarts: must not decrease']);
  });

  it('refuses a field rectangle that is reversed or does not have four numbers', () => {
    const reversed = example();
    reversed['fields'] = { f1: { page: 2, rect: [3360, 9020, 1440, 9300] } };
    expect(problemsOf(reversed)).toEqual([
      'fields.f1.rect: right and bottom must not be less than left and top',
    ]);
    const short = example();
    short['fields'] = { f1: { page: 2, rect: [1, 2, 3] } };
    expect(problemsOf(short)).toEqual(['fields.f1.rect: must be four finite numbers']);
  });

  it('refuses a field on page 0', () => {
    const value = example();
    value['fields'] = { f1: { page: 0, rect: [1, 2, 3, 4] } };
    expect(problemsOf(value)).toEqual(['fields.f1.page: must be a page number from 1']);
  });

  it('lists every problem it finds, not only the first', () => {
    const value = { ...example(), seq: 'x', granularity: 'word', pages: 'many' };
    const problems = problemsOf(value);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateLayoutJson reads the file the export worker writes (FE-100 criterion 5)', () => {
  /** The shape of `LAYOUT_SCHEMA` in services/export-worker/src/layout.ts: every optional key set. */
  function workerFile(): Record<string, unknown> {
    return {
      seq: 7,
      classVersion: '1.3.0',
      granularity: 'line',
      unit: 'twip',
      pages: [
        {
          n: 1,
          setup: null,
          starts: { blockId: 'p0000000000000001', offset: 0, y: 1440 },
          opensWith: 'text',
        },
        { n: 2, setup: 'ps1', starts: null, opensWith: 'float' },
      ],
      blocks: {
        p0000000000000001: {
          page: 1,
          y: 1440,
          lineStarts: [0, 40, 81],
          linePages: [1, 1, 2],
          columnBreaks: [2],
        },
        t0000000000000002: { page: 2, y: 200, rowPages: [2, null, 3] },
        i0000000000000003: { page: 3, y: 0, granularity: 'block' },
      },
      fields: {},
    };
  }

  it('accepts the unit, the y of a start, a page with no setup or start, and the block keys', () => {
    const check = validateLayoutJson(workerFile());
    if (!check.ok) throw new Error(check.problems.join('; '));
    expect(check.layout.unit).toBe('twip');
    expect(check.layout.pages[0]?.setup).toBeNull();
    expect(check.layout.pages[1]?.starts).toBeNull();
    expect(check.layout.blocks['p0000000000000001']?.linePages).toEqual([1, 1, 2]);
    expect(check.layout.blocks['t0000000000000002']?.rowPages).toEqual([2, null, 3]);
    expect(check.layout.blocks['t0000000000000002']?.lineStarts).toEqual([]);
  });

  it('still refuses a unit other than twip, a null seq and a misshapen block key', () => {
    expect(problemsOf({ ...workerFile(), unit: 'pt' })).toEqual([
      'unit: must be "twip" when present',
    ]);
    expect(problemsOf({ ...workerFile(), seq: null })).toEqual([
      'seq: must be a non-negative integer',
    ]);
    const value = workerFile();
    (value['blocks'] as Record<string, Record<string, unknown>>)['p0000000000000001']![
      'linePages'
    ] = [1];
    expect(problemsOf(value)).toEqual([
      'blocks.p0000000000000001.linePages: must have one page for each line start',
    ]);
  });

  it('adopts no page start from a page without one, and no line starts from a block-level block', () => {
    const check = validateLayoutJson(workerFile());
    if (!check.ok) throw new Error(check.problems.join('; '));
    const pins = adoptablePins(check.layout, new Set(), 'line');
    expect(pins.pages).toEqual([{ page: 1, blockId: 'p0000000000000001', offset: 0 }]);
    expect(pins.keptOwnPages).toEqual([2]);
    expect(pins.lines.map((l) => l.offset)).toEqual([0, 40, 81]);
  });
});
