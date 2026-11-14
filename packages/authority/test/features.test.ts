// Room and gateway behaviour asked for by other packets (ADR 0050 items 5, 10 and 11): optional
// features per channel and the growth of `requires` (03 §11.1; CDM-047), `markSet` steps (04 §4),
// a refreshed token that changes a role (05 §3.1), a gateway started from a checkpoint, the
// model's invariant fixtures replayed as commits (CDM-014; FRW-005), and the field invariants on
// the shared corpus through validate() and the room (FRW-005 criterion 6).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDocument } from '@docedit/corpus';
import { supportedFeatures } from '@docedit/model/definition';
import { validate } from '@docedit/model/validate';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceStep,
  Step,
  Transform,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { visibility } from '../src/permissions/visibility.ts';
import { ProjectionGateway } from '../src/projection/gateway.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, StoredCommit, ToClient } from '../src/room/types.ts';
import { expandMarkSets, stepsToJson } from '../src/steps.ts';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  basePermissions,
  posInside,
  posOf,
  schema,
} from './fixtures.ts';

type J = Record<string, unknown>;
let counter = 0;
const uid = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;
const msgs = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
const reject = (fx: Effects, channel: string) => {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.reject');
  return m?.t === 'sync.reject' ? m : null;
};

/** The base document without form fields, so that it needs no feature. */
function plainDoc(): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const legal = json.content[1]!.content.find(
    (b) => (b['attrs'] as J | undefined)?.['id'] === 'rLegal000000000B',
  )!;
  (legal['content'] as J[])[0]!['content'] = [{ type: 'text', text: 'Liability is limited.' }];
  json.content[0]!.content = json.content[0]!.content.filter((d) => d['type'] !== 'role_def');
  return schema.nodeFromJSON(json);
}
const room = (extra: Partial<RoomInit> = {}, doc = plainDoc(), requires: string[] = []) =>
  new Room({
    schema,
    initial: doc,
    requires,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_771_000_000_000,
    ...extra,
  });
const fieldStep = (doc: Node) => {
  const at = posInside(doc, 'pIntro0000000001');
  const f = schema.nodes['form_field']!.create({
    id: 'fNew000000000001',
    key: 'new.key',
    kind: 'text',
    label: 'New',
  });
  return new ReplaceStep(at, at, new Slice(Fragment.from(f), 0, 0));
};

describe('features per channel (03 §11.1; CDM-047)', () => {
  it('refuses a channel whose client lacks a feature the document requires, with unsupported_feature', () => {
    const r = room({}, schema.nodeFromJSON(BASE_JSON), REQUIRES);
    const fx = r.open('c1', { ...USERS.carol, features: [] });
    expect(fx.refused).toEqual({ channel: 'c1', code: 'unsupported_feature', missing: ['fields'] });
    expect(fx.send).toEqual([]);
    expect(r.open('c2', { ...USERS.carol, features: ['fields'] }).send[0]?.msg.t).toBe('ch.opened');
    // A connection that announced nothing is not checked (backward compatible).
    expect(r.open('c3', USERS.carol).send[0]?.msg.t).toBe('ch.opened');
  });

  it('lets requires grow when every attached client announced the feature, and refuses the commit otherwise', () => {
    const growing = room({ requiresGrowth: true });
    growing.open('c1', { ...USERS.carol, features: ['fields'] });
    growing.open('a1', { ...USERS.alice, features: supportedFeatures() });
    const fx = growing.submit('c1', {
      id: uid(),
      base: 0,
      steps: stepsToJson([fieldStep(growing.document)]),
    });
    expect(reject(fx, 'c1')).toBeNull();
    expect(fx.write?.commits[0]).toMatchObject({ requires: ['fields'] });
    growing.writeCompleted({ status: 'ok' });
    expect(growing.requiresList).toEqual(['fields']);
    // A client without it can no longer open the document.
    expect(growing.open('v1', { ...USERS.frank, features: [] }).refused?.missing).toEqual([
      'fields',
    ]);

    const blocked = room({ requiresGrowth: true });
    blocked.open('c1', { ...USERS.carol, features: ['fields'] });
    blocked.open('f1', { ...USERS.frank, features: [] });
    const no = blocked.submit('c1', {
      id: uid(),
      base: 0,
      steps: stepsToJson([fieldStep(blocked.document)]),
    });
    expect(reject(no, 'c1')).toMatchObject({ code: 'conflict', action: 'drop' });
    expect(blocked.requiresList).toEqual([]);
    // Without the host's opt-in the commit is refused as before, as I1.
    const off = room();
    off.open('c1', { ...USERS.carol, features: ['fields'] });
    expect(
      reject(
        off.submit('c1', { id: uid(), base: 0, steps: stepsToJson([fieldStep(off.document)]) }),
        'c1',
      ),
    ).toMatchObject({ code: 'invalid_op' });
  });

  it('applies the requires a stored commit recorded when the room replays the log', () => {
    const first = room({ requiresGrowth: true });
    first.open('c1', { ...USERS.carol, features: ['fields'] });
    const stored = first.submit('c1', {
      id: uid(),
      base: 0,
      steps: stepsToJson([fieldStep(first.document)]),
    }).write!.commits[0]!;
    const replayed = room({ requiresGrowth: true, log: [stored] });
    expect(replayed.requiresList).toEqual(['fields']);
  });

  it('does not let the gateway’s own channel block a feature, and passes refusals on', () => {
    const now = () => 1_771_000_000_000;
    const r = new Room({
      schema,
      initial: plainDoc(),
      requires: [],
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now,
      requiresGrowth: true,
    });
    const g = new ProjectionGateway(r, schema, visibility(now));
    g.open('c1', { ...USERS.carol, features: ['fields'] });
    const fx = g.submit('c1', { id: uid(), base: 0, steps: stepsToJson([fieldStep(r.document)]) });
    expect(reject(fx, 'c1')).toBeNull();
    g.writeCompleted({ status: 'ok' });
    expect(g.open('f1', { ...USERS.frank, features: [] }).refused?.code).toBe(
      'unsupported_feature',
    );
  });
});

