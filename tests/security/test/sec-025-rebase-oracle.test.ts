/**
 * SEC-025 criterion 6 (lane V-SEC-017-032): the step validation and rebase fuzz target, run with the
 * oracle of SEC-021, finds no violation. The fuzz target of SEC-059 (fuzz.test.ts) checks only that
 * parsing, rebase and apply never throw. This file runs the same target, with the same step shapes
 * and its regression cases, and adds the permission oracle: random commits from an editor who may
 * not edit the restricted region R are parsed, applied directly or rebased over a concurrent commit
 * that wraps the intro paragraph in a restricted region of its own, and judged by the outcome check
 * with the standard rules.
 *
 * The oracle is the one SEC-021 names, PRM-017's (packages/authority/test/harness/oracle.ts): for
 * every commit the outcome check accepts, `oracleViolations` must be empty, and every scope in
 * `changedScopes(before, after)` must be in the writable set that `computeAccess` gives the editor
 * (07 §4, §5.1; 10 §3.3). Both are checked on the direct and on the rebased path, against the
 * document the commit is applied to.
 */
import {
  applySteps,
  computeAccess,
  DEFAULT_LIMITS,
  outcomeCheck,
  parseSteps,
  rebaseOver,
  STANDARD_RULES,
  type Access,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import fc from 'fast-check';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceAroundStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import {
  changedScopes,
  oracleViolations,
} from '../../../packages/authority/test/harness/oracle.ts';
import { CAROL, fieldsDoc, permissions, regionsOf } from './support/authority-fixtures.ts';

const R = 'rLegal000000000B'; // restricted: CAROL (editor) holds no edit here
const WRAP = 'rWrap00000000001'; // restricted, created by the concurrent commit
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 300);
const schema = cdmSchema();

/** The position of the node with `id` in the document. */
function posOf(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** The concurrent commit: the owner wraps the intro paragraph in a new restricted region. */
function wrapIntro(base: Node): { wrap: Step; doc: Node } {
  const p = posOf(base, 'pIntro0000000001');
  const end = p + base.nodeAt(p)!.nodeSize;
  const wrap = new ReplaceAroundStep(
    p,
    end,
    p,
    end,
    new Slice(
      Fragment.from(schema.nodes['region']!.create({ id: WRAP, policy: 'restricted' })),
      0,
      0,
    ),
    1,
    true,
  );
  const applied = applySteps(base, [wrap]);
  if (!applied.ok) throw new Error('the wrap does not apply');
  return { wrap, doc: applied.value.doc };
}

function accessAt(doc: Node): Access {
  return computeAccess(CAROL, regionsOf(doc), permissions(), 0);
}

/** The outcome check for CAROL on one commit, with the access the authority computes. */
function judge(before: Node, after: Node) {
  return outcomeCheck({
    before,
    after,
    user: CAROL.sub,
    access: accessAt(before),
    perms: permissions(),
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: STANDARD_RULES,
  });
}

/** The container scope of a form field in `doc`: `region:<id>` or `body`. */
function fieldContainer(doc: Node, id: string): string {
  let scope = 'body';
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name !== 'region') return;
    c.descendants((n) => {
      if (n.type.name === 'form_field' && n.attrs['id'] === id)
        scope = `region:${String(c.attrs['id'])}`;
      return true;
    });
  });
  return scope;
}

/**
 * Every scope `changedScopes` reports that is outside the writable set of `computeAccess` for the
 * document before the commit (07 §4): `doc`, definitions and stories need `edit` in the structure
 * scopes; the body and a kept region need `edit` or `suggest` there (a suggestion is then judged by
 * `oracleViolations`); a region added or removed needs `structure`, and `edit` in it (P2); a field
 * value needs `edit` in its container (CAROL holds no participant role, so fill never applies).
 */
function outsideWritable(before: Node, after: Node): string[] {
  const access = accessAt(before);
  const writes = (caps: ReadonlySet<string> | undefined) =>
    caps !== undefined && (caps.has('edit') || caps.has('suggest'));
  const regionIds = (d: Node) => new Set(regionsOf(d).map((r) => r.id));
  const was = regionIds(before);
  const is = regionIds(after);
  const out: string[] = [];
  for (const scope of changedScopes(before, after)) {
    if (scope === 'doc' || scope.startsWith('defs:') || scope.startsWith('story:')) {
      if (!access.structureScopes.has('edit')) out.push(scope);
    } else if (scope === 'body') {
      if (!writes(access.body)) out.push(scope);
    } else if (scope.startsWith('region:')) {
      const id = scope.slice(7);
      const structure = access.docRole.has('structure');
      if (was.has(id) && is.has(id)) {
        if (!writes(access.regions.get(id))) out.push(scope);
      } else if (was.has(id)) {
        if (!structure || !access.regions.get(id)?.has('edit')) out.push(`${scope} (removed)`);
      } else if (!structure || !access.newRegion.has('edit')) out.push(`${scope} (added)`);
    } else if (scope.startsWith('field:')) {
      const container = fieldContainer(before, scope.slice(6));
      const caps = container === 'body' ? access.body : access.regions.get(container.slice(7));
      if (!caps?.has('edit')) out.push(scope);
    } else out.push(`${scope} (unknown scope)`);
  }
  return out;
}

