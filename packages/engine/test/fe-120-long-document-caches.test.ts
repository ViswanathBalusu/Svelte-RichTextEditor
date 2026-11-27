/**
 * FE-120: three whole-document walks that ran on every keystroke are cached by node, or skipped for
 * an edit that cannot change their answer. The tests check that the answer is the one a walk over the
 * whole document gives, after edits of each kind, and that an edit leaves the lists of contents
 * alone only when it is plain text in an ordinary paragraph. The cost figures are in the perf
 * harness (packages/perf/e2e/fe-120-profile-300.harness.spec.ts), not here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { removedReferencedTargets, removedReferencedTargetsOf } from '../src/referenced-targets.ts';
import { editingSchema } from '../src/schema.ts';
import { isPlainTextEdit, tocContext, tocEntries, tocNodes } from '../src/toc-entries.ts';
import { tocPlugin } from '../src/view/toc-view.ts';
import { countBodyWords } from '../src/word-count.ts';
import { formFieldCount } from '../src/frw-072-form-fields.ts';

const style = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, builtIn: true, ...extra },
});
const t = (text: string) => ({ type: 'text', text });
const p = (id: string, styleId: string, ...content: unknown[]) => ({
  type: 'paragraph',
  attrs: { id, style: styleId },
  content,
});
const refTo = (target: string) => ({ type: 'field', attrs: { kind: 'ref', target, cached: null } });
const formField = (key: string) => ({
  type: 'form_field',
  attrs: { kind: 'text', key, id: `f${key}`.padEnd(16, 'x') },
});

function docOf(body: unknown[]): PMNode {
  return editingSchema().nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
          style('Normal'),
          style('Heading1', { basedOn: 'Normal', outlineLevel: 1 }),
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  });
}

/** Where the node with `id` is: its position, and the start and end of its content. */
function locate(doc: PMNode, id: string): { pos: number; start: number; end: number } {
  let out = { pos: 0, start: 0, end: 0 };
  doc.descendants((node, pos) => {
    if (node.attrs['id'] === id) out = { pos, start: pos + 1, end: pos + node.nodeSize - 1 };
    return true;
  });
  return out;
}

const toc = {
  type: 'toc',
  attrs: { id: 'tocxxxxxxxxxxxxx', minLevel: 1, maxLevel: 3, of: 'headings' },
};

/** The words by a plain walk, as the counter did before it kept a count for each node. */
function wordsByWalk(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    const name = node.type.name;
    if (name === 'defs' || name === 'story' || name === 'footnote') return false;
    if (node.isTextblock) {
      let text = '';
      node.forEach((child) => {
        text += child.isText ? (child.text ?? '') : ' ';
      });
      n += text.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      return false;
    }
    return true;
  });
  return n;
}

function fieldsByWalk(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === 'form_field') n++;
    return true;
  });
  return n;
}

const stateOf = (doc: PMNode, plugins: EditorState['plugins'] = []): EditorState =>
  EditorState.create({ doc, plugins });

describe('the word count and the form field count keep a count for each node (FE-120)', () => {
  const body = [
    p('p1xxxxxxxxxxxxxx', 'Normal', t('one two three')),
    p('p2xxxxxxxxxxxxxx', 'Normal', t('four five'), formField('a'), t(' six')),
    p('p3xxxxxxxxxxxxxx', 'Normal', t('seven')),
  ];

  it('count the words and the fields of a document, as a walk does', () => {
    const doc = docOf(body);
    expect(countBodyWords(doc)).toBe(wordsByWalk(doc));
    expect(countBodyWords(doc)).toBe(7);
    expect(formFieldCount(stateOf(doc))).toBe(fieldsByWalk(doc));
    expect(formFieldCount(stateOf(doc))).toBe(1);
  });

  it('follow an edit: typing, a deletion, a split and a field added', () => {
    let state = stateOf(docOf(body));
    const before = countBodyWords(state.doc);
    expect(before).toBe(7);
    const steps: Array<(tr: Transaction) => Transaction> = [
      (tr) => tr.insertText(' eight nine', 20),
      (tr) => tr.delete(5, 9),
      (tr) => tr.split(14),
      (tr) => tr.insert(30, state.schema.nodeFromJSON(formField('b'))),
    ];
    for (const edit of steps) {
      const tr = edit(state.tr);
      if (!tr.docChanged) continue;
      state = state.apply(tr);
      expect(countBodyWords(state.doc)).toBe(wordsByWalk(state.doc));
      expect(formFieldCount(state)).toBe(fieldsByWalk(state.doc));
    }
    expect(countBodyWords(state.doc)).not.toBe(before);
  });
});

