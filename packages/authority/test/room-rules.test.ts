// The rules language in the room (12 §3.6, §4.2, §5; ADR 0030; SYN-012, SYN-037; FRW-019): the
// rule half of I14 on every commit, fills only into fields the rules leave visible and enabled
// (P7), and a rule evaluation budget whose overrun is refused with `rate_limited`.
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, posOf, schema } from './fixtures.ts';

let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

type J = Record<string, unknown>;

/** The base document with a flag field beside the tenant's name and rules in the definitions. */
function withRules(rules: J[], flag: string | null = null) {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  json.content[0]!.content.push(...rules.map((attrs) => ({ type: 'rule_def', attrs })));
  const intro = json.content[1]!.content[1]!;
  intro['content'] = [
    { type: 'text', text: 'Flag: ' },
    {
      type: 'form_field',
      attrs: {
        id: 'fFlag00000000001',
        key: 'tenant.flag',
        kind: 'text',
        label: 'Flag',
        value: flag,
      },
    },
  ];
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** The tenant's name is hidden while the flag is empty. */
const showName = {
  id: 'rHideName',
  when: { empty: [{ field: 'tenant.flag' }] },
  then: [{ hide: ['tenant.name'] }],
};

function room(doc: ReturnType<typeof withRules>, extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: doc,
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_800_000_000_000,
    ...extra,
  });
}
type Reject = Extract<ToClient, { t: 'sync.reject' }>;
function rejection(fx: Effects, channel: string): Reject | undefined {
  const m = fx.send.find((o) => o.channel === channel && o.msg.t === 'sync.reject')?.msg;
  return m?.t === 'sync.reject' ? m : undefined;
}
const fill = (
  doc: ReturnType<typeof withRules>,
  field = 'fTenantName00001',
  value: unknown = 'Ada',
) => stepsToJson([new AttrStep(posOf(doc, field), 'value', value)]);

describe('rules in the room (FRW-019; SYN-012; SYN-037)', () => {
  it('refuses a commit that adds a 501st rule with invalid_op (I15)', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, when: true, then: [] }));
    const doc = withRules(many);
    const r = room(doc);
    r.open('a1', USERS.alice);
    const at = posOf(doc, 'r0');
    const one = schema.nodes['rule_def']!.create({ id: 'r500', when: true, then: [] });
    const fx = r.submit('a1', {
      id: id(),
      base: 0,
      steps: stepsToJson([new ReplaceStep(at, at, new Slice(Fragment.from(one), 0, 0))]),
    });
    expect(rejection(fx, 'a1')).toMatchObject({
      code: 'invalid_op',
      reason: expect.stringMatching(/^I15 /),
    });
  });

  it('lets a participant fill a field only while the rules show it (P7)', () => {
    const hidden = withRules([showName]);
    const r = room(hidden);
    r.open('e1', USERS.erin);
    expect(
      rejection(r.submit('e1', { id: id(), base: 0, steps: fill(hidden) }), 'e1'),
    ).toMatchObject({
      code: 'permission_denied',
      reason: expect.stringMatching(/hidden or disabled by the rules/),
    });
    const shown = withRules([showName], 'yes');
    const s = room(shown);
    s.open('e1', USERS.erin);
    expect(
      rejection(s.submit('e1', { id: id(), base: 0, steps: fill(shown) }), 'e1'),
    ).toBeUndefined();
  });

  it('refuses a commit whose rule evaluation exceeds the budget with rate_limited, without stalling', () => {
    const shown = withRules([showName], 'yes');
    const r = room(shown, { ruleBudget: 1 });
    r.open('e1', USERS.erin);
    const t0 = performance.now();
    const fx = r.submit('e1', { id: id(), base: 0, steps: fill(shown) });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(rejection(fx, 'e1')).toMatchObject({ code: 'rate_limited', action: 'retry' });
    expect(fx.write).toBeNull();
    // An editor's change of the same value is not a fill: P1 decides, no rule is evaluated.
    r.open('a1', USERS.alice);
    expect(
      rejection(r.submit('a1', { id: id(), base: 0, steps: fill(shown) }), 'a1'),
    ).toBeUndefined();
  });

  it('refuses a rule that reads a key that does not exist, or a cycle of formulas, with invalid_op (I14)', () => {
    const doc = withRules([]);
    const r = room(doc);
    r.open('a1', USERS.alice);
    const at = posOf(doc, 'role_tenant') + doc.nodeAt(posOf(doc, 'role_tenant'))!.nodeSize;
    const add = (...rules: J[]) =>
      stepsToJson([
        new ReplaceStep(
          at,
          at,
          new Slice(
            Fragment.from(rules.map((attrs) => schema.nodes['rule_def']!.create(attrs))),
            0,
            0,
          ),
        ),
      ]);
    const unknown = rejection(
      r.submit('a1', {
        id: id(),
        base: 0,
        steps: add({ id: 'rNope', when: { '==': [{ field: 'nope' }, '1'] }, then: [] }),
      }),
      'a1',
    );
    expect(unknown).toMatchObject({ code: 'invalid_op', reason: expect.stringMatching(/^I14 /) });
    // Two formula fields set from each other.
    const formulas = withRules([]);
    const json = formulas.toJSON() as { content: Array<{ content: J[] }> };
    (json.content[1]!.content[1]!['content'] as J[]).push(
      {
        type: 'form_field',
        attrs: { id: 'fFormulaA0000001', key: 'calc.a', kind: 'formula', label: 'A' },
      },
      {
        type: 'form_field',
        attrs: { id: 'fFormulaB0000001', key: 'calc.b', kind: 'formula', label: 'B' },
      },
    );
    const two = schema.nodeFromJSON(json);
    const t = room(two);
    t.open('a1', USERS.alice);
    const cycle = rejection(
      t.submit('a1', {
        id: id(),
        base: 0,
        steps: add(
          {
            id: 'rA',
            when: true,
            then: [{ set: { field: 'calc.a', value: { field: 'calc.b' } } }],
          },
          {
            id: 'rB',
            when: true,
            then: [{ set: { field: 'calc.b', value: { field: 'calc.a' } } }],
          },
        ),
      }),
      'a1',
    );
    expect(cycle).toMatchObject({
      code: 'invalid_op',
      reason: expect.stringMatching(/I14 .*calc\.a, calc\.b/),
    });
  });
});
