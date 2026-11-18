/**
 * UX-027 criterion 2: with concurrent local and remote edits, each peer's selection stays on the same
 * text. Two real cores on the mock service, with presence on: each selects some text, both edit at
 * once while the server holds the writes (so each has unconfirmed steps the other has not seen),
 * the writes are released and the commits are rebased, and then each core's view of the other's
 * selection (`peerSelections`, the positions the shell turns into carets) covers the text the peer
 * selected. Node.js; the rectangles are the body view's and are tested in browsers.
 */
import { MockService } from '@docedit/backend-mock';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { counted, microtask, posOf, sleep, until } from './support.ts';

interface Peer {
  readonly core: DocumentCore;
  readonly detach: () => void;
}

/** Joins as `join` of support.ts does, with the presence port attached. */
async function joinWithPresence(service: MockService, docId: string, sub: string): Promise<Peer> {
  const backend = service.backend({ sub }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const channel = counted(
    await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    }),
  );
  const limits = backend.auth.session?.limits;
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    ...(limits ? { limits } : {}),
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
    presence: backend.presence!,
  });
  return { core, detach };
}

/** Selects `text` inside the paragraph `id` of the core's own document. */
function selectText(core: DocumentCore, id: string, text: string): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  const offset = i.state.doc.nodeAt(at - 1)!.textContent.indexOf(text);
  expect(offset).toBeGreaterThanOrEqual(0);
  i.dispatch(
    i.state.tr.setSelection(
      TextSelection.create(i.state.doc, at + offset, at + offset + text.length),
    ),
  );
}

const paragraph = (core: DocumentCore, id: string): string => {
  const doc = internals(core).state.doc;
  return doc.nodeAt(posOf(doc, id))!.textContent;
};

/** What the peer's selection covers in `core`'s own document. */
function covered(core: DocumentCore, sub: string): string | null {
  const peer = core.peerSelections.get().find((p) => p.user === sub);
  if (!peer) return null;
  const doc = internals(core).state.doc;
  return doc.textBetween(Math.min(peer.anchor, peer.head), Math.max(peer.anchor, peer.head));
}

type Edit = (core: DocumentCore) => void;
const insertAtStart =
  (id: string, text: string): Edit =>
  (core) => {
    const i = internals(core);
    i.dispatch(i.state.tr.insertText(text, posOf(i.state.doc, id) + 1));
  };
const deleteStart =
  (id: string, length: number): Edit =>
  (core) => {
    const i = internals(core);
    const at = posOf(i.state.doc, id) + 1;
    i.dispatch(i.state.tr.delete(at, at + length));
  };

const SCRIPTS: ReadonlyArray<{ name: string; ada: Edit; bob: Edit }> = [
  {
    name: 'both insert before the peers’ selections',
    ada: insertAtStart(IDS.intro, 'ONE '),
    bob: insertAtStart(IDS.intro, 'TWO '),
  },
  {
    name: 'one deletes text before the other’s selection while the other types before both',
    ada: deleteStart(IDS.intro, 6),
    bob: insertAtStart(IDS.intro, 'Intro: '),
  },
  {
    name: 'edits in the paragraph that holds one selection and the one that holds the other',
    ada: insertAtStart(IDS.mid, 'Mid '),
    bob: insertAtStart(IDS.intro, 'Top '),
  },
];

describe('UX-027 criterion 2: peers’ selections stay on the same text under concurrent edits', () => {
  for (const script of SCRIPTS) {
    it(script.name, async () => {
      const service = new MockService({ presence: true });
      const docId = service.createDocument(contractDocument());
      const ada = await joinWithPresence(service, docId, 'ada');
      const bob = await joinWithPresence(service, docId, 'bob');
      try {
        // Ada selects "Between" in the middle paragraph and Bob selects "world" in the intro.
        selectText(ada.core, IDS.mid, 'Between');
        selectText(bob.core, IDS.intro, 'world');
        await until(
          () => covered(ada.core, 'bob') === 'world' && covered(bob.core, 'ada') === 'Between',
          'each side to see the other’s selection',
        );

        // Both edit while the server holds the writes: neither has seen the other's steps.
        const held = service.holdWrites(docId);
        script.ada(ada.core);
        script.bob(bob.core);
        await sleep(20);
        expect(ada.core.saveState.get()).not.toBe('saved');
        await held.release();
        await until(
          () =>
            internals(ada.core).state.doc.eq(internals(bob.core).state.doc) &&
            ada.core.saveState.get() === 'saved' &&
            bob.core.saveState.get() === 'saved',
          'both cores to converge',
        );

        // The selections the shell draws are still on the text the peers selected.
        await until(
          () => covered(ada.core, 'bob') === 'world' && covered(bob.core, 'ada') === 'Between',
          'the peers’ selections to settle',
        );
        expect(covered(ada.core, 'bob')).toBe('world');
        expect(covered(bob.core, 'ada')).toBe('Between');
        // The edits did happen, in both cores, and are the same.
        expect(paragraph(ada.core, IDS.intro)).toBe(paragraph(bob.core, IDS.intro));
        expect(paragraph(ada.core, IDS.intro)).not.toBe('Hello world');
      } finally {
        ada.detach();
        bob.detach();
      }
    });
  }
});
