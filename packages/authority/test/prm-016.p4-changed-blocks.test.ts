// PRM-016 criterion 3 (lane V-PRM-001-017): when the P4 comparison runs for a commit that touches
// few blocks, it looks only at the changed blocks. The count is taken on the rule the outcome
// check actually calls (`rules.suggest`), not on a separate helper.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import { outcomeCheck } from '../src/permissions/outcome.ts';
import type { OutcomeRules } from '../src/permissions/registry.ts';
import { type Counter, checkSuggestion } from '../src/permissions/suggestions.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import { BASE_JSON, USERS, basePermissions, posInside, schema } from './fixtures.ts';

type J = Record<string, unknown>;

const ins = (id: string, user: string) => schema.marks['ins']!.create({ id, user });

/** The base document with `extra` more paragraphs in the body (the last child of the document). */
function bodyWith(extra: number): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const body = json.content[json.content.length - 1]!.content;
  for (let i = 0; i < extra; i++)
    body.push({
      type: 'paragraph',
      attrs: { id: `pPrm016Extra${String(i).padStart(8, '0')}` },
      content: [{ type: 'text', text: `Body paragraph ${i}.` }],
    });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** Dave suggests an insertion in the intro paragraph; the body is a scope he may only suggest in. */
function suggestionCommit(before: Node): Node {
  const pos = posInside(before, 'pIntro0000000001');
  const step = new ReplaceStep(
    pos,
    pos,
    new Slice(Fragment.from(schema.text('new ', [ins('sDave00000000016', 'dave')])), 0, 0),
  );
  const r = applySteps(before, [step]);
  if (!r.ok) throw new Error(r.reason);
  return r.value.doc;
}

/** Runs the outcome check with a P4 rule that counts the nodes its comparison converts. */
function runWithCount(before: Node, after: Node) {
  const count: Counter = { visited: 0 };
  let calls = 0;
  const rules: OutcomeRules = {
    suggest: {
      id: 'P4',
      check: (_scope, b, a, ctx) => {
        calls++;
        return checkSuggestion(b, a, ctx, count);
      },
    },
  };
  const perms = basePermissions();
  const verdict = outcomeCheck({
    before,
    after,
    user: USERS.dave.sub,
    access: computeAccess(USERS.dave, regionInfos(before), perms, 0),
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules,
  });
  return { verdict, count: count.visited, calls };
}

describe('PRM-016 criterion 3: the P4 comparison examines only changed blocks', () => {
  it('is accepted through the registered rule and calls it once for the body', () => {
    const before = bodyWith(0);
    const { verdict, calls } = runWithCount(before, suggestionCommit(before));
    expect(verdict.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('visits the same number of nodes in a body of 400 more paragraphs, and fewer than 12', () => {
    const visits = (extra: number) => {
      const before = bodyWith(extra);
      const { verdict, count, calls } = runWithCount(before, suggestionCommit(before));
      expect(verdict.ok).toBe(true);
      expect(calls).toBe(1);
      return count;
    };
    expect(visits(400)).toBe(visits(0));
    expect(visits(0)).toBeLessThan(12);
  });
});
