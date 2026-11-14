/**
 * Suggestion mode in the core, through the authority (FE-041 criterion 2 and 5, FE-042 criteria 1 to
 * 5 and 7, FE-043 criteria 1 to 4; 02 §5.2; 03 §5; 07 §5.2 P4). Members join the mock service (the
 * real authority room) as the element does: the core is given the user of `welcome.user.id` when it
 * attaches, and its own identifier source. They type, delete, type over a selection and run the
 * formatting commands through `DocumentCore`; the test then reads what the server stored and checks
 * that the authority accepted every commit (nothing set aside, the head moved).
 */
import type { CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import fc from 'fast-check';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore, type CoreConfig } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument, editorAccess, SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { caret, countedPort, microtask, newService, posOf, type, until } from './support.ts';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

interface Member {
  core: DocumentCore;
  detach: () => void;
}

/** A fresh identifier source per member, valid node identifiers (03 §9), distinct per user. */
function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(16 - prefix.length, '0')}`;
}

/**
 * Joins as the element does (packages/element/src/session.ts): content over REST, the channel
 * resumed at its seq, and `attach` given the user of the welcome.
 */
async function joinAs(
  service: MockService,
  docId: string,
  sub: string,
  role: DocRole,
  config: Partial<CoreConfig> = {},
): Promise<Member> {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({
    doc: content,
    schedule: microtask,
    generateId: idSource(`s${sub}`),
    ...config,
  });
  const port = countedPort(backend.sync);
  const channel = await port.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: port,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
    user: backend.auth.session!.user.id,
  });
  await until(() => core.permissions.get() !== null, 'access');
  return { core, detach };
}

/** The contract document, with `marks` on part of the intro ("Hello world") when given. */
function documentWith(
  introRuns: JsonNode[] | null = null,
  settings: Record<string, unknown> = {},
): CdmEnvelope {
  const env = contractDocument();
  const root = env.doc as unknown as JsonNode;
  const find = (n: JsonNode, id: string): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c, id);
      if (r) return r;
    }
    return null;
  };
  if (introRuns) find(root, IDS.intro)!.content = introRuns;
  const defs = root.content![0]!;
  const s = defs.content!.find((n) => n.type === 'settings')!;
  s.attrs = { ...s.attrs, ...settings };
  return env;
}

/** The runs of a paragraph on the server: text, and suggestion or formatting marks as names. */
function serverRuns(service: MockService, docId: string, id: string): [string, string[]][] {
  const doc = service.document(docId)!.content().doc as unknown as JsonNode;
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return (find(doc)!.content ?? []).map((t) => [
    t.text ?? '',
    (t.marks ?? []).map((m) =>
      m.attrs?.['user'] === undefined ? m.type : `${m.type}:${String(m.attrs['user'])}`,
    ),
  ]);
}

/** The marks of the server's text at `offset` in the paragraph `id`, as JSON. */
function serverMarks(service: MockService, docId: string, id: string, offset: number) {
  const doc = service.document(docId)!.content().doc as unknown as JsonNode;
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  let at = 0;
  for (const t of find(doc)!.content ?? []) {
    const len = (t.text ?? '').length;
    if (offset < at + len) return t.marks ?? [];
    at += len;
  }
  return [];
}

function serverEnvelope(service: MockService, docId: string): CdmEnvelope {
  const c = service.document(docId)!.content();
  return { cdm: 1, requires: c.requires, doc: c.doc } as unknown as CdmEnvelope;
}

async function saved(m: Member): Promise<void> {
  await until(() => m.core.saveState.get() === 'saved', 'saved', 5000);
}

/** Every commit was accepted: nothing set aside, the head moved by `commits`. */
function accepted(m: Member, service: MockService, docId: string, head: number, commits = 1) {
  expect(m.core.recovered.get().count).toBe(0);
  expect(service.document(docId)!.head).toBeGreaterThanOrEqual(head + commits);
  expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
}

/** Selects `[from, to)` of the paragraph `id` (offsets into its text). */
function select(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

/** Backspace at a caret: deletes the character before it, as the view's deletion does. */
function backspace(core: DocumentCore): void {
  const i = internals(core);
  const { from } = i.state.selection;
  i.dispatch(i.state.tr.delete(from - 1, from));
}

/** Delete at a caret: deletes the character after it. */
function deleteForward(core: DocumentCore): void {
  const i = internals(core);
  const { from } = i.state.selection;
  i.dispatch(i.state.tr.delete(from, from + 1));
}

/** Types one character at a time, as keystrokes do. */
function typeKeys(core: DocumentCore, text: string): void {
  for (const ch of text) type(core, ch);
}

/** The caret's offset in its paragraph. */
function caretOffset(core: DocumentCore): number {
  return internals(core).state.selection.$head.parentOffset;
}

async function setUp(doc: CdmEnvelope = documentWith()) {
  const service = newService();
  const docId = service.createDocument(doc);
  return { service, docId, head: service.document(docId)!.head };
}

describe('typing and deleting as a suggester (FE-042 criteria 1, 2, 3 and 5)', () => {
  it('typed text carries one ins naming the user, with an identifier from the core (criterion 1)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    expect(sam.core.suggestion.get()).toEqual({
      on: true,
      locked: true,
      reason: 'rights',
      scope: 'body',
    });
    caret(sam.core, IDS.intro, 'Hello '.length);
    typeKeys(sam.core, 'big ');
    expect(caretOffset(sam.core)).toBe('Hello big '.length);
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:sam']],
      ['world', []],
    ]);
    // One suggestion for the typed word, with the core's first identifier.
    const marks = serverMarks(service, docId, IDS.intro, 6);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ type: 'ins', attrs: { id: 'ssam000000000001', user: 'sam' } });
    sam.detach();
    await service.dispose();
  });

  it('deleted baseline text stays with a del, and the caret moves as the key says (criterion 2)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'end');
    for (let k = 0; k < 'world'.length; k++) backspace(sam.core);
    expect(caretOffset(sam.core)).toBe('Hello '.length);
    caret(sam.core, IDS.intro, 0);
    deleteForward(sam.core);
    expect(caretOffset(sam.core)).toBe(1);
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['H', ['del:sam']],
      ['ello ', []],
      ['world', ['del:sam']],
    ]);
    sam.detach();
    await service.dispose();
  });

  it('deleting another user’s insertion adds the user’s del and keeps the other mark and text (criterion 3)', async () => {
    const { service, docId, head } = await setUp(
      documentWith([
        { type: 'text', text: 'Hello ' },
        {
          type: 'text',
          text: 'big ',
          marks: [{ type: 'ins', attrs: { id: 'sTessInsert00001', user: 'tess' } }],
        },
        { type: 'text', text: 'world' },
      ]),
    );
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello big '.length);
    const i = internals(sam.core);
    i.dispatch(i.state.tr.deleteSelection());
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:tess', 'del:sam']],
      ['world', []],
    ]);
    sam.detach();
    await service.dispose();
  });

  it('deleting text the user suggested inserting removes it (P4 lets a user take it back)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'Hello '.length);
    typeKeys(sam.core, 'xy');
    backspace(sam.core);
    backspace(sam.core);
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([['Hello world', []]]);
    sam.detach();
    await service.dispose();
  });

  it('typing over a selection gives the selection del and the new text ins after it (criterion 5)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    type(sam.core, 'there');
    expect(caretOffset(sam.core)).toBe('Hello worldthere'.length);
    expect(internals(sam.core).state.selection.empty).toBe(true);
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['world', ['del:sam']],
      ['there', ['ins:sam']],
    ]);
    sam.detach();
    await service.dispose();
  });

  it('a change suggestion mode cannot record (splitting a paragraph) is refused, not made directly', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'Hello '.length);
    const i = internals(sam.core);
    const before = i.state.doc;
    i.dispatch(i.state.tr.split(i.state.selection.from));
    expect(internals(sam.core).state.doc).toBe(before);
    expect(sam.core.refusal.get()).toMatchObject({ reason: 'suggestion', scopes: ['body'] });
    expect(service.document(docId)!.head).toBe(head);
    sam.detach();
    await service.dispose();
  });
});

describe('two users suggest on the same text (FE-042 criterion 4)', () => {
  it('both del marks coexist on the server', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    const tess = await joinAs(service, docId, 'tess', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    internals(sam.core).dispatch(internals(sam.core).state.tr.deleteSelection());
    await saved(sam);
    await until(
      () => tess.core.confirmedSeq.get() === service.document(docId)!.head,
      'tess sees sam',
    );
    select(tess.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    internals(tess.core).dispatch(internals(tess.core).state.tr.deleteSelection());
    await saved(tess);
    accepted(sam, service, docId, head, 2);
    expect(tess.core.recovered.get().count).toBe(0);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['world', ['del:sam', 'del:tess']],
    ]);
    sam.detach();
    tess.detach();
    await service.dispose();
  });
});

describe('formatting commands as a suggester (FE-043 criteria 1 to 4)', () => {
  it('bold records an fmt with id, user and the previous marks, and the authority accepts it (criteria 1 and 4)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(sam.core.run('bold')).toBe(true);
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['world', ['bold', 'fmt:sam']],
    ]);
    const fmt = serverMarks(service, docId, IDS.intro, 6).find((m) => m.type === 'fmt')!;
    expect(fmt.attrs).toMatchObject({
      id: 'ssam000000000001',
      user: 'sam',
      before: { marks: [], attrs: {} },
    });
    sam.detach();
    await service.dispose();
  });

  it('a colour on bold text records the bold as the previous formatting (criterion 1)', async () => {
    const { service, docId, head } = await setUp(
      documentWith([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world', marks: [{ type: 'bold', attrs: { value: true } }] },
      ]),
    );
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(sam.core.run('color', { color: '#c00000' })).toBe(true);
    await saved(sam);
    accepted(sam, service, docId, head);
    const marks = serverMarks(service, docId, IDS.intro, 6);
    expect(marks.find((m) => m.type === 'color')?.attrs).toMatchObject({ value: '#C00000' });
    // `before` holds the bold mark's JSON as the editing schema writes it (with its `ext` default).
    expect(marks.find((m) => m.type === 'fmt')?.attrs?.['before']).toMatchObject({
      marks: [{ type: 'bold', attrs: { value: true } }],
      attrs: {},
    });
    sam.detach();
    await service.dispose();
  });

  it('two users’ formatting suggestions on the same text coexist (criterion 2)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    const tess = await joinAs(service, docId, 'tess', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    sam.core.run('bold');
    await saved(sam);
    await until(
      () => tess.core.confirmedSeq.get() === service.document(docId)!.head,
      'tess sees sam',
    );
    select(tess.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    tess.core.run('italic');
    await saved(tess);
    accepted(sam, service, docId, head, 2);
    expect(tess.core.recovered.get().count).toBe(0);
    const fmts = serverMarks(service, docId, IDS.intro, 6).filter((m) => m.type === 'fmt');
    expect(fmts.map((m) => m.attrs?.['user']).sort()).toEqual(['sam', 'tess']);
    sam.detach();
    tess.detach();
    await service.dispose();
  });

  it('an editor rejecting the suggestion puts back exactly the previous marks (criterion 3)', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    sam.core.run('bold');
    await saved(sam);
    const eddie = await joinAs(service, docId, 'eddie', 'editor');
    expect(eddie.core.resolveSuggestions('reject', 'document')).toMatchObject({ handled: 1 });
    await saved(eddie);
    accepted(eddie, service, docId, head, 2);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([['Hello world', []]]);
    sam.detach();
    eddie.detach();
    await service.dispose();
  });
});

describe('suggestion mode by rule, in the core (FE-041 criteria 2, 3, 4 and 5)', () => {
  it('review mode for an editor records typing as suggestions; edit mode types directly (criteria 2 and 5)', async () => {
    const { service, docId, head } = await setUp();
    const eddie = await joinAs(service, docId, 'eddie', 'editor', { mode: 'review' });
    caret(eddie.core, IDS.intro, 'Hello '.length);
    expect(eddie.core.suggestion.get()).toEqual({
      on: true,
      locked: false,
      reason: 'review-mode',
      scope: 'body',
    });
    typeKeys(eddie.core, 'big ');
    await saved(eddie);
    accepted(eddie, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:eddie']],
      ['world', []],
    ]);
    eddie.core.setMode('edit');
    expect(eddie.core.suggestion.get()).toMatchObject({ on: false, reason: null });
    caret(eddie.core, IDS.intro, 'end');
    type(eddie.core, '!');
    await saved(eddie);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:eddie']],
      ['world!', []],
    ]);
    eddie.detach();
    await service.dispose();
  });

  it('trackChanges everyone makes an editor suggest, and the setting follows a remote change live (criterion 3)', async () => {
    const { service, docId, head } = await setUp(documentWith(null, { trackChanges: 'everyone' }));
    const eddie = await joinAs(service, docId, 'eddie', 'editor');
    caret(eddie.core, IDS.intro, 'Hello '.length);
    expect(eddie.core.suggestion.get()).toEqual({
      on: true,
      locked: true,
      reason: 'document-setting',
      scope: 'body',
    });
    type(eddie.core, 'X');
    await saved(eddie);
    accepted(eddie, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)[1]).toEqual(['X', ['ins:eddie']]);
    // An owner, who has manage, switches the setting off; the editor's mode follows.
    const olivia = await joinAs(service, docId, 'olivia', 'owner');
    expect(olivia.core.suggestion.get()).toMatchObject({ on: true, locked: false });
    const o = internals(olivia.core);
    let settings = -1;
    o.state.doc.firstChild!.forEach((n, offset) => {
      if (n.type.name === 'settings') settings = 1 + offset;
    });
    o.dispatch(o.state.tr.setNodeAttribute(settings, 'trackChanges', 'off'));
    await saved(olivia);
    await until(() => eddie.core.suggestion.get().on === false, 'the setting reaches eddie');
    expect(olivia.core.recovered.get().count).toBe(0);
    eddie.detach();
    olivia.detach();
    await service.dispose();
  });

  it('the mode follows the scope under the caret (criterion 4)', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      schedule: microtask,
      user: 'sam',
      access: editorAccess({
        docRole: 'suggester',
        caps: ['view', 'comment', 'suggest'],
        scopes: {
          ...editorAccess().scopes,
          body: ['view', 'comment', 'suggest'],
          [`region:${SPIKE_IDS.region}`]: ['view', 'comment', 'suggest', 'edit'],
        },
      }),
    });
    caret(c, SPIKE_IDS.after, 1);
    expect(c.suggestion.get()).toMatchObject({ on: true, locked: true, reason: 'rights' });
    caret(c, SPIKE_IDS.legal, 1);
    expect(c.suggestion.get()).toEqual({
      on: false,
      locked: false,
      reason: null,
      scope: `region:${SPIKE_IDS.region}`,
    });
    type(c, 'Z');
    const i = internals(c);
    expect(
      i.state.doc.nodeAt(i.state.selection.from - 1)!.marks.map((m) => m.type.name),
    ).not.toContain('ins');
  });

  it('without a user to name in the marks, a suggestion is refused rather than made directly', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      schedule: microtask,
      mode: 'review',
      access: editorAccess(),
    });
    caret(c, SPIKE_IDS.after, 1);
    const before = internals(c).state.doc;
    type(c, 'Z');
    expect(internals(c).state.doc).toBe(before);
    expect(c.refusal.get()).toMatchObject({ reason: 'suggestion', scopes: ['body'] });
  });
});

describe('random edits as a suggester against the authority (FE-042 criterion 7)', () => {
  it('every commit is accepted, the baseline and the other user’s insertion stay, every new mark names the user', async () => {
    const TEXT = 'Hello world';
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom('type', 'backspace', 'replace', 'bold'),
            a: fc.nat(TEXT.length),
            b: fc.nat(TEXT.length),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (ops) => {
          const { service, docId, head } = await setUp(
            documentWith([
              { type: 'text', text: 'He' },
              {
                type: 'text',
                text: 'llo',
                marks: [{ type: 'ins', attrs: { id: 'sTessInsert00001', user: 'tess' } }],
              },
              { type: 'text', text: ' world' },
            ]),
          );
          const sam = await joinAs(service, docId, 'sam', 'suggester');
          for (const op of ops) {
            const size = internals(sam.core).state.doc.nodeAt(
              posOf(internals(sam.core).state.doc, IDS.intro),
            )!.content.size;
            const lo = Math.min(op.a, op.b, size);
            const hi = Math.min(Math.max(op.a, op.b), size);
            if (op.kind === 'type') {
              caret(sam.core, IDS.intro, lo);
              type(sam.core, 'Q');
            } else if (op.kind === 'backspace') {
              if (lo === 0) continue;
              caret(sam.core, IDS.intro, lo);
              backspace(sam.core);
            } else if (op.kind === 'replace') {
              if (lo === hi) continue;
              select(sam.core, IDS.intro, lo, hi);
              type(sam.core, 'R');
            } else {
              if (lo === hi) continue;
              select(sam.core, IDS.intro, lo, hi);
              sam.core.run('bold');
            }
            await saved(sam);
          }
          expect(sam.core.recovered.get().count).toBe(0);
          expect(validate(serverEnvelope(service, docId)).valid).toBe(true);
          const runs = serverRuns(service, docId, IDS.intro);
          // The baseline: every run but sam's insertions, in order, is the original text.
          const baseline = runs
            .filter(([, marks]) => !marks.includes('ins:sam'))
            .map(([text]) => text)
            .join('');
          expect(baseline).toBe(TEXT);
          // tess's insertion is still on the same text.
          expect(
            runs
              .filter(([, marks]) => marks.includes('ins:tess'))
              .map(([text]) => text)
              .join(''),
          ).toBe('llo');
          // Every suggestion mark is tess's original one or names sam.
          for (const [, marks] of runs)
            for (const m of marks)
              if (/^(ins|del|fmt):/.test(m))
                expect(['ins:tess', 'ins:sam', 'del:sam', 'fmt:sam']).toContain(m);
          expect(service.document(docId)!.head).toBeGreaterThanOrEqual(head);
          sam.detach();
          await service.dispose();
        },
      ),
      { numRuns: 12 },
    );
  }, 60000);
});
