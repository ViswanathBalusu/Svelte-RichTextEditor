/**
 * Comment ranges on the client agree with the service's own copy after every commit (FE-048
 * criterion 2; lane U-FE-033-048). An owner creates a thread on the intro paragraph through the
 * room of the mock service (the real authority `Room`, reached through the document of the mock);
 * then the owner's edits and a remote commit from an editor move the text. Every transaction the
 * owner's core applies, local or remote, is mapped into the client's `CommentRanges`; once each
 * commit is saved, the client's range must equal the room's range for the thread, and the detached
 * flag must match too.
 *
 * Node.js, backend-mock with the real Room. Not run in a browser.
 */
import type { Room, Connection } from '@docedit/authority';
import type { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { CommentRanges } from '../src/comment-ranges.ts';
import type { CoreConfig, DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, join, newService, posOf, type, until } from './support.ts';

const THREAD = '0190f000-0000-7000-8000-000000000048';

function roomOf(service: MockService, docId: string): Room {
  return (service.document(docId) as unknown as { room: Room }).room;
}

async function saved(core: DocumentCore): Promise<void> {
  await until(() => core.saveState.get() === 'saved', 'saved', 5000);
}

/** The offset of the first character of the intro paragraph's text, in document positions. */
function introStart(core: DocumentCore): number {
  return posOf(internals(core).state.doc, IDS.intro) + 1;
}

async function joinWithAccess(
  service: MockService,
  docId: string,
  sub: string,
  role: 'owner' | 'editor',
  config: Partial<CoreConfig> = {},
) {
  const m = await join(service, docId, sub, role, config);
  await until(() => m.core.permissions.get() !== null, `access for ${sub}`);
  return m;
}

describe('comment ranges agree with the service after every commit (FE-048 criterion 2)', () => {
  it('local edits and a remote commit keep the client range equal to the room range', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const head = service.document(docId)!.head;
    const olivia = await joinWithAccess(service, docId, 'olivia', 'owner');
    const sam = await joinWithAccess(service, docId, 'sam', 'editor');
    const room = roomOf(service, docId);

    // The thread covers "world" in the intro paragraph ("Hello world").
    const start = introStart(olivia.core);
    const range = { from: start + 'Hello '.length, to: start + 'Hello world'.length };
    const as: Connection = {
      sub: 'olivia',
      session: 'u-fe-033-048-thread',
      role: 'owner',
      groups: [],
      participantRoles: [],
      participantActive: false,
    };
    const outcome = room.createThread({
      id: THREAD,
      as,
      target: { range: { ...range, baseSeq: head } },
    });
    expect(outcome.ok).toBe(true);

    // The client holds the range as the thread was created, at the head it was created at.
    const client = new CommentRanges();
    client.set('thread', range, head);
    let seq = head;
    const i = internals(olivia.core);
    const unlisten = i.onTransaction((tr) => {
      if (!tr.docChanged) return;
      client.apply(tr.mapping.maps, ++seq);
    });

    // The room's copy of the thread, as the service holds it at its durable head.
    const serverRange = () => {
      const anchor = room.threadAnchors().find((a) => a.id === THREAD)!;
      const t = anchor.target;
      if (!('range' in t)) throw new Error('the thread is not a range');
      return { from: t.range.from, to: t.range.to, detached: anchor.detached };
    };
    const clientRange = () => {
      const c = client.get('thread')!;
      return { from: c.from, to: c.to, detached: c.detached };
    };
    const agree = () => {
      expect(clientRange()).toEqual(serverRange());
    };

    // 1. An insertion before the range: the owner types at the start of the intro.
    caret(olivia.core, IDS.intro, 0);
    type(olivia.core, 'Big ');
    await saved(olivia.core);
    agree();
    expect(clientRange()).toEqual({ from: range.from + 4, to: range.to + 4, detached: false });

    // 2. A deletion inside the range: "or" of "world" goes.
    const at = introStart(olivia.core) + 'Big Hello w'.length;
    i.dispatch(i.state.tr.delete(at, at + 2));
    await saved(olivia.core);
    agree();

    // 3. A remote commit: sam, an editor, types at the start of the intro. Olivia's core receives
    // it as a remote transaction, which the listener maps like a local one.
    caret(sam.core, IDS.intro, 0);
    type(sam.core, 'X');
    await saved(sam.core);
    await until(
      () => olivia.core.confirmedSeq.get() === service.document(docId)!.head,
      'olivia receives sam',
    );
    agree();

    // 4. An insertion at the end edge of the range: the owner types after "wld".
    const end = introStart(olivia.core) + 'XBig Hello wld'.length;
    i.dispatch(i.state.tr.insertText('!', end));
    await saved(olivia.core);
    agree();

    // 5. The whole range is deleted: it collapses, and both copies say the thread is detached.
    const c = client.get('thread')!;
    i.dispatch(i.state.tr.delete(c.from, c.to));
    await saved(olivia.core);
    agree();
    expect(serverRange().detached).toBe(true);
    expect(clientRange().detached).toBe(true);

    unlisten();
    olivia.detach();
    sam.detach();
    await service.dispose();
  });
});
