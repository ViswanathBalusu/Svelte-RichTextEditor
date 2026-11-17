// FRW-005 criterion 3 (lane w4): the first half of I14 through the authority's commit path (12 §3.6).
// A mirror (`field` of kind `formValue`) whose target is no field key is refused with `invalid_op`,
// and so is a commit that deletes a field whose key a stored mirror targets. The model's
// `validateDoc` gives the same verdict (I14) for each result.
import { validateDoc } from '@docedit/model/validate';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applySteps } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';

let clock = 1_780_000_000_000;
let counter = 0;
const commitId = () => `0192f0c4-7b1e-7000-8005-${(++counter).toString(16).padStart(12, '0')}`;

const FIELD = 'fTenantName00001';

const mirror = (target: string): Node =>
  schema.nodes['field']!.create({ kind: 'formValue', target });

const insertMirror = (doc: Node, target: string): Step[] => {
  const at = posInside(doc, 'pIntro0000000001');
  return [new ReplaceStep(at, at, new Slice(Fragment.from(mirror(target)), 0, 0))];
};

const deleteNode = (doc: Node, pos: number): Step =>
  new ReplaceStep(pos, pos + doc.nodeAt(pos)!.nodeSize, Slice.empty);

/** The position of the first mirror of the document. */
function mirrorPos(doc: Node): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'field' && node.attrs['kind'] === 'formValue') found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error('the document has no mirror');
  return found;
}

function freshRoom(): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
  });
}

/** Submits a commit and completes the room's pending log write; returns what the sender was sent. */
function submit(r: Room, base: number, steps: Step[]): ToClient[] {
  let fx: Effects = r.submit('a1', { id: commitId(), base, steps: stepsToJson(steps) });
  const out = fx.send.filter((o) => o.channel === 'a1').map((o) => o.msg);
  while (fx.write) {
    fx = r.writeCompleted({ status: 'ok' });
    out.push(...fx.send.filter((o) => o.channel === 'a1').map((o) => o.msg));
  }
  return out;
}

const i14 = (doc: Node): string[] => {
  const verdict = validateDoc(doc, REQUIRES);
  return verdict.valid
    ? []
    : verdict.violations.filter((v) => v.invariant === 'I14').map((v) => v.code);
};

/** The result of `steps` on `doc`. */
function after(doc: Node, steps: Step[]): Node {
  const applied = applySteps(doc, steps);
  if (!applied.ok) throw new Error(`the steps do not apply: ${applied.reason}`);
  return applied.value.doc;
}

describe('FRW-005 criterion 3: a mirror always targets a field that exists (I14, first half)', () => {
  it('refuses a mirror whose target is no field key', () => {
    const r = freshRoom();
    r.open('a1', USERS.alice);
    const steps = insertMirror(baseDoc(), 'field:nobody');
    expect(i14(after(baseDoc(), steps))).toEqual(['unresolved_field_key']);
    const sent = submit(r, 0, steps);
    expect(sent.find((m) => m.t === 'sync.reject')).toMatchObject({ code: 'invalid_op' });
    expect(sent.some((m) => m.t === 'sync.ack')).toBe(false);
  });

  it('refuses a commit that deletes a field whose key a mirror targets, and keeps the field', () => {
    const r = freshRoom();
    r.open('a1', USERS.alice);
    const withMirror = insertMirror(baseDoc(), 'field:tenant.name');
    expect(submit(r, 0, withMirror).some((m) => m.t === 'sync.ack')).toBe(true);
    const stored = after(baseDoc(), withMirror);
    expect(i14(stored)).toEqual([]);

    const removal = [deleteNode(stored, posOf(stored, FIELD))];
    expect(i14(after(stored, removal))).toEqual(['unresolved_field_key']);
    const sent = submit(r, 1, removal);
    expect(sent.find((m) => m.t === 'sync.reject')).toMatchObject({ code: 'invalid_op' });
    expect(sent.some((m) => m.t === 'sync.ack')).toBe(false);
    // The stored document still holds the field: nothing of the commit was applied.
    expect(r.document.nodeAt(posOf(r.document, FIELD))?.attrs['key']).toBe('tenant.name');
    expect(r.head).toBe(1);
  });

  it('refuses a commit that renames the key a mirror targets', () => {
    const r = freshRoom();
    r.open('a1', USERS.alice);
    const withMirror = insertMirror(baseDoc(), 'field:tenant.name');
    submit(r, 0, withMirror);
    const stored = after(baseDoc(), withMirror);
    const rename = [new AttrStep(posOf(stored, FIELD), 'key', 'tenant.fullName')];
    expect(i14(after(stored, rename))).toEqual(['unresolved_field_key']);
    expect(submit(r, 1, rename).find((m) => m.t === 'sync.reject')).toMatchObject({
      code: 'invalid_op',
    });
  });

  it('accepts a commit that deletes the field together with its mirror', () => {
    const r = freshRoom();
    r.open('a1', USERS.alice);
    const withMirror = insertMirror(baseDoc(), 'field:tenant.name');
    submit(r, 0, withMirror);
    const stored = after(baseDoc(), withMirror);
    // The later node first, so that the earlier position still holds.
    const positions = [posOf(stored, FIELD), mirrorPos(stored)].sort((a, b) => b - a);
    const first = deleteNode(stored, positions[0]!);
    const steps = [first, deleteNode(after(stored, [first]), positions[1]!)];
    expect(i14(after(stored, steps))).toEqual([]);
    const sent = submit(r, 1, steps);
    expect(sent.find((m) => m.t === 'sync.reject')).toBeUndefined();
    expect(sent.some((m) => m.t === 'sync.ack')).toBe(true);
  });
});
