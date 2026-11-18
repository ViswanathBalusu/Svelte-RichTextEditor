// FRW-029 criterion 1 (lane w4): while a workflow is `sent` or `in_progress`, a commit that is not a
// fill allowed by P7 or a server-authored value allowed by P8 is refused, whoever sends it, the
// owner included. The code is `read_only` where the state is what forbids the change (the same
// user could make it on an active document with no workflow) and `permission_denied` where it is
// not (a participant outside their fields, a user with no right in any state). The room is the one
// the service runs; the lock is the one `lockFor` gives for the workflow state.
import fc from 'fast-check';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room/room.ts';
import { stepsToJson } from '../src/steps.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { posInside, posOf } from './fixtures.ts';
import {
  FIELDS,
  USERS,
  commitId,
  fieldsDoc,
  messages,
  morePermissions,
  rejection,
  roomWith,
  schema,
} from './permission-fixtures.ts';

type UserName = keyof typeof USERS;
const CHANGES = {
  /** Text in the body. */
  text: (doc: Node): Step[] => {
    const pos = posInside(doc, 'pIntro0000000001');
    return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))];
  },
  /** An attribute of a field: its definition, not its value. */
  attribute: (doc: Node): Step[] => [
    new AttrStep(posOf(doc, FIELDS.number), 'key', 'tenant.changed'),
  ],
  /** A value in a field assigned to the tenant: P7 allows the tenant's participant. */
  fillTenant: (doc: Node): Step[] => [new AttrStep(posOf(doc, FIELDS.number), 'value', '12.50')],
  /** A value in a field assigned to the landlord: outside the tenant participant's fields. */
  fillLandlord: (doc: Node): Step[] => [
    new AttrStep(posOf(doc, FIELDS.landlord), 'value', 'Grace'),
  ],
  /** A value in a field no role may fill. */
  fillAuthorOnly: (doc: Node): Step[] => [
    new AttrStep(posOf(doc, FIELDS.authorOnly), 'value', 'note'),
  ],
  /** A signature: a value only the server sets (P8). */
  clientSignature: (doc: Node): Step[] => [
    new AttrStep(posOf(doc, FIELDS.signature), 'value', {
      asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
      mode: 'typed',
    }),
  ],
} as const;
type ChangeName = keyof typeof CHANGES;

/** The users whose role carries `fill`: the owner, the editors and the filler (12 §4.1). */
const HOLDS_FILL: ReadonlySet<UserName> = new Set(['alice', 'bob', 'carol', 'mallory', 'erin']);

const lockedRoom = (state: 'sent' | 'in_progress'): Room => {
  const lock = lockFor(state)!;
  return roomWith(
    fieldsDoc(),
    morePermissions({
      revision: 2,
      documentState: lock.documentState,
      workflowActive: lock.workflowActive,
    }),
  );
};

/** What the same user and change meet on an active document with no workflow. */
function onDraft(user: UserName, change: ChangeName): string {
  const doc = fieldsDoc();
  const room = roomWith(doc, morePermissions());
  room.open('c', USERS[user]);
  const fx = room.submit('c', {
    id: commitId(),
    base: 0,
    steps: stepsToJson(CHANGES[change](doc)),
  });
  const refusal = rejection(fx, 'c');
  return refusal ? refusal.code : 'accepted';
}

