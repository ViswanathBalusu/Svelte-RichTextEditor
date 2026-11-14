// FE-006 criterion 3, at the session level (02 §2.1; PRO-076): a closed session releases its
// channel, detaches and destroys its editor, drops every subscription it made on the editor's views
// and closes the backend it was asked to close. The counters wrap the real objects, so a release
// that is missed shows as a count that does not return to zero. Workers, timers, observers and
// IndexedDB handles are not owned by Session; they are not covered here (see the story's Notes).
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import {
  backendFor,
  fakeEditor,
  recordingHost,
  service,
  settle,
  type FakeEditor,
} from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);

interface Subscribable {
  subscribe(listener: () => void): () => void;
}

/** Counts the subscriptions a view has open: +1 on subscribe, -1 on the first call of its stop. */
function countSubscriptions(view: Subscribable, tally: { live: number }): void {
  const subscribe = view.subscribe.bind(view);
  view.subscribe = (listener) => {
    tally.live++;
    const stop = subscribe(listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      tally.live--;
      stop();
    };
  };
}

describe('Session: release on close (FE-006 criterion 3, session level)', () => {
  it('closes the channel, detaches and destroys the editor, drops its subscriptions and closes the backend once', async () => {
    const { service: s, docId } = service();
    const editor: FakeEditor = fakeEditor();
    const tally = { live: 0 };
    for (const view of [
      editor.saveState,
      editor.confirmed,
      editor.access,
      editor.recovered,
      editor.problem,
    ])
      countSubscriptions(view, tally);

    let detaches = 0;
    const attach = editor.handle.attach;
    editor.handle.attach = (channel, at) => {
      const detach = attach(channel, at);
      return () => {
        detaches++;
        detach();
      };
    };

    const backend = backendFor(s, docId, 'editor', 'editor');
    let backendCloses = 0;
    const closeBackend = backend.close.bind(backend);
    backend.close = async () => {
      backendCloses++;
      await closeBackend();
    };

    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    expect(session.phase).toBe('ready');
    expect(tally.live).toBeGreaterThan(0);

    const channel = editor.attached[0]!;
    let channelCloses = 0;
    const closeChannel = channel.close.bind(channel);
    channel.close = () => {
      channelCloses++;
      closeChannel();
    };

    const eventsBefore = host.events.length;
    await session.close({ closeBackend: true });
    await session.close({ closeBackend: true });

    expect(session.phase).toBe('closed');
    // The session closes its channel, and the backend it closes closes its own channels too, so the
    // channel may be closed more than once; the close must be safe to repeat.
    expect(channelCloses).toBeGreaterThanOrEqual(1);
    expect(detaches).toBe(1);
    expect(editor.destroyed).toBe(1);
    expect(backendCloses).toBe(1);
    expect(tally.live).toBe(0);

    // Whatever the editor's views say after close reaches no listener and no host event.
    editor.saveState.set('unsaved');
    editor.confirmed.set(3);
    editor.recovered.set({ count: 2 });
    await settle();
    expect(host.events.length).toBe(eventsBefore);
    expect(tally.live).toBe(0);
  });
});
