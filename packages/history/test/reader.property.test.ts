// History as the requester's projection (ADR 0019; HIS-046): every surface that returns content,
// text, attribution or field values is computed on the requester's projection, so canary strings
// written into hidden regions and hidden values never appear in what a reader of that class gets.
import {
  type ContentSource,
  type HiddenSet,
  NOTHING_HIDDEN,
  computeAccess,
  defaultReplayers,
  regionInfos,
} from '@docedit/authority';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, applyCommit } from '../src/attribution.ts';
import { compareStates, compareSteps } from '../src/compare.ts';
import { listHistory } from '../src/groups.ts';
import {
  activitySince,
  attributionFor,
  fieldHistory,
  forkContent,
  hiddenAcross,
  unionHidden,
  versionFor,
} from '../src/reader.ts';
import { planRestore } from '../src/restore.ts';
import {
  CANARY,
  CANARY_VALUE,
  HIDDEN,
  LogBuilder,
  baseDoc,
  meta,
  posInside,
  schema,
} from './fixtures.ts';
import { type EditKind, randomEdit } from './random-edits.ts';

const SECRET_REGION = 'rSecret00000000B';
const VALUES_ONLY: HiddenSet = {
  regions: new Set(),
  values: new Set(['fTenantName00001', 'fSecretName00001']),
  titles: false,
};

function fieldPos(doc: Node, id: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (n.attrs['id'] === id) at = pos;
    return at < 0;
  });
  return at;
}

type Op =
  | { t: 'visible'; kind: EditKind; a: number; b: number }
  | { t: 'secret-text'; at: number }
  | { t: 'secret-value'; field: 'fTenantName00001' | 'fSecretName00001' };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant('visible' as const),
    kind: fc.constantFrom<EditKind>(
      'type',
      'type',
      'delete',
      'split',
      'join',
      'mark',
      'attr',
      'retype',
    ),
    a: fc.double({ min: 0, max: 0.999, noNaN: true }),
    b: fc.double({ min: 0, max: 0.999, noNaN: true }),
  }),
  fc.record({ t: fc.constant('secret-text' as const), at: fc.integer({ min: 0, max: 10 }) }),
  fc.record({
    t: fc.constant('secret-value' as const),
    field: fc.constantFrom('fTenantName00001' as const, 'fSecretName00001' as const),
  }),
);

/** A log whose hidden region gains canary text and whose hidden values are set to canaries. */
function build(ops: readonly Op[]): LogBuilder {
  const b = new LogBuilder();
  let n = 0;
  for (const o of ops) {
    n++;
    if (o.t === 'visible') {
      // Visible edits never take content out of the hidden region.
      const tr = randomEdit(b.doc, o.kind, o.a, o.b, 'w', new Set([SECRET_REGION]));
      if (tr?.steps.length) b.add(() => tr, { user: n % 2 ? 'bob' : 'carol', scopes: ['body'] });
    } else if (o.t === 'secret-text') {
      b.add(
        (d) => {
          const p = posInside(d, 'pSecret00000001B', 0);
          const size = d.nodeAt(p - 1)!.content.size;
          return new Transform(d).insert(p + Math.min(o.at, size), schema.text(`${CANARY}${n}`));
        },
        { user: 'alice', scopes: [`region:${SECRET_REGION}`] },
      );
    } else {
      b.add(
        (d) =>
          new Transform(d).setNodeAttribute(fieldPos(d, o.field), 'value', `${CANARY_VALUE}${n}`),
        {
          user: 'erin',
          origin: 'fill',
          scopes: [`field:${o.field}`],
        },
      );
    }
  }
  return b;
}

function maps(b: LogBuilder): AttributionMap[] {
  const out = [AttributionMap.create(b.docs[0]!.content.size, { user: 'owner', seq: 0 })];
  for (const c of b.log) {
    const m = out[out.length - 1]!.clone();
    applyCommit(m, c, schema);
    out.push(m);
  }
  return out;
}

const text = (v: unknown) => JSON.stringify(v) ?? '';

