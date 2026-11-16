// PRM-017, criterion 6: the oracle's writable set is P1 plus registered hooks (P4, P7, P9). A rule
// is added by registering a hook; the generator (`harness/client.ts`) and the suites that call
// `oracleViolations` do not change.
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/permissions/model.ts';
import { applySteps } from '../src/rebase.ts';
import { USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';
import {
  oracleViolations,
  p4Suggestions,
  p7Fill,
  p9ExclusiveFill,
  registerWritableHook,
  writableRules,
  type WritableHook,
} from './harness/oracle.ts';

type Doc = ReturnType<typeof baseDoc>;

const FIELD = 'fTenantName00001';

function commit(user: Connection, make: (doc: Doc) => Step[], since?: string[]) {
  const before = baseDoc();
  const r = applySteps(before, make(before));
  if (!r.ok) throw new Error(`steps do not apply: ${r.reason}`);
  return {
    user,
    perms: basePermissions(),
    time: 0,
    before,
    after: r.value.doc,
    owners: new Map<string, string>(),
    ...(since ? { fieldsChangedSinceBase: new Set(since) } : {}),
  };
}

/** Dave suggests an insertion in the body, where he has `suggest` and not `edit`. */
const suggestion = (doc: Doc) => {
  const pos = posInside(doc, 'pIntro0000000001');
  const mark = schema.marks['ins']!.create({ id: 'sDave00000000001', user: 'dave' });
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('new ', [mark])), 0, 0))];
};
const direct = (doc: Doc) => {
  const pos = posInside(doc, 'pIntro0000000001');
  return [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('new ')), 0, 0))];
};
const fill = (doc: Doc) => [new AttrStep(posOf(doc, FIELD), 'value', 'Ada Lovelace')];

const only = (...rules: [string, WritableHook][]) => new Map(rules);

describe('the oracle writable set is extended through registered hooks (PRM-017)', () => {
  it('registers P4, P7 and P9, and nothing else, when the oracle loads', () => {
    expect(writableRules()).toEqual(['P4', 'P7', 'P9']);
  });

  it('P1 alone: an edit where the user may edit passes, a suggestion or a fill does not', () => {
    const none = only();
    expect(oracleViolations(commit(USERS.carol, direct), none)).toEqual([]);
    expect(oracleViolations(commit(USERS.dave, suggestion), none)).toEqual([
      'body: changed without edit or suggest',
    ]);
    expect(oracleViolations(commit(USERS.erin, fill), none)).toEqual([
      `field:${FIELD}: filled without the fill rules`,
    ]);
  });

  it('P4 puts a valid suggestion in the set and still fails a direct change', () => {
    const p4 = only(['P4', p4Suggestions]);
    expect(oracleViolations(commit(USERS.dave, suggestion), p4)).toEqual([]);
    expect(oracleViolations(commit(USERS.dave, direct), p4)).toEqual([
      "body: invalid suggestion (changed other than through the user's own suggestions)",
    ]);
    // P4 says nothing about fields: a fill still needs P7.
    expect(oracleViolations(commit(USERS.erin, fill), p4)).toHaveLength(1);
  });

  it('P7 puts the fill of an assigned field in the set, for an active participant only', () => {
    const p7 = only(['P7', p7Fill]);
    expect(oracleViolations(commit(USERS.erin, fill), p7)).toEqual([]);
    expect(oracleViolations(commit({ ...USERS.erin, participantRoles: [] }, fill), p7)).toEqual([
      `field:${FIELD}: filled without the fill rules`,
    ]);
    expect(oracleViolations(commit({ ...USERS.erin, participantActive: false }, fill), p7)).toEqual(
      [`field:${FIELD}: filled without the fill rules`],
    );
  });

  it('P9 takes a field out of the set when a commit after the base changed it', () => {
    const raced = [`field:${FIELD}`];
    const violation = `field:${FIELD}: changed although another commit changed it after the base (P9)`;
    // Without the hook the racing fill passes; with it, it fails, for a filler and for an editor.
    expect(oracleViolations(commit(USERS.erin, fill, raced), only(['P7', p7Fill]))).toEqual([]);
    const withP9 = only(['P7', p7Fill], ['P9', p9ExclusiveFill]);
    expect(oracleViolations(commit(USERS.erin, fill, raced), withP9)).toEqual([violation]);
    expect(oracleViolations(commit(USERS.erin, fill, raced))).toEqual([violation]);
    expect(oracleViolations(commit(USERS.bob, fill, raced))).toEqual([violation]);
    // Another field changed since the base, or no record of the base: nothing to report.
    expect(oracleViolations(commit(USERS.erin, fill, ['field:fOther0000000001']))).toEqual([]);
    expect(oracleViolations(commit(USERS.erin, fill))).toEqual([]);
  });

  it('a rule registered later changes the verdict of the same commits, and leaves again', () => {
    // A made-up rule: Frank, a viewer, may change the body. No generator or suite knows of it.
    const frank = commit(USERS.frank, direct);
    expect(oracleViolations(frank)).toEqual(['body: changed without edit or suggest']);
    const remove = registerWritableHook('PX', (q) =>
      q.scope === 'body' && q.commit.user.sub === 'frank' ? [] : null,
    );
    try {
      expect(writableRules()).toEqual(['P4', 'P7', 'P9', 'PX']);
      expect(oracleViolations(frank)).toEqual([]);
      expect(oracleViolations(commit(USERS.dave, direct))).toHaveLength(1);
      expect(() => registerWritableHook('PX', () => null)).toThrow(/already has a hook for PX/);
    } finally {
      remove();
    }
    expect(writableRules()).toEqual(['P4', 'P7', 'P9']);
    expect(oracleViolations(frank)).toEqual(['body: changed without edit or suggest']);
  });
});