describe('markSet steps (04 §4; ADR 0050 item 10)', () => {
  it('refuses markSet with invalid_op, and accepts the expanded steps with the same result', () => {
    const r = room();
    const doc = r.document;
    const start = posInside(doc, 'pIntro0000000001');
    const bold = schema.marks['bold']!.create();
    const tr = new Transform(doc).addMark(start, start + 4, bold);
    const undo = new RemoveMarkStep(start, start + 4, bold);
    const set = Step.fromJSON(schema, {
      stepType: 'markSet',
      steps: [undo.toJSON(), new AddMarkStep(start, start + 2, bold).toJSON()],
    });
    r.open('c1', USERS.carol);
    const refused = r.submit('c1', { id: uid(), base: 0, steps: stepsToJson([set]) });
    expect(reject(refused, 'c1')).toMatchObject({ code: 'invalid_op' });
    const expanded = expandMarkSets([set]);
    expect(expanded.map((s) => (s.toJSON() as J)['stepType'])).toEqual(['removeMark', 'addMark']);
    const ok = r.submit('c1', { id: uid(), base: 0, steps: stepsToJson(expanded) });
    expect(reject(ok, 'c1')).toBeNull();
    expect(
      set.apply(doc).doc!.eq(new Transform(doc).step(expanded[0]!).step(expanded[1]!).doc),
    ).toBe(true);
    void tr;
  });
});