/** The PRM-017 oracle for one accepted commit by CAROL, and the writable-set check. */
function expectNoViolation(before: Node, after: Node, steps: unknown, path: string) {
  const violations = oracleViolations({
    user: CAROL,
    perms: permissions(),
    time: 0,
    before,
    after,
    owners: new Map(),
    origin: 'input',
    serverAuthored: false,
  });
  const context = `${path}: ${JSON.stringify(steps)}`;
  expect(violations, `oracle violation (${context})`).toEqual([]);
  expect(outsideWritable(before, after), `scope outside the writable set (${context})`).toEqual([]);
}

const base = fieldsDoc();
const { wrap, doc: wrapped } = wrapIntro(base);
const SIZE = base.content.size;

// The step shapes of SEC-059's generator (fuzz.test.ts), with positions over the whole document so
// that some steps land in R, some in the intro paragraph that the wrap protects, some in the
// definitions and some in the open body.
const pos = fc.oneof(
  fc.integer({ min: -5, max: SIZE + 5 }),
  fc.constantFrom(0, 1, 2, 3, 10, 40, 1e9, -1, 3.5, Number.NaN),
);
const realPos = fc.integer({ min: 0, max: SIZE });
const attrName = fc.constantFrom(
  'id',
  'style',
  'policy',
  'name',
  'text',
  'value',
  'align',
  'title',
  'lang',
  'kind',
  'assignee',
  'trackChanges',
);
const attrValue = fc.oneof(
  fc.string(),
  fc.constantFrom(
    'restricted',
    'inherit',
    'confidential',
    'Normal',
    'Plain',
    'end',
    'everyone',
    null,
  ),
  fc.jsonValue(),
);
// Well-formed steps, so that a useful share of commits applies: a slice copied from the document
// itself (it may carry region, paragraph and field tokens), marks, and attributes.
const copiedReplace = fc.tuple(realPos, realPos, realPos, realPos).map(([f, t, a, b]) => {
  let slice: unknown;
  try {
    slice = base.slice(Math.min(a, b), Math.max(a, b)).toJSON();
  } catch {
    slice = null;
  }
  return {
    stepType: 'replace',
    from: Math.min(f, t),
    to: Math.max(f, t),
    ...(slice === null ? {} : { slice }),
  };
});
const markStep = fc.record({
  stepType: fc.constantFrom('addMark', 'removeMark'),
  from: realPos,
  to: realPos,
  mark: fc.constantFrom({ type: 'bold' }, { type: 'italic' }, { type: 'strike' }),
});
const stepJson: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    stepType: fc.constantFrom(
      'replace',
      'replaceAround',
      'addMark',
      'removeMark',
      'attr',
      'docAttr',
      'frob',
    ),
    from: pos,
    to: pos,
  }),
  fc.record({ stepType: fc.constant('replace'), from: pos, to: pos, slice: fc.jsonValue() }),
  fc.record({
    stepType: fc.constant('attr'),
    pos: fc.oneof(pos, realPos),
    attr: attrName,
    value: attrValue,
  }),
  copiedReplace,
  copiedReplace,
  markStep,
  fc.jsonValue(),
);
const wellFormed: fc.Arbitrary<unknown> = fc.oneof(
  copiedReplace,
  markStep,
  fc.record({ stepType: fc.constant('attr'), pos: realPos, attr: attrName, value: attrValue }),
);
// One malformed step refuses the whole commit, so half the commits use well-formed steps only.
const stepsJsonArb = fc.oneof(
  fc.array(stepJson, { minLength: 1, maxLength: 6 }),
  fc.array(wellFormed, { minLength: 1, maxLength: 3 }),
);

/** SEC-059's regression cases (fuzz.test.ts), replayed on both paths first. */
const REGRESSIONS: unknown[][] = [
  [{ stepType: 'addMark', from: 1, to: 1e9, mark: { type: 'bold' } }],
  [{ stepType: 'replace', from: 9_999, to: 10_001 }],
];

