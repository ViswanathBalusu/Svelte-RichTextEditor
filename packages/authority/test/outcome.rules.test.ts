// The outcome check's registered rule modules (PRM-010; 07 §5.2; 12 §4.2): P4 and P7 are modules
// behind seams, a missing or failing module leaves its scopes refused (fail closed), a module is
// consulted only for the scopes routed to it, and no module, however permissive, can relax a rule
// of the core (P2, P8, P9, `manage`, 07 §5.3, values that cannot be read).
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { outcomeCheck, type OutcomeVerdict } from '../src/permissions/outcome.ts';
import {
  type FillRule,
  NO_RULES,
  type OutcomeRules,
  type SuggestRule,
} from '../src/permissions/registry.ts';
import { STANDARD_RULES } from '../src/permissions/standard.ts';
import { SUGGESTION_RULE } from '../src/permissions/suggestions.ts';
import { FILL_RULE } from '../src/permissions/fill.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import { USERS, posInside, posOf } from './fixtures.ts';
import { FIELDS, MORE, fieldsDoc, morePermissions, schema } from './permission-fixtures.ts';

function run(
  user: Connection,
  before: Node,
  steps: Step[],
  rules: OutcomeRules | undefined,
  perms: PermissionState = morePermissions(),
  extra: { fieldsChangedSinceBase?: Set<string> } = {},
): OutcomeVerdict {
  const r = applySteps(before, steps);
  if (!r.ok) throw new Error(r.reason);
  return outcomeCheck({
    before,
    after: r.value.doc,
    user: user.sub,
    access: computeAccess(user, regionInfos(before), perms, 0),
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: extra.fieldsChangedSinceBase ?? new Set(),
    serverAuthored: false,
    origin: 'input',
    ...(rules ? { rules } : {}),
  });
}

const suggestIn = (doc: Node, user: string): Step[] => {
  const pos = posInside(doc, 'pIntro0000000001', 5);
  const mark = schema.marks['ins']!.create({ id: `s${user.padEnd(15, '0')}`, user });
  return [
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('really ', [mark])), 0, 0)),
  ];
};
const fill = (doc: Node, id: string, value: unknown): Step[] => [
  new AttrStep(posOf(doc, id), 'value', value),
];

/** A stub that records its calls and answers as told. */
function stubSuggest(answer: 'ok' | 'no' | 'throw'): SuggestRule & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'P4-stub',
    calls,
    check(scope) {
      calls.push(scope);
      if (answer === 'throw') throw new Error('boom');
      return answer === 'ok' ? { ok: true, claimed: [] } : { ok: false, reason: 'stub says no' };
    },
  };
}
function stubFill(answer: 'ok' | 'no' | 'throw' | 'odd'): FillRule & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'P7-stub',
    calls,
    check(f) {
      calls.push(f.id);
      if (answer === 'throw') throw new Error('boom');
      if (answer === 'odd') return { ok: 'yes' } as never; // anything but `ok: true` refuses
      return answer === 'ok' ? { ok: true } : { ok: false, reason: 'stub says no' };
    },
  };
}

describe('the P4 seam (PRM-010, criterion 5)', () => {
  it('refuses a valid suggestion when no suggestion rule is registered: fail closed', () => {
    const doc = fieldsDoc();
    expect(run(USERS.dave, doc, suggestIn(doc, 'dave'), STANDARD_RULES).ok).toBe(true);
    for (const rules of [NO_RULES, { fill: FILL_RULE }]) {
      const v = run(USERS.dave, doc, suggestIn(doc, 'dave'), rules);
      expect(v).toMatchObject({ ok: false, code: 'permission_denied', scopes: ['body'] });
      if (!v.ok) expect(v.reason).toMatch(/no suggestion rule is registered \(fail closed\)/);
    }
  });

  it('delegates only suggest-only scopes, and a module that throws or refuses leaves them refused', () => {
    const doc = fieldsDoc();
    const yes = stubSuggest('ok');
    expect(run(USERS.dave, doc, suggestIn(doc, 'dave'), { suggest: yes }).ok).toBe(true);
    expect(yes.calls).toEqual(['body']);
    // An editor's direct change is P1's: the module is never asked.
    const asked = stubSuggest('no');
    const pos = posInside(doc, 'pIntro0000000001');
    const typed = [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))];
    expect(run(USERS.carol, doc, typed, { suggest: asked }).ok).toBe(true);
    expect(asked.calls).toEqual([]);
    for (const answer of ['no', 'throw'] as const) {
      const v = run(USERS.dave, doc, suggestIn(doc, 'dave'), { suggest: stubSuggest(answer) });
      expect(v, answer).toMatchObject({ ok: false, scopes: ['body'] });
    }
  });

  it('PRM-014 registers P4: the standard registry holds the suggestion rule', () => {
    expect(STANDARD_RULES.suggest).toBe(SUGGESTION_RULE);
    expect(STANDARD_RULES.suggest?.id).toBe('P4');
  });
});

