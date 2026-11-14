// FRW-018 criterion 1, the commit path (lane U-FRW-001-018): a validation.pattern outside the
// regular-expression subset is refused by the authority on commit with `invalid_op`, naming the
// construct; a pattern inside the subset is accepted. The check is RULE_INVARIANTS
// (room/rules.ts), which the model's validate runs on every commit, so both verdicts are compared.
import { validateDoc } from '@docedit/model/validate';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { RULE_INVARIANTS } from '../src/room/rules.ts';
import { applySteps } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_780_200_000_000;
let counter = 0;
const commitId = () => `0192f0c4-7c3e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function patternField(pattern: string): Node {
  return schema.nodes['form_field']!.create({
    id: 'fPatternNew00001',
    key: 'tenant.code',
    label: 'Code',
    assignee: 'role_tenant',
    kind: 'text',
    validation: { pattern },
  });
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

const cases = [
  { name: 'a back-reference in validation.pattern', pattern: '([A-Z]{2})\\1', valid: false },
  { name: 'a pattern inside the subset', pattern: '[A-Z]{2}[0-9]+', valid: true },
];

describe('FRW-018 criterion 1: the commit path refuses a pattern outside the subset', () => {
  for (const c of cases) {
    it(`${c.name}: model validate and the commit path agree (valid: ${c.valid})`, () => {
      const doc = baseDoc();
      const at = posInside(doc, 'pIntro0000000001');
      const steps = [
        new ReplaceStep(at, at, new Slice(Fragment.from(patternField(c.pattern)), 0, 0)),
      ];
      const applied = applySteps(doc, steps);
      if (!applied.ok) throw new Error(`the steps do not apply: ${applied.reason}`);

      const model = validateDoc(applied.value.doc, REQUIRES, {
        retiredRegionIds: new Set<string>(),
        invariants: [RULE_INVARIANTS],
      });
      const patternCodes = model.valid
        ? []
        : model.violations.map((v) => v.code).filter((code) => code === 'pattern_unsupported');
      expect(patternCodes.length === 0).toBe(c.valid);

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
        expect(String((reject as { reason?: unknown }).reason)).toContain('back-reference');
      }
    });
  }
});