describe('SEC-025 criterion 6: the rebase fuzz target with the PRM-017 permission oracle', () => {
  it('the premise holds: CAROL has no edit in R or in the wrapped region, and edits the body', () => {
    expect(accessAt(base).regions.get(R)?.has('edit')).toBe(false);
    expect(accessAt(wrapped).regions.get(WRAP)?.has('edit')).toBe(false);
    expect(accessAt(base).body.has('edit')).toBe(true);
    wrapped.check();
    // The oracle sees the wrap as the creation of a region (and a body change), so it is a commit
    // CAROL could not make: a restricted region created without manage.
    expect(changedScopes(base, wrapped)).toEqual(
      expect.arrayContaining([`region:${WRAP}`, 'body']),
    );
  });

  it('the oracle is live: it reports a change in R and in the wrapped region', () => {
    // Text deleted in R.
    const p = posOf(base, 'pLegal000000001B');
    const inR = applySteps(base, [new ReplaceStep(p + 1, p + 5, Slice.empty)]);
    expect(inR.ok).toBe(true);
    if (inR.ok) expect(outsideWritable(base, inR.value.doc)).toEqual([`region:${R}`]);
    // Text deleted in the wrapped intro paragraph.
    const q = posOf(wrapped, 'pIntro0000000001');
    const inWrap = applySteps(wrapped, [new ReplaceStep(q + 1, q + 5, Slice.empty)]);
    expect(inWrap.ok).toBe(true);
    if (inWrap.ok) {
      expect(outsideWritable(wrapped, inWrap.value.doc)).toEqual([`region:${WRAP}`]);
      const v = oracleViolations({
        user: CAROL,
        perms: permissions(),
        time: 0,
        before: wrapped,
        after: inWrap.value.doc,
        owners: new Map(),
      });
      expect(v.some((s) => s.startsWith(`region:${WRAP}`))).toBe(true);
    }
  });

  it('no random commit the outcome check accepts violates the oracle, direct or rebased over the wrap', () => {
    let acceptedDirect = 0;
    let acceptedRebased = 0;
    const run = (json: unknown[], overWrap: boolean) => {
      const parsed = parseSteps(schema, json, DEFAULT_LIMITS);
      if (!parsed.ok) {
        expect(typeof parsed.code).toBe('string');
        return;
      }
      if (!overWrap) {
        // Built on the current base: apply, then judge against the base.
        const applied = applySteps(base, parsed.value);
        if (!applied.ok) return;
        const verdict = judge(base, applied.value.doc);
        if (!verdict.ok) return;
        acceptedDirect++;
        expectNoViolation(base, applied.value.doc, json, 'direct');
        return;
      }
      // Built on `base` and rebased over the concurrent wrap, as the authority does (04 §6).
      const rebased = rebaseOver(parsed.value, [wrap.getMap()], wrapped, 'reject');
      if (!rebased.ok) {
        expect(typeof rebased.code).toBe('string');
        return;
      }
      const verdict = judge(wrapped, rebased.value.doc);
      if (!verdict.ok) return;
      acceptedRebased++;
      rebased.value.doc.check();
      expectNoViolation(wrapped, rebased.value.doc, json, 'rebased');
    };
    for (const r of REGRESSIONS) {
      run(r, false);
      run(r, true);
    }
    fc.assert(
      fc.property(stepsJsonArb, fc.boolean(), (json, overWrap) => run(json, overWrap)),
      { numRuns: RUNS },
    );
    // The property must not pass vacuously: commits are accepted on both paths.
    expect(acceptedDirect).toBeGreaterThan(0);
    expect(acceptedRebased).toBeGreaterThan(0);
  });

  it('a commit built on the old base that deletes text in R is refused after the rebase', () => {
    const p = posOf(base, 'pLegal000000001B');
    // Delete the first word of R's paragraph, as built against the old base (before the wrap).
    const del = new ReplaceStep(p + 1, p + 5, Slice.empty);
    const rebased = rebaseOver([del], [wrap.getMap()], wrapped, 'reject');
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    // The oracle would report it, and the outcome check refuses it.
    expect(outsideWritable(wrapped, rebased.value.doc)).toEqual([`region:${R}`]);
    expect(judge(wrapped, rebased.value.doc)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('a commit built on the old base that edits the intro paragraph is refused once it is wrapped', () => {
    const q = posOf(base, 'pIntro0000000001');
    // On the old base the intro paragraph is open body text CAROL may edit.
    const del = new ReplaceStep(q + 1, q + 5, Slice.empty);
    const direct = applySteps(base, [del]);
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(judge(base, direct.value.doc).ok).toBe(true);
    // Rebased over the wrap, it lands in the new restricted region and is refused.
    const rebased = rebaseOver([del], [wrap.getMap()], wrapped, 'reject');
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(outsideWritable(wrapped, rebased.value.doc)).toEqual([`region:${WRAP}`]);
    expect(judge(wrapped, rebased.value.doc)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });
});
