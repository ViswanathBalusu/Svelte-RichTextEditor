// Screen-reader announcements (02 §10; FE-107): once per save-state change, the rejected-edit,
// presence and recovered-edit sentences, the order and the no-loss guarantee of the queue.
import type { ResolveUsers, UserInfo } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ANNOUNCE_EN, Announcer, type Notice } from '../src/announcer.ts';
import type { SyncState } from '../src/events.ts';
import { manualFrames } from './support.ts';

/** Lets pending promise callbacks (name resolution) run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const names =
  (table: Record<string, string>): ResolveUsers =>
  async (ids) =>
    ids.map((id): UserInfo | null => (id in table ? { id, name: table[id] ?? '' } : null));

function harness(opts: { resolveUsers?: ResolveUsers | null; initialSync?: SyncState } = {}) {
  const frames = manualFrames();
  const sent: string[] = [];
  const announcer = new Announcer({
    sink: (text) => sent.push(text),
    schedule: frames.schedule,
    resolveUsers: opts.resolveUsers ?? null,
    initialSync: opts.initialSync ?? 'saved',
  });
  /** Runs every scheduled delivery, letting name resolution settle between them. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 50 && (frames.pending() > 0 || announcer.pending > 0); i++) {
      await tick();
      frames.flush();
    }
  };
  return { announcer, sent, drain, frames };
}

describe('save state (criterion 1)', () => {
  it('announces each change once, in order, and not the state the document opened in', async () => {
    const { announcer, sent, drain } = harness();
    expect(announcer.notify({ kind: 'sync', sync: 'saved' })).toBe(false);
    expect(announcer.notify({ kind: 'sync', sync: 'saving' })).toBe(true);
    expect(announcer.notify({ kind: 'sync', sync: 'saving' })).toBe(false);
    expect(announcer.notify({ kind: 'sync', sync: 'saved' })).toBe(true);
    expect(announcer.notify({ kind: 'sync', sync: 'unsaved' })).toBe(true);
    expect(announcer.notify({ kind: 'sync', sync: 'readonly' })).toBe(true);
    await drain();
    expect(sent).toEqual([
      ANNOUNCE_EN.saving,
      ANNOUNCE_EN.saved,
      ANNOUNCE_EN.unsaved,
      ANNOUNCE_EN.readonly,
    ]);
  });
});

describe('rejected edits and recovered edits (criterion 2 text, criterion 4)', () => {
  it('names where the edit was refused and the reason the protocol gives', async () => {
    const { announcer, sent, drain } = harness();
    announcer.notify({
      kind: 'rejected',
      where: 'Section 2',
      reason: 'You cannot edit this part.',
    });
    await drain();
    expect(sent).toEqual(['An edit was not applied at Section 2. You cannot edit this part.']);
  });

  it('announces recovered edits with their count, and nothing for zero', async () => {
    const { announcer, sent, drain } = harness();
    expect(announcer.notify({ kind: 'recovered', count: 0 })).toBe(false);
    expect(announcer.notify({ kind: 'recovered', count: 3 })).toBe(true);
    await drain();
    expect(sent).toEqual(['Edits set aside for recovery: 3.']);
  });
});

describe('presence (criterion 3)', () => {
  it('names the collaborator through resolveUsers', async () => {
    const { announcer, sent, drain } = harness({ resolveUsers: names({ u1: 'Ada Lovelace' }) });
    announcer.notify({ kind: 'presence', change: 'arrived', userId: 'u1' });
    announcer.notify({ kind: 'presence', change: 'left', userId: 'u1' });
    await drain();
    expect(sent).toEqual(['Ada Lovelace joined the document.', 'Ada Lovelace left the document.']);
  });

  it('falls back to a generic name when the host does not know the identifier or fails', async () => {
    const failing: ResolveUsers = async () => {
      throw new Error('host down');
    };
    const unknown = harness({ resolveUsers: names({}) });
    unknown.announcer.notify({ kind: 'presence', change: 'arrived', userId: 'nobody' });
    await unknown.drain();
    const broken = harness({ resolveUsers: failing });
    broken.announcer.notify({ kind: 'presence', change: 'left', userId: 'u9' });
    await broken.drain();
    const none = harness({ resolveUsers: null });
    none.announcer.notify({ kind: 'presence', change: 'arrived', userId: 'u2' });
    await none.drain();
    expect(unknown.sent).toEqual(['A collaborator joined the document.']);
    expect(broken.sent).toEqual(['A collaborator left the document.']);
    expect(none.sent).toEqual(['A collaborator joined the document.']);
  });

  it('keeps the order when a slow name resolves after a later save-state change', async () => {
    let release: (() => void) | undefined;
    const slow: ResolveUsers = async (ids) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ids.map((id) => ({ id, name: 'Grace' }));
    };
    const { announcer, sent, drain } = harness({ resolveUsers: slow });
    announcer.notify({ kind: 'presence', change: 'arrived', userId: 'u3' });
    announcer.notify({ kind: 'sync', sync: 'saving' });
    await tick();
    expect(sent).toEqual([]);
    release?.();
    await drain();
    expect(sent).toEqual(['Grace joined the document.', ANNOUNCE_EN.saving]);
  });
});

describe('queue (criterion 5)', () => {
  it('spreads a burst over scheduled turns instead of delivering it at once', () => {
    const { announcer, sent, frames } = harness();
    announcer.notify({ kind: 'recovered', count: 1 });
    announcer.notify({ kind: 'recovered', count: 2 });
    announcer.notify({ kind: 'recovered', count: 3 });
    expect(sent).toEqual([]);
    frames.flush();
    expect(sent).toHaveLength(1);
    frames.flush();
    frames.flush();
    expect(sent).toEqual([
      'Edits set aside for recovery: 1.',
      'Edits set aside for recovery: 2.',
      'Edits set aside for recovery: 3.',
    ]);
  });

  it('closed announcers accept nothing and deliver nothing more', async () => {
    const { announcer, sent, drain } = harness();
    announcer.notify({ kind: 'recovered', count: 1 });
    announcer.close();
    expect(announcer.notify({ kind: 'recovered', count: 2 })).toBe(false);
    await drain();
    expect(sent).toEqual([]);
  });

  it('delivers every accepted notice exactly once and in the order accepted (property)', async () => {
    const noticeArb: fc.Arbitrary<Notice> = fc.oneof(
      fc
        .constantFrom<SyncState>('saved', 'saving', 'unsaved', 'readonly')
        .map((sync): Notice => ({ kind: 'sync', sync })),
      fc
        .record({ where: fc.constantFrom('Intro', 'Table 1'), reason: fc.constant('No.') })
        .map((r): Notice => ({ kind: 'rejected', ...r })),
      fc.integer({ min: 0, max: 5 }).map((count): Notice => ({ kind: 'recovered', count })),
      fc
        .record({
          change: fc.constantFrom('arrived' as const, 'left' as const),
          userId: fc.constantFrom('u1', 'u2'),
        })
        .map((p): Notice => ({ kind: 'presence', ...p })),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(noticeArb, { maxLength: 40 }), async (notices) => {
        const { announcer, sent, drain } = harness({
          resolveUsers: names({ u1: 'Ada', u2: 'Alan' }),
        });
        // A model of what must be accepted, and of the sentence each accepted notice makes.
        let last: SyncState = 'saved';
        const expected: string[] = [];
        for (const n of notices) {
          const accepted = announcer.notify(n);
          let want = false;
          if (n.kind === 'sync' && n.sync !== last) {
            want = true;
            last = n.sync;
            expected.push(ANNOUNCE_EN[n.sync]);
          } else if (n.kind === 'rejected') {
            want = true;
            expected.push(`An edit was not applied at ${n.where}. ${n.reason}`);
          } else if (n.kind === 'recovered' && n.count > 0) {
            want = true;
            expected.push(`Edits set aside for recovery: ${n.count}.`);
          } else if (n.kind === 'presence') {
            want = true;
            const name = n.userId === 'u1' ? 'Ada' : 'Alan';
            expected.push(
              n.change === 'arrived'
                ? `${name} joined the document.`
                : `${name} left the document.`,
            );
          }
          expect(accepted).toBe(want);
        }
        await drain();
        expect(sent).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });
});
