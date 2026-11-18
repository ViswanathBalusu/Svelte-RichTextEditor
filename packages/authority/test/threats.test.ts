// The threat cases of 07 §16 that concern commits (rows 1 to 6, 9 and 13; PRM-059), each as an
// executable test against the room, so that a regression cannot reopen a known attack.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AttrStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { Room } from '../src/room/room.ts';
import type { Effects } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { addSuggestion } from './block-suggest.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';
import { MemoryStorage } from './harness/storage.ts';
import { commitId, rejection, roomWith } from './permission-fixtures.ts';

const LEGAL = 'rLegal000000000B';

function open(room: Room, ...users: Connection[]): void {
  for (const u of users) room.open(u.sub, u);
}
const send = (room: Room, user: Connection, steps: Step[], base = 0): Effects =>
  room.submit(user.sub, { id: commitId(), base, steps: stepsToJson(steps) });
const typeAt = (doc: Node, paragraph: string, text = 'pwned '): Step[] => {
  const pos = posInside(doc, paragraph);
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
};

describe('threat cases against commits (07 §16; PRM-059)', () => {
  it('row 1: steps that edit a region without a grant are refused with permission_denied', () => {
    const room = roomWith(baseDoc(), basePermissions());
    open(room, USERS.carol);
    const fx = send(room, USERS.carol, typeAt(room.document, 'pLegal000000001B'));
    expect(rejection(fx, 'carol')).toMatchObject({
      code: 'permission_denied',
      scopes: [`region:${LEGAL}`],
    });
    expect(fx.write).toBeNull();
  });

  it('row 2: attribute, mark, block-suggestion and crafted replaceAround steps are judged by what changed', () => {
    const doc = baseDoc();
    const p = posOf(doc, 'pLegal000000001B');
    const start = posInside(doc, 'pLegal000000001B');
    const node = doc.nodeAt(p)!;
    const sneaky: Array<[string, Step[]]> = [
      ['attr', [new AttrStep(p, 'style', 'Heading1')]],
      ['addMark', [new AddMarkStep(start, start + 9, schema.marks['strike']!.create())]],
      [
        'block suggestion (attr)',
        [
          addSuggestion(
            doc,
            p,
            schema.marks['del']!.create({ id: 'sCarol0000000009', user: 'carol' }),
          ),
        ],
      ],
      [
        'replaceAround',
        [
          new ReplaceAroundStep(
            p,
            p + node.nodeSize,
            p + 1,
            p + node.nodeSize - 1,
            new Slice(
              Fragment.from(schema.nodes['paragraph']!.create({ ...node.attrs, align: 'end' })),
              0,
              0,
            ),
            1,
            true,
          ),
        ],
      ],
    ];
    for (const [kind, steps] of sneaky) {
      const room = roomWith(baseDoc(), basePermissions());
      open(room, USERS.carol);
      const fx = send(room, USERS.carol, steps);
      expect(rejection(fx, 'carol'), kind).toMatchObject({
        code: 'permission_denied',
        scopes: [`region:${LEGAL}`],
      });
    }
  });

  it('row 3: steps based on an old version are checked after rebasing, against the document now', () => {
    const room = roomWith(baseDoc(), basePermissions());
    open(room, USERS.alice, USERS.carol);
    const old = room.document;
    // The owner wraps the paragraph Carol is about to edit in a new restricted region.
    const at = posOf(old, 'pMiddle000000001');
    const end = at + old.nodeAt(at)!.nodeSize;
    const wrap = new ReplaceAroundStep(
      at,
      end,
      at,
      end,
      new Slice(
        Fragment.from(
          schema.nodes['region']!.create({ id: 'rLocked000000001', policy: 'restricted' }),
        ),
        0,
        0,
      ),
      1,
      true,
    );
    send(room, USERS.alice, [wrap]);
    room.writeCompleted({ status: 'ok' });
    // Carol's commit was made before the wrap and names the paragraph's old position.
    const fx = send(room, USERS.carol, typeAt(old, 'pMiddle000000001'), 0);
    expect(rejection(fx, 'carol')).toMatchObject({
      code: 'permission_denied',
      scopes: ['region:rLocked000000001'],
    });
  });

  it('row 4: a document-level editor cannot delete or move a whole restricted region', () => {
    const doc = baseDoc();
    const at = posOf(doc, LEGAL);
    const legal = doc.nodeAt(at)!;
    const top = posOf(doc, 'pTitle0000000001');
    for (const steps of [
      [new ReplaceStep(at, at + legal.nodeSize, Slice.empty)],
      [
        new ReplaceStep(at, at + legal.nodeSize, Slice.empty),
        new ReplaceStep(top, top, new Slice(Fragment.from(legal), 0, 0)),
      ],
    ]) {
      const room = roomWith(baseDoc(), basePermissions());
      open(room, USERS.carol);
      expect(rejection(send(room, USERS.carol, steps), 'carol')).toMatchObject({
        code: 'permission_denied',
      });
    }
  });

  it("row 5: wrapping others' content needs structure, and flipping a region to restricted needs manage", () => {
    const doc = baseDoc();
    const at = posOf(doc, 'pIntro0000000001');
    const end = at + doc.nodeAt(at)!.nodeSize;
    const wrap = (policy: string) => [
      new ReplaceAroundStep(
        at,
        end,
        at,
        end,
        new Slice(
          Fragment.from(schema.nodes['region']!.create({ id: 'rWrap00000000001', policy })),
          0,
          0,
        ),
        1,
        true,
      ),
    ];
    const room = roomWith(baseDoc(), basePermissions());
    open(room, USERS.dave, USERS.carol);
    expect(rejection(send(room, USERS.dave, wrap('inherit')), 'dave')?.code).toBe(
      'permission_denied',
    );
    expect(rejection(send(room, USERS.carol, wrap('restricted')), 'carol')?.reason).toMatch(
      /`region.policy` needs `manage`/,
    );
    const flip = [new AttrStep(posOf(doc, 'rTerms000000000A'), 'policy', 'restricted')];
    expect(rejection(send(room, USERS.carol, flip), 'carol')?.reason).toMatch(
      /`region.policy` needs `manage`/,
    );
  });

  it('row 6: restyling, hiding or renumbering protected text through a definition is refused', () => {
    const doc = baseDoc();
    for (const [attr, value] of [
      ['strike', true],
      ['hidden', true],
      ['color', '#FFFFFF'],
      ['fontSize', 2],
    ] as const) {
      const room = roomWith(baseDoc(), basePermissions());
      open(room, USERS.carol);
      const fx = send(room, USERS.carol, [new AttrStep(posOf(doc, 'LegalBody'), attr, value)]);
      const r = rejection(fx, 'carol');
      // Either the attribute is outside the grammar (I11) or 07 §5.3 refuses it: never stored.
      expect(fx.write, attr).toBeNull();
      expect(['permission_denied', 'invalid_op'], attr).toContain(r?.code);
      if (r?.code === 'permission_denied') expect(r.scopes, attr).toContain(`region:${LEGAL}`);
    }
  });

  it('row 9: reusing a node identifier or re-creating a deleted region to inherit its grants is refused', () => {
    const room = roomWith(baseDoc(), basePermissions());
    open(room, USERS.alice, USERS.carol);
    const doc = room.document;
    // I2: give a paragraph the identifier of another node.
    const reuse = [new AttrStep(posOf(doc, 'pIntro0000000001'), 'id', 'pTitle0000000001')];
    expect(rejection(send(room, USERS.carol, reuse), 'carol')?.code).toBe('invalid_op');
    // I3: the owner deletes Legal, then a region with its identifier is created again.
    const at = posOf(doc, LEGAL);
    const legal = doc.nodeAt(at)!;
    send(room, USERS.alice, [new ReplaceStep(at, at + legal.nodeSize, Slice.empty)]);
    room.writeCompleted({ status: 'ok' });
    const end = posOf(room.document, 'pEnd00000000001Z');
    const again = send(
      room,
      USERS.alice,
      [new ReplaceStep(end, end, new Slice(Fragment.from(legal), 0, 0))],
      1,
    );
    expect(rejection(again, 'alice')).toMatchObject({ code: 'invalid_op' });
    expect(again.write).toBeNull();
  });

  it('row 13: after a grant is removed and the room missed the notification, nothing is stored under the old revision', () => {
    const storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
    const room = new Room({
      schema,
      initial: storage.initial,
      requires: storage.requires,
      log: storage.log,
      perms: storage.perms,
      initialRevision: storage.initialRevision,
      epoch: storage.epoch,
      incarnation: storage.incarnation,
      now: () => 1_760_000_000_000,
    });
    open(room, USERS.bob);
    // The legal group's grant is removed; the notification to the room is lost.
    storage.changePermissions((p: PermissionState) => ({
      ...p,
      grants: p.grants.filter((g) => g.principal !== 'group:legal'),
    }));
    const fx = send(room, USERS.bob, typeAt(room.document, 'pLegal000000001B'));
    // The room still holds the old grants and queues the commit, but the write is conditional.
    expect(fx.write?.revision).toBe(1);
    const result = storage.write(fx.write!, 'none');
    expect(result.status).toBe('revision_moved');
    const done = room.writeCompleted(result);
    expect(rejection(done, 'bob')).toMatchObject({ code: 'unavailable', action: 'retry' });
    expect(storage.log).toEqual([]);
    // Resubmitted, it is checked against the new permissions and refused.
    const retry = send(room, USERS.bob, typeAt(room.document, 'pLegal000000001B'));
    expect(rejection(retry, 'bob')).toMatchObject({
      code: 'permission_denied',
      scopes: [`region:${LEGAL}`],
    });
    expect(storage.log).toEqual([]);
  });
});
