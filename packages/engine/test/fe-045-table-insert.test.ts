/**
 * Inserting a whole table as a suggestion (FE-045 criterion 3, lane w1; 02 §5.2; 03 §5). The core is
 * headless, in review mode for `alice`: `insertTable` is dispatched through the core, which records
 * the new table as one `ins` node mark on the table, with none on its rows. Deleting a whole table is
 * `fe-045-table-suggest.test.ts` ('whole-table suggestions'). The resolve builder takes the mark on
 * accept and reject.
 */
import { validate } from '@docedit/model/validate';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { resolveSuggestions } from '../src/suggestion-resolve.ts';
import { insertTable } from '../src/table.ts';
import { blockEntries } from '../src/block-suggestion.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';
import { microtask } from './support.ts';

function reviewer(user = 'alice'): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc: spikeDocument(),
    schedule: microtask,
    mode: 'review',
    user,
    access: editorAccess(),
    generateId: () => `t${String(++n).padStart(15, '0')}`,
  });
}

function tables(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'table') out.push(node);
    return true;
  });
  return out;
}

const marksOf = (node: PMNode): string[] => blockEntries(node).map((e) => e.type);

function inserted(c: DocumentCore): void {
  const i = internals(c);
  expect(insertTable([1440, 1440], 2)(i.state, i.dispatch)).toBe(true);
}

describe('inserting a whole table as a suggestion (FE-045 criterion 3)', () => {
  it('records the table with one ins node mark naming the user, and none on its rows', () => {
    const c = reviewer();
    inserted(c);
    const found = tables(internals(c).state.doc);
    expect(found).toHaveLength(1);
    const table = found[0]!;
    expect(blockEntries(table).map((e) => [e.type, e.attrs.user])).toEqual([['ins', 'alice']]);
    expect(table.childCount).toBe(2);
    table.forEach((row) => expect(marksOf(row)).toEqual([]));
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('puts the caret in the first cell of the new table', () => {
    const c = reviewer();
    inserted(c);
    const { $from } = internals(c).state.selection;
    const names: string[] = [];
    for (let d = $from.depth; d > 0; d--) names.push($from.node(d).type.name);
    expect(names).toContain('table_cell');
    expect(names).toContain('table');
  });

  it('outside review mode inserts a plain table with no mark', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      schedule: microtask,
      access: editorAccess(),
    });
    inserted(c);
    expect(marksOf(tables(internals(c).state.doc)[0]!)).toEqual([]);
  });

  it('rejecting the suggestion removes the table, and accepting it keeps the table without the mark', () => {
    const c = reviewer();
    inserted(c);
    const state = internals(c).state;
    const everything = { from: 0, to: state.doc.content.size };
    const rejected = state.apply(resolveSuggestions(state, 'reject', everything).tr);
    expect(tables(rejected.doc)).toHaveLength(0);
    const accepted = state.apply(resolveSuggestions(state, 'accept', everything).tr);
    expect(tables(accepted.doc)).toHaveLength(1);
    expect(marksOf(tables(accepted.doc)[0]!)).toEqual([]);
  });

  it('lets the same user delete the table they inserted, which removes it outright', () => {
    const c = reviewer();
    inserted(c);
    expect(c.run('deleteTable')).toBe(true);
    expect(tables(internals(c).state.doc)).toHaveLength(0);
  });
});
