/**
 * The format painter in the editing core (UX-009 criteria 1 to 3): `copyFormat` takes the
 * formatting at the selection, `pasteFormat` puts it on another selection through the guards, as a
 * direct change, as a formatting suggestion for a user who may only suggest, or not at all where the
 * user may not change the scope. Node.js; the suggestion case runs two cores against backend-mock,
 * which runs the real authority.
 */
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, SPIKE_IDS, contractDocument, editorAccess, spikeDocument } from './fixtures.ts';
import { type Member, microtask, newService, posOf, until } from './support.ts';

function select(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

function setAttr(core: DocumentCore, id: string, attr: string, value: unknown): void {
  const i = internals(core);
  i.dispatch(i.state.tr.setNodeAttribute(posOf(i.state.doc, id), attr, value));
}

type Run = { text: string; marks: Record<string, unknown> };

/** The text runs of a paragraph with their marks, by mark type. */
function runsOf(core: DocumentCore, id: string): Run[] {
  const doc = internals(core).state.doc;
  const para = doc.nodeAt(posOf(doc, id)) as PMNode;
  const out: Run[] = [];
  para.forEach((n) => {
    if (n.isText)
      out.push({
        text: n.text ?? '',
        marks: Object.fromEntries(
          n.marks.map((m: Mark) => [m.type.name, m.attrs['value'] ?? m.attrs]),
        ),
      });
  });
  return out;
}

const attrOf = (core: DocumentCore, id: string, attr: string): unknown => {
  const doc = internals(core).state.doc;
  return doc.nodeAt(posOf(doc, id))!.attrs[attr];
};

const textOf = (core: DocumentCore, id: string): string => {
  const doc = internals(core).state.doc;
  return doc.nodeAt(posOf(doc, id))!.textContent;
};

function editor(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule: microtask });
}

/** Selects the whole content of a paragraph. */
function selectWhole(core: DocumentCore, id: string): void {
  const i = internals(core);
  const node = i.state.doc.nodeAt(posOf(i.state.doc, id))!;
  select(core, id, 0, node.content.size);
}

/** The intro paragraph, 'Alpha bravo charlie', with its first word formatted and the paragraph set. */
function formattedSource(core: DocumentCore): void {
  select(core, SPIKE_IDS.intro, 0, 5);
  expect(core.run('bold')).toBe(true);
  expect(core.run('color', { color: '#ff0000' })).toBe(true);
  expect(core.run('fontSize', { fontSize: 28 })).toBe(true);
  setAttr(core, SPIKE_IDS.intro, 'align', 'center');
  setAttr(core, SPIKE_IDS.intro, 'indentLeft', 720);
}

describe('the painter takes and puts formatting (UX-009 criterion 1)', () => {
  it('puts the character and paragraph formatting on a whole target paragraph and keeps its content', () => {
    const c = editor();
    formattedSource(c);
    selectWhole(c, SPIKE_IDS.intro);
    expect(c.queryCommand('copyFormat').enabled).toBe(true);
    expect(c.run('copyFormat')).toBe(true);

    const text = textOf(c, SPIKE_IDS.last);
    selectWhole(c, SPIKE_IDS.last);
    expect(c.queryCommand('pasteFormat').enabled).toBe(true);
    expect(c.run('pasteFormat')).toBe(true);

    const runs = runsOf(c, SPIKE_IDS.last);
    expect(runs.map((r) => r.text).join('')).toBe(text);
    expect(runs.every((r) => r.marks['bold'] === true && r.marks['color'] === '#FF0000')).toBe(
      true,
    );
    expect(runs[0]!.marks).toMatchObject({ fontSize: 28 });
    expect(attrOf(c, SPIKE_IDS.last, 'align')).toBe('center');
    expect(attrOf(c, SPIKE_IDS.last, 'indentLeft')).toBe(720);
    // The source is as it was.
    expect(attrOf(c, SPIKE_IDS.intro, 'align')).toBe('center');
  });

  it('a part of a paragraph takes the character formatting alone', () => {
    const c = editor();
    formattedSource(c);
    select(c, SPIKE_IDS.intro, 0, 5);
    expect(c.run('copyFormat')).toBe(true);
    const text = textOf(c, SPIKE_IDS.last);
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.run('pasteFormat')).toBe(true);
    const runs = runsOf(c, SPIKE_IDS.last);
    expect(runs[0]).toMatchObject({ text: text.slice(0, 4) });
    expect(runs[0]!.marks).toMatchObject({ bold: true, color: '#FF0000', fontSize: 28 });
    expect(runs.slice(1).every((r) => !('bold' in r.marks) && !('color' in r.marks))).toBe(true);
    expect(runs.map((r) => r.text).join('')).toBe(text);
    expect(attrOf(c, SPIKE_IDS.last, 'align')).toBe(null);
    expect(attrOf(c, SPIKE_IDS.last, 'indentLeft')).toBe(null);
  });

  it('replaces the formatting the target had, not adds to it', () => {
    const c = editor();
    formattedSource(c);
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.run('italic')).toBe(true);
    expect(c.run('color', { color: '#0000ff' })).toBe(true);
    select(c, SPIKE_IDS.intro, 0, 5);
    c.run('copyFormat');
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.run('pasteFormat')).toBe(true);
    const first = runsOf(c, SPIKE_IDS.last)[0]!;
    expect(first.marks).toMatchObject({ bold: true, color: '#FF0000' });
    expect('italic' in first.marks).toBe(false);
  });

  it('is one step of the history', () => {
    const c = editor();
    formattedSource(c);
    selectWhole(c, SPIKE_IDS.intro);
    c.run('copyFormat');
    selectWhole(c, SPIKE_IDS.last);
    expect(c.run('pasteFormat')).toBe(true);
    expect(attrOf(c, SPIKE_IDS.last, 'align')).toBe('center');
    expect(c.run('undo')).toBe(true);
    expect(attrOf(c, SPIKE_IDS.last, 'align')).toBe(null);
    expect('bold' in runsOf(c, SPIKE_IDS.last)[0]!.marks).toBe(false);
  });

  it('with a caret, the next typed text carries the formatting', () => {
    const c = editor();
    formattedSource(c);
    select(c, SPIKE_IDS.intro, 0, 5);
    c.run('copyFormat');
    select(c, SPIKE_IDS.last, 2, 2);
    expect(c.run('pasteFormat')).toBe(true);
    const i = internals(c);
    i.dispatch(i.state.tr.insertText('XY'));
    const typed = runsOf(c, SPIKE_IDS.last).find((r) => r.text.includes('XY'));
    expect(typed?.marks).toMatchObject({ bold: true, color: '#FF0000' });
  });

  it('is unavailable until formatting has been taken', () => {
    const c = editor();
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.query('canPasteFormat')).toBe(false);
    expect(c.run('pasteFormat')).toBe(false);
    expect(c.query('canCopyFormat')).toBe(true);
    c.run('copyFormat');
    expect(c.query('canPasteFormat')).toBe(true);
    expect(c.queryNames).toContain('canCopyFormat');
    expect(c.queryNames).toContain('canPasteFormat');
  });
});

