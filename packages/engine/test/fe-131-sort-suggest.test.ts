/**
 * FE-131 criterion 4: under suggestion mode a sort of table rows is unavailable, with the
 * `suggestion` reason, and it changes nothing. The other branch the criterion allows (the
 * reordering proposed as whole-row suggestions) is not built; the choice is proposed in ADR 0365.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';
import { microtask } from './support.ts';

/** The spike document with a 3 by 2 table in the body, its first column out of order. */
function tableDocument(): CdmEnvelope {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(c);
  const { schema } = i;
  const table = schema.nodes['table']!.create(
    { grid: [1440, 1440], headerRows: 0 },
    ['c', 'a', 'b'].map((text) =>
      schema.nodes['table_row']!.create(
        null,
        [text, `${text}2`].map((t) =>
          schema.nodes['table_cell']!.create(
            null,
            schema.nodes['paragraph']!.create(null, schema.text(t)),
          ),
        ),
      ),
    ),
  );
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, table));
  return c.getContent();
}

function tablePos(doc: PMNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'table') found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error('no table');
  return found;
}

function firstColumn(doc: PMNode): string[] {
  const table = doc.nodeAt(tablePos(doc))!;
  const out: string[] = [];
  table.forEach((row) => out.push(row.child(0).textContent));
  return out;
}

/** Puts the caret in the first cell of the table. */
function caretInTable(c: DocumentCore): void {
  const i = internals(c);
  const pos = tablePos(i.state.doc) + 4;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

describe('sorting rows under suggestion mode (FE-131 criterion 4)', () => {
  it('is available and sorts in edit mode', () => {
    const editor = new DocumentCore({ doc: tableDocument(), schedule: microtask });
    caretInTable(editor);
    expect(editor.queryCommand('sortTableRows', { sortDirection: 'ascending' })).toEqual({
      enabled: true,
      active: false,
    });
    expect(editor.run('sortTableRows', { sortDirection: 'ascending' })).toBe(true);
    expect(firstColumn(internals(editor).state.doc)).toEqual(['a', 'b', 'c']);
  });

  it('is unavailable with the suggestion reason, refused, and changes nothing', () => {
    const c = new DocumentCore({
      doc: tableDocument(),
      schedule: microtask,
      mode: 'review',
      user: 'alice',
      access: editorAccess(),
    });
    caretInTable(c);
    for (const sortDirection of ['ascending', 'descending'] as const) {
      expect(c.queryCommand('sortTableRows', { sortDirection })).toEqual({
        enabled: false,
        active: false,
        reason: 'suggestion',
      });
      const before = internals(c).state.doc;
      expect(c.run('sortTableRows', { sortDirection })).toBe(false);
      expect(c.exec('sortTableRows', { sortDirection })).toBe(false);
      expect(internals(c).state.doc.eq(before)).toBe(true);
      expect(c.refusal.get()?.reason).toBe('suggestion');
    }
    expect(firstColumn(internals(c).state.doc)).toEqual(['c', 'a', 'b']);
  });
});
