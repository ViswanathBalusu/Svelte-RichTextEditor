// Region policy and access (PRM-036): a manage holder restricts a region to named people, the
// access of connected people follows, the owner keeps every region capability, and returning the
// policy to inherit gives the document roles back. Run through the room (04 §5 steps 6, 7 and 9).
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import { REGION_CAPABILITIES } from '../src/permissions/model.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { posInside, posOf } from './fixtures.ts';
import {
  USERS,
  commitId,
  fieldsDoc,
  messages,
  morePermissions,
  rejection,
  roomWith,
  schema,
} from './permission-fixtures.ts';
import type { Room } from '../src/room/room.ts';

const TERMS = 'rTerms000000000A';
const TERMS_PARA = 'pTerms000000001A';

const setPolicy = (doc: Node, policy: string): Step[] => [
  new AttrStep(posOf(doc, TERMS), 'policy', policy),
];
const typeIn = (doc: Node, paragraph: string, text = 'x'): Step[] => {
  const pos = posInside(doc, paragraph);
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
};
const submit = (room: Room, channel: string, base: number, steps: Step[]): Effects =>
  room.submit(channel, { id: commitId(), base, steps: stepsToJson(steps) });
const store = (room: Room): Effects => room.writeCompleted({ status: 'ok' });

/** The region capabilities a connection holds in Terms, recomputed from the room's state. */
const termsCaps = (room: Room, user: (typeof USERS)[keyof typeof USERS]): string[] =>
  [
    ...computeAccess(user, regionInfos(room.document), room.permissions, 0).regions.get(TERMS)!,
  ].sort();

const openedAccess = (fx: Effects, channel: string) => {
  const m: ToClient | undefined = messages(fx, channel).find((x) => x.t === 'ch.opened');
  if (!m || m.t !== 'ch.opened') throw new Error(`no ch.opened on ${channel}`);
  return m.access;
};

describe('region policy and access (PRM-036)', () => {
  it('a manage holder restricts a region; a connected editor without a grant keeps only view and comment (criteria 1 and 2)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions());
    const carolOpened = room.open('c1', USERS.carol);
    expect(openedAccess(carolOpened, 'c1').regions.get(TERMS)).toContain('edit');

    room.open('a1', USERS.alice);
    const submitted = submit(room, 'a1', 0, setPolicy(doc, 'restricted'));
    expect(rejection(submitted, 'a1')).toBeNull();
    const stored = store(room);
    expect(room.document.nodeAt(posOf(room.document, TERMS))!.attrs['policy']).toBe('restricted');

    // Criterion 1: the connected editor's access is recomputed and sent to her channel.
    const pushed = messages(stored, 'c1').find((m) => m.t === 'perm.changed');
    if (!pushed || pushed.t !== 'perm.changed') throw new Error('no perm.changed for c1');
    expect([...pushed.access.regions.get(TERMS)!].sort()).toEqual(['comment', 'view']);
    expect(messages(stored, 'a1').some((m) => m.t === 'perm.changed')).toBe(false);

    // Criterion 2: no edit in Terms, while view and comment remain.
    expect(termsCaps(room, USERS.carol)).toEqual(['comment', 'view']);
    const refused = submit(room, 'c1', room.head, typeIn(room.document, TERMS_PARA));
    expect(rejection(refused, 'c1')).toMatchObject({ action: 'drop' });
    expect(room.head).toBe(1);
  });

  it('the owner keeps all four region capabilities in a restricted region', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions());
    room.open('a1', USERS.alice);
    submit(room, 'a1', 0, setPolicy(doc, 'restricted'));
    store(room);
    expect(termsCaps(room, USERS.alice)).toEqual([...REGION_CAPABILITIES].sort());
  });

  it('a user without manage cannot restrict a region: the commit is refused and nothing changes (criterion 3, authority half)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions());
    room.open('c1', USERS.carol);
    const fx = submit(room, 'c1', 0, setPolicy(doc, 'restricted'));
    expect(rejection(fx, 'c1')).toMatchObject({ action: 'drop' });
    expect(fx.write).toBeNull();
    expect(room.document.nodeAt(posOf(room.document, TERMS))!.attrs['policy']).toBe('inherit');
  });

  it('returning the policy to inherit gives the document roles back (criterion 4)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions());
    room.open('a1', USERS.alice);
    room.open('c1', USERS.carol);
    submit(room, 'a1', 0, setPolicy(doc, 'restricted'));
    store(room);
    expect(termsCaps(room, USERS.carol)).not.toContain('edit');

    submit(room, 'a1', room.head, setPolicy(room.document, 'inherit'));
    store(room);
    expect(termsCaps(room, USERS.carol)).toEqual([...REGION_CAPABILITIES].sort());
    const fx = submit(room, 'c1', room.head, typeIn(room.document, TERMS_PARA));
    expect(rejection(fx, 'c1')).toBeNull();
    expect(fx.write).not.toBeNull();
  });
});