describe('history surfaces never return hidden content (HIS-046, property)', () => {
  for (const [label, hidden, canaries] of [
    ['a reader of neither the region nor the values', HIDDEN, [CANARY, CANARY_VALUE]],
    ['a reader of the region but not the values', VALUES_ONLY, [CANARY_VALUE]],
  ] as const) {
    it(`serves ${label} nothing hidden`, () => {
      fc.assert(
        fc.property(
          fc.array(op, { minLength: 1, maxLength: 30 }),
          fc.integer({ min: 0, max: 30 }),
          (ops, k) => {
            const b = build(ops);
            const head = b.head;
            const from = Math.min(k, head);
            const ms = maps(b);
            const gate = { min: 0, head };
            const outputs: unknown[] = [];
            const s1 = compareSteps({
              schema,
              from: { seq: from, doc: b.docs[from]! },
              commits: b.commits(from, head),
              hidden,
            });
            const s2 = compareStates({
              from: { seq: from, doc: b.docs[from]! },
              to: { seq: head, doc: b.doc, attribution: ms[head]! },
              hidden,
              scopeIndex: (s) => ({ user: `who-${s}`, seq: head }),
            });
            outputs.push(s1, s2);
            outputs.push(attributionFor({ doc: b.doc, map: ms[head]!, seq: head, gate, hidden }));
            const source: ContentSource = {
              incarnation: 'inc-1',
              head,
              checkpoints: [{ seq: 0, doc: b.docs[0]! }],
              commits: (after, to) => b.commits(after, to),
              resolve: () => b.docs[0]!,
              replayers: defaultReplayers(schema),
            };
            for (let seq = 0; seq <= head; seq++) {
              const v = versionFor(seq, source, { min: 0 }, hidden);
              outputs.push(v.ok ? v.projection.doc.toJSON() : v);
            }
            outputs.push(listHistory({ commits: b.log.map(meta), versions: [], gate, hidden }));
            outputs.push(fieldHistory('fTenantName00001', b.log.map(meta), gate, hidden));
            const editor = {
              sub: 'bob',
              session: 's-bob',
              role: 'editor' as const,
              groups: [],
              participantRoles: [],
              participantActive: false,
            };
            const access = computeAccess(
              editor,
              regionInfos(b.doc),
              {
                revision: 1,
                grants: [],
                regionStates: new Map(),
                leases: [],
                documentState: 'active',
                workflowActive: false,
              },
              0,
            );
            const dry = planRestore(
              { toSeq: from, region: 'rTerms000000000A', dryRun: true },
              {
                schema,
                head: { seq: head, doc: b.doc, attribution: ms[head]! },
                target: (s) => ({ doc: b.docs[s]!, attribution: ms[s]! }),
                gate,
                hidden,
                access,
                user: 'bob',
              },
            );
            outputs.push(dry.ok ? dry.plan.dryRun : dry);
            outputs.push(forkContent(b.doc, hidden, access).toJSON());
            outputs.push(
              activitySince({
                marker: from,
                user: 'bob',
                gate,
                hidden,
                source: {
                  schema,
                  incarnation: 'inc-1',
                  content: (s) => b.docs[s],
                  commits: (after, to) => b.commits(after, to),
                  attribution: (s) => ms[s],
                },
                commits: b.log.map(meta),
                versions: [],
              }),
            );
            for (const out of outputs)
              for (const canary of canaries) expect(text(out)).not.toContain(canary);
            // Hidden scopes are named nowhere either.
            if (hidden === HIDDEN)
              for (const out of outputs.slice(0, 3))
                expect(text(out)).not.toContain(SECRET_REGION + '"');
          },
        ),
        { numRuns: 80, seed: label.length },
      );
    });
  }

  it('lets a reader who may see everything see the canaries, so the property is not vacuous', () => {
    const b = build([
      { t: 'secret-text', at: 2 },
      { t: 'secret-value', field: 'fTenantName00001' },
    ]);
    const r = compareSteps({
      schema,
      from: { seq: 0, doc: b.docs[0]! },
      commits: b.log,
      hidden: NOTHING_HIDDEN,
    });
    expect(text(r)).toContain(CANARY);
    const s = compareStates({
      from: { seq: 0, doc: b.docs[0]! },
      to: { seq: 2, doc: b.doc },
      hidden: NOTHING_HIDDEN,
    });
    expect(text(s)).toContain(CANARY);
  });
});

describe('what changed since the last visit, as the reader’s projection (HIS-046)', () => {
  it('compares from the marker, summarises per region and lists other people’s commits only', () => {
    const b = build([
      { t: 'visible', kind: 'type', a: 0.3, b: 0.2 },
      { t: 'secret-text', at: 1 },
      { t: 'visible', kind: 'type', a: 0.5, b: 0.5 },
    ]);
    const ms = maps(b);
    const run = (marker: number, gate = { min: 0, head: b.head }) =>
      activitySince({
        marker,
        user: 'bob',
        gate,
        hidden: HIDDEN,
        source: {
          schema,
          incarnation: 'inc-1',
          content: (s) => b.docs[s],
          commits: (after, to) => b.commits(after, to),
          attribution: (s) => ms[s],
        },
        commits: b.log.map(meta),
        versions: [],
      });
    const r = run(1);
    if (!r.ok) throw new Error(r.reason);
    expect([r.fromSeq, r.toSeq]).toEqual([1, b.head]);
    // Bob's own commit is not listed; the commit inside the hidden region is listed without content.
    expect(
      r.items.flatMap((i) => (i.type === 'group' ? i.authors.map((a) => a.user) : [])),
    ).not.toContain('bob');
    expect(r.summary.reduce((n, s) => n + s.changes, 0)).toBe(r.comparison.changes.length);
    expect(text(r)).not.toContain(CANARY);
    // A marker below the gate starts at the gate.
    const gated = run(0, { min: 2, head: b.head });
    expect(gated.ok && gated.fromSeq).toBe(2);
  });
});