describe('a refreshed token that changes a role (05 §3.1; ADR 0050 item 11)', () => {
  it('swaps the channel’s connection and sends perm.changed with the new access, without closing', () => {
    const r = room();
    r.open('f1', USERS.frank);
    const before = r.submit('f1', {
      id: uid(),
      base: 0,
      steps: stepsToJson([
        new ReplaceStep(
          posInside(r.document, 'pIntro0000000001'),
          posInside(r.document, 'pIntro0000000001'),
          new Slice(Fragment.from(schema.text('x')), 0, 0),
        ),
      ]),
    });
    expect(reject(before, 'f1')).toMatchObject({ code: 'permission_denied' });
    const fx = r.refresh('f1', { ...USERS.frank, role: 'editor' });
    const changed = msgs(fx, 'f1').find((m) => m.t === 'perm.changed');
    expect(changed?.t === 'perm.changed' && changed.access.body.has('edit')).toBe(true);
    expect(msgs(fx, 'f1').some((m) => m.t === 'ch.closed')).toBe(false);
    const after = r.submit('f1', {
      id: uid(),
      base: 0,
      steps: stepsToJson([
        new ReplaceStep(
          posInside(r.document, 'pIntro0000000001'),
          posInside(r.document, 'pIntro0000000001'),
          new Slice(Fragment.from(schema.text('x')), 0, 0),
        ),
      ]),
    });
    expect(reject(after, 'f1')).toBeNull();
    // The same access sends nothing; another user's token closes the channel.
    expect(r.refresh('f1', { ...USERS.frank, role: 'editor' }).send).toEqual([]);
    expect(msgs(r.refresh('f1', USERS.carol), 'f1')).toEqual([
      { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
    ]);
  });

  it('through the gateway: perm.changed when the reader’s class stays, a close when it changes', () => {
    const now = () => 1_771_000_000_000;
    const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
    for (const b of json.content[1]!.content)
      if ((b['attrs'] as J | undefined)?.['id'] === 'rLegal000000000B')
        (b['attrs'] as J)['policy'] = 'confidential';
    const r = new Room({
      schema,
      initial: schema.nodeFromJSON(json),
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now,
    });
    const g = new ProjectionGateway(r, schema, visibility(now));
    g.open('c1', USERS.carol);
    // A role change that hides nothing new: the reader keeps the channel.
    const same = g.refresh('c1', { ...USERS.carol, role: 'suggester' });
    expect(msgs(same, 'c1').map((m) => m.t)).toEqual(['perm.changed']);
    // Joining the legal group reveals the confidential region: the class changes and the channel closes.
    const moved = g.refresh('c1', { ...USERS.carol, role: 'suggester', groups: ['legal'] });
    expect(msgs(moved, 'c1').find((m) => m.t === 'ch.closed')).toMatchObject({
      reason: 'access_changed',
    });
  });
});

describe('a gateway started from a checkpoint (BE-019, BE-020)', () => {
  it('takes the content at initialSeq and serves a catch-up stream from it', () => {
    const now = () => 1_771_000_000_000;
    const first = room();
    first.open('c1', USERS.carol);
    const commits: StoredCommit[] = [];
    for (const text of ['a', 'b', 'c']) {
      const fx = first.submit('c1', {
        id: uid(),
        base: first.head,
        steps: stepsToJson([
          new ReplaceStep(
            posInside(first.document, 'pIntro0000000001'),
            posInside(first.document, 'pIntro0000000001'),
            new Slice(Fragment.from(schema.text(text)), 0, 0),
          ),
        ]),
      });
      commits.push(fx.write!.commits[0]!);
      first.writeCompleted({ status: 'ok' });
    }
    // A checkpoint at seq 2; the room and the gateway start from it with the log after it.
    const atTwo = (() => {
      const r = room({ log: commits.slice(0, 2) });
      return r.document;
    })();
    const r = room({ initial: atTwo, initialSeq: 2, log: commits.slice(2) });
    const g = new ProjectionGateway(r, schema, visibility(now), undefined, {
      initial: atTwo,
      log: commits.slice(2),
      initialSeq: 2,
    });
    const open = g.open('c2', USERS.carol);
    const opened = msgs(open, 'c2')[0];
    expect(opened?.t === 'ch.opened' && opened.catchUp).toBe('reload');
    const view = opened?.t === 'ch.opened' ? opened.view : undefined;
    const resumed = g.open('c3', USERS.carol, {
      seq: 2,
      incarnation: 'inc-1',
      inflight: null,
      ...(view ? { view } : {}),
    });
    expect(msgs(resumed, 'c3').map((m) => m.t)).toEqual([
      'ch.opened',
      'sync.commit',
      'sync.caughtUp',
    ]);
  });
});

describe("the model's invariant fixtures as commits through the room (CDM-014; FRW-005)", () => {
  const fixtures = resolve(import.meta.dirname, '../../model/fixtures');
  const BASES: Record<string, string> = {
    example: 'example-03-12.json',
    'kitchen-sink': 'kitchen-sink.json',
  };
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      const o = value as J;
      if (typeof o['$repeat'] === 'string' && typeof o['count'] === 'number')
        return o['$repeat'].repeat(o['count']);
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
    }
    return value;
  };
  interface Fixture {
    name: string;
    base: string | J;
    steps: J[];
    requires?: string[];
    context: { attachedAssets?: string[]; retiredRegionIds?: string[]; mathGateRefuses?: string };
    expected: string[];
  }
  const cases = readdirSync(resolve(fixtures, 'invariants/cases'))
    .filter((f) => f.endsWith('.json'))
    .map(
      (f) => JSON.parse(readFileSync(resolve(fixtures, 'invariants/cases', f), 'utf8')) as Fixture,
    )
    .filter((f) => f.steps.length > 0);

  const replay = (f: Fixture) => {
    const base =
      typeof f.base === 'string'
        ? (JSON.parse(
            readFileSync(resolve(fixtures, BASES[f.base] ?? `${f.base}.json`), 'utf8'),
          ) as J)
        : f.base;
    const gate = f.context.mathGateRefuses;
    const r = new Room({
      schema,
      initial: schema.nodeFromJSON(base['doc']),
      requires: f.requires ?? (base['requires'] as string[]),
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now: () => 1_771_000_000_000,
      limits: { maxStepsPerCommit: 5000, maxCommitBytes: 64 << 20, maxRebaseSteps: 5000 },
      ...(f.context.attachedAssets ? { attachedAssets: new Set(f.context.attachedAssets) } : {}),
      retiredRegionIds: f.context.retiredRegionIds ?? [],
      ...(gate !== undefined
        ? { mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null) }
        : {}),
    });
    r.open('o1', USERS.alice);
    return r.submit('o1', { id: uid(), base: 0, steps: expand(f.steps) });
  };

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, f) => {
    const fx = replay(f);
    const r = reject(fx, 'o1');
    if (f.expected.length === 0) {
      expect(r, f.name).toBeNull();
      expect(fx.write?.commits).toHaveLength(1);
    } else {
      // Every failing fixture is refused at step 6 and nothing is stored; a value of the wrong type
      // is `field_invalid` (12 §4.2) only for a user who holds `fill` and not `edit`; for everyone
      // else I15 is `invalid_op` (04 §5 step 6, SYN-012 criterion 3). The replay submits as alice,
      // the owner, so the expected code is `invalid_op`.
      expect(r?.code, `${f.name}: ${r?.reason}`).toBe('invalid_op');
      expect(fx.write).toBeNull();
      expect(
        r?.reason.startsWith(f.expected[0]!) || f.expected.some((i) => r!.reason.includes(i)),
        `${f.name}: ${r?.reason}`,
      ).toBe(true);
    }
  });

  it('covers I14 (a formValue without its field) and I15 (a 2,001st field) as commits (FRW-005)', () => {
    const names = cases.map((c) => c.name);
    expect(names).toContain('i14-mirror-without-field');
    expect(names).toContain('i15-fields-2001');
    expect(reject(replay(cases.find((c) => c.name === 'i15-fields-2001')!), 'o1')?.reason).toMatch(
      /I15/,
    );
    expect(
      reject(replay(cases.find((c) => c.name === 'i14-mirror-without-field')!), 'o1')?.reason,
    ).toMatch(/I14/);
  });
});

