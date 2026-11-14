// Permission stories through the room (04 §5 steps 1, 6 and 7): locked and archived documents
// (PRM-005), retired regions (PRM-003), and fills (FRW-007 to FRW-010) as the room stores, stamps,
// acknowledges and refuses them.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { PermissionState } from '../src/permissions/model.ts';
import type { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { posInside, posOf } from './fixtures.ts';
import { SimClient } from './harness/client.ts';
import {
  FIELDS,
  MORE,
  USERS,
  commitId,
  fieldsDoc,
  messages,
  morePermissions,
  rejection,
  roomWith,
  schema,
} from './permission-fixtures.ts';

const typeIn = (doc: Node, paragraph: string, text = 'x'): Step[] => {
  const pos = posInside(doc, paragraph);
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
};
const fill = (doc: Node, id: string, value: unknown): Step[] => [
  new AttrStep(posOf(doc, id), 'value', value),
];
const valueOf = (doc: Node, id: string): unknown => doc.nodeAt(posOf(doc, id))!.attrs['value'];
const submit = (room: Room, channel: string, base: number, steps: Step[], origin?: string) =>
  room.submit(channel, {
    id: commitId(),
    base,
    steps: stepsToJson(steps),
    ...(origin ? { origin } : {}),
  });
/** Completes the pending write and returns the messages that followed. */
const store = (room: Room): Effects => room.writeCompleted({ status: 'ok' });

describe('locked and archived documents (PRM-005)', () => {
  it('refuses every commit with read_only and drop, the owner included, and stores nothing', () => {
    for (const documentState of ['locked', 'archived'] as const) {
      const doc = fieldsDoc();
      const room = roomWith(doc, morePermissions({ documentState }));
      for (const [ch, user] of [
        ['a1', USERS.alice],
        ['c1', USERS.carol],
        ['e1', USERS.erin],
      ] as const) {
        room.open(ch, user);
        const fx = submit(
          room,
          ch,
          0,
          ch === 'e1' ? fill(doc, FIELDS.number, '1') : typeIn(doc, 'pIntro0000000001'),
        );
        expect(rejection(fx, ch), `${documentState} ${user.sub}`).toMatchObject({
          code: 'read_only',
          action: 'drop',
        });
        expect(fx.write).toBeNull();
      }
      expect(room.head).toBe(0);
    }
  });

  it('keeps fill for participants while a workflow is active, and nothing else', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions({ documentState: 'locked', workflowActive: true }));
    room.open('e1', USERS.erin);
    room.open('f1', USERS.frank);
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '12.50'));
    expect(fx.write?.commits[0]?.scopes).toEqual([`field:${FIELDS.number}`]);
    store(room);
    expect(valueOf(room.document, FIELDS.number)).toBe('12.50');
    // Anything but a fill is refused, and a viewer remains read-only.
    expect(
      rejection(submit(room, 'e1', 1, typeIn(room.document, 'pIntro0000000001')), 'e1'),
    ).toMatchObject({
      code: 'permission_denied',
      action: 'drop',
    });
    expect(
      rejection(submit(room, 'f1', 1, typeIn(room.document, 'pIntro0000000001')), 'f1')?.code,
    ).toBe('read_only');
  });

  it("recomputes every connection's access and sends perm.changed when the state changes", () => {
    const room = roomWith(fieldsDoc());
    for (const [ch, user] of [
      ['a1', USERS.alice],
      ['c1', USERS.carol],
      ['e1', USERS.erin],
    ] as const)
      room.open(ch, user);
    const next: PermissionState = { ...morePermissions(), revision: 2, documentState: 'archived' };
    const fx = room.permissionsChanged(next);
    for (const ch of ['a1', 'c1', 'e1']) {
      const m = messages(fx, ch).find((x) => x.t === 'perm.changed') as Extract<
        ToClient,
        { t: 'perm.changed' }
      >;
      expect(m, ch).toBeDefined();
      expect(m.revision).toBe(2);
      expect([...m.access.body]).toEqual(['view']);
      for (const caps of m.access.regions.values()) expect([...caps]).toEqual(['view']);
      expect(m.access.fill.allowed).toBe(false);
    }
  });
});

