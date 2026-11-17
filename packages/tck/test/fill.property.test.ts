// FRW-066: the fill permission proved by a property test against the authority (12 §4 P7, P9;
// 07 §5.1). A fill-only participant submits random commits built from all seven step types,
// crafted replaceAround steps, attribute, mark and node-mark steps and pasted fields; every commit
// the outcome check accepts is judged by an oracle written independently of it: the documents
// before and after must be equal once the values of the fields P7 allows are set aside. A second
// property shows that a check that reasons about the shape of steps, as the first draft did, fails.
import {
  DEFAULT_LIMITS,
  EMPTY_PERMISSIONS,
  SERVER_ONLY_KINDS,
  applySteps,
  computeAccess,
  outcomeCheck,
  parseSteps,
  Room,
  regionInfos,
  type Connection,
  type Effects,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { posBefore } from '../src/documents.ts';
import { FIELD_IDS, fieldsDocument } from '../src/profiles/fields.ts';

const schema = cdmSchema();
type Node = ReturnType<typeof schema.nodeFromJSON>;
const startJson = fieldsDocument().doc as unknown;
const start = schema.nodeFromJSON(startJson);
const ROLES = ['role_tenant'];
const perms = { ...EMPTY_PERMISSIONS, workflowActive: true };
const participant = (sub: string): Connection => ({
  sub,
  session: `s-${sub}`,
  role: 'filler',
  groups: [],
  participantRoles: ROLES,
  participantActive: true,
});

interface J {
  type: string;
  attrs?: Record<string, unknown>;
  content?: J[];
  marks?: unknown[];
  text?: string;
}

/** The oracle: a document with the values P7 lets this participant change set aside (12 §4). */
function setAside(n: J): J {
  const out: J = { ...n };
  if (n.type === 'form_field' && n.attrs) {
    const allowed =
      ROLES.includes(n.attrs['assignee'] as string) &&
      !SERVER_ONLY_KINDS.has(n.attrs['kind'] as string);
    if (allowed) {
      const { value: _value, ...rest } = n.attrs;
      out.attrs = rest;
    }
  }
  if (n.content) out.content = n.content.map(setAside);
  return out;
}

const sameApartFromAllowedValues = (a: Node, b: Node) =>
  JSON.stringify(setAside(a.toJSON() as J)) === JSON.stringify(setAside(b.toJSON() as J));

/** Fields whose value differs between two documents. */
function changedFields(a: Node, b: Node): string[] {
  const values = (n: Node) => {
    const m = new Map<string, unknown>();
    n.descendants((x) => {
      if (x.type.name === 'form_field') m.set(String(x.attrs['id']), x.attrs['value']);
      return true;
    });
    return m;
  };
  const va = values(a);
  const vb = values(b);
  return [...new Set([...va.keys(), ...vb.keys()])].filter(
    (k) => JSON.stringify(va.get(k)) !== JSON.stringify(vb.get(k)),
  );
}

const FIELD = fc.constantFrom(FIELD_IDS.name, FIELD_IDS.rent, FIELD_IDS.sign);
const VALUE = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom('12.50', '-3', 'abc'),
  fc.constant(null),
  fc.constant({ asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10', mode: 'typed' }),
);

/** Random steps over the current document: every step type, crafted where it matters. */
function stepArb(doc: Node): fc.Arbitrary<Record<string, unknown>[]> {
  const json = doc.toJSON() as unknown;
  const size = doc.content.size;
  const pos = fc.integer({ min: 0, max: size });
  const para = posBefore(json, FIELD_IDS.para);
  const paraNode = doc.nodeAt(para)!;
  const fieldPos = (id: string) => posBefore(json, id);
  const step: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
    fc
      .tuple(FIELD, VALUE)
      .map(([f, v]) => ({ stepType: 'attr', pos: fieldPos(f), attr: 'value', value: v })),
    fc
      .tuple(
        FIELD,
        fc.constantFrom('assignee', 'required', 'kind', 'key', 'readOnly', 'sensitive', 'default'),
        VALUE,
      )
      .map(([f, a, v]) => ({ stepType: 'attr', pos: fieldPos(f), attr: a, value: v })),
    fc.tuple(pos, fc.string({ minLength: 1, maxLength: 3 })).map(([p, t]) => ({
      stepType: 'replace',
      from: p,
      to: p,
      slice: { content: [{ type: 'text', text: t }] },
    })),
    fc
      .tuple(pos, pos)
      .map(([a, b]) => ({ stepType: 'replace', from: Math.min(a, b), to: Math.max(a, b) })),
    // A pasted field: the participant's field replaced by a copy carrying another assignee or value.
    fc
      .tuple(FIELD, VALUE, fc.constantFrom('role_tenant', 'role_landlord'))
      .map(([f, v, assignee]) => {
        const at = fieldPos(f);
        const node = doc.nodeAt(at)!.toJSON() as J;
        return {
          stepType: 'replace',
          from: at,
          to: at + 1,
          slice: { content: [{ ...node, attrs: { ...node.attrs, value: v, assignee } }] },
        };
      }),
    // A crafted replaceAround that rewrites the paragraph around unchanged content.
    fc.constantFrom('Heading1', 'Normal').map((style) => ({
      stepType: 'replaceAround',
      from: para,
      to: para + paraNode.nodeSize,
      gapFrom: para + 1,
      gapTo: para + paraNode.nodeSize - 1,
      insert: 1,
      structure: true,
      slice: { content: [{ type: 'paragraph', attrs: { ...paraNode.attrs, style } }] },
    })),
    fc.tuple(pos, pos, fc.constantFrom('addMark', 'removeMark')).map(([a, b, t]) => ({
      stepType: t,
      mark: { type: 'bold' },
      from: Math.min(a, b),
      to: Math.max(a, b),
    })),
    fc.tuple(FIELD, fc.constantFrom('addNodeMark', 'removeNodeMark')).map(([f, t]) => ({
      stepType: t,
      pos: fieldPos(f),
      mark: { type: 'ins', attrs: { id: 'sFill00000000001', user: 'erin' } },
    })),
  );
  return fc.array(step, { minLength: 1, maxLength: 3 });
}

type Checker = (
  before: Node,
  after: Node,
  steps: Record<string, unknown>[],
  since: ReadonlySet<string>,
) => boolean;

/** The authority's outcome check for a fill-only participant (P7, P9). */
const authority: Checker = (before, after, _steps, since) =>
  outcomeCheck({
    before,
    after,
    user: 'erin',
    access: computeAccess(participant('erin'), regionInfos(before), perms, 0),
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: since,
    serverAuthored: false,
    origin: 'fill',
  }).ok;

/** The first draft's mistake: a check that trusts the shape of the steps (review S-01). */
const byShape: Checker = (_b, _a, steps) =>
  steps.every((s) => s['stepType'] === 'attr' && s['attr'] === 'value');

/** Commits accepted by the check under test, so that a property cannot hold vacuously. */
const accepted = { count: 0 };

/** Runs a random sequence of commits and reports the first accepted commit the oracle refutes. */
function sequence(check: Checker) {
  return fc.asyncProperty(
    fc.integer({ min: 1, max: 6 }),
    fc.infiniteStream(fc.nat()),
    async (n, seeds) => {
      let doc = start;
      for (let i = 0; i < n; i++) {
        const [steps] = fc.sample(stepArb(doc), { seed: seeds.next().value, numRuns: 1 });
        const parsed = parseSteps(schema, steps, DEFAULT_LIMITS);
        if (!parsed.ok) continue;
        let applied;
        try {
          applied = applySteps(doc, parsed.value);
        } catch (e) {
          throw new Error(`applySteps threw (a crash) on ${JSON.stringify(steps)}`, { cause: e });
        }
        if (!applied.ok) continue;
        if (!check(doc, applied.value.doc, steps!, new Set())) continue;
        accepted.count++;
        if (!sameApartFromAllowedValues(doc, applied.value.doc))
          throw new Error(
            `accepted a change beyond the values P7 allows: ${JSON.stringify(steps)}`,
          );
        doc = applied.value.doc;
      }
    },
  );
}

describe('a fill-only participant changes nothing but the values P7 allows (FRW-066 criterion 1)', () => {
  it('holds for random commits of every step type, checked by an independent oracle', async () => {
    accepted.count = 0;
    await fc.assert(sequence(authority), { numRuns: Number(process.env['FRW066_RUNS'] ?? 300) });
    expect(
      accepted.count,
      'some fills are accepted, so the property is not vacuous',
    ).toBeGreaterThan(10);
  });
});

describe('concurrent fills of one field (FRW-066 criterion 2, P9)', () => {
  it('never accepts a fill of a field changed after its base', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            who: fc.constantFrom('erin', 'tara'),
            behind: fc.nat(3),
            value: fc.string({ minLength: 1, maxLength: 4 }),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        (fills) => {
          // The log: the document after each accepted commit and the fields each changed.
          const docs: Node[] = [start];
          const changed: string[][] = [[]];
          for (const f of fills) {
            const head = docs.length - 1;
            const base = Math.max(0, head - f.behind);
            const since = new Set(changed.slice(base + 1).flat());
            const cur = docs[head]!;
            const parsed = parseSteps(
              schema,
              [
                {
                  stepType: 'attr',
                  pos: posBefore(cur.toJSON(), FIELD_IDS.name),
                  attr: 'value',
                  value: f.value,
                },
              ],
              DEFAULT_LIMITS,
            );
            if (!parsed.ok) continue;
            const applied = applySteps(cur, parsed.value);
            if (!applied.ok) continue;
            const verdict = outcomeCheck({
              before: cur,
              after: applied.value.doc,
              user: f.who,
              access: computeAccess(participant(f.who), regionInfos(cur), perms, 0),
              perms,
              suggestionOwners: new Map(),
              fieldsChangedSinceBase: since,
              serverAuthored: false,
              origin: 'fill',
            });
            const fields = changedFields(cur, applied.value.doc);
            if (verdict.ok) {
              expect(
                fields.filter((x) => since.has(x)),
                'an accepted fill overwrote a value changed after its base (P9)',
              ).toEqual([]);
              docs.push(applied.value.doc);
              changed.push(fields);
            } else if (fields.some((x) => since.has(x))) expect(verdict.code).toBe('conflict');
          }
        },
      ),
      { numRuns: Number(process.env['FRW066_RUNS'] ?? 300) },
    );
  });
});