describe('the P7 seam (PRM-010, criterion 4)', () => {
  it('delegates a fill-only change of a field value to the registered module, tested with a stub', () => {
    const doc = fieldsDoc();
    const yes = stubFill('ok');
    expect(run(USERS.erin, doc, fill(doc, FIELDS.number, '12.50'), { fill: yes }).ok).toBe(true);
    expect(yes.calls).toEqual([FIELDS.number]);
    // The stub decides: it may accept a field P7 itself would refuse, and refuse one it accepts.
    const lenient = stubFill('ok');
    expect(run(USERS.erin, doc, fill(doc, FIELDS.landlord, 'x'), { fill: lenient }).ok).toBe(true);
    expect(run(USERS.erin, doc, fill(doc, FIELDS.landlord, 'x'), STANDARD_RULES).ok).toBe(false);
    const v = run(USERS.erin, doc, fill(doc, FIELDS.number, '1'), { fill: stubFill('no') });
    expect(v).toMatchObject({ ok: false, scopes: [`field:${FIELDS.number}`] });
    if (!v.ok) expect(v.reason).toMatch(/stub says no \(P7-stub\)/);
  });

  it('refuses every fill without a registered fill rule, and when the module throws or answers oddly', () => {
    const doc = fieldsDoc();
    for (const rules of [
      NO_RULES,
      { suggest: SUGGESTION_RULE },
      { fill: stubFill('throw') },
      {
        fill: stubFill('odd'),
      },
    ]) {
      const v = run(USERS.erin, doc, fill(doc, FIELDS.number, '12.50'), rules);
      expect(v).toMatchObject({ ok: false, scopes: [`field:${FIELDS.number}`] });
    }
  });

  it('never asks the module about a value an editor may change under P1', () => {
    const doc = fieldsDoc();
    const spy = stubFill('no');
    expect(run(USERS.carol, doc, fill(doc, FIELDS.number, '3'), { fill: spy }).ok).toBe(true);
    expect(spy.calls).toEqual([]);
  });

  it('FRW-008 registers P7: the standard registry holds the fill rule', () => {
    expect(STANDARD_RULES.fill).toBe(FILL_RULE);
    expect(STANDARD_RULES.fill?.id).toBe('P7');
  });
});