describe('a deleted region never comes back (PRM-003)', () => {
  it('refuses a commit that inserts a retired identifier, so its grants attach to nothing', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('a1', USERS.alice);
    room.open('b1', USERS.bob);
    const at = posOf(doc, 'rLegal000000000B');
    const legal = doc.nodeAt(at)!;
    const fx = submit(room, 'a1', 0, [new ReplaceStep(at, at + legal.nodeSize, Slice.empty)]);
    expect(fx.write?.commits[0]?.retired).toEqual(['rLegal000000000B']);
    store(room);
    // Bob's group grant on Legal still exists, but there is no region it can apply to.
    const end = posOf(room.document, 'pEnd00000000001Z');
    const again = submit(room, 'a1', 1, [
      new ReplaceStep(end, end, new Slice(Fragment.from(legal), 0, 0)),
    ]);
    expect(rejection(again, 'a1')).toMatchObject({ code: 'invalid_op' });
    expect(rejection(again, 'a1')?.reason).toMatch(/I3/);
    expect(again.write).toBeNull();
    const opened = messages(room.open('b2', USERS.bob), 'b2').find((m) => m.t === 'ch.opened');
    expect(opened?.t === 'ch.opened' && opened.access.regions.has('rLegal000000000B')).toBe(false);
  });

  it('refuses an undo that re-inserts the region, and the client keeps the content as recovered edits', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    const carol = new SimClient('carol', USERS.carol, false);
    const deliver = (fx: Effects) => {
      for (const o of fx.send) if (o.channel === carol.channel) carol.receive(o.msg);
    };
    const flush = () => {
      for (const m of carol.outbox.splice(0)) {
        if (m.t === 'open') deliver(room.open(m.channel, m.conn, m.resume));
        else deliver(room.submit(m.channel, m.commit));
      }
    };
    carol.connect();
    flush();
    // Carol deletes the region Notes, which she may edit, and it is stored.
    const at = posOf(carol.visible!, 'rNotes000000000C');
    const notes = carol.visible!.nodeAt(at)!;
    const del = new ReplaceStep(at, at + notes.nodeSize, Slice.empty);
    carol.queue.push(del);
    carol.visible = del.apply(carol.visible!).doc!;
    expect(carol.trySend()).toBe(true);
    flush();
    deliver(store(room));
    expect(room.head).toBe(1);
    // Her undo puts the node back with its old identifier.
    const undo = del.invert(doc);
    carol.queue.push(undo);
    carol.visible = undo.apply(carol.visible!).doc!;
    const recoveredBefore = carol.recovered;
    expect(carol.trySend()).toBe(true);
    const sent = carol.outbox.find((m) => m.t === 'submit');
    expect(sent).toBeDefined();
    const fx = room.submit(sent!.channel, sent!.t === 'submit' ? sent!.commit : (null as never));
    carol.outbox.length = 0;
    expect(rejection(fx, carol.channel!)).toMatchObject({ code: 'invalid_op', action: 'drop' });
    deliver(fx);
    expect(carol.recovered).toBeGreaterThan(recoveredBefore);
    expect(carol.visible!.eq(room.document)).toBe(true);
    expect(room.head).toBe(1);
  });
});