describe('the painter keeps to the scopes the user may change (UX-009 criterion 3)', () => {
  it('changes nothing in a region the user may only read', () => {
    const c = editor();
    formattedSource(c);
    select(c, SPIKE_IDS.intro, 0, 5);
    c.run('copyFormat');
    const before = JSON.stringify(internals(c).state.doc.toJSON());
    select(c, SPIKE_IDS.legal, 0, 3);
    expect(c.queryCommand('pasteFormat').enabled).toBe(false);
    expect(c.run('pasteFormat')).toBe(false);
    expect(JSON.stringify(internals(c).state.doc.toJSON())).toBe(before);
  });

  it('a reader may take formatting but cannot put it anywhere', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess({
        docRole: 'commenter',
        caps: ['view', 'comment'],
        scopes: { doc: ['view'], body: ['view', 'comment'], defs: ['view'] },
      }),
      schedule: microtask,
    });
    select(c, SPIKE_IDS.intro, 0, 5);
    expect(c.run('copyFormat')).toBe(true);
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.queryCommand('pasteFormat').enabled).toBe(false);
    expect(c.run('pasteFormat')).toBe(false);
  });
});

// --- Criterion 2: a user who may only suggest -----------------------------------------------

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function serverNode(service: MockService, docId: string, id: string): JsonNode {
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return find(service.document(docId)!.content().doc as unknown as JsonNode)!;
}

async function joinAs(
  service: MockService,
  docId: string,
  sub: string,
  role: DocRole,
): Promise<Member> {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
    user: backend.auth.session!.user.id,
  });
  await until(() => core.permissions.get() !== null, 'access');
  return { core, detach, backend };
}

describe('the painter for a user who may only suggest (UX-009 criterion 2)', () => {
  it('records the formatting as suggestions naming the user, and writes no direct mark', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    // An editor formats the source word and the source paragraph, and the change is saved.
    const eve = await joinAs(service, docId, 'eve', 'editor');
    select(eve.core, IDS.intro, 0, 5);
    expect(eve.core.run('bold')).toBe(true);
    // The whole paragraph is the source below, and its first run is the bold word.
    setAttr(eve.core, IDS.intro, 'align', 'center');
    await until(() => eve.core.saveState.get() === 'saved', 'eve saved');
    eve.detach();

    const sam = await joinAs(service, docId, 'sam', 'suggester');
    await until(
      () => runsOf(sam.core, IDS.intro).some((r) => 'bold' in r.marks),
      'sam sees the source',
    );
    selectWhole(sam.core, IDS.intro);
    expect(sam.core.run('copyFormat')).toBe(true);
    selectWhole(sam.core, IDS.mid);
    expect(sam.core.queryCommand('pasteFormat').enabled).toBe(true);
    expect(sam.core.run('pasteFormat')).toBe(true);
    await until(() => sam.core.saveState.get() === 'saved', 'sam saved');

    const mid = serverNode(service, docId, IDS.mid);
    const marks = (mid.content ?? []).flatMap((t) => t.marks ?? []);
    const fmt = marks.find((m) => m.type === 'fmt');
    expect(fmt?.attrs?.['user']).toBe('sam');
    // The paragraph's alignment is a block suggestion: a fmt entry in its `suggest` attribute, naming sam.
    const suggest = (mid.attrs?.['suggest'] ?? []) as {
      type: string;
      attrs?: Record<string, unknown>;
    }[];
    const block = suggest.find((m) => m.type === 'fmt');
    expect(block?.attrs?.['user']).toBe('sam');

    sam.detach();
    await service.dispose();
  });
});