describe('no module relaxes the core (PRM-010)', () => {
  const PERMISSIVE: OutcomeRules = { suggest: stubSuggest('ok'), fill: stubFill('ok') };

  it('keeps P8, P9, `manage`, 07 §5.3 and P1 for other scopes, whatever the modules say', () => {
    const doc = fieldsDoc();
    // P8: a client never sets a signature value, not even the owner.
    const sig = { asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10', mode: 'typed' };
    expect(run(USERS.alice, doc, fill(doc, FIELDS.signature, sig), PERMISSIVE).ok).toBe(false);
    expect(run(USERS.erin, doc, fill(doc, FIELDS.signature, sig), PERMISSIVE).ok).toBe(false);
    // P9: a concurrent fill of the same field is a conflict.
    const p9 = run(USERS.erin, doc, fill(doc, FIELDS.number, '1'), PERMISSIVE, morePermissions(), {
      fieldsChangedSinceBase: new Set([FIELDS.number]),
    });
    expect(p9).toMatchObject({ ok: false, code: 'conflict' });
    // `manage`: a policy change by an editor.
    const policy = [new AttrStep(posOf(doc, 'rTerms000000000A'), 'policy', 'restricted')];
    expect(run(USERS.carol, doc, policy, PERMISSIVE).ok).toBe(false);
    // 07 §5.3: a style the restricted region uses.
    const style = [new AttrStep(posOf(doc, 'LegalBody'), 'color', '#FF0000')];
    expect(run(USERS.carol, doc, style, PERMISSIVE).ok).toBe(false);
    // P1 for a scope routed to no module: Rita may edit only the region Terms, and a permissive
    // suggestion module does not let her change the body, where she holds neither right.
    const intro = posInside(doc, 'pIntro0000000001');
    const mark = schema.marks['ins']!.create({ id: 'sRita00000000001', user: 'rita' });
    const inBody = [
      new ReplaceStep(intro, intro, new Slice(Fragment.from(schema.text('x', [mark])), 0, 0)),
    ];
    expect(run(MORE.rita, doc, inBody, PERMISSIVE)).toMatchObject({ ok: false, scopes: ['body'] });
    // A value the user cannot read: Carol may edit the body but cannot read the landlord's secret.
    expect(run(USERS.carol, doc, fill(doc, FIELDS.secret, 'guess'), PERMISSIVE).ok).toBe(false);
  });

  it('is monotone: removing modules never accepts more (property test)', () => {
    const users = [...Object.values(USERS), ...Object.values(MORE)];
    const registries: OutcomeRules[] = [
      NO_RULES,
      { suggest: SUGGESTION_RULE },
      { fill: FILL_RULE },
      STANDARD_RULES,
    ];
    let accepted = 0;
    let refusedOnlyWithout = 0;
    fc.assert(
      fc.property(
        fc.record({
          at: fc.nat(10_000),
          len: fc.nat(6),
          kind: fc.nat(6),
          user: fc.nat(users.length - 1),
          field: fc.nat(12),
        }),
        (e) => {
          const doc = fieldsDoc();
          const size = doc.content.size;
          const from = 1 + (e.at % (size - 2));
          const to = Math.min(size - 1, from + e.len);
          const ids = Object.values(FIELDS);
          const who = users[e.user]!;
          const owned = schema.marks['ins']!.create({
            id: `s${who.sub.padEnd(15, '1')}`,
            user: who.sub,
          });
          const steps: Step[] = [
            new ReplaceStep(from, from, new Slice(Fragment.from(schema.text('z', [owned])), 0, 0)),
            new AddMarkStep(
              from,
              to,
              schema.marks['del']!.create({ id: 'sDel000000000001', user: who.sub }),
            ),
            new ReplaceStep(from, to, Slice.empty),
            new AttrStep(posOf(doc, ids[e.field % ids.length]!), 'value', 'v'),
            new AddMarkStep(from, to, schema.marks['bold']!.create()),
            new RemoveMarkStep(from, to, schema.marks['bold']!.create()),
            new AddNodeMarkStep(from, owned),
          ];
          const step = steps[e.kind % steps.length]!;
          const applied = applySteps(doc, [step]);
          if (!applied.ok) return;
          const verdicts = registries.map((rules) => run(who, doc, [step], rules).ok);
          // NO_RULES ⊆ each single module ⊆ STANDARD_RULES.
          if (verdicts[0]) expect(verdicts.slice(1)).toEqual([true, true, true]);
          if (verdicts[1] || verdicts[2]) expect(verdicts[3]).toBe(true);
          if (verdicts[3]) accepted++;
          if (verdicts[3] && !verdicts[0]) refusedOnlyWithout++;
        },
      ),
      { numRuns: 1500 },
    );
    // Not vacuous: commits were accepted, and some only because a module justified them.
    expect(accepted).toBeGreaterThan(100);
    expect(refusedOnlyWithout).toBeGreaterThan(10);
  });
});
