// FRW-005 criterion 6, I15 part (lane U-FRW-001-018): the field-count limit (2,000 fields per
// document) gives the same verdict through the model's `validateDoc` and through the authority's
// commit path. The I13 and I14 corpus is frw-005.corpus.test.ts (lane FRW-001-013); this file adds
// the one case it left out, so that the corpus covers I13 to I15.
import { validateDoc } from '@docedit/model/validate';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { Transform, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applySteps } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const LIMIT = 2_000;
let clock = 1_780_100_000_000;
let counter = 0;
const commitId = () => `0192f0c4-7b2e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const fieldNode = (i: number): Node =>
  schema.nodes['form_field']!.create({
    id: `fLimit${String(i).padStart(10, '0')}`,
    key: `tenant.limit.k${i}`,
    label: `Limit ${i}`,
    assignee: 'role_tenant',
  });

function countFields(doc: Node): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === 'form_field') n++;
    return true;
  });
  return n;
}

/** The fixture document with fields added until it holds `total` fields. */
function docWithFields(total: number): Node {
  const doc = baseDoc();
  const extra = total - countFields(doc);
  if (extra <= 0) return doc;
  const nodes = Array.from({ length: extra }, (_, k) => fieldNode(k + 1));
  const at = posInside(doc, 'pIntro0000000001');
  return new Transform(doc).replace(at, at, new Slice(Fragment.from(nodes), 0, 0)).doc;
}

function insertOneField(doc: Node): Step[] {
  const at = posInside(doc, 'pIntro0000000001');
  // A key that no field has: the fixture count is taken from the document, not assumed.
  const node = schema.nodes['form_field']!.create({
    id: 'fLimitNewOne0001',
    key: 'tenant.limit.new',
    label: 'New',
    assignee: 'role_tenant',
  });
  return new Transform(doc).replace(at, at, new Slice(Fragment.from(node), 0, 0)).steps;
}

function freshRoom(doc: Node): Room {
  return new Room({
    schema,
    initial: doc,
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
  });
}

function sent(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}

function flush(r: Room, fx: Effects): Effects {
  const all: Effects = { send: [...fx.send], write: null };
  let write = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    all.send.push(...done.send);
    write = done.write;
  }
  return all;
}

describe('FRW-005 I15: the model and the authority give the same verdict at the field limit', () => {
  const cases = [
    { name: 'the 2,000th field', before: LIMIT - 1, valid: true },
    { name: 'the 2,001st field', before: LIMIT, valid: false },
  ];

  for (const c of cases) {
    it(`${c.name}: validateDoc and the commit path agree (valid: ${c.valid})`, () => {
      const start = docWithFields(c.before);
      expect(countFields(start)).toBe(c.before);
      const steps = insertOneField(start);
      const applied = applySteps(start, steps);
      if (!applied.ok) throw new Error(`the steps do not apply: ${applied.reason}`);
      expect(countFields(applied.value.doc)).toBe(c.before + 1);

      const model = validateDoc(applied.value.doc, REQUIRES);
      const i15 = model.valid
        ? []
        : model.violations.map((v) => v.invariant).filter((inv) => inv === 'I15');
      expect(i15.length === 0).toBe(c.valid);

      const r = freshRoom(start);
      r.open('a1', USERS.alice);
      const fx = flush(r, r.submit('a1', { id: commitId(), base: 0, steps: stepsToJson(steps) }));
      const ack = sent(fx, 'a1').some((m) => m.t === 'sync.ack');
      const reject = sent(fx, 'a1').find((m) => m.t === 'sync.reject');
      if (c.valid) {
        expect(reject, c.name).toBeUndefined();
        expect(ack).toBe(true);
      } else {
        expect(ack).toBe(false);
        expect(reject).toMatchObject({ t: 'sync.reject', code: 'invalid_op' });
      }
    });
  }
});
