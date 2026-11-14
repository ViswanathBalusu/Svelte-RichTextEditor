/**
 * FE-128 criterion 7 (lane V-FE-113-128): a formatting command from a user who has `suggest` but
 * not `edit` produces `fmt` suggestions (FE-043) and writes no `bold` mark. A control user with
 * `edit` gets the mark directly. Two cores attached to backend-mock, which runs the real authority
 * `Room`; the server's marks are read after each commit.
 *
 * Node.js, backend-mock. Not run in a browser.
 */
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { type Member, microtask, newService, posOf, until } from './support.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function serverDoc(service: MockService, docId: string): JsonNode {
  return service.document(docId)!.content().doc as unknown as JsonNode;
}

/** The marks of every text run of the paragraph `id`, in document order. */
function runMarks(service: MockService, docId: string, id: string) {
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return (find(serverDoc(service, docId))!.content ?? [])
    .filter((t) => t.type === 'text')
    .map((t) => ({ text: t.text ?? '', marks: t.marks ?? [] }));
}

function select(member: Member, id: string, from: number, to: number): void {
  const i = internals(member.core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

/** As `join`, but the attach names the user, which suggestion marks need (FE-042, fe-043 test). */
async function joinWithAccess(
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

async function saved(member: Member): Promise<void> {
  await until(() => member.core.saveState.get() === 'saved', 'saved', 5000);
}

describe('formatting by a suggester produces fmt suggestions (FE-128 criterion 7)', () => {
  it('suggest but not edit: bold is recorded as a fmt suggestion naming the user, whose before has no bold', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const sam = await joinWithAccess(service, docId, 'sam', 'suggester');

    select(sam, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(sam.core.run('bold')).toBe(true);
    await saved(sam);

    // The run that holds the selected word carries the author's fmt suggestion. Its `before`
    // records the formatting the text had (no bold), so rejecting it puts that back (03 §5, P4).
    const runs = runMarks(service, docId, IDS.intro);
    const selected = runs.find((r) => r.text.includes('world'));
    expect(selected).toBeDefined();
    const fmt = selected!.marks.find((m) => m.type === 'fmt');
    expect(fmt?.attrs?.['user']).toBe('sam');
    const before = fmt?.attrs?.['before'] as { marks: { type: string }[] } | undefined;
    expect(before?.marks.map((m) => m.type) ?? []).not.toContain('bold');

    sam.detach();
    await service.dispose();
  });

  it('control: edit lets the same command write the bold mark directly, with no fmt mark', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const eve = await joinWithAccess(service, docId, 'eve', 'editor');

    select(eve, IDS.intro, 'Hello '.length, 'Hello world'.length);
    expect(eve.core.run('bold')).toBe(true);
    await saved(eve);

    const runs = runMarks(service, docId, IDS.intro);
    const marks = runs.flatMap((r) => r.marks.map((m) => m.type));
    expect(marks).toContain('bold');
    expect(marks).not.toContain('fmt');

    eve.detach();
    await service.dispose();
  });
});