describe('the field invariants on the shared corpus, through validate() and the room (FRW-005)', () => {
  it('gives the same verdict for I13 to I15 on the form-fields document', async () => {
    const { envelope, attachedAssets } = await loadDocument('form-fields');
    const doc = schema.nodeFromJSON(envelope.doc);
    const fields: Array<{ node: Node; pos: number }> = [];
    doc.descendants((n, pos) => {
      if (n.type.name === 'form_field') fields.push({ node: n, pos });
      return true;
    });
    const body = doc.child(doc.childCount - 1);
    const bodyStart = doc.content.size - body.nodeSize + 1;
    let firstText = -1;
    body.descendants((n, pos) => {
      if (firstText < 0 && n.isTextblock) firstText = bodyStart + pos + 1;
      return firstText < 0;
    });
    const [a, b] = fields;
    const number = fields.find(
      (f) => f.node.attrs['kind'] === 'number' || f.node.attrs['kind'] === 'date',
    );
    const at = posOf(doc, String(a!.node.attrs['id']));
    const breakers: Array<[string, Step[], string]> = [
      ['I13: a key used twice', [new AttrStep(b!.pos, 'key', String(a!.node.attrs['key']))], 'I13'],
      ['I13: an assignee no role defines', [new AttrStep(at, 'assignee', 'role_nobody')], 'I13'],
      [
        'I15: a value of the wrong type',
        number ? [new AttrStep(number.pos, 'value', 'not a value')] : [],
        'I15',
      ],
      [
        'I14: a formValue that mirrors no field',
        [
          new ReplaceStep(
            at,
            at,
            new Slice(
              Fragment.from(
                schema.nodes['field']!.create({ kind: 'formValue', target: 'field:no.such.key' }),
              ),
              0,
              0,
            ),
          ),
        ],
        'I14',
      ],
      ['valid: a value of the right kind', [], ''],
    ];
    for (const [what, steps, invariant] of breakers) {
      if (what.startsWith('I15') && !steps.length) continue;
      const tr = new Transform(doc);
      for (const s of steps) tr.step(s);
      const result = tr.doc;
      const violations = validate(
        { cdm: envelope.cdm, requires: [...envelope.requires], doc: result.toJSON() },
        { retiredRegionIds: new Set(), attachedAssets },
      ).violations.map((v) => v.invariant);
      const r = new Room({
        schema,
        initial: doc,
        requires: [...envelope.requires],
        log: [],
        perms: basePermissions(),
        initialRevision: 1,
        epoch: 1,
        incarnation: 'inc-1',
        now: () => 1,
        attachedAssets,
      });
      r.open('o1', USERS.alice);
      const fx = r.submit('o1', {
        id: uid(),
        base: 0,
        steps: stepsToJson(
          steps.length
            ? steps
            : [
                new ReplaceStep(
                  firstText,
                  firstText,
                  new Slice(Fragment.from(schema.text('x')), 0, 0),
                ),
              ],
        ),
      });
      const refused = reject(fx, 'o1');
      if (!invariant) {
        expect(violations, what).toEqual([]);
        expect(refused, what).toBeNull();
        continue;
      }
      expect(violations, what).toContain(invariant);
      expect(refused?.reason, what).toMatch(new RegExp(invariant));
    }
  });
});
