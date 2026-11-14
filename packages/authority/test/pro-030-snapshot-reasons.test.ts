// PRO-030 criterion 1 (lane U-PRO-018-034): every snapshot commit reaches every open channel as
// `sync.reset` carrying its `seq` and its `reason`, and the four reasons of 04 §3.2 (`import`,
// `restore`, `migration`, `repair`) all take that path. The room is the component that emits the
// reset; the data plane forwards it unchanged. services/document-service/src/data-plane/
// snapshot-reset.test.ts covers `import` over the whole plane.
import { describe, expect, it } from 'vitest';
import { basePermissions } from './fixtures.ts';
import { USERS, commitId, fieldsDoc, roomWith } from './permission-fixtures.ts';
import type { Room } from '../src/room/room.ts';

const NOW = 1_000;

const REASONS = ['import', 'restore', 'migration', 'repair'] as const;

/** Completes the writes the room asks for, as the document service would; returns every send. */
function completeWrites(room: Room): { channel: string; msg: { t: string } }[] {
  const sent: { channel: string; msg: { t: string } }[] = [];
  let fx = room.writeCompleted({ status: 'ok' });
  sent.push(...fx.send);
  while (fx.write) {
    fx = room.writeCompleted({ status: 'ok' });
    sent.push(...fx.send);
  }
  return sent;
}

describe('a snapshot commit reaches every channel as sync.reset (PRO-030 criterion 1)', () => {
  it.each(REASONS)(
    'sends sync.reset with the seq and the reason %s to every open channel',
    (reason) => {
      const room = roomWith(fieldsDoc(), basePermissions(), () => NOW);
      room.open('a1', USERS.alice);
      room.open('b1', USERS.bob);
      room.open('f1', USERS.frank);
      // A restore needs `manage`, so it is requested as the owner; the other reasons are server
      // authored and go in as the system.
      const fx = room.snapshot('control', {
        id: commitId(),
        reason,
        content: fieldsDoc(),
        checkpoint: 'c',
        as: reason === 'restore' ? USERS.alice : 'system',
      });
      expect(fx.write?.snapshot).toMatchObject({ origin: reason });
      const sent = completeWrites(room);
      const seq = room.head;
      expect(seq).toBeGreaterThan(0);
      for (const channel of ['a1', 'b1', 'f1']) {
        const resets = sent.filter((o) => o.channel === channel && o.msg.t === 'sync.reset');
        expect(resets).toHaveLength(1);
        expect(resets[0]!.msg).toMatchObject({ t: 'sync.reset', seq, reason });
      }
    },
  );
});
