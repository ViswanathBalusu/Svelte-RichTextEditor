/**
 * The region guard (02 §5.2; 07 §5.5, §7; FE-036) and what a reader may not send (ADR 0019): every
 * refused change leaves the document as it was and puts nothing in the sync client's queue.
 */
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import { noNestedFootnote } from '../src/footnote.ts';
import { ReplaceStep } from 'prosemirror-transform';
import { undo } from 'prosemirror-history';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import {
  SPIKE_IDS,
  editorAccess,
  ownerAccess,
  projectedDocument,
  regionOnlyAccess,
  spikeDocument,
} from './fixtures.ts';
import { caret, microtask, posOf, type } from './support.ts';

const REGION = `region:${SPIKE_IDS.region}`;

function core(access = editorAccess(), doc = spikeDocument()): DocumentCore {
  return new DocumentCore({ doc, access, schedule: microtask });
}

/** Dispatches and reports whether the document changed and whether anything was queued. */
function attempt(c: DocumentCore, make: (i: ReturnType<typeof internals>) => void) {
  const i = internals(c);
  const doc = i.state.doc;
  const queued = unconfirmed(i.sync).length;
  make(i);
  return { changed: i.state.doc !== doc, queued: unconfirmed(internals(c).sync).length - queued };
}

describe('the region guard (FE-036)', () => {
  it('refuses typing in a scope without edit, suggest or fill; nothing is queued; the scopes are named', () => {
    const c = core();
    caret(c, SPIKE_IDS.legal, 3);
    const r = attempt(c, () => type(c, 'x'));
    expect(r).toEqual({ changed: false, queued: 0 });
    expect(c.refusal.get()).toEqual({ n: 1, reason: 'scope', scopes: [REGION] });
    // The body is editable.
    caret(c, SPIKE_IDS.after, 0);
    expect(attempt(c, () => type(c, 'y'))).toEqual({ changed: true, queued: 1 });
  });

  it('refuses mark-only and attribute-only changes too: scopes come from comparing documents', () => {
    const c = core();
    const i = internals(c);
    const p = posOf(i.state.doc, SPIKE_IDS.legal);
    const bold = i.schema.marks['italic']!.create({ value: true });
    expect(attempt(c, () => i.dispatch(i.state.tr.addMark(p + 1, p + 5, bold))).changed).toBe(
      false,
    );
    expect(
      attempt(c, () => i.dispatch(i.state.tr.setNodeAttribute(p, 'style', 'Heading1'))).changed,
    ).toBe(false);
    expect(c.refusal.get()?.scopes).toEqual([REGION]);
    expect(c.refusal.get()?.n).toBe(2);
  });

  it('a region the access does not list is not editable until an access lists it', () => {
    const listed = editorAccess();
    const access = editorAccess({
      scopes: Object.fromEntries(Object.entries(listed.scopes).filter(([k]) => k !== REGION)),
    });
    const c = core(access);
    // The editor could edit an inherit region, but an unlisted one is refused (05 §5.5).
    const i = internals(c);
    i.dispatch(
      i.state.tr.setNodeAttribute(posOf(i.state.doc, SPIKE_IDS.region), 'policy', 'inherit'),
    );
    caret(c, SPIKE_IDS.legal, 1);
    expect(attempt(c, () => type(c, 'x')).changed).toBe(false);
    expect(c.canEdit(REGION)).toBe(false);
    c.setAccess(
      editorAccess({
        rev: 2,
        asOfSeq: 1,
        scopes: { ...editorAccess().scopes, [REGION]: ['view', 'comment', 'suggest', 'edit'] },
      }),
    );
    expect(c.canEdit(REGION)).toBe(true);
    expect(attempt(c, () => type(c, 'x')).changed).toBe(true);
  });

  it('uses a new access at the next transaction (perm.changed), without a reload', () => {
    const c = core(ownerAccess());
    caret(c, SPIKE_IDS.legal, 1);
    expect(attempt(c, () => type(c, 'a')).changed).toBe(true);
    c.setAccess(editorAccess({ rev: 2 }));
    expect(attempt(c, () => type(c, 'b')).changed).toBe(false);
    c.setAccess(ownerAccess());
    expect(attempt(c, () => type(c, 'c')).changed).toBe(true);
  });

  it('refuses paste, drag and drop, inserted content, replace all and undo by the same guard', () => {
    const c = core(ownerAccess());
    const i = internals(c);
    // Made while the user could edit the region; undone after the grant is gone.
    caret(c, SPIKE_IDS.legal, 0);
    type(c, 'mine ');
    c.setAccess(editorAccess({ rev: 2 }));
    const legal = () => posOf(i.state.doc, SPIKE_IDS.legal);
    const slice = new Slice(Fragment.from(i.schema.text('pasted')), 0, 0);
    // Paste at a caret in the region.
    expect(
      attempt(c, () => {
        i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, legal() + 2)));
        i.dispatch(i.state.tr.replaceSelection(slice));
      }).changed,
    ).toBe(false);
    // Drag and drop: text moved from the body into the region.
    expect(
      attempt(c, () => {
        const from = posOf(i.state.doc, SPIKE_IDS.after) + 1;
        const tr = i.state.tr;
        const moved = tr.doc.slice(from, from + 6);
        tr.delete(from, from + 6);
        tr.replace(tr.mapping.map(legal() + 1), tr.mapping.map(legal() + 1), moved);
        i.dispatch(tr);
      }).changed,
    ).toBe(false);
    // insertContent: a paragraph inserted inside the region.
    expect(
      attempt(c, () => {
        i.dispatch(i.state.tr.insert(legal(), i.schema.nodes['paragraph']!.create()));
      }).changed,
    ).toBe(false);
    // Replace all: one transaction replacing a word in the body and in the region.
    expect(
      attempt(c, () => {
        const tr = i.state.tr;
        const body = posOf(tr.doc, SPIKE_IDS.after) + 1;
        tr.insertText('R', body, body + 1);
        tr.insertText('L', legal() + 1, legal() + 2);
        i.dispatch(tr);
      }).changed,
    ).toBe(false);
    // Undo of the change in the region.
    expect(attempt(c, () => undo(i.state, i.dispatch)).changed).toBe(false);
    expect(c.refusal.get()?.n).toBe(5);
  });

  it('refuses an input-method composition in a protected region by the same guard (FE-036 criterion 5)', () => {
    const c = core(ownerAccess());
    const i = internals(c);
    caret(c, SPIKE_IDS.legal, 0);
    type(c, 'mine ');
    c.setAccess(editorAccess({ rev: 2 }));
    const at = posOf(i.state.doc, SPIKE_IDS.legal) + 2;
    // prosemirror-view tags each transaction of a composition with the composition id, so the
    // composition's text, and its replacement of an open composition, reach the same filter.
    const before = i.state.doc;
    const typed = i.state.tr.insertText('k', at).setMeta('composition', 1);
    expect(attempt(c, () => i.dispatch(typed)).changed).toBe(false);
    const replaced = i.state.tr.insertText('ka', at - 1, at).setMeta('composition', 2);
    expect(attempt(c, () => i.dispatch(replaced)).changed).toBe(false);
    expect(i.state.doc.eq(before)).toBe(true);
    expect(c.refusal.get()?.n).toBeGreaterThanOrEqual(2);
  });

  it('allows a scope with suggest only, and the edit becomes a suggestion (FE-042)', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess({
        scopes: { ...editorAccess().scopes, [REGION]: ['view', 'comment', 'suggest'] },
      }),
      schedule: microtask,
      user: 'sam',
    });
    caret(c, SPIKE_IDS.legal, 1);
    expect(attempt(c, () => type(c, 's')).changed).toBe(true);
    const typed = internals(c).state.doc.nodeAt(internals(c).state.selection.from - 1)!;
    expect(typed.marks.map((m) => `${m.type.name}:${String(m.attrs['user'])}`)).toContain(
      'ins:sam',
    );
  });

  it('refuses changes to definitions, the page setup and headers to a user who may edit only regions', () => {
    const c = core(regionOnlyAccess());
    const i = internals(c);
    let normal = -1;
    let pageSetup = -1;
    i.state.doc.descendants((n, pos) => {
      if (n.type.name === 'style_def' && n.attrs['id'] === 'Normal') normal = pos;
      if (n.type.name === 'page_setup') pageSetup = pos;
      return n.type.name === 'doc' || n.type.name === 'defs';
    });
    expect(
      attempt(c, () => i.dispatch(i.state.tr.setNodeAttribute(normal, 'color', '#FF0000'))).changed,
    ).toBe(false);
    expect(c.refusal.get()?.scopes).toEqual(['defs']);
    expect(
      attempt(c, () => i.dispatch(i.state.tr.setNodeAttribute(pageSetup, 'marginTop', 720)))
        .changed,
    ).toBe(false);
    const header = posOf(i.state.doc, SPIKE_IDS.headerParagraph) + 1;
    expect(attempt(c, () => i.dispatch(i.state.tr.insertText('h', header))).changed).toBe(false);
    expect(c.refusal.get()?.scopes).toEqual([`story:${SPIKE_IDS.header}`]);
    // But the region is theirs, and existing styles can be applied there (07 §7).
    caret(c, SPIKE_IDS.legal, 1);
    expect(attempt(c, () => type(c, 'ok')).changed).toBe(true);
    expect(c.run('paragraphStyle', { style: 'Heading1' })).toBe(true);
  });

  it('refuses structural changes without structure, and a policy change without manage (P2)', () => {
    const c = core();
    const i = internals(c);
    const region = i.schema.nodeFromJSON({
      type: 'region',
      attrs: { title: 'New' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    });
    expect(
      attempt(c, () => i.dispatch(i.state.tr.insert(posOf(i.state.doc, SPIKE_IDS.last), region)))
        .changed,
    ).toBe(false);
    expect(c.refusal.get()?.reason).toBe('structure');
    const owner = core(ownerAccess());
    const o = internals(owner);
    expect(
      attempt(owner, () =>
        o.dispatch(o.state.tr.insert(posOf(o.state.doc, SPIKE_IDS.last), region)),
      ).changed,
    ).toBe(true);
    const ownerWithoutManage = core(
      editorAccess({
        caps: ['view', 'comment', 'suggest', 'edit', 'structure'],
        scopes: ownerAccess().scopes,
      }),
    );
    const m = internals(ownerWithoutManage);
    expect(
      attempt(ownerWithoutManage, () =>
        m.dispatch(
          m.state.tr.setNodeAttribute(posOf(m.state.doc, SPIKE_IDS.region), 'policy', 'inherit'),
        ),
      ).changed,
    ).toBe(false);
    expect(ownerWithoutManage.refusal.get()?.reason).toBe('manage');
  });

  it('refuses a footnote inside a footnote (I10), in the document and in the footnote panel', () => {
    const c = core(ownerAccess());
    const i = internals(c);
    const note = posOf(i.state.doc, SPIKE_IDS.footnoteParagraph) + 2; // inside the footnote's text
    const nested = i.schema.nodes['footnote']!.createAndFill()!;
    expect(attempt(c, () => i.dispatch(i.state.tr.insert(note, nested))).changed).toBe(false);
    expect(c.refusal.get()?.reason).toBe('invariant');
    // The panel's own state refuses it too, before anything reaches the document.
    const footnote = i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.footnote))!;
    const panel = EditorState.create({ doc: footnote, plugins: [noNestedFootnote()] });
    const pasted = panel.tr.replaceWith(2, 2, nested);
    expect(panel.apply(pasted)).toBe(panel);
    // A footnote elsewhere in the body is fine.
    const body = posOf(i.state.doc, SPIKE_IDS.last) + 3;
    expect(attempt(c, () => i.dispatch(i.state.tr.insert(body, nested))).changed).toBe(true);
  });

  it('refuses steps the authority never accepts (04 §4), even without an access', () => {
    const c = core(null as never);
    const i = internals(c);
    // A docAttr step (04 §4) is refused before it is sent.
    expect(attempt(c, () => i.dispatch(i.state.tr.setDocAttribute('ext', { x: 1 }))).changed).toBe(
      false,
    );
    expect(c.refusal.get()?.reason).toBe('step');
  });
});

