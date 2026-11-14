// FRW-003 criterion 6: a whole-document restore with no active workflow returns field values to
// their values at the restored sequence number (12 §3.3). The restore is a snapshot commit (04 §3.2;
// SYN-005) whose content is the checkpoint, so the field values come back with the rest of the
// document. Criterion 5 (comparison and history) is tested in frw-003.field-time.test.ts.
import { AttrStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { basePermissions, posOf } from './fixtures.ts';
import { stepsToJson } from '../src/steps.ts';
import { FIELDS, USERS, commitId, fieldsDoc, rejection, roomWith } from './permission-fixtures.ts';
import type { Node } from 'prosemirror-model';
import type { Room } from '../src/room/room.ts';

const NOW = 1_000;

const valueAt = (doc: Node): unknown => doc.nodeAt(posOf(doc, FIELDS.number))!.attrs['value'];

const setValue = (room: Room, value: string) => {
  const steps: Step[] = [new AttrStep(posOf(room.document, FIELDS.number), 'value', value)];
  const fx = room.submit('a1', { id: commitId(), base: room.head, steps: stepsToJson(steps) });
  expect(rejection(fx, 'a1')).toBeNull();
  storeAll(room);
};

/** Completes every write the room asks for, as the document service would. */
const storeAll = (room: Room): void => {
  let fx = room.writeCompleted({ status: 'ok' });
  while (fx.write) fx = room.writeCompleted({ status: 'ok' });
};

describe('FRW-003 a whole-document restore returns field values (criterion 6)', () => {
  it('returns a field value to its value at the restored sequence number', () => {
    const room = roomWith(fieldsDoc(), basePermissions(), () => NOW);
    room.open('a1', USERS.alice);
    setValue(room, '12.50');
    // The content at the sequence number to restore to: the value is 12.50 there.
    const restoredContent = room.document;
    expect(valueAt(restoredContent)).toBe('12.50');
    setValue(room, '13.00');
    expect(valueAt(room.document)).toBe('13.00');

    const fx = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content: restoredContent,
      checkpoint: 'c',
      as: USERS.alice,
    });
    expect(fx.write?.snapshot).toMatchObject({ origin: 'restore' });
    storeAll(room);
    expect(valueAt(room.document)).toBe('12.50');
  });

  it('refuses the same restore while a workflow is active, and leaves the value as it is', () => {
    const room = roomWith(fieldsDoc(), { ...basePermissions(), workflowActive: true }, () => NOW);
    room.open('a1', USERS.alice);
    const before = valueAt(room.document);
    const fx = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content: fieldsDoc(),
      checkpoint: 'c',
      as: USERS.alice,
    });
    expect(fx.write).toBeNull();
    storeAll(room);
    expect(valueAt(room.document)).toBe(before);
  });
});