describe('fills through the room (FRW-007 to FRW-010)', () => {
  it('stamps a fill with its field scope only, acknowledges it and broadcasts it (FRW-007, FRW-008)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('e1', USERS.erin);
    room.open('c1', USERS.carol);
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '12.50'), 'fill');
    expect(fx.write?.commits[0]).toMatchObject({
      scopes: [`field:${FIELDS.number}`],
      origin: 'fill',
      user: 'erin',
    });
    const done = store(room);
    expect(messages(done, 'e1').map((m) => m.t)).toEqual(['sync.ack']);
    expect(messages(done, 'c1').map((m) => m.t)).toEqual(['sync.commit']);
    // A refusal names the offending field.
    expect(
      rejection(submit(room, 'e1', 1, fill(room.document, FIELDS.landlord, 'x')), 'e1'),
    ).toMatchObject({
      code: 'permission_denied',
      action: 'drop',
      scopes: [`field:${FIELDS.landlord}`],
    });
  });

  it('refuses a wrongly typed value with field_invalid and drop, and keeps the stored value (FRW-008)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('e1', USERS.erin);
    // A binary float in a number field is refused the same way: the model reports a value of the
    // wrong type as I15 (`field_invalid`), not as I11.
    for (const [id, value] of [
      [FIELDS.number, 12.5],
      [FIELDS.number, 'twelve'],
      [FIELDS.number, '1,5'],
      [FIELDS.date, '06/11/2026'],
      [FIELDS.date, '2026-11-06T10:00:00Z'],
      [FIELDS.choice, 'maybe'],
    ] as const) {
      const fx = submit(room, 'e1', 0, fill(doc, id, value));
      const r = rejection(fx, 'e1');
      expect(r, `${id} ${String(value)}`).toMatchObject({ code: 'field_invalid', action: 'drop' });
      expect(r?.reason).toMatch(/field: value must be/);
      expect(fx.write).toBeNull();
      expect(valueOf(room.document, id)).toBeNull();
    }
  });

  it('accepts a fill made on an old base after unrelated commits, rebased (FRW-008, FRW-010)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('c1', USERS.carol);
    room.open('e1', USERS.erin);
    submit(room, 'c1', 0, typeIn(doc, 'pIntro0000000001', 'Hello '));
    store(room);
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '3'));
    const done = store(room);
    expect(fx.write?.commits).toHaveLength(1);
    const ack = messages(done, 'e1')[0]!;
    expect(ack.t === 'sync.ack' && ack.rebased).toBe(true);
    expect(valueOf(room.document, FIELDS.number)).toBe('3');
  });

  it('refuses a server-set value from every client, and accepts it only from the server (FRW-009)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('a1', USERS.alice);
    room.open('e1', USERS.erin);
    for (const ch of ['a1', 'e1'])
      expect(
        rejection(submit(room, ch, 0, fill(doc, FIELDS.dateSigned, '2020-01-01')), ch)?.code,
      ).toBe('permission_denied');
    expect(valueOf(room.document, FIELDS.dateSigned)).toBeNull();
    // The signing service writes the date in a commit with origin `sign`, under the signer.
    const signed = room.author('svc', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(fill(doc, FIELDS.dateSigned, '2026-11-06')),
      origin: 'sign',
      as: USERS.erin,
    });
    expect(signed.write?.commits[0]).toMatchObject({
      origin: 'sign',
      user: 'erin',
      scopes: [`field:${FIELDS.dateSigned}`],
    });
    store(room);
    expect(valueOf(room.document, FIELDS.dateSigned)).toBe('2026-11-06');
    // Any other server origin is refused: a prefill cannot set it (12 §9).
    const prefill = room.author('svc', {
      id: commitId(),
      base: 1,
      steps: stepsToJson(fill(room.document, FIELDS.formula, '10')),
      origin: 'prefill',
      as: 'system',
    });
    expect(prefill.send.find((o) => o.channel === 'svc')?.msg).toMatchObject({
      t: 'sync.reject',
      code: 'permission_denied',
    });
  });

  it('rejects the second of two fills of one field from the same base with conflict (FRW-010)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    const erin2 = { ...USERS.erin, sub: 'erin2', session: 's-erin2' };
    room.open('e1', USERS.erin);
    room.open('e2', erin2);
    submit(room, 'e1', 0, fill(doc, FIELDS.number, '1'));
    store(room);
    const fx = submit(room, 'e2', 0, fill(doc, FIELDS.number, '2'));
    expect(rejection(fx, 'e2')).toMatchObject({
      code: 'conflict',
      action: 'drop',
      scopes: [`field:${FIELDS.number}`],
    });
    expect(valueOf(room.document, FIELDS.number)).toBe('1');
  });

  it('leaves the reference client showing the other value after a conflict, unmerged (FRW-010)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    const a = new SimClient('erin', USERS.erin, false);
    const b = new SimClient('erin2', { ...USERS.erin, sub: 'erin2', session: 's-erin2' }, false);
    const clients = [a, b];
    const deliver = (fx: Effects) => {
      for (const o of fx.send)
        for (const c of clients) if (o.channel === c.channel) c.receive(o.msg);
    };
    const flush = (c: SimClient) => {
      for (const m of c.outbox.splice(0)) {
        if (m.t === 'open') deliver(room.open(m.channel, m.conn, m.resume));
        else deliver(room.submit(m.channel, m.commit));
      }
    };
    for (const c of clients) {
      c.connect();
      flush(c);
    }
    // Both fill the same field from the same base.
    for (const [c, value] of [
      [a, '100'],
      [b, '200'],
    ] as const) {
      const step = new AttrStep(posOf(c.visible!, FIELDS.number), 'value', value);
      c.queue.push(step);
      c.visible = step.apply(c.visible!).doc!;
      expect(c.trySend()).toBe(true);
    }
    flush(a);
    flush(b); // waits for storage behind A's commit
    deliver(store(room));
    deliver(store(room));
    expect(valueOf(room.document, FIELDS.number)).toBe('100');
    expect(valueOf(b.visible!, FIELDS.number)).toBe('100');
    expect(valueOf(b.confirmed!, FIELDS.number)).toBe('100');
    expect(b.recovered).toBeGreaterThan(0);
  });

  it('rejects a fill after a server-authored change of the same field (FRW-010)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('e1', USERS.erin);
    // The server writes a value of the same field, for example a prefill (12 §9).
    const prefill = room.author('svc', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(fill(doc, FIELDS.number, '9')),
      origin: 'prefill',
      as: 'system',
    });
    expect(prefill.write?.commits).toHaveLength(1);
    store(room);
    expect(rejection(submit(room, 'e1', 0, fill(doc, FIELDS.number, '1')), 'e1')?.code).toBe(
      'conflict',
    );
  });

  it("rejects a fill after an author's edit of the same field, and the whole commit with it (FRW-010)", () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('c1', USERS.carol);
    room.open('e1', USERS.erin);
    // An author sets the date directly while the document is a draft.
    submit(room, 'c1', 0, fill(doc, FIELDS.date, '2026-12-01'));
    store(room);
    const fx = submit(room, 'e1', 0, [
      ...fill(doc, FIELDS.number, '5'),
      ...fill(doc, FIELDS.date, '2026-12-24'),
    ]);
    expect(rejection(fx, 'e1')).toMatchObject({
      code: 'conflict',
      scopes: [`field:${FIELDS.date}`],
    });
    expect(valueOf(room.document, FIELDS.number)).toBeNull();
    expect(valueOf(room.document, FIELDS.date)).toBe('2026-12-01');
    // Unrelated fields changed meanwhile never conflict.
    const ok = submit(room, 'e1', 0, fill(doc, FIELDS.choice, 'yes'));
    expect(ok.write?.commits).toHaveLength(1);
  });

  it('lets Lena, a landlord participant, fill only the landlord fields', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('l1', MORE.lena);
    expect(submit(room, 'l1', 0, fill(doc, FIELDS.landlord, 'Lena')).write?.commits).toHaveLength(
      1,
    );
    store(room);
    expect(
      rejection(submit(room, 'l1', 1, fill(room.document, FIELDS.number, '1')), 'l1')?.code,
    ).toBe('permission_denied');
  });
});
