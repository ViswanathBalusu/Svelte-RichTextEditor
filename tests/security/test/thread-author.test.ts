/**
 * SEC-019 criterion 4 — a thread request that names another author is stored with the caller as
 * author (10 §3.2; 05 §5.4; 07 §12 row 5). The authority's room stores the thread; the wire route
 * for threads and comments is not served in phase 1a, so this proof runs at the room, the component
 * that writes the anchor, with the request carrying the claimed identity the wire could carry.
 */
import { Room, type Connection } from '@docedit/authority';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CAROL, fieldsDoc, permissions, schema } from './support/authority-fixtures.ts';

type ThreadRequest = Parameters<Room['createThread']>[0];

let clock = 1_770_000_000_000;
let counter = 0;
/** A fresh thread identifier in the UUID version 7 layout. */
const threadId = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(): Room {
  return new Room({
    schema,
    initial: fieldsDoc(),
    requires: ['fields'],
    log: [],
    perms: permissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-sec-019',
    now: () => ++clock,
  });
}

const DAN: Connection = { ...CAROL, sub: 'dan', session: 's-dan' };

describe('SEC-019 criterion 4: a thread names its caller as author, whatever the request claims', () => {
  it('stores the caller as author when the request claims another author', () => {
    const r = room();
    // A request with extra identity fields, as a hand-crafted message could carry them.
    const claimed = {
      id: threadId(),
      as: CAROL,
      target: { block: 'pIntro0000000001' },
      author: 'victim',
      user: 'victim',
      session: 'forged',
    } as unknown as ThreadRequest;
    const out = r.createThread(claimed);
    expect(out).toMatchObject({ ok: true });
    const [stored] = r.threadAnchors();
    expect(stored!.author).toBe(CAROL.sub);
    expect(stored!.author).not.toBe('victim');
  });

  it('answers a retry of the same thread only to its author; another user cannot take the id', () => {
    const r = room();
    const id = threadId();
    expect(r.createThread({ id, as: CAROL, target: { block: 'pIntro0000000001' } })).toMatchObject({
      ok: true,
    });
    const other = r.createThread({ id, as: DAN, target: { block: 'pIntro0000000001' } });
    expect(other).toMatchObject({ ok: false, code: 'conflict' });
    expect(r.threadAnchors().map((t) => t.author)).toEqual([CAROL.sub]);
  });

  it('whatever author fields are claimed, the stored author is always the caller', () => {
    const r = room();
    fc.assert(
      fc.property(
        fc.record({
          author: fc.string({ maxLength: 16 }),
          user: fc.string({ maxLength: 16 }),
          sub: fc.string({ maxLength: 16 }),
        }),
        (claims) => {
          const out = r.createThread({
            id: threadId(),
            as: CAROL,
            target: { block: 'pIntro0000000001' },
            ...claims,
          } as unknown as ThreadRequest);
          if (!out.ok) return; // the thread limit or a scope refusal would be a different proof
          expect(out.thread.author).toBe(CAROL.sub);
        },
      ),
      { numRuns: 50 },
    );
    for (const t of r.threadAnchors()) expect(t.author).toBe(CAROL.sub);
  });
});
