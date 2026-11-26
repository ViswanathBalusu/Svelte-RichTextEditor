/**
 * EXP-033 criterion 6, the width case (Node.js): the log line the house class writes for a value
 * wider than its field (`docedit: field too wide N`) becomes a `field_too_wide` warning whose block
 * is the field's identifier, read from `map.json` (`fields`), never from the message. A number the
 * converter did not issue gives a warning with no block. The class side is compiled in
 * `packages/export-latex/src/exp-033-field-width.compile.test.ts`.
 */
import type { SourceMap } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import { CODES, parseLog } from './diagnostics.ts';

const map: SourceMap = {
  version: 1,
  blocks: [null, 'pAAAAAAAAAAAAAAA'],
  kinds: ['', 'paragraph'],
  owners: [null, null],
  lines: [{ from: 1, to: 20, block: 1 }],
  setups: ['ps1'],
  fields: [null, 'ff-one', 'ff-two'],
};

describe('EXP-033 criterion 6: field_too_wide', () => {
  it('is a warning in the catalogue', () => {
    expect(CODES.field_too_wide.severity).toBe('warning');
  });

  it('names the field of the number in the log line', () => {
    const log = ['This is LuaHBTeX', 'docedit: field too wide 2', 'docedit: field too wide 1'];
    const { entries } = parseLog(log.join('\n'), map);
    expect(entries.map((e) => [e.code, e.severity, e.blockId])).toEqual([
      ['field_too_wide', 'warning', 'ff-two'],
      ['field_too_wide', 'warning', 'ff-one'],
    ]);
  });

  it('reports a field once, however often the class logs it', () => {
    const { entries } = parseLog('docedit: field too wide 1\ndocedit: field too wide 1\n', map);
    expect(entries).toHaveLength(1);
  });

  it('gives no block for a number the converter never issued', () => {
    const { entries } = parseLog('docedit: field too wide 9\ndocedit: field too wide 0', map);
    expect(entries.map((e) => e.blockId)).toEqual([null]);
    expect(parseLog('docedit: field too wide 1', null).entries[0]!.blockId).toBeNull();
  });

  it('ignores lines that only imitate the shape', () => {
    const log = [
      'text docedit: field too wide 1',
      'docedit: field too wide 1 and more',
      'docedit: field too wide -3',
      'docedit: field too wide ',
    ].join('\n');
    expect(parseLog(log, map).entries).toEqual([]);
  });
});
