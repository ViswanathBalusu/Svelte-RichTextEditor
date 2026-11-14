// PRO-028 criterion 4 (lane V-PRO-018-034): a `sync.reject` with `field_invalid` names the rule
// that failed. The room is the authority (04 §5 step 6); the fixtures are those of the permission
// stories.
import { type Node } from 'prosemirror-model';
import { AttrStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room/room.ts';
import { stepsToJson } from '../src/steps.ts';
import { posOf } from './fixtures.ts';
import { FIELDS, USERS, commitId, fieldsDoc, rejection, roomWith } from './permission-fixtures.ts';

const fill = (doc: Node, id: string, value: unknown): Step[] => [
  new AttrStep(posOf(doc, id), 'value', value),
];
const submit = (room: Room, channel: string, base: number, steps: Step[]) =>
  room.submit(channel, { id: commitId(), base, steps: stepsToJson(steps) });

describe('sync.reject for a wrongly typed field value (PRO-028 criterion 4)', () => {
  it('names the rule I15 with field_invalid for a user who may only fill', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('e1', USERS.erin);
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, 'twelve'));
    expect(rejection(fx, 'e1')).toMatchObject({
      code: 'field_invalid',
      action: 'drop',
      rule: 'I15',
    });
  });

  it('gives invalid_op with no rule for a user who may edit the document', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('a1', USERS.alice);
    const fx = submit(room, 'a1', 0, fill(doc, FIELDS.number, 'twelve'));
    const r = rejection(fx, 'a1') as Record<string, unknown> | undefined;
    expect(r).toMatchObject({ code: 'invalid_op' });
    expect(r).not.toHaveProperty('rule');
  });
});
