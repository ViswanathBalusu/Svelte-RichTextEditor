/**
 * SYN-036 criterion 5 (lane w4): a sender types text that is not yet confirmed, with its caret inside
 * it. The receiver's body view draws the sender's caret from the core's `carets` view, which the
 * shell's caret layer paints as it is given (UX-027). The caret must sit at a position of the
 * document the receiver holds, never inside the text it does not have.
 *
 * Both sides are real cores on backend-mock's room and presence relay. The sender's commit is never
 * answered, so its text stays unconfirmed for the whole test. The receiver is the web view, mounted
 * in a real page: run with `pnpm exec vitest run --project browser <this file>` (Chromium, Firefox
 * and WebKit). In Node.js there is no DOM, so the suite is skipped there.
 */
import { MockService } from '@docedit/backend-mock';
import type { SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../headless.ts';
import { internals } from '../testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from '../../test/fixtures.ts';
import { caret, posOf, textOfNode, type, until } from '../../test/support.ts';
import { EditorCore, viewsOf } from './web.ts';

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
  return { content, channel, at };
}

describe.skipIf(!isBrowser)('a peer caret in the receiver view (SYN-036 criterion 5)', () => {
  it('is drawn at the confirmed insertion point, never inside text the receiver lacks', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });

    // The receiver: the web view in the page.
    const host = document.createElement('div');
    host.style.position = 'relative';
    document.body.append(host);
    const r = await open(service, docId, 'rita');
    const receiver = new EditorCore({ doc: r.content, schedule });
    const unmount = receiver.mountBody(host);
    const detachReceiver = receiver.attach(r.channel, r.at);

    // The sender: its commits are never answered, so what it types stays unconfirmed.
    const s = await open(service, docId, 'sam');
    (s.channel as { submit: SyncChannel['submit'] }).submit = () => new Promise(() => {});
    const sender = new DocumentCore({ doc: s.content, schedule });
    const detachSender = sender.attach(s.channel, s.at);

    try {
      const typed = 'UNCONFIRMED ';
      caret(sender, IDS.intro, 0);
      type(sender, typed);
      // The sender's caret is in the middle of its unconfirmed text.
      caret(sender, IDS.intro, 5);
      expect(textOfNode(internals(sender).state.doc, IDS.intro)).toContain(typed);

      await until(
        () => receiver.carets.get().some((p) => p.caret !== null),
        'the receiver draws the caret',
      );
      // The update settles on the sender's last selection (presence is rate-limited).
      const view = viewsOf(receiver).view;
      if (!view) throw new Error('the body view is not mounted');
      const doc = internals(receiver).state.doc;
      const insertion = posOf(doc, IDS.intro) + 1;
      await until(
        () => receiver.peerSelections.get()[0]?.head === insertion,
        'the caret is at the confirmed insertion point',
      );

      // The receiver does not have the text, in its document or on the page.
      expect(textOfNode(doc, IDS.intro)).not.toContain('UNCONFIRMED');
      expect(view.dom.textContent).not.toContain('UNCONFIRMED');

      const peers = receiver.peerSelections.get();
      expect(peers).toHaveLength(1);
      expect(peers[0]!.anchor).toBe(insertion);
      // The position is one of the receiver's own document, in a text block.
      expect(peers[0]!.head).toBeLessThanOrEqual(doc.content.size);
      expect(doc.resolve(peers[0]!.head).parent.isTextblock).toBe(true);

      // The rectangle the shell draws is the view's own rectangle for that position, relative to
      // the element the view is mounted in.
      const drawn = receiver.carets.get();
      expect(drawn).toHaveLength(1);
      const c = view.coordsAtPos(insertion);
      const origin = host.getBoundingClientRect();
      const rect = drawn[0]!.caret!;
      expect(rect.x).toBeCloseTo(c.left - origin.left, 3);
      expect(rect.y).toBeCloseTo(c.top - origin.top, 3);
      expect(rect.height).toBeGreaterThan(0);
      expect(drawn[0]!.selection).toEqual([]);

      // The receiver types before the caret: the drawn caret follows its own text, and still sits
      // at a position of the receiver's document.
      caret(receiver, IDS.intro, 0);
      type(receiver, 'mine ');
      await until(
        () => receiver.peerSelections.get()[0]?.head === insertion + 5,
        'the caret is mapped through the receiver’s own text',
      );
      const after = internals(receiver).state.doc;
      expect(textOfNode(after, IDS.intro)).not.toContain('UNCONFIRMED');
      const moved = view.coordsAtPos(insertion + 5);
      await until(
        () => Math.abs((receiver.carets.get()[0]?.caret?.x ?? -1) - (moved.left - origin.left)) < 1,
        'the caret is measured again',
      );
    } finally {
      detachSender();
      detachReceiver();
      unmount();
      host.remove();
    }
    expect(receiver.carets.get()).toEqual([]);
  });
});
