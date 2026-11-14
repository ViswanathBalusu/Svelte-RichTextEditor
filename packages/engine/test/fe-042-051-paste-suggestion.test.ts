/**
 * Paste and `insertContent` in suggestion mode (FE-042 criterion 6, paste half; FE-051 criterion 6,
 * suggestion-mode half; 02 §5.2; 03 §5; 07 §5.2 P4). A suggester joins the mock service (the real
 * authority room) as the element does, pastes plain text through `pasteFromClipboard` and inserts a
 * fragment through `insertContent`. The test reads what the server stored: the inserted text carries
 * one `ins` naming the suggester, the baseline is unchanged, and the authority accepted the commit.
 * Input-method composition is not covered here: it needs a browser (FE-066).
 */
import type { CdmEnvelope } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore, type CoreConfig } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, countedPort, microtask, newService, posOf, until } from './support.ts';

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

/** Joins as the element does: content over REST, the channel resumed, `attach` given the user. */
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

/** The marks of the server's text at `offset` in the paragraph `id`. */
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

/** Every commit was accepted: nothing set aside, the head moved, the server's content is valid. */
function accepted(m: Member, service: MockService, docId: string, head: number) {
  expect(m.core.recovered.get().count).toBe(0);
  expect(service.document(docId)!.head).toBeGreaterThanOrEqual(head + 1);
  const c = service.document(docId)!.content();
  const env = { cdm: 1, requires: c.requires, doc: c.doc } as unknown as CdmEnvelope;
  expect(validate(env).valid).toBe(true);
}

async function saved(m: Member): Promise<void> {
  await until(() => m.core.saveState.get() === 'saved', 'saved', 5000);
}

/** Selects `[from, to)` of the paragraph `id` (offsets into its text). */
function select(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

async function setUp() {
  const service = newService();
  const docId = service.createDocument(contractDocument());
  return { service, docId, head: service.document(docId)!.head };
}

describe('paste and insertContent in suggestion mode (FE-042 criterion 6, FE-051 criterion 6)', () => {
  it('a plain-text paste as a suggester carries one ins naming the user and the baseline stays', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'Hello '.length);
    expect(sam.core.pasteFromClipboard({ text: 'big ' })).toEqual({ ok: true });
    await saved(sam);
    accepted(sam, service, docId, head);
    expect(serverRuns(service, docId, IDS.intro)).toEqual([
      ['Hello ', []],
      ['big ', ['ins:sam']],
      ['world', []],
    ]);
    // Each pasted character carries exactly one suggestion mark, naming the suggester.
    const marks = serverMarks(service, docId, IDS.intro, 6);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ type: 'ins', attrs: { user: 'sam' } });
    sam.detach();
    await service.dispose();
  });

  it('a paste over a selection as a suggester records a del for the selection and one ins for the text', async () => {
    const { service, docId, head } = await setUp();
    const sam = await joinAs(service, docId, 'sam', 'suggester');
    select(sam.core, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(sam.core.pasteFromClipboard({ text: 'there' })).toEqual({ ok: true });
    await saved(sam);
    accepted(sam, service, docId, head);
    const runs = serverRuns(service, docId, IDS.intro);
    expect(runs[0]).toEqual(['Hello ', []]);
    // The new text is one run carrying one ins; the baseline "world" is marked del, not removed.
    const ins = runs.filter(([, marks]) => marks.includes('ins:sam'));
    expect(ins).toEqual([['there', ['ins:sam']]]);
    expect(runs.some(([text, marks]) => text === 'world' && marks.includes('del:sam'))).toBe(true);
    sam.detach();
    await service.dispose();
  });

  it('an inline fragment inserted by insertContent as a suggester carries one ins naming the user', async () => {
    const { service, docId, head } = await setUp();
    // The fragment is copied from a separate core on the same document, so its identifiers are its own.
    const source = new DocumentCore({
      doc: contractDocument(),
      schedule: microtask,
      generateId: idSource('zsrc'),
    });
    select(source, IDS.intro, 0, 'Hello'.length);
    const fragment = source.getSelectionContent();

    const sam = await joinAs(service, docId, 'sam', 'suggester');
    caret(sam.core, IDS.intro, 'Hello '.length);
    expect(sam.core.insertContent(fragment)).toEqual({ ok: true });
    await saved(sam);
    accepted(sam, service, docId, head);
    const runs = serverRuns(service, docId, IDS.intro);
    const ins = runs.filter(([, marks]) => marks.includes('ins:sam'));
    expect(ins).toHaveLength(1);
    expect(ins[0]![0]).toBe('Hello');
    expect(serverMarks(service, docId, IDS.intro, 6)).toHaveLength(1);
    sam.detach();
    await service.dispose();
  });
});