describe('the activity since the marker leaves out what is at or below the gate (HIS-027 criterion 5)', () => {
  /** A log of visible edits; commit `s` is by `u<s>`, except every third, which is the caller's. */
  function authored(ops: readonly { kind: EditKind; a: number; b: number }[]): LogBuilder {
    const b = new LogBuilder();
    for (const o of ops) {
      const tr = randomEdit(b.doc, o.kind, o.a, o.b, 'w', new Set([SECRET_REGION]));
      if (!tr?.steps.length) continue;
      const seq = b.head + 1;
      b.add(() => tr, { user: seq % 3 === 0 ? 'me' : `u${seq}`, scopes: ['body'] });
    }
    return b;
  }

  const activity = (b: LogBuilder, marker: number, min: number) => {
    const ms = maps(b);
    return activitySince({
      marker,
      user: 'me',
      gate: { min, head: b.head },
      hidden: HIDDEN,
      source: {
        schema,
        incarnation: 'inc-1',
        content: (s) => b.docs[s],
        commits: (after, to) => b.commits(after, to),
        attribution: (s) => ms[s],
      },
      commits: b.log.map(meta),
      versions: [],
    });
  };

  /** Every seq and user that a result names: changes, spans, items and the summary. */
  function named(r: Extract<ReturnType<typeof activity>, { ok: true }>) {
    const seqs: number[] = [];
    const users: string[] = [];
    for (const ch of r.comparison.changes) {
      if (ch.seq !== undefined) seqs.push(ch.seq);
      if (ch.user !== undefined) users.push(ch.user);
      for (const sp of ch.spans ?? []) {
        if (sp.seq !== undefined) seqs.push(sp.seq);
        if (sp.user !== undefined) users.push(sp.user);
      }
    }
    for (const item of r.items) {
      if (item.type === 'group') {
        seqs.push(item.fromSeq, item.toSeq);
        users.push(...item.authors.map((a) => a.user));
      } else seqs.push(item.version.seq);
    }
    for (const s of r.summary) users.push(...s.users);
    return { seqs, users };
  }

  it('returns nothing from a commit at or below the gate for a marker of 0 and a gate at 2', () => {
    const b = authored([
      { kind: 'type', a: 0.1, b: 0.1 },
      { kind: 'type', a: 0.4, b: 0.2 },
      { kind: 'type', a: 0.6, b: 0.3 },
      { kind: 'type', a: 0.8, b: 0.4 },
      { kind: 'type', a: 0.2, b: 0.5 },
    ]);
    expect(b.head).toBe(5);
    const all = activity(b, 0, 0);
    const gated = activity(b, 0, 2);
    if (!all.ok || !gated.ok) throw new Error('activity refused');
    // Without the gate, commits 1 and 2 are in the result, so the gated check below is not vacuous.
    expect(named(all).users).toEqual(expect.arrayContaining(['u1', 'u2']));
    expect([gated.fromSeq, gated.comparison.fromSeq, gated.toSeq]).toEqual([2, 2, 5]);
    const { seqs, users } = named(gated);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((s) => s > 2 && s <= 5)).toBe(true);
    expect(users).not.toContain('u1');
    expect(users).not.toContain('u2');
    expect(users).not.toContain('owner');
    expect(users).toContain('u4');
    // The caller's own commit (3) is not listed.
    expect(
      gated.items.flatMap((i) => (i.type === 'group' ? i.authors.map((a) => a.user) : [])),
    ).not.toContain('me');
    expect(gated.summary.reduce((n, s) => n + s.changes, 0)).toBe(gated.comparison.changes.length);
  });

  it('names no seq and no author at or below max(marker, gate) in the changes, items or summary (property)', () => {
    let nonEmpty = 0;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom<EditKind>(
              'type',
              'type',
              'delete',
              'split',
              'join',
              'mark',
              'attr',
            ),
            a: fc.double({ min: 0, max: 0.999, noNaN: true }),
            b: fc.double({ min: 0, max: 0.999, noNaN: true }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        // The marker and the gate are drawn relative to the log's length, from 0 to two past the
        // head, so that most runs fall strictly inside the log and the count below is not left
        // to chance (fixed integers up to 22 often landed at 0 or past the head of a short log).
        // Integers in thousandths, because fc.double draws values near 0 far more often.
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        (ops, markerAt, minAt) => {
          const b = authored(ops);
          const marker = Math.floor((markerAt * (b.head + 3)) / 1000);
          const min = Math.floor((minAt * (b.head + 3)) / 1000);
          const gateMin = Math.min(min, b.head);
          const r = activity(b, marker, gateMin);
          if (!r.ok) throw new Error(r.reason);
          const from = Math.min(Math.max(marker, gateMin), b.head);
          expect([r.fromSeq, r.comparison.fromSeq, r.toSeq]).toEqual([from, from, b.head]);
          const allowed = new Set(b.log.filter((c) => c.seq > from).map((c) => c.user));
          const { seqs, users } = named(r);
          for (const s of seqs) expect(s).toBeGreaterThan(from);
          for (const u of users) expect(allowed.has(u), `user ${u} after ${from}`).toBe(true);
          if (from === b.head) expect(r.comparison.changes).toEqual([]);
          if (seqs.length > 0 && from > 0) nonEmpty++;
        },
      ),
      { numRuns: 200 },
    );
    expect(nonEmpty).toBeGreaterThan(20);
  });
});

