// FRW-005 criterion 6: one corpus of valid and invalid field documents gives the same verdict for
// I13 and I14 through the model's `validateDoc` and through the authority's commit path (12 §3.6).
// I15 (the limit of 2,000 fields) is not in this corpus: the model test covers it, and building 2,000
// fields here would only repeat it. The rules' half of I14 is FRW-019.
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
const commitId = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

type Case = { name: string; make: (doc: Node) => Step[]; valid: boolean };

const newField = (key: string, assignee: string | null, id: string): Node =>
  schema.nodes['form_field']!.create({ id, key, label: key, assignee });

const insertInBody = (doc: Node, node: Node): Step[] => {
  const at = posInside(doc, 'pIntro0000000001');
  return [new ReplaceStep(at, at, new Slice(Fragment.from(node), 0, 0))];
};

const CASES: Case[] = [
  {
    name: 'a new field with a fresh key and a role that exists',
    make: (doc) => insertInBody(doc, newField('tenant.note', 'role_tenant', 'fCorpusNote00001')),
    valid: true,
  },
  {
    name: 'I13: a second field with an existing key',
    make: (doc) => insertInBody(doc, newField('tenant.name', 'role_tenant', 'fCorpusDup000001')),
    valid: false,
  },
  {
    name: 'I13: an assignee that names no role',
    make: (doc) => [new AttrStep(posOf(doc, 'fTenantName00001'), 'assignee', 'role_nobody')],
    valid: false,
  },
  {
    name: 'I13: deleting a role that a field still uses',
    make: (doc) => {
      const role = posOf(doc, 'role_tenant');
      return [new ReplaceStep(role, role + doc.nodeAt(role)!.nodeSize, Slice.empty)];
    },
    valid: false,
  },
  {
    name: 'I14: a mirror of a key that no field has',
    make: (doc) =>
      insertInBody(
        doc,
        schema.nodes['field']!.create({ kind: 'formValue', target: 'field:nobody' }),
      ),
    valid: false,
  },
  {
    name: 'I14: a mirror of an existing key',
    make: (doc) =>
      insertInBody(
        doc,
        schema.nodes['field']!.create({ kind: 'formValue', target: 'field:tenant.name' }),
      ),
    valid: true,
  },
];

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

function sent(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}

/** Completes the room's pending log write, as the document service does (see room-scenarios). */
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

describe('FRW-005 I13 and I14: the model and the authority give the same verdict', () => {
  for (const c of CASES) {
    it(`${c.name}: validateDoc and the commit path agree (valid: ${c.valid})`, () => {
      const doc = baseDoc();
      const steps = c.make(doc);
      const applied = applySteps(doc, steps);
      if (!applied.ok) throw new Error(`the steps do not apply: ${applied.reason}`);

      const model = validateDoc(applied.value.doc, REQUIRES);
      const modelFieldCodes = model.valid
        ? []
        : model.violations
            .map((v) => v.invariant)
            .filter((inv) => inv === 'I13' || inv === 'I14' || inv === 'I15');
      expect(modelFieldCodes.length === 0).toBe(c.valid);

      const r = freshRoom();
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
