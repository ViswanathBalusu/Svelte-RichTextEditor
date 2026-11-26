/**
 * "Tracked changes for everyone" in the core, through the authority (UX-038 criteria 1 to 4; 13 §5;
 * 07 §5.2; owner decision 118: only a user with `manage` switches it). Members join the mock service
 * (the real authority room) as the element does. The owner turns the setting on and off; the other
 * members see the change arrive without a reload, an editor then types as a suggestion, and an
 * editor whose change was made before the setting reached them is refused by the server and the
 * change is set aside as any rejected change is (UX-017).
 */
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, countedPort, microtask, newService, type, until } from './support.ts';

interface Member {
  core: DocumentCore;
  detach: () => void;
}

function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(16 - prefix.length, '0')}`;
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
  const core = new DocumentCore({
    doc: content,
    schedule: microtask,
    generateId: idSource(`s${sub}`),
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

const saved = (m: Member): Promise<void> =>
  until(() => m.core.status.get().sync === 'saved', 'a saved state');

/** The text of the intro paragraph as the core holds it. */
function intro(core: DocumentCore): string {
  let text = '';
  internals(core).state.doc.descendants((node) => {
    if (node.attrs['id'] === IDS.intro) {
      text = node.textContent;
      return false;
    }
    return text === '';
  });
  return text;
}

describe('tracked changes for everyone (UX-038)', () => {
  it('is turned on by a user with manage and refused for an editor (criteria 1 and 2)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const olga = await joinAs(service, docId, 'olga', 'owner');
    const eddie = await joinAs(service, docId, 'eddie', 'editor');
    expect(olga.core.trackedForEveryone.get()).toBe(false);
    // An editor has no manage: the call is refused and the document is not changed.
    const head = service.document(docId)!.head;
    expect(eddie.core.setTrackedForEveryone(true)).toBe(false);
    expect(eddie.core.trackedForEveryone.get()).toBe(false);
    expect(service.document(docId)!.head).toBe(head);

    expect(olga.core.setTrackedForEveryone(true)).toBe(true);
    expect(olga.core.trackedForEveryone.get()).toBe(true);
    await saved(olga);
    expect(service.document(docId)!.head).toBeGreaterThan(head);
    // Turning it on again changes nothing.
    expect(olga.core.setTrackedForEveryone(true)).toBe(true);
    olga.detach();
    eddie.detach();
    await service.dispose();
  });

  it('is refused by the server for a change that a client without manage sends (criterion 2)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const eddie = await joinAs(service, docId, 'eddie', 'editor');
    // The editor's own core would refuse; send the step itself, as a client that skipped the check.
    const i = internals(eddie.core);
    let at = -1;
    i.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'settings') at = pos;
      return at < 0;
    });
    const before = service.document(docId)!.head;
    i.dispatch(
      i.state.tr.setNodeMarkup(at, undefined, {
        ...i.state.doc.nodeAt(at)!.attrs,
        trackChanges: 'everyone',
      }),
    );
    await until(
      () => eddie.core.recovered.get().count > 0 || eddie.core.status.get().sync === 'saved',
      'an answer',
    );
    const content = service.document(docId)!.content().doc as unknown as {
      content: Array<{
        type: string;
        content: Array<{ type: string; attrs: Record<string, unknown> }>;
      }>;
    };
    const settings = content.content[0]!.content.find((n) => n.type === 'settings')!;
    expect(settings.attrs['trackChanges'] ?? 'off').toBe('off');
    expect(service.document(docId)!.head).toBe(before);
    eddie.detach();
    await service.dispose();
  });

  it('reaches the other members without a reload, makes an editor suggest, and ends when it is turned off (criterion 3)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const olga = await joinAs(service, docId, 'olga', 'owner');
    const eddie = await joinAs(service, docId, 'eddie', 'editor');
    expect(eddie.core.suggestion.get()).toMatchObject({ on: false });

    olga.core.setTrackedForEveryone(true);
    await until(() => eddie.core.trackedForEveryone.get(), 'the setting on the editor');
    expect(eddie.core.suggestion.get()).toMatchObject({
      on: true,
      locked: true,
      reason: 'document-setting',
    });
    // The editor's typing is recorded as a suggestion, and the server accepts it.
    caret(eddie.core, IDS.intro, 'Hello '.length);
    type(eddie.core, 'big ');
    await saved(eddie);
    const marks = JSON.stringify(service.document(docId)!.content().doc);
    expect(marks).toContain('"type":"ins"');

    // Switched off, the editor edits directly again, in the same session.
    olga.core.setTrackedForEveryone(false);
    await until(() => !eddie.core.trackedForEveryone.get(), 'the setting off on the editor');
    expect(eddie.core.suggestion.get()).toMatchObject({ on: false });
    const insBefore = (
      JSON.stringify(service.document(docId)!.content().doc).match(/"type":"ins"/g) ?? []
    ).length;
    type(eddie.core, 'X');
    await saved(eddie);
    const insAfter = (
      JSON.stringify(service.document(docId)!.content().doc).match(/"type":"ins"/g) ?? []
    ).length;
    expect(insAfter).toBe(insBefore);
    expect(intro(eddie.core)).toContain('X');
    olga.detach();
    eddie.detach();
    await service.dispose();
  });

  it('refuses a direct change made before the setting reached the editor, and sets it aside (criterion 4)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const olga = await joinAs(service, docId, 'olga', 'owner');
    const eddie = await joinAs(service, docId, 'eddie', 'editor');
    const head = service.document(docId)!.head;
    // The owner's change is committed first; the editor types before it has arrived.
    olga.core.setTrackedForEveryone(true);
    expect(eddie.core.trackedForEveryone.get()).toBe(false);
    caret(eddie.core, IDS.intro, 'Hello '.length);
    type(eddie.core, 'late ');
    await until(() => eddie.core.recovered.get().count > 0, 'the change set aside');
    // The server never took the editor's direct text, and the editor's own copy no longer has it.
    expect(JSON.stringify(service.document(docId)!.content().doc)).not.toContain('late ');
    expect(service.document(docId)!.head).toBeGreaterThan(head);
    await until(
      () => !intro(eddie.core).includes('late '),
      'the document without the refused text',
    );
    olga.detach();
    eddie.detach();
    await service.dispose();
  });
});