describe('read restrictions in the core (ADR 0019; CDM-053)', () => {
  it('opens a projection with a placeholder; no position lies inside it', () => {
    const c = new DocumentCore({ doc: projectedDocument('Clause'), schedule: microtask });
    const doc = internals(c).state.doc;
    const at = posOf(doc, SPIKE_IDS.region);
    const node = doc.nodeAt(at)!;
    expect(node.type.name).toBe('hidden_region');
    expect(node.isAtom && node.isLeaf).toBe(true);
    expect(node.nodeSize).toBe(1);
    // A text selection can never be inside: the next text positions either side are in paragraphs.
    expect(Selection.findFrom(doc.resolve(at), 1, true)!.$from.parent.type.name).toBe('paragraph');
    expect(Selection.findFrom(doc.resolve(at + 1), -1, true)!.$from.parent.type.name).toBe(
      'paragraph',
    );
    // Selected whole, it is a node selection (selectable, CDM-053).
    expect(NodeSelection.isSelectable(node)).toBe(true);
    // Read back unchanged (ProseMirror writes the default attributes the input left out).
    const schema = internals(c).schema;
    expect(
      schema
        .nodeFromJSON(c.getContent().doc)
        .eq(schema.nodeFromJSON(projectedDocument('Clause').doc)),
    ).toBe(true);
  });

  it('refuses any change that touches or moves a placeholder, whatever the access says', () => {
    const c = new DocumentCore({
      doc: projectedDocument(),
      access: ownerAccess(),
      schedule: microtask,
    });
    const i = internals(c);
    const at = () => posOf(i.state.doc, SPIKE_IDS.region);
    // Deleting a range across it.
    expect(attempt(c, () => i.dispatch(i.state.tr.delete(at() - 3, at() + 3))).changed).toBe(false);
    expect(c.refusal.get()?.reason).toBe('placeholder');
    // Deleting it alone, selected whole.
    expect(
      attempt(c, () => {
        i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at())));
        i.dispatch(i.state.tr.deleteSelection());
      }).changed,
    ).toBe(false);
    // Changing its attributes.
    expect(
      attempt(c, () => i.dispatch(i.state.tr.setNodeAttribute(at(), 'title', 'x'))).changed,
    ).toBe(false);
    // Pasting a copy of it.
    expect(
      attempt(c, () => {
        const copy = i.state.doc.slice(at(), at() + 1);
        i.dispatch(
          i.state.tr.step(
            new ReplaceStep(
              posOf(i.state.doc, SPIKE_IDS.last),
              posOf(i.state.doc, SPIKE_IDS.last),
              copy,
            ),
          ),
        );
      }).changed,
    ).toBe(false);
    // Typing next to it is fine.
    caret(c, SPIKE_IDS.after, 0);
    expect(attempt(c, () => type(c, 'next to it')).changed).toBe(true);
  });

  it('refuses slices that carry a redacted value and changes to a value the reader cannot read', () => {
    const env = spikeDocument();
    const doc = structuredClone(env.doc) as {
      content: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    const body = doc.content[doc.content.length - 1]!;
    body.content!.push({
      type: 'paragraph',
      attrs: { id: 'pField0000000001' },
      content: [
        {
          type: 'form_field',
          attrs: { id: 'fSecret000000001', kind: 'text', key: 'salary', value: { redacted: true } },
        },
      ],
    });
    const c = new DocumentCore({
      doc: { ...env, requires: ['fields'], doc },
      access: ownerAccess(),
      schedule: microtask,
    });
    const i = internals(c);
    let field = -1;
    i.state.doc.descendants((n, pos) => {
      if (n.type.name === 'form_field') field = pos;
      return field < 0;
    });
    expect(
      attempt(c, () => i.dispatch(i.state.tr.setNodeAttribute(field, 'value', 'guess'))).changed,
    ).toBe(false);
    expect(c.refusal.get()?.reason).toBe('redacted');
    const copy = i.state.doc.slice(field, field + 1);
    expect(
      attempt(c, () =>
        i.dispatch(
          i.state.tr.replace(
            posOf(i.state.doc, SPIKE_IDS.last) + 1,
            posOf(i.state.doc, SPIKE_IDS.last) + 1,
            copy,
          ),
        ),
      ).changed,
    ).toBe(false);
  });
});
