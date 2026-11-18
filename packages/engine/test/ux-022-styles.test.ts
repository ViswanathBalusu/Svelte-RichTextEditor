/**
 * The styles pane's core side (UX-022). Criterion 4: a user who may only suggest applies a style and
 * it is recorded as a formatting suggestion, for the three kinds of style. Further criteria are added
 * to this file as they are met. Node.js, headless core.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { resolveSuggestions } from '../src/suggestion-resolve.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { caret, microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };

/** The styled document with a table style `Grid` and a table of one cell in the body. */
function tableDocument(): CdmEnvelope {
  const env = styledDocument();
  const defs = (env.doc as Json).content!.find((c) => c.type === 'defs')!;
  defs.content!.splice(1, 0, {
    type: 'style_def',
    attrs: { id: 'Grid', kind: 'table', name: 'Grid table' },
  });
  const edit = new DocumentCore({ doc: env, schedule: microtask });
  const i = internals(edit);
  const { schema } = i;
  const cell = schema.nodes['table_cell']!.create(
    null,
    schema.nodes['paragraph']!.create(null, schema.text('Cell')),
  );
  const table = schema.nodes['table']!.create({ grid: [1440], headerRows: 0 }, [
    schema.nodes['table_row']!.create(null, [cell]),
  ]);
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, table));
  return edit.getContent();
}

/** A user who may suggest in the body and nothing more (07 §1). */
function suggestOnly(): ReturnType<typeof styledEditorAccess> {
  const base = styledEditorAccess();
  return {
    ...base,
    docRole: 'suggester',
    caps: ['view', 'comment', 'suggest'],
    scopes: { ...base.scopes, body: ['view', 'comment', 'suggest'] },
  };
}

function suggester(doc: CdmEnvelope = styledDocument()): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc,
    access: suggestOnly(),
    schedule: microtask,
    user: 'sam',
    generateId: () => `s${String(++n).padStart(15, '0')}`,
  });
}

const marksOf = (node: PMNode) => node.marks.map((m) => m.type.name);
const nodeAt = (c: DocumentCore, id: string) => {
  const doc = internals(c).state.doc;
  return doc.nodeAt(posOf(doc, id))!;
};

describe('UX-022 criterion 4: a style applied by a user who may only suggest', () => {
  it('records a paragraph style as a formatting suggestion and keeps the style until resolved', () => {
    const c = suggester();
    expect(c.mode.get().effective).toBe('review');
    caret(c, STYLE_IDS.plain, 2);
    expect(c.run('paragraphStyle', { style: 'Quote' })).toBe(true);
    const node = nodeAt(c, STYLE_IDS.plain);
    expect(node.attrs['style']).toBe('Quote');
    const fmt = node.marks.find((m) => m.type.name === 'fmt');
    expect(fmt?.attrs['user']).toBe('sam');
    expect(fmt?.attrs['before']).toEqual({ attrs: { style: null } });
    expect(node.textContent).toBe('Plain text');
  });

  it('records a character style on the selected text as a formatting suggestion', () => {
    const c = suggester();
    const i = internals(c);
    const at = posOf(i.state.doc, STYLE_IDS.plain) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at, at + 5)));
    expect(c.run('charStyle', { charStyle: 'Emphasis' })).toBe(true);
    const runs: Array<{ text: string; marks: string[] }> = [];
    nodeAt(c, STYLE_IDS.plain).forEach((child) =>
      runs.push({ text: child.text ?? '', marks: marksOf(child) }),
    );
    expect(runs[0]).toMatchObject({ text: 'Plain' });
    expect(runs[0]!.marks).toContain('charStyle');
    expect(runs[0]!.marks).toContain('fmt');
    expect(runs[1]!.marks).not.toContain('fmt');
  });

  it('records a table style as a formatting suggestion on the table', () => {
    const c = suggester(tableDocument());
    const i = internals(c);
    let at = -1;
    i.state.doc.descendants((node, pos) => {
      if (node.type.name === 'table_cell') at = pos + 2;
      return at < 0;
    });
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)));
    expect(c.run('setTableStyle', { tableStyle: 'Grid' })).toBe(true);
    let table: PMNode | null = null;
    i.state.doc.descendants((node) => {
      if (node.type.name === 'table') table = node;
      return table === null;
    });
    expect(table!.attrs['style']).toBe('Grid');
    expect(marksOf(table!)).toContain('fmt');
    // Rejecting takes the style back; accepting keeps it.
    const all = { from: 0, to: i.state.doc.content.size };
    const rejected = i.state.apply(resolveSuggestions(i.state, 'reject', all).tr);
    const accepted = i.state.apply(resolveSuggestions(i.state, 'accept', all).tr);
    const tableOf = (doc: PMNode): PMNode => {
      let found: PMNode | null = null;
      doc.descendants((n) => {
        if (n.type.name === 'table') found = n;
        return found === null;
      });
      return found!;
    };
    expect(tableOf(rejected.doc).attrs['style']).toBeNull();
    expect(marksOf(tableOf(rejected.doc))).not.toContain('fmt');
    expect(tableOf(accepted.doc).attrs['style']).toBe('Grid');
    expect(marksOf(tableOf(accepted.doc))).not.toContain('fmt');
  });
});