describe('the oracle catches the critical finding of the review (FRW-066 criterion 4)', () => {
  it('fails for a check that reasons about step shapes', async () => {
    const result = await fc.check(sequence(byShape), { numRuns: 500, endOnFailure: true });
    expect(result.failed, 'the weakened check must be caught').toBe(true);
    expect(String(result.errorInstance), 'caught by the oracle, not by a crash').toMatch(
      /beyond the values P7 allows/,
    );
  });
});

describe('fuzzing the fill path (FRW-066 criterion 6)', () => {
  it('finds no crash or stall in parsing, applying and checking random steps', async () => {
    const started = Date.now();
    await fc.assert(sequence(authority), { numRuns: 200 });
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});

describe('a rejected fill leaves the room document unchanged (FRW-066 criterion 3)', () => {
  it('keeps the stored document and head whenever the room refuses a commit', () => {
    let clock = 1_790_200_000_000;
    let counter = 0;
    const commitId = () => `0192f0c4-7b1e-7000-9000-${(++counter).toString(16).padStart(12, '0')}`;
    let rejected = 0;
    let accepted = 0;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.infiniteStream(fc.nat()), (n, seeds) => {
        const room = new Room({
          schema,
          initial: start,
          requires: ['fields'],
          log: [],
          perms,
          initialRevision: 0,
          epoch: 1,
          incarnation: 'inc-fill',
          now: () => ++clock,
        });
        room.open('c1', { ...participant('erin'), features: ['fields'] });
        for (let i = 0; i < n; i++) {
          const [steps] = fc.sample(stepArb(room.document), {
            seed: seeds.next().value,
            numRuns: 1,
          });
          const before = room.document;
          const beforeJson = JSON.stringify(before.toJSON());
          const head = room.head;
          const fx = room.submit('c1', { id: commitId(), base: head, steps: steps! });
          if (fx.write === null) {
            // Refused by the room: nothing is stored, so the head and the document are as before.
            rejected++;
            expect(room.head).toBe(head);
            expect(JSON.stringify(room.document.toJSON())).toBe(beforeJson);
            continue;
          }
          accepted++;
          let write: ReturnType<Room['writeCompleted']>['write'] = fx.write;
          while (write) write = room.writeCompleted({ status: 'ok' }).write;
          expect(
            sameApartFromAllowedValues(before, room.document),
            'an accepted fill changed more than the values P7 allows',
          ).toBe(true);
        }
      }),
      { numRuns: Number(process.env['FRW066_RUNS'] ?? 300) },
    );
    expect(rejected, 'some commits are refused, so the property is not vacuous').toBeGreaterThan(0);
    expect(accepted, 'some commits are accepted, so the property is not vacuous').toBeGreaterThan(
      0,
    );
  });
});

