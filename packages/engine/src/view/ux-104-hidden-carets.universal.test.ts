/**
 * UX-104 criterion 3 (lane w3): a collaborator working inside hidden content has no caret and no name
 * flag in the reader's body view (ADR 0019). The reader is the web view, mounted in a real page, over
 * a document in which the "Clause" region is a placeholder. The collaborator publishes presence
 * through backend-mock's relay, first with the scope of the hidden region, then with the scope of the
 * body. The core's `carets` view (what the shell's caret layer paints, UX-027) and its `presence`
 * list (the name flags) must hold nobody while the peer is in the hidden region, and the peer once it
 * is in the body.
 *
 * Run with `pnpm exec vitest run --project browser <this file>` (Chromium, Firefox and WebKit). In
 * Node.js there is no DOM, so the suite is skipped there.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { SPIKE_IDS, projectedDocument, spikeDocument } from '../../test/fixtures.ts';
import { internals } from '../testing.ts';
import { posOf, sleep, until } from '../../test/support.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';
const schedule = (run: () => void): void => queueMicrotask(run);

async function open(service: MockService, docId: string, sub: string) {
  const backend = service.backend({ sub }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  if (!backend.presence) throw new Error('the mock backend has no presence port');
  const at = {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    presence: backend.presence,
  };
  return { backend, content, channel, at };
}

describe.skipIf(!isBrowser)('no caret or name flag in hidden content (UX-104 criterion 3)', () => {
  it('draws nobody for a peer in the hidden region, and draws the peer once it is in the body', async () => {
    const service = new MockService();
    const docId = service.createDocument(
      spikeDocument() as Parameters<MockService['createDocument']>[0],
    );

    const host = document.createElement('div');
    host.style.position = 'relative';
    document.body.append(host);
    const r = await open(service, docId, 'rita');
    const receiver = new EditorCore({ doc: projectedDocument('Clause'), schedule });
    const unmount = receiver.mountBody(host);
    const detach = receiver.attach(r.channel, r.at);

    const s = await open(service, docId, 'sam');
    const doc = internals(receiver).state.doc;
    // The placeholder is the hidden region; a position just inside it is in hidden content.
    const inside = posOf(doc, SPIKE_IDS.region) + 1;
    const body = posOf(doc, SPIKE_IDS.intro) + 1;
    const publish = (seq: number, scope: string, at: number) =>
      s.at.presence.update(docId, {
        seq,
        state: { selection: { anchor: at, head: at }, scope, status: 'active' },
      });

    try {
      const seq = s.content.seq;
      // The peer is inside hidden content: the relay delivers it, and nothing is shown for it.
      publish(seq, `region:${SPIKE_IDS.region}`, inside);
      await sleep(100);
      expect(receiver.presence.get()).toEqual([]);
      expect(receiver.peerSelections.get()).toEqual([]);
      expect(receiver.carets.get()).toEqual([]);

      // The same peer moves into the body: now the name flag and the caret are there.
      publish(seq, 'body', body);
      await until(
        () => receiver.carets.get().some((p) => p.caret !== null),
        'the caret of the peer in the body',
      );
      expect(receiver.presence.get().map((p) => p.user)).toEqual([expect.any(String)]);
      expect(receiver.carets.get()).toHaveLength(1);

      // And back into hidden content: the caret and the name flag go.
      publish(seq, `region:${SPIKE_IDS.region}`, inside);
      await until(() => receiver.carets.get().length === 0, 'the caret is removed');
      expect(receiver.presence.get()).toEqual([]);
    } finally {
      detach();
      unmount();
      host.remove();
    }
  });
});
