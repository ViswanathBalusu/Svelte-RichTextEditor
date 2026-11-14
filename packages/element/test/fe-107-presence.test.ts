// FE-107 criterion 3: arrivals and departures of other sessions are reported once each, with the
// user identifier the host resolves to a name. The diff is pure (presence-notices.ts); the session
// test checks that the editor's presence view reaches `onPresence`. Node.js only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PresenceWatch, presenceChanges, type PeerLike } from '../src/presence-notices.ts';
import { Session } from '../src/session.ts';
import { Value, backendFor, fakeEditor, recordingHost, service, settle } from './support.ts';

const peer = (session: string, user: string): PeerLike => ({ session, user });

describe('presenceChanges (criterion 3)', () => {
  it('reports the users of the sessions that arrived and left, in list order', () => {
    const before = [peer('s1', 'ada'), peer('s2', 'grace')];
    const after = [peer('s2', 'grace'), peer('s3', 'linus'), peer('s4', 'ada')];
    expect(presenceChanges(before, after)).toEqual({ arrived: ['linus', 'ada'], left: ['ada'] });
  });

  it('reports nothing for an unchanged list, or for a user whose session is still there', () => {
    expect(presenceChanges([peer('s1', 'ada')], [peer('s1', 'ada')])).toEqual({
      arrived: [],
      left: [],
    });
  });

  it('gives two notices for one user with two sessions, one per session', () => {
    expect(presenceChanges([], [peer('s1', 'ada'), peer('s2', 'ada')])).toEqual({
      arrived: ['ada', 'ada'],
      left: [],
    });
  });
});

describe('PresenceWatch (criterion 3)', () => {
  it('takes the list it starts with as the baseline, and reports later changes only', () => {
    const reported: string[] = [];
    const watch = new PresenceWatch([peer('s1', 'ada')], (change, user) =>
      reported.push(`${change}:${user}`),
    );
    watch.update([peer('s1', 'ada')]);
    expect(reported).toEqual([]);
    watch.update([peer('s1', 'ada'), peer('s2', 'grace')]);
    watch.update([peer('s2', 'grace')]);
    expect(reported).toEqual(['arrived:grace', 'left:ada']);
  });

  it('started without a baseline, reports nothing until settled, then takes the settled list', () => {
    const reported: string[] = [];
    const watch = new PresenceWatch(null, (change, user) => reported.push(`${change}:${user}`));
    watch.update([peer('s1', 'ada')]);
    expect(watch.settled).toBe(false);
    watch.settle([peer('s1', 'ada'), peer('s2', 'grace')]);
    watch.settle([]); // a second settle changes nothing
    watch.update([peer('s1', 'ada'), peer('s2', 'grace')]);
    expect(reported).toEqual([]);
    watch.update([peer('s2', 'grace'), peer('s3', 'linus')]);
    expect(reported).toEqual(['arrived:linus', 'left:ada']);
  });

  it('is a property: over random snapshots, each arrival and departure is reported exactly once', () => {
    const sessions = ['s1', 's2', 's3', 's4', 's5'];
    const users = ['ada', 'grace', 'linus'];
    const snapshot = fc
      .uniqueArray(fc.constantFrom(...sessions), { maxLength: sessions.length })
      .map((ids) => ids.map((id) => peer(id, users[sessions.indexOf(id) % users.length]!)));
    fc.assert(
      fc.property(fc.array(snapshot, { minLength: 1, maxLength: 20 }), (steps) => {
        const reported: string[] = [];
        const first = steps[0]!;
        const watch = new PresenceWatch(first, (change, user) =>
          reported.push(`${change}:${user}`),
        );
        const expected: string[] = [];
        let previous = first;
        for (const next of steps.slice(1)) {
          watch.update(next);
          const { arrived, left } = presenceChanges(previous, next);
          expected.push(...arrived.map((u) => `arrived:${u}`), ...left.map((u) => `left:${u}`));
          previous = next;
        }
        expect(reported).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });
});

describe('session wiring (criterion 3)', () => {
  // The stand-in editor takes no `presence.state`, so the list in hand when the opening window ends
  // (0 ms here) is the baseline. The real core against the mock backend: fe-107-presence-core.test.ts.
  it('calls onPresence for each change of the editor presence view, and not for the baseline', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const presence = new Value<readonly PeerLike[]>([peer('s9', 'ada')]);
    Object.assign(editor.handle, { presence });
    const changes: string[] = [];
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host: recordingHost(editor),
      scheduler: (run) => queueMicrotask(run),
      onPresence: (change, user) => changes.push(`${change}:${user}`),
      presenceBaselineMs: 0,
    });
    await session.start();
    await settle();
    presence.set([peer('s9', 'ada'), peer('s10', 'grace')]);
    presence.set([peer('s10', 'grace')]);
    expect(changes).toEqual(['arrived:grace', 'left:ada']);
    await session.close();
    await s.dispose();
  });
});