describe('the referenced-target guard looks at the changed span only (FE-120)', () => {
  const doc = docOf([
    p('p1xxxxxxxxxxxxxx', 'Normal', t('see '), refTo('node:p3xxxxxxxxxxxxxx')),
    p('p2xxxxxxxxxxxxxx', 'Normal', t('middle text')),
    p('p3xxxxxxxxxxxxxx', 'Normal', t('the target')),
  ]);

  it('gives the answer of the whole-document check for typing, a deletion and a removed target', () => {
    const state = stateOf(doc);
    const other = locate(doc, 'p2xxxxxxxxxxxxxx');
    const target = locate(doc, 'p3xxxxxxxxxxxxxx');
    const edits: Array<[string, (tr: Transaction) => Transaction]> = [
      ['typing in another paragraph', (tr) => tr.insertText('x', other.end)],
      ['typing in the target paragraph', (tr) => tr.insertText('x', target.end)],
      ['deleting the target paragraph', (tr) => tr.delete(target.pos, target.end + 1)],
      ['a split of the target paragraph', (tr) => tr.split(target.start + 3)],
    ];
    for (const [name, edit] of edits) {
      const tr = edit(state.tr);
      expect(tr.docChanged, name).toBe(true);
      expect(removedReferencedTargetsOf(state.doc, tr.doc, tr), name).toEqual(
        removedReferencedTargets(state.doc, tr.doc),
      );
    }
  });

  it('still refuses the removal of a target that a reference names', () => {
    const state = stateOf(doc);
    const target = locate(doc, 'p3xxxxxxxxxxxxxx');
    const tr = state.tr.delete(target.pos, target.end + 1);
    expect(removedReferencedTargetsOf(state.doc, tr.doc, tr)).toEqual(['node:p3xxxxxxxxxxxxxx']);
  });

  it('checks a transaction whose steps have no range as a whole (an attribute change)', () => {
    const state = stateOf(doc);
    const tr = state.tr.setNodeAttribute(
      locate(doc, 'p3xxxxxxxxxxxxxx').pos,
      'id',
      'renamedxxxxxxxxx',
    );
    expect(removedReferencedTargetsOf(state.doc, tr.doc, tr)).toEqual(
      removedReferencedTargets(state.doc, tr.doc),
    );
    expect(removedReferencedTargetsOf(state.doc, tr.doc, tr)).toEqual(['node:p3xxxxxxxxxxxxxx']);
  });
});

describe('the lists of contents are kept for a plain text edit (FE-120)', () => {
  const doc = docOf([
    toc,
    p('h1xxxxxxxxxxxxxx', 'Heading1', t('Chapter one')),
    p('p1xxxxxxxxxxxxxx', 'Normal', t('some body text')),
    p('p2xxxxxxxxxxxxxx', 'Normal', t('more'), refTo('node:h1xxxxxxxxxxxxxx')),
  ]);
  const at = (id: string) => locate(doc, id);
  const listJson = (state: EditorState): string[] =>
    tocNodes(state.doc).map(({ node }) => JSON.stringify(tocEntries(tocContext(state.doc), node)));
  const decorated = (state: EditorState): string[] => {
    const found: string[] = [];
    const set = (tocPlugin().props.decorations as (s: EditorState) => unknown).call(
      null,
      state,
    ) as { find(): Array<{ spec: { toc?: string } }> } | null;
    for (const d of set?.find() ?? []) if (d.spec.toc !== undefined) found.push(d.spec.toc);
    return found;
  };

  it('is a plain text edit only for text in a paragraph with no level and no inline node', () => {
    const state = stateOf(doc);
    const body = at('p1xxxxxxxxxxxxxx');
    expect(isPlainTextEdit(state.tr.insertText('x', body.end))).toBe(true);
    expect(isPlainTextEdit(state.tr.delete(body.start, body.start + 2))).toBe(true);
    // A heading changes an entry, a paragraph with a field may be a caption, a split adds a block.
    expect(isPlainTextEdit(state.tr.insertText('x', at('h1xxxxxxxxxxxxxx').end))).toBe(false);
    expect(isPlainTextEdit(state.tr.insertText('x', at('p2xxxxxxxxxxxxxx').start + 1))).toBe(false);
    expect(isPlainTextEdit(state.tr.split(body.start + 3))).toBe(false);
    expect(isPlainTextEdit(state.tr)).toBe(false);
  });

  it('gives the lists a full computation gives, after plain edits and after heading edits', () => {
    const plugin = tocPlugin();
    let state = stateOf(doc, [plugin]);
    const edits: Array<(s: EditorState) => Transaction> = [
      (s) => s.tr.insertText(' added', at('p1xxxxxxxxxxxxxx').end),
      (s) => s.tr.insertText('Zero. ', 2 + 1),
      (s) => s.tr.insertText('!', at('h1xxxxxxxxxxxxxx').end),
    ];
    for (const edit of edits) {
      const tr = edit(state);
      if (!tr.docChanged) continue;
      state = state.apply(tr);
      // Whatever the plugin kept or rebuilt, it equals the lists computed from the document.
      expect(decorated(state)).toEqual(listJson(state));
    }
    expect(listJson(state)[0]).toContain('Chapter one!');
  });
});