describe('a commit under a running workflow is a fill or a server value, or it is refused (FRW-029 criterion 1)', () => {
  it('accepts only the fill of the participant who holds the role, refuses every other user and change, stores nothing for them', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'sent' | 'in_progress'>('sent', 'in_progress'),
        fc.constantFrom(...(Object.keys(USERS) as UserName[])),
        fc.constantFrom(...(Object.keys(CHANGES) as ChangeName[])),
        (state, user, change) => {
          const doc = fieldsDoc();
          const room = lockedRoom(state);
          room.open('c', USERS[user]);
          const fx = room.submit('c', {
            id: commitId(),
            base: 0,
            steps: stepsToJson(CHANGES[change](doc)),
          });
          const refusal = rejection(fx, 'c');
          if (user === 'erin' && change === 'fillTenant') {
            // P7: the active participant fills a field of their role.
            expect(refusal).toBeNull();
            expect(fx.write).not.toBeNull();
            return;
          }
          expect(refusal, `${user} ${change} ${state}`).not.toBeNull();
          expect(fx.write).toBeNull();
          expect(room.head).toBe(0);
          // `read_only` where only the state forbids the change: step 1 for a user with no `fill`
          // (04 §5), and the outcome check for one who could make it on an active document.
          // `permission_denied` for what no state would allow.
          const stateOnly = !HOLDS_FILL.has(user) || onDraft(user, change) === 'accepted';
          expect(refusal!.code, `${user} ${change} ${state}`).toBe(
            stateOnly ? 'read_only' : 'permission_denied',
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it('gives a participant permission_denied for a change outside their fields', () => {
    for (const change of ['text', 'attribute', 'fillLandlord', 'fillAuthorOnly'] as const) {
      const doc = fieldsDoc();
      const room = lockedRoom('in_progress');
      room.open('e1', USERS.erin);
      const fx = room.submit('e1', {
        id: commitId(),
        base: 0,
        steps: stepsToJson(CHANGES[change](doc)),
      });
      expect(rejection(fx, 'e1'), change).toMatchObject({ code: 'permission_denied' });
    }
  });

  it('refuses a signature written by a client with permission_denied in any state (P8), the owner included', () => {
    for (const state of ['sent', 'in_progress'] as const) {
      const doc = fieldsDoc();
      const room = lockedRoom(state);
      room.open('a1', USERS.alice);
      const fx = room.submit('a1', {
        id: commitId(),
        base: 0,
        steps: stepsToJson(CHANGES.clientSignature(doc)),
      });
      expect(rejection(fx, 'a1'), state).toMatchObject({ code: 'permission_denied' });
      expect(onDraft('alice', 'clientSignature')).toBe('permission_denied');
    }
  });

  it('refuses the owner in every changing form with read_only', () => {
    for (const state of ['sent', 'in_progress'] as const) {
      for (const change of ['text', 'attribute', 'fillTenant'] as const) {
        const doc = fieldsDoc();
        const room = lockedRoom(state);
        room.open('a1', USERS.alice);
        const fx = room.submit('a1', {
          id: commitId(),
          base: 0,
          steps: stepsToJson(CHANGES[change](doc)),
        });
        expect(rejection(fx, 'a1'), `${state} ${change}`).toMatchObject({
          code: 'read_only',
          action: 'drop',
        });
      }
    }
  });
});

describe('a value the server sets stays possible under the lock (FRW-029 criterion 1, P8)', () => {
  const author = (
    room: Room,
    origin: 'sign' | 'rules' | 'prefill',
    steps: Step[],
    as: 'system' | (typeof USERS)[UserName],
  ) =>
    room.author('control', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(steps),
      origin,
      as,
    });

  it('accepts a signature that the server writes with origin sign, for the participant who signs', () => {
    for (const state of ['sent', 'in_progress'] as const) {
      const doc = fieldsDoc();
      const room = lockedRoom(state);
      const fx = author(room, 'sign', CHANGES.clientSignature(doc), USERS.erin);
      expect(rejection(fx, 'control'), state).toBeNull();
      expect(fx.write, state).not.toBeNull();
    }
  });

  it('accepts a formula value that the server writes with origin rules', () => {
    const doc = fieldsDoc();
    const room = lockedRoom('in_progress');
    const fx = author(
      room,
      'rules',
      [new AttrStep(posOf(doc, FIELDS.formula), 'value', '12')],
      'system',
    );
    expect(rejection(fx, 'control')).toBeNull();
    expect(fx.write).not.toBeNull();
  });

  it('refuses a server commit with another reserved origin that changes text or a server kind', () => {
    const doc = fieldsDoc();
    const cases = [
      ['prefill', CHANGES.text(doc), USERS.alice],
      ['prefill', CHANGES.clientSignature(doc), USERS.alice],
      ['rules', CHANGES.text(doc), 'system'],
      ['sign', CHANGES.text(doc), USERS.erin],
    ] as const;
    for (const [origin, steps, as] of cases) {
      const room = lockedRoom('sent');
      const fx = author(room, origin, [...steps], as);
      expect(
        messages(fx, 'control')[0],
        `${origin} ${typeof as === 'string' ? as : as.sub}`,
      ).toMatchObject({
        t: 'sync.reject',
      });
      expect(fx.write).toBeNull();
      expect(room.head).toBe(0);
    }
  });
});
