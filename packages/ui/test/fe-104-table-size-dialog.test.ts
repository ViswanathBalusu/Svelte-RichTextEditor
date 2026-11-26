/**
 * FE-104 criterion 1 and 3 in the shell: the table size dialog makes the `setTableSize` arguments a
 * column drag would store, and the commands that move a block and set a table's size are registered
 * with the queries and command names the core must list. The effect on the document is the engine's
 * (packages/engine/test/fe-104-keyboard-alternatives.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { coreCommands } from '../src/commands/builtin.ts';
import { CORE_QUERY_NAMES_1B } from '../src/commands/queries.ts';
import type { TableSizeView } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { TWIPS_PER_CM } from '../src/shell/ruler.ts';
import { tableSizeArgs, tableSizeFields } from '../src/shell/table-size-dialog.ts';

const cm = (n: number): number => Math.round(n * TWIPS_PER_CM);
const view = (over: Partial<TableSizeView> = {}): TableSizeView => ({
  columnWidths: [cm(4), cm(6)],
  rowHeight: null,
  row: 0,
  column: 0,
  editable: true,
  ...over,
});

describe('table size dialog fields', () => {
  it('shows the widths in centimetres and a blank height for the natural one', () => {
    const f = tableSizeFields(view());
    expect(f.columns).toEqual(['4', '6']);
    expect(f.rowHeight).toBe('');
    expect(tableSizeFields(view({ rowHeight: cm(2) })).rowHeight).toBe('2');
  });

  it('makes no arguments when nothing changed', () => {
    const v = view();
    expect(tableSizeArgs(v, tableSizeFields(v))).toEqual({ args: null, invalid: [] });
  });

  it('makes the widths in twips and only what changed', () => {
    const v = view();
    const f = tableSizeFields(v);
    f.columns[1] = '7,5';
    const result = tableSizeArgs(v, f);
    expect(result.invalid).toEqual([]);
    expect(result.args).toEqual({ columnWidths: [cm(4), cm(7.5)] });
    f.rowHeight = '1.5';
    expect(tableSizeArgs(v, f).args).toEqual({
      columnWidths: [cm(4), cm(7.5)],
      rowHeight: cm(1.5),
    });
  });

  it('returns a row to its natural height when the field is cleared', () => {
    const v = view({ rowHeight: cm(1) });
    const f = tableSizeFields(v);
    f.rowHeight = '  ';
    expect(tableSizeArgs(v, f).args).toEqual({ rowHeight: null });
  });

  it('names the fields that hold no length the CDM can store', () => {
    const v = view();
    const f = tableSizeFields(v);
    f.columns[0] = 'wide';
    f.columns[1] = '0';
    f.rowHeight = '-1';
    const result = tableSizeArgs(v, f);
    expect(result.args).toBeNull();
    expect(result.invalid).toEqual(['column0', 'column1', 'rowHeight']);
    f.columns = ['4', '600'];
    f.rowHeight = '';
    expect(tableSizeArgs(v, f).invalid).toEqual(['column1']);
  });
});

describe('the commands of FE-104', () => {
  const entries = coreCommands();
  const byId = (id: string) => entries.find((e) => e.id === id);

  it('registers the two block moves with the names the core must list', () => {
    for (const [id, name, query] of [
      ['edit.moveBlockUp', 'moveBlockUp', 'canMoveBlockUp'],
      ['edit.moveBlockDown', 'moveBlockDown', 'canMoveBlockDown'],
    ] as const) {
      const entry = byId(id)!;
      expect(entry.needs).toBe(name);
      expect(entry.enabled).toBe(query);
      expect(entry.changesContent).toBe(true);
      expect(CORE_QUERY_NAMES_1B).toContain(query);
      expect(EN_GB[entry.label as keyof typeof EN_GB]).toBeTypeOf('string');
    }
    expect(CORE_QUERY_NAMES_1B).toContain('canSetTableSize');
  });

  it('gives each reason the engine states a sentence', () => {
    for (const code of ['firstBlock', 'lastBlock', 'notInTable', 'notMovable']) {
      expect(EN_GB[`reason.query.${code}` as keyof typeof EN_GB]).toBeTypeOf('string');
    }
  });
});
