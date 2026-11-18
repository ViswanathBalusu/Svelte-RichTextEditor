/**
 * SEC-023 criterion 5 (10 §5; 03 §5; 07 §5.2, §17): suggestions on blocks other than paragraphs,
 * whole table rows and whole tables are refused. Owner decision 7 of 2026-11-15
 * (docs/owner-decisions-2026-11-15.md) settles the set, and decision 92 the form: a block suggestion is
 * an entry of the `suggest` attribute, which only `paragraph`, `table_row` and `table` have, and
 * no block takes a node mark (invariant I1, `node_mark_host`).
 *
 * The room applies the steps, runs the outcome check (P4) and then the invariants of the result.
 * A node mark on any block is refused at the first stage, because the schema lets no parent hold a
 * marked block; `model.validate()` is the second guard and is tested directly. A suggestion on the
 * three hosts is an attribute step, which the pipeline accepts. The proof drives all stages.
 */
import {
  applySteps,
  checkInvariants,
  type Connection,
  outcomeCheck,
  STANDARD_RULES,
} from '@docedit/authority';
import { validateDoc } from '@docedit/model/validate';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { AddNodeMarkStep, AttrStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { BASE_JSON, accessOf, permissions, schema } from './support/authority-fixtures.ts';

const SAM: Connection = {
  sub: 'sam',
  session: 's-sam',
  role: 'suggester',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const HOSTS = ['paragraph', 'table_row', 'table'];
const ctx = { requires: ['fields'], retiredRegionIds: new Set<string>() };

type J = Record<string, unknown>;

/** The base document with `trackChanges: everyone` and a table of two rows after the intro paragraph. */
function baseDoc(): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const settings = json.content[0]!.content.find((n) => n['type'] === 'settings')!;
  (settings['attrs'] as J)['trackChanges'] = 'everyone';
  const cell = (id: string, t: string) => ({
    type: 'table_cell',
    attrs: { id },
    content: [
      { type: 'paragraph', attrs: { id: `p${id.slice(1)}` }, content: [{ type: 'text', text: t }] },
    ],
  });
  const body = json.content[1]!.content;
  const at = body.findIndex((b) => (b['attrs'] as J | undefined)?.['id'] === 'pIntro0000000001');
  body.splice(at + 1, 0, {
    type: 'table',
    attrs: { id: 'tTable0000000001', grid: [2000, 2000] },
    content: [
      {
        type: 'table_row',
        attrs: { id: 'trRow00000000001' },
        content: [cell('cA00000000000001', 'Rent'), cell('cB00000000000001', 'Monthly')],
      },
      {
        type: 'table_row',
        attrs: { id: 'trRow00000000002' },
        content: [cell('cA00000000000002', 'Deposit'), cell('cB00000000000002', 'One month')],
      },
    ],
  });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

interface Target {
  type: string;
  pos: number;
}

/** Every non-text, non-atom node with its position. */
function targets(doc: Node): Target[] {
  const out: Target[] = [];
  doc.descendants((n, pos) => {
    if (!n.isText && !n.isLeaf) out.push({ type: n.type.name, pos });
    return true;
  });
  return out;
}

let counter = 0;
const sid = () => `sBlk${String(++counter).padStart(12, '0')}`;

function markOf(kind: 'ins' | 'del' | 'fmt', user: string) {
  if (kind === 'fmt')
    return schema.marks['fmt']!.create({ id: sid(), user, before: { attrs: { align: 'left' } } });
  return schema.marks[kind]!.create({ id: sid(), user });
}

/** The entry of `suggest` that says the same as a suggestion mark. */
function entryOf(kind: 'ins' | 'del' | 'fmt', user: string): J {
  const attrs: J = { id: sid(), user };
  if (kind === 'fmt') attrs['before'] = { attrs: { align: 'left' } };
  return { type: kind, attrs };
}

/** The step a suggester makes: an attribute step on a host, a node mark (which fails) elsewhere. */
function suggestionStep(t: Target, kind: 'ins' | 'del' | 'fmt'): Step {
  return HOSTS.includes(t.type)
    ? new AttrStep(t.pos, 'suggest', [entryOf(kind, SAM.sub)])
    : new AddNodeMarkStep(t.pos, markOf(kind, SAM.sub));
}

/** The room's pipeline: outcome check, then the invariants of the result. */
function pipeline(before: Node, steps: Step[]) {
  const applied = applySteps(before, steps);
  if (!applied.ok) return { stage: 'apply' as const, code: 'not_applied', reason: applied.reason };
  const outcome = outcomeCheck({
    before,
    after: applied.value.doc,
    user: SAM.sub,
    access: accessOf(SAM, before),
    perms: permissions(),
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: STANDARD_RULES,
  });
  if (!outcome.ok)
    return { stage: 'outcome' as const, code: outcome.code as string, reason: outcome.reason };
  const inv = checkInvariants(before, applied.value.doc, steps, applied.value.docs, ctx);
  if (!inv.ok)
    return { stage: 'invariants' as const, code: inv.code as string, reason: inv.reason };
  return { stage: 'accepted' as const, code: 'ok', reason: '' };
}

describe('SEC-023 criterion 5: block suggestions beyond paragraphs, table rows and tables are refused', () => {
  const doc = baseDoc();
  const all = targets(doc);
  const byType = (t: string) => all.find((x) => x.type === t)!;

  it('the document holds the block types the proof draws from', () => {
    const types = new Set(all.map((x) => x.type));
    for (const t of ['body', 'region', 'table', 'table_row', 'table_cell', 'paragraph'])
      expect(types.has(t)).toBe(true);
  });

  it.each(HOSTS)('a suggested deletion on a whole %s is accepted (the control)', (type) => {
    const t = byType(type);
    const r = pipeline(doc, [suggestionStep(t, 'del')]);
    expect(r).toEqual({ stage: 'accepted', code: 'ok', reason: '' });
  });

  it.each(HOSTS)(
    'a node mark on a whole %s is refused: a block suggestion is an attribute',
    (type) => {
      const t = byType(type);
      const r = pipeline(doc, [new AddNodeMarkStep(t.pos, markOf('del', SAM.sub))]);
      expect(r.stage).toBe('apply');
    },
  );

  it('a suggested deletion on a table cell is refused: the schema does not let a row hold a marked cell', () => {
    const t = byType('table_cell');
    const r = pipeline(doc, [new AddNodeMarkStep(t.pos, markOf('del', SAM.sub))]);
    expect(r.stage).toBe('apply');
    expect(r.reason).toContain('Invalid content for node table_row');
  });

  it('a document whose table cell carries a suggestion mark fails model validation (I1, node_mark_host)', () => {
    const json = doc.toJSON() as J;
    const found: J[] = [];
    const walk = (n: J): void => {
      if (n['type'] === 'table_cell' && found.length === 0) found.push(n);
      for (const c of (n['content'] as J[] | undefined) ?? []) walk(c);
    };
    walk(json);
    found[0]!['marks'] = [{ type: 'del', attrs: { id: 'sBlk000000009999', user: SAM.sub } }];
    const marked = schema.nodeFromJSON(json);
    const result = validateDoc(marked, ['fields'], { retiredRegionIds: new Set<string>() });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violations.some((v) => v.invariant === 'I1')).toBe(true);
  });

  it('a suggested deletion on the body is refused', () => {
    const t = byType('body');
    const r = pipeline(doc, [new AddNodeMarkStep(t.pos, markOf('del', SAM.sub))]);
    expect(r.stage).not.toBe('accepted');
  });

  it('a formatting suggestion on a table cell is refused', () => {
    const t = byType('table_cell');
    const r = pipeline(doc, [new AddNodeMarkStep(t.pos, markOf('fmt', SAM.sub))]);
    expect(r.stage).not.toBe('accepted');
  });

  it('property: whatever node and suggestion mark a suggester picks, only a paragraph, a table row or a table is accepted', () => {
    let accepted = 0;
    let refusedOther = 0;
    fc.assert(
      fc.property(
        fc.nat(all.length - 1),
        fc.constantFrom<'ins' | 'del' | 'fmt'>('ins', 'del', 'fmt'),
        (i, kind) => {
          const t = all[i]!;
          const r = pipeline(doc, [suggestionStep(t, kind)]);
          if (r.stage === 'accepted') {
            accepted++;
            expect(HOSTS).toContain(t.type);
          } else if (!HOSTS.includes(t.type)) refusedOther++;
        },
      ),
      { numRuns: 300 },
    );
    // The property must reach both outcomes, or it proves nothing.
    expect(accepted).toBeGreaterThan(0);
    expect(refusedOther).toBeGreaterThan(0);
  });
});