describe('random bases, reconnects and failed writes through the room (FRW-066 criterion 1)', () => {
  it('accepts from a fill-only participant nothing but the values P7 allows', () => {
    let clock = 1_790_300_000_000;
    let counter = 0;
    const commitId = () => `0192f0c4-7b1e-7000-a000-${(++counter).toString(16).padStart(12, '0')}`;
    const seen = { stored: 0, stale: 0, conflicts: 0, failed: 0, reconnects: 0, resumed: 0 };
    const INCARNATION = 'inc-fill-bases';
    const OP = fc.constantFrom(
      'erin',
      'erin',
      'erin',
      'tara',
      'tara',
      'ok',
      'ok',
      'failed',
      'reconnect',
    );
    fc.assert(
      fc.property(
        fc.array(fc.record({ op: OP, behind: fc.nat(3), seed: fc.nat() }), {
          minLength: 2,
          maxLength: 14,
        }),
        (ops) => {
          const room = new Room({
            schema,
            initial: start,
            requires: ['fields'],
            log: [],
            perms,
            initialRevision: 0,
            epoch: 1,
            incarnation: INCARNATION,
            now: () => ++clock,
          });
          const conn = (sub: string) => ({ ...participant(sub), features: ['fields'] });
          room.open('c1', conn('erin'));
          room.open('c2', conn('tara'));
          // The test's own record of the log, replayed from the write requests alone: the
          // document at each stored seq, the fields each commit changed, and each commit's base.
          const docs = new Map<number, Node>([[room.head, start]]);
          const changed = new Map<number, string[]>();
          const bases = new Map<string, number>();
          const storedSeq = new Map<string, number>();
          const erinIds: string[] = [];
          let outstanding: Effects['write'] = null;

          const submit = (channel: string, base: number, steps: unknown) => {
            const id = commitId();
            bases.set(id, base);
            if (channel === 'c1') erinIds.push(id);
            const fx = room.submit(channel, { id, base, steps, origin: 'fill' });
            const reject = fx.send.find((o) => o.msg.t === 'sync.reject');
            if (reject && reject.msg.t === 'sync.reject' && reject.msg.code === 'conflict')
              seen.conflicts++;
            if (fx.write) {
              expect(outstanding, 'one write at a time').toBeNull();
              outstanding = fx.write;
            }
          };

          const complete = (status: 'ok' | 'failed') => {
            const write = outstanding;
            if (!write) return;
            const head = room.head;
            const fx = room.writeCompleted({ status });
            outstanding = fx.write;
            if (status === 'failed') {
              // A failed write stores nothing: the head and the document are as before.
              seen.failed++;
              expect(room.head).toBe(head);
              expect(JSON.stringify(room.document.toJSON())).toBe(
                JSON.stringify(docs.get(head)!.toJSON()),
              );
              return;
            }
            let doc = docs.get(head)!;
            for (const c of write.commits) {
              const parsed = parseSteps(schema, c.steps, DEFAULT_LIMITS);
              if (!parsed.ok) throw new Error(`a stored commit does not parse: ${c.id}`);
              const applied = applySteps(doc, parsed.value);
              if (!applied.ok) throw new Error(`a stored commit does not apply: ${c.id}`);
              const after = applied.value.doc;
              expect(
                sameApartFromAllowedValues(doc, after),
                `commit ${c.seq} by ${c.user} changed more than the values P7 allows: ${JSON.stringify(c.steps)}`,
              ).toBe(true);
              const fields = changedFields(doc, after);
              const base = bases.get(c.id)!;
              const since = new Set<string>();
              for (let s = base + 1; s < c.seq; s++)
                for (const f of changed.get(s) ?? []) since.add(f);
              expect(
                fields.filter((f) => since.has(f)),
                `commit ${c.seq} overwrote a value changed after its base ${base} (P9)`,
              ).toEqual([]);
              if (c.user === 'erin' && base < c.seq - 1) seen.stale++;
              seen.stored++;
              changed.set(c.seq, fields);
              storedSeq.set(c.id, c.seq);
              docs.set(c.seq, after);
              doc = after;
            }
            // The room's durable document is the replay of what it asked the store to write.
            expect(JSON.stringify(room.document.toJSON())).toBe(JSON.stringify(doc.toJSON()));
            expect(docs.has(room.head)).toBe(true);
          };

          for (const { op, behind, seed } of ops) {
            if (op === 'erin') {
              // A random base: the steps are built over the document the participant last saw.
              const base = Math.max(0, room.head - behind);
              const [steps] = fc.sample(stepArb(docs.get(base)!), { seed, numRuns: 1 });
              submit('c1', base, steps);
            } else if (op === 'tara') {
              const cur = docs.get(room.head)!;
              const field = seed % 2 === 0 ? FIELD_IDS.name : FIELD_IDS.rent;
              submit('c2', room.head, [
                {
                  stepType: 'attr',
                  pos: posBefore(cur.toJSON(), field),
                  attr: 'value',
                  value: String(seed % 97),
                },
              ]);
            } else if (op === 'reconnect') {
              seen.reconnects++;
              room.close('c1');
              const seq = Math.max(0, room.head - behind);
              // The commit the participant believes is in flight: any one it has sent.
              const lastErin = erinIds.length === 0 ? null : erinIds[seed % erinIds.length]!;
              const fx = room.open('c1', conn('erin'), {
                seq,
                incarnation: INCARNATION,
                inflight: lastErin,
              });
              const opened = fx.send.find((o) => o.msg.t === 'ch.opened');
              expect(opened, 'the channel reopens').toBeDefined();
              if (opened?.msg.t !== 'ch.opened') continue;
              expect(opened.msg.head).toBe(room.head);
              const at = lastErin === null ? undefined : storedSeq.get(lastErin);
              if (lastErin === null) expect(opened.msg.inflight).toBeNull();
              else if (at !== undefined) {
                seen.resumed++;
                expect(opened.msg.inflight).toEqual({ state: 'accepted', seq: at });
              } else expect(opened.msg.inflight).toEqual({ state: 'unknown' });
            } else complete(op);
          }
          while (outstanding) complete('ok');
        },
      ),
      { numRuns: Number(process.env['FRW066_RUNS'] ?? 300) },
    );
    // None of the cases the criterion names is vacuous.
    expect(seen.stored, 'commits were stored').toBeGreaterThan(10);
    expect(seen.stale, 'fills with a base behind the head were stored').toBeGreaterThan(0);
    expect(
      seen.conflicts,
      'fills of a value changed after their base were refused',
    ).toBeGreaterThan(0);
    expect(seen.failed, 'writes failed').toBeGreaterThan(0);
    expect(seen.reconnects, 'the participant reconnected').toBeGreaterThan(0);
    expect(seen.resumed, 'a reconnect resumed with a stored commit in flight').toBeGreaterThan(0);
  });
});
