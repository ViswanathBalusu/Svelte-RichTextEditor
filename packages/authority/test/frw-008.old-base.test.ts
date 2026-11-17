// FRW-008 criterion 5 (lane w4): a fill made on an old base, through the room (12 §4.2; ADR 0011).
//
// - Unrelated commits were stored meanwhile, some of them before the field, so the field moved.
//   The fill is accepted, and its one `attr` step lands on the field.
// - An `attr` step has no position map: a commit made before the fill needs no mapping over it.
// - The fill is refused when it is no longer valid: the field is gone, or its value changed.
// - The check costs the same in a document 300 paragraphs longer: the scopes compared and the
//   field index entries scanned do not grow with the unchanged content, and the field is found in
//   the room's field index.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { diffScopes } from '../src/permissions/scopes.ts';
import { applySteps } from '../src/rebase.ts';
import type { Room } from '../src/room/room.ts';
import type { Effects } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { posInside, posOf } from './fixtures.ts';
import {
  FIELDS,
  USERS,
  commitId,
  fieldsDoc,
  messages,
  rejection,
  roomWith,
  schema,
} from './permission-fixtures.ts';

const INTRO = 'pIntro0000000001';
const FIELDS_PARAGRAPH = 'pFields00000001X';
const END = 'pEnd00000000001Z';

const typeIn = (doc: Node, paragraph: string, text: string): Step[] => {
  const pos = posInside(doc, paragraph);
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0))];
};
const fill = (doc: Node, id: string, value: unknown): Step[] => [
  new AttrStep(posOf(doc, id), 'value', value),
];
const valueOf = (doc: Node, id: string): unknown => doc.nodeAt(posOf(doc, id))!.attrs['value'];
const submit = (room: Room, channel: string, base: number, steps: Step[]): Effects =>
  room.submit(channel, { id: commitId(), base, steps: stepsToJson(steps) });
const store = (room: Room): Effects => room.writeCompleted({ status: 'ok' });

/** A document with `count` more paragraphs of unchanged text at its end. */
function grown(doc: Node, count: number): Node {
  const at = posOf(doc, END);
  const more = Array.from({ length: count }, (_, i) =>
    schema.nodeFromJSON({
      type: 'paragraph',
      attrs: { id: `pBulk${String(i).padStart(11, '0')}` },
      content: [{ type: 'text', text: 'unchanged' }],
    }),
  );
  const r = applySteps(doc, [new ReplaceStep(at, at, new Slice(Fragment.from(more), 0, 0))]);
  if (!r.ok) throw new Error(r.reason);
  return r.value.doc;
}

describe('FRW-008 criterion 5: a fill made on an old base', () => {
  it('is accepted after unrelated commits that moved the field, and lands on the field', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('c1', USERS.carol);
    room.open('e1', USERS.erin);
    // Two unrelated commits: text before the fields' paragraph, and text in it before the field.
    submit(room, 'c1', 0, typeIn(doc, INTRO, 'Hello '));
    store(room);
    submit(room, 'c1', 0, typeIn(doc, FIELDS_PARAGRAPH, 'More '));
    store(room);
    expect(room.head).toBe(2);
    const moved = posOf(room.document, FIELDS.number);
    expect(moved).toBe(posOf(doc, FIELDS.number) + 'Hello '.length + 'More '.length);

    // Erin's fill was made on the document of seq 0.
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '3'));
    expect(rejection(fx, 'e1')).toBeNull();
    const written = fx.write?.commits ?? [];
    expect(written).toHaveLength(1);
    // The stored commit is the one `attr` step, at the field's place in the head document, and
    // it is stamped with the field's scope alone.
    expect(written[0]!.steps).toEqual([
      { stepType: 'attr', pos: moved, attr: 'value', value: '3' },
    ]);
    expect(written[0]!.scopes).toEqual([`field:${FIELDS.number}`]);
    const ack = messages(store(room), 'e1')[0]!;
    expect(ack).toMatchObject({ t: 'sync.ack', seq: 3, rebased: true });
    expect(valueOf(room.document, FIELDS.number)).toBe('3');
    // Nothing else of the document changed.
    expect(posOf(room.document, FIELDS.number)).toBe(moved);
  });

  it('has no position map, so a commit made before the fill is stored where it was made', () => {
    const doc = fieldsDoc();
    const [step] = fill(doc, FIELDS.number, '3');
    const ranges: number[] = [];
    step!.getMap().forEach((from, to) => ranges.push(from, to));
    expect(ranges).toEqual([]);
    expect(
      Step.fromJSON(schema, stepsToJson([step!])[0])
        .getMap()
        .map(posOf(doc, END)),
    ).toBe(posOf(doc, END));

    const room = roomWith(doc);
    room.open('c1', USERS.carol);
    room.open('e1', USERS.erin);
    submit(room, 'e1', 0, fill(doc, FIELDS.number, '3'));
    store(room);
    // Carol typed after the field on the document of seq 0; the fill does not move her text.
    const typed = typeIn(doc, END, 'x');
    const fx = submit(room, 'c1', 0, typed);
    expect(fx.write?.commits[0]!.steps).toEqual(stepsToJson(typed));
    store(room);
    expect(room.head).toBe(2);
  });

  it('is refused when the field was removed meanwhile, and stores nothing', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('a1', USERS.alice);
    room.open('e1', USERS.erin);
    const at = posOf(doc, FIELDS.number);
    submit(room, 'a1', 0, [new ReplaceStep(at, at + 1, Slice.empty)]);
    store(room);
    expect(room.head).toBe(1);
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '3'));
    expect(rejection(fx, 'e1')).not.toBeNull();
    expect(fx.write).toBeNull();
    expect(room.head).toBe(1);
  });

  it('is refused with conflict when the same field was filled meanwhile (FRW-010)', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc);
    room.open('a1', USERS.alice);
    room.open('e1', USERS.erin);
    submit(room, 'a1', 0, fill(doc, FIELDS.number, '9'));
    store(room);
    const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '3'));
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'conflict' });
    expect(valueOf(room.document, FIELDS.number)).toBe('9');
  });

  it('is found in the field index, and costs the same in a document 300 paragraphs longer', () => {
    const cost = (doc: Node) => {
      const room = roomWith(doc);
      room.open('c1', USERS.carol);
      room.open('e1', USERS.erin);
      submit(room, 'c1', 0, typeIn(doc, INTRO, 'Hello '));
      store(room);
      // The room's index knows the field by its identifier, with its key and its container.
      expect(room.indexes.field(FIELDS.number)).toEqual({
        id: FIELDS.number,
        key: 'tenant.amount',
        container: 'body',
      });
      const before = room.document;
      const fx = submit(room, 'e1', 0, fill(doc, FIELDS.number, '3'));
      expect(rejection(fx, 'e1')).toBeNull();
      store(room);
      return {
        // The nodes the scope comparison of the outcome check looked at.
        compared: diffScopes(before, room.document).visited,
        // The nodes the room looked at to bring its indexes up to date after the fill.
        scanned: room.indexes.scanned,
        size: room.document.nodeSize,
      };
    };
    const small = cost(fieldsDoc());
    const large = cost(grown(fieldsDoc(), 300));
    expect(large.size).toBeGreaterThan(small.size + 300);
    expect(large.compared).toBe(small.compared);
    expect(large.scanned).toBe(small.scanned);
  });
});