describe('the hidden set of a history read (HIS-046)', () => {
  it('hides in old versions what the reader’s current access hides in the head or in that version', () => {
    const base = baseDoc();
    // A reader without a grant: the confidential region is hidden in every version that has it.
    const viewer = {
      sub: 'frank',
      session: 's-frank',
      role: 'viewer' as const,
      groups: [],
      participantRoles: [],
      participantActive: false,
    };
    const perms = {
      revision: 1,
      grants: [],
      regionStates: new Map(),
      leases: [],
      documentState: 'active' as const,
      workflowActive: false,
    };
    // The region is deleted in the head; it stays hidden in the old version.
    const at = base.child(base.childCount - 1);
    let regionPos = -1;
    base.descendants((n, pos) => {
      if (n.attrs['id'] === SECRET_REGION) regionPos = pos;
      return regionPos < 0;
    });
    const head = new Transform(base).delete(
      regionPos,
      regionPos + base.nodeAt(regionPos)!.nodeSize,
    ).doc;
    expect(at).toBeDefined();
    const h = hiddenAcross(viewer, [base, head], perms, 0);
    expect([...h.regions]).toEqual([SECRET_REGION]);
    expect(h.values.has('fTenantName00001')).toBe(true);
    expect(
      unionHidden(
        { regions: new Set(['a']), values: new Set(), titles: true },
        { regions: new Set(), values: new Set(['b']), titles: false },
      ),
    ).toEqual({
      regions: new Set(['a']),
      values: new Set(['b']),
      titles: false,
    });
  });

  it('refuses attribution and field history for hidden scopes as if they did not exist', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, { user: 'owner', seq: 0 });
    expect(
      attributionFor({
        doc,
        map,
        seq: 0,
        gate: { min: 0, head: 0 },
        hidden: HIDDEN,
        region: SECRET_REGION,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      attributionFor({
        doc,
        map,
        seq: 0,
        gate: { min: 0, head: 0 },
        hidden: HIDDEN,
        blocks: ['pSecret00000001B'],
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      attributionFor({
        doc,
        map,
        seq: 0,
        gate: { min: 0, head: 0 },
        hidden: HIDDEN,
        region: 'rNothing00000000',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(fieldHistory('fTenantName00001', [], { min: 0, head: 0 }, HIDDEN)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(
      attributionFor({
        doc,
        map,
        seq: 0,
        gate: { min: 0, head: 0 },
        hidden: HIDDEN,
        region: 'rTerms000000000A',
      }).ok,
    ).toBe(true);
  });

  it('copies a version for a requester as their projection unless they hold manage', () => {
    const doc = baseDoc();
    const perms = {
      revision: 1,
      grants: [],
      regionStates: new Map(),
      leases: [],
      documentState: 'active' as const,
      workflowActive: false,
    };
    const owner = computeAccess(
      {
        sub: 'alice',
        session: 's',
        role: 'owner',
        groups: [],
        participantRoles: [],
        participantActive: false,
      },
      regionInfos(doc),
      perms,
      0,
    );
    const editor = computeAccess(
      {
        sub: 'bob',
        session: 's',
        role: 'editor',
        groups: [],
        participantRoles: [],
        participantActive: false,
      },
      regionInfos(doc),
      perms,
      0,
    );
    expect(forkContent(doc, HIDDEN, owner)).toBe(doc);
    const copy = forkContent(doc, HIDDEN, editor);
    copy.check();
    expect(text(copy.toJSON())).not.toContain('CANARY');
    expect(text(copy.toJSON())).not.toContain(SECRET_REGION);
  });
});
