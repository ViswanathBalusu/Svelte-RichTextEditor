// SYN-050 to SYN-053 (ADR 0019, changes 1 to 5; second review SR-M1): how stored commits reach a
// visibility class, how a reader's commit is vetted, and how a reader whose class changes starts
// again. projection.property.test.ts runs the same machinery under random schedules.
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
  Transform,
} from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type {
  Connection,
  DocumentState,
  PermissionState,
  RegionState,
} from '../src/permissions/model.ts';
import { visibility as standardVisibility } from '../src/permissions/visibility.ts';
import { ProjectionGateway, type Visibility, viewToken } from '../src/projection/gateway.ts';
import {
  type HiddenSet,
  diffStep,
  project,
  projectCommit,
  projectionSchema,
  toFullSteps,
  visibilityKey,
} from '../src/projection/projection.ts';
import { mapsOf, rebaseOver } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  basePermissions,
  posInside,
  posOf,
  schema,
} from './fixtures.ts';
import { SimClient, resetIds, simId } from './harness/client.ts';
import {
  INCOME,
  LEGAL,
  SECRET_REGION,
  SECRET_TITLE,
  SECRET_VALUE,
  canReadRegion,
  canReadValue,
  secretDoc,
} from './harness/projection-sim.ts';
import { MemoryStorage } from './harness/storage.ts';

const pschema = projectionSchema();
const NOW = 1_760_000_000_000;
const hidden: HiddenSet = { regions: new Set([LEGAL]), values: new Set([INCOME]), titles: false };

const visibility: Visibility = (conn, _doc, perms) => ({
  regions: canReadRegion(conn, perms, NOW) ? new Set() : new Set([LEGAL]),
  values: canReadValue(conn) ? new Set() : new Set([INCOME]),
  titles: false,
});

/** A room behind a gateway over in-memory storage that stores every write at once. */
function setup(
  doc: Node = secretDoc(),
  vis: Visibility = visibility,
  perms = basePermissions(),
  now: () => number = () => NOW,
) {
  resetIds();
  const storage = new MemoryStorage(doc, REQUIRES, perms);
  const room = new Room({
    schema,
    initial: storage.initial,
    requires: storage.requires,
    log: storage.log,
    perms: storage.perms,
    initialRevision: storage.initialRevision,
    epoch: storage.epoch,
    incarnation: storage.incarnation,
    now,
  });
  const gateway = new ProjectionGateway(room, schema, vis, pschema, {
    initial: storage.initial,
    log: storage.log,
  });
  /** Every message sent, by channel, across writes. */
  const sent: Array<{ channel: string; msg: ToClient }> = [];
  const run = (fx: Effects): Effects => {
    sent.push(...fx.send);
    let write = fx.write;
    while (write) {
      const done = gateway.writeCompleted(storage.write(write, 'none'));
      sent.push(...done.send);
      write = done.write;
    }
    return fx;
  };
  const to = (channel: string) => sent.filter((o) => o.channel === channel).map((o) => o.msg);
  return { storage, room, gateway, run, to, sent };
}

function connectReader(g: ReturnType<typeof setup>, channel: string, conn: Connection): SimClient {
  const client = new SimClient(channel, conn, false, pschema);
  client.connect();
  const open = client.outbox.shift()!;
  if (open.t !== 'open') throw new Error('expected an open');
  for (const o of g.gateway.open(channel, conn, open.resume).send)
    if (o.channel === channel) client.receive(o.msg);
  client.channel = channel;
  return client;
}

describe('the steps a class receives (SYN-051; ADR 0019 change 4; SR-M1)', () => {
  it('keeps the type of every step that does not touch hidden content', () => {
    const full = secretDoc();
    const intro = posInside(full, 'pIntro0000000001');
    const p = posOf(full, 'pIntro0000000001');
    const bold = schema.marks['bold']!.create();
    const del = schema.marks['del']!.create({ id: 'sSuggestion00001', user: 'alice' });
    const tr = new Transform(full);
    tr.insert(intro, schema.text('A'));
    tr.addMark(intro, intro + 4, bold);
    tr.removeMark(intro, intro + 2, bold);
    // A block takes no node mark (its suggestions are in `suggest`); an inline node still does.
    tr.insert(intro, schema.nodes['tab']!.create());
    tr.step(new AddNodeMarkStep(intro, del));
    tr.step(new RemoveNodeMarkStep(intro, del));
    tr.step(new AttrStep(p, 'style', 'Heading1'));
    tr.setNodeMarkup(p, null, { ...tr.doc.nodeAt(p)!.attrs, style: 'Normal' });
    const before = project(full, hidden, pschema);
    const r = projectCommit(before, full, tr.steps, hidden, pschema);
    expect(r.routes.every((x) => x === 'mapped')).toBe(true);
    expect(r.steps.map((s) => s.toJSON().stepType)).toEqual(
      tr.steps.map((s) => s.toJSON().stepType),
    );
    expect(new Set(r.steps.map((s) => s.toJSON().stepType))).toEqual(
      new Set([
        'replace',
        'addMark',
        'removeMark',
        'addNodeMark',
        'removeNodeMark',
        'attr',
        'replaceAround',
      ]),
    );
    expect(r.view.doc.eq(project(tr.doc, hidden, pschema).doc)).toBe(true);
  });

  it('never forwards a step that changes nothing: its payload could carry a hidden value', () => {
    // Found by S12 (seed 1267336607): a fill made before a snapshot reset, re-applied after it at
    // a stale position, became an attribute step that sets `value` on a paragraph. The paragraph
    // has no such attribute, so the document does not change, but the step's JSON holds the value.
    const g = setup();
    connectReader(g, 'f1', USERS.frank);
    g.gateway.open('e1', USERS.erin);
    const steps = stepsToJson([
      new AttrStep(posOf(g.gateway.fullHead, 'pIntro0000000001'), 'value', `${SECRET_VALUE}-stale`),
      new AddMarkStep(
        posOf(g.gateway.fullHead, 'pIntro0000000001'),
        posOf(g.gateway.fullHead, 'pIntro0000000001'),
        schema.marks['link']!.create({ href: 'https://example.org/', title: SECRET_VALUE }),
      ),
    ]);
    g.run(g.gateway.submit('e1', { id: simId(), base: 0, steps }));
    const commit = g.to('f1').find((m) => m.t === 'sync.commit');
    expect(commit?.t === 'sync.commit' && commit.commit.steps).toEqual([]);
    expect(JSON.stringify(g.to('f1'))).not.toContain(SECRET_VALUE);
  });

  it('sends nothing for a change inside a hidden region: an empty commit that still advances seq', () => {
    const g = setup();
    const frank = connectReader(g, 'f1', USERS.frank);
    g.gateway.open('a1', USERS.alice);
    const inside = posInside(g.gateway.fullHead, 'pSecret00000001B');
    const steps = stepsToJson([
      new ReplaceStep(inside, inside, new Slice(Fragment.from(schema.text(SECRET_REGION)), 0, 0)),
    ]);
    g.run(g.gateway.submit('a1', { id: simId(), base: 0, steps }));
    const [commit] = g.to('f1').filter((m) => m.t === 'sync.commit');
    expect(commit?.t === 'sync.commit' && commit.commit.seq).toBe(1);
    expect(commit?.t === 'sync.commit' && commit.commit.steps).toEqual([]);
    frank.receive(commit!);
    expect(frank.confirmedSeq).toBe(1);
  });

  it('sends, from a step that cuts into hidden content, one replace step per changed range of the result', () => {
    const full = secretDoc();
    // Delete from inside the paragraph before the hidden region to inside the region, then type
    // far away in the notes region.
    const from = posInside(full, 'pMiddle000000001', 3);
    const to = posInside(full, 'pLegal000000001B', 2);
    const far = posInside(full, 'pNotes000000001C');
    const tr = new Transform(full).delete(from, to);
    tr.insert(tr.mapping.map(far), schema.text('kept'));
    const before = project(full, hidden, pschema);
    const r = projectCommit(before, full, tr.steps, hidden, pschema);
    expect(r.routes).toEqual(['diff', 'diff']);
    // Two ranges changed, so two steps, in descending position order; neither spans the other's
    // range, so a reader's typing between them (the paragraph after the hidden region) survives.
    expect(r.steps.map((s) => s.toJSON().stepType)).toEqual(['replace', 'replace']);
    const [notes, cut] = r.steps as [ReplaceStep, ReplaceStep];
    const after = posInside(before.doc, 'pAfter0000000001');
    expect(notes.from).toBeGreaterThan(after);
    expect(cut.to).toBeLessThan(after);
    expect(r.view.doc.eq(project(tr.doc, hidden, pschema).doc)).toBe(true);
  });

  it('never sends a state inside a commit: hidden text moved out and deleted again stays unsent', () => {
    // Found by the property below (seed -906979464): a cut across the hidden region's boundary
    // joins its text into the region before it, and a second deletion removes it again.
    const full = secretDoc();
    const tr = new Transform(full).delete(110, 153);
    tr.delete(120, 148);
    expect(JSON.stringify(project(tr.doc, hidden, pschema).doc.toJSON())).not.toContain(
      'TOPSECRET',
    );
    const r = projectCommit(project(full, hidden, pschema), full, tr.steps, hidden, pschema);
    expect(JSON.stringify(r.steps.map((s) => s.toJSON()))).not.toContain('TOPSECRET');
    expect(r.view.doc.eq(project(tr.doc, hidden, pschema).doc)).toBe(true);
  });

  it("keeps a reader's typing between two hidden values that one commit sets (SR-M1)", () => {
    // Two sensitive fields with a visible paragraph between them, as a form completion sets them.
    const json = structuredClone(BASE_JSON) as unknown as {
      content: Array<{ content: unknown[] }>;
    };
    const field = (id: string, key: string) => ({
      type: 'paragraph',
      attrs: { id: `p${id.slice(1)}` },
      content: [
        {
          type: 'form_field',
          attrs: { id, key, kind: 'text', label: key, assignee: 'role_tenant', sensitive: true },
        },
      ],
    });
    json.content[1]!.content.splice(
      1,
      0,
      field('fFirstSecret0001', 'first'),
      {
        type: 'paragraph',
        attrs: { id: 'pBetween00000001' },
        content: [{ type: 'text', text: 'Between.' }],
      },
      field('fSecondSecret001', 'second'),
    );
    const doc = schema.nodeFromJSON(json);
    doc.check();
    const values: Visibility = (conn) => ({
      regions: new Set(),
      values: canReadValue(conn) ? new Set() : new Set(['fFirstSecret0001', 'fSecondSecret001']),
      titles: false,
    });
    const g = setup(doc, values);
    const carol = connectReader(g, 'c1', USERS.carol);
    g.gateway.open('a1', USERS.alice);
    // Carol types into the paragraph between the fields; it is not sent yet.
    const at = posInside(carol.visible!, 'pBetween00000001');
    const typed = new Transform(carol.visible!).insert(at, pschema.text('mine '));
    carol.queue.push(...typed.steps);
    carol.visible = typed.doc;
    // Alice's commit sets both values: the fields lie on either side of Carol's typing.
    const full = g.gateway.fullHead;
    const steps = [
      new AttrStep(posOf(full, 'fFirstSecret0001'), 'value', `${SECRET_VALUE}-1`),
      new AttrStep(posOf(full, 'fSecondSecret001'), 'value', `${SECRET_VALUE}-2`),
    ];
    const before = project(full, values(USERS.carol, full, g.room.permissions), pschema).doc;
    g.run(g.gateway.submit('a1', { id: simId(), base: 0, steps: stepsToJson(steps) }));
    const commit = g.to('c1').find((m) => m.t === 'sync.commit');
    if (commit?.t !== 'sync.commit') throw new Error('no commit for Carol');
    // Carol's class receives the two value changes, redacted, each as its own attribute step.
    expect(commit.commit.steps.map((s) => [s.stepType, s['value']])).toEqual([
      ['attr', { redacted: true }],
      ['attr', { redacted: true }],
    ]);
    expect(JSON.stringify(commit)).not.toContain(SECRET_VALUE);
    carol.receive(commit);
    expect(carol.recovered).toBe(0);
    expect(carol.visible!.textContent).toContain('mine Between.');
    // Her commit then goes in, and the full document holds her text.
    carol.trySend();
    const submit = carol.outbox.shift()!;
    if (submit.t !== 'submit') throw new Error('expected a submit');
    g.run(g.gateway.submit('c1', submit.commit));
    expect(g.to('c1').some((m) => m.t === 'sync.ack')).toBe(true);
    expect(g.gateway.fullHead.textContent).toContain('mine Between.');
    // The control: one diff step from the first to the last change would have dropped her typing.
    const hiddenForCarol = values(USERS.carol, full, g.room.permissions);
    const whole = diffStep(before, project(applyAll(full, steps), hiddenForCarol, pschema).doc)!;
    const rebased = rebaseOver(typed.steps, mapsOf([whole]), whole.apply(before).doc!, 'drop');
    expect(rebased.ok && rebased.value.dropped).toEqual([0]);
  });

  it("gives a read-restricted reader its class's steps in the acknowledgement, and rebased: false when they are its own (core.sync.ack)", () => {
    const g = setup();
    connectReader(g, 'c1', USERS.carol);
    const view = () => project(g.gateway.fullHead, hidden, pschema).doc;
    const typeAt = (doc: ReturnType<typeof view>) => {
      const at = posInside(doc, 'pIntro0000000001');
      return new ReplaceStep(at, at, new Slice(Fragment.from(pschema.text('x')), 0, 0));
    };
    // A commit made on the head whose class steps are exactly the steps sent: rebased: false.
    const base = view();
    g.run(g.gateway.submit('c1', { id: simId(), base: 0, steps: stepsToJson([typeAt(base)]) }));
    const first = g.to('c1').find((m) => m.t === 'sync.ack');
    expect(first).toMatchObject({ t: 'sync.ack', seq: 1, rebased: false });
    expect(first?.t === 'sync.ack' && first.steps).toBeFalsy();
    // A commit on the old base, after another: the class's rebased steps, rebased: true.
    g.run(g.gateway.submit('c1', { id: simId(), base: 0, steps: stepsToJson([typeAt(base)]) }));
    const second = g.to('c1').filter((m) => m.t === 'sync.ack')[1];
    expect(second).toMatchObject({ t: 'sync.ack', seq: 2, rebased: true });
    expect(second?.t === 'sync.ack' && second.steps?.map((s) => s.stepType)).toEqual(['replace']);
  });

  it('turns random commits into steps that give exactly the projection after them (property)', () => {
    const kinds = fc.record({
      at: fc.nat(10_000),
      len: fc.nat(40),
      kind: fc.nat(8),
      text: fc.string({ minLength: 1, maxLength: 3, unit: fc.constantFrom('x', 'y') }),
    });
    let routes = { mapped: 0, noop: 0, inside: 0, value: 0, diff: 0 };
    fc.assert(
      fc.property(fc.array(kinds, { minLength: 1, maxLength: 6 }), (ops) => {
        const full = secretDoc();
        const tr = new Transform(full);
        for (const op of ops) {
          const positions: number[] = [];
          tr.doc.descendants((n, pos) => {
            if (n.isTextblock)
              for (let i = 0; i <= n.content.size; i++) positions.push(pos + 1 + i);
            return true;
          });
          const from = positions[op.at % positions.length]!;
          const to = positions[(op.at + op.len) % positions.length]!;
          const [a, b] = from <= to ? [from, to] : [to, from];
          try {
            switch (op.kind) {
              case 0:
                tr.insert(a, schema.text(op.text));
                break;
              case 1:
                // Deletions may run across paragraphs and regions, the hidden one included.
                tr.delete(a, b);
                break;
              case 2:
                tr.addMark(a, b, schema.marks['bold']!.create());
                break;
              case 3:
                tr.removeMark(a, b, schema.marks['bold']!);
                break;
              case 4:
                tr.addMark(
                  a,
                  b,
                  schema.marks['del']!.create({ id: 'sSuggestion00001', user: 'alice' }),
                );
                break;
              case 5: {
                const $a = tr.doc.resolve(a);
                tr.setNodeMarkup($a.before($a.depth), null, {
                  ...$a.parent.attrs,
                  style: 'Heading1',
                });
                break;
              }
              case 6: {
                let f = -1;
                tr.doc.descendants((n, pos) => {
                  if (n.type.name === 'form_field' && n.attrs['id'] === INCOME) f = pos;
                  return f < 0;
                });
                if (f >= 0) tr.setNodeAttribute(f, 'value', op.text.length > 1 ? null : op.text);
                break;
              }
              default:
                tr.split(a);
            }
          } catch {
            /* an edit that does not fit is skipped */
          }
        }
        const before = project(full, hidden, pschema);
        const r = projectCommit(before, full, tr.steps, hidden, pschema);
        for (const x of r.routes) routes[x]++;
        // Built from scratch, so that no cached node makes the comparison easy.
        const truth = project(schema.nodeFromJSON(tr.doc.toJSON()), hidden, pschema);
        expect(r.view.doc.eq(truth.doc)).toBe(true);
        expect(JSON.stringify(r.view.spans)).toBe(JSON.stringify(truth.spans));
        let doc = before.doc;
        for (const s of r.steps) doc = s.apply(doc).doc!;
        expect(doc.eq(truth.doc)).toBe(true);
        // The steps carry nothing the projection after the commit does not show. (These commits
        // skip the room's checks, so a deletion across a region boundary can move hidden text into
        // a visible region; then the full document itself shows it, and so may the steps.)
        if (!JSON.stringify(truth.doc.toJSON()).includes('TOPSECRET'))
          expect(JSON.stringify(r.steps.map((s) => s.toJSON()))).not.toContain('TOPSECRET');
      }),
      { numRuns: 500 },
    );
    // Not vacuous: every route was taken.
    expect(routes.mapped).toBeGreaterThan(100);
    expect(routes.inside).toBeGreaterThan(0);
    expect(routes.value).toBeGreaterThan(0);
    expect(routes.diff).toBeGreaterThan(0);
    routes = { mapped: 0, noop: 0, inside: 0, value: 0, diff: 0 };
  });
});

function applyAll(doc: Node, steps: readonly Step[]): Node {
  let d = doc;
  for (const s of steps) d = s.apply(d).doc!;
  return d;
}

describe('projections (SYN-050)', () => {
  it('rebuilds only the nodes on the path to a change', () => {
    const full = secretDoc();
    const at = posInside(full, 'pIntro0000000001');
    const next = new Transform(full).insert(at, schema.text('x')).doc;
    const a = project(full, hidden, pschema).doc;
    const b = project(next, hidden, pschema).doc;
    const mapped = projectCommit(
      project(full, hidden, pschema),
      full,
      new Transform(full).insert(at, schema.text('x')).steps,
      hidden,
      pschema,
    ).view.doc;
    const bodyA = a.child(a.childCount - 1);
    for (const doc of [b, mapped]) {
      const body = doc.child(doc.childCount - 1);
      let rebuilt = 0;
      for (let i = 0; i < body.childCount; i++) if (body.child(i) !== bodyA.child(i)) rebuilt++;
      expect(rebuilt).toBe(1); // the intro paragraph; every other child is the same object
      expect(doc.child(0)).toBe(a.child(0)); // the definitions are shared too
    }
  });
});

describe("vetting a reader's commit (SYN-052; ADR 0019 change 5)", () => {
  const full = secretDoc();
  const p = project(full, hidden, pschema);
  const span = p.spans[0]!;
  const fieldPos = (() => {
    let at = -1;
    p.doc.descendants((n, pos) => {
      if (n.type.name === 'form_field' && n.attrs['id'] === INCOME) at = pos;
      return at < 0;
    });
    return at;
  })();

  it('refuses a slice that carries the placeholder or a redacted value', () => {
    const end = posInside(p.doc, 'pEnd00000000001Z');
    const placeholder = p.doc.nodeAt(span.projStart)!;
    const pastePlaceholder = new ReplaceStep(
      posOf(p.doc, 'pEnd00000000001Z'),
      posOf(p.doc, 'pEnd00000000001Z'),
      new Slice(Fragment.from(placeholder), 0, 0),
    );
    const field = p.doc.nodeAt(fieldPos)!;
    const pasteField = new ReplaceStep(end, end, new Slice(Fragment.from(field), 0, 0));
    for (const s of [pastePlaceholder, pasteField]) {
      const r = toFullSteps([s], full, hidden, pschema, schema);
      expect(r.ok === false && r.code).toBe('permission_denied');
    }
  });

  it("refuses changes to a hidden field's value or default", () => {
    for (const attr of ['value', 'default']) {
      const r = toFullSteps([new AttrStep(fieldPos, attr, 'guess')], full, hidden, pschema, schema);
      expect(r.ok === false && r.code, attr).toBe('permission_denied');
    }
    // Its other attributes are visible and may be changed.
    expect(
      toFullSteps([new AttrStep(fieldPos, 'label', 'Pay')], full, hidden, pschema, schema).ok,
    ).toBe(true);
  });

  it('refuses crafted steps that map outside the document with invalid_op, and never throws', () => {
    const size = p.doc.content.size;
    const crafted: Step[] = [
      new ReplaceStep(size + 5, size + 9, Slice.empty),
      new AddMarkStep(size - 1, size + 40, schema.marks['bold']!.create()),
      new RemoveMarkStep(-3, 4, schema.marks['bold']!.create()),
      new AttrStep(size + 100, 'style', 'Heading1'),
      new ReplaceAroundStep(1, size + 3, 2, size + 2, Slice.empty, 0, true),
    ];
    for (const s of crafted) {
      let r: ReturnType<typeof toFullSteps> | undefined;
      expect(() => (r = toFullSteps([s], full, hidden, pschema, schema))).not.toThrow();
      expect(
        r!.ok === false && ['invalid_op', 'permission_denied'].includes(r!.code),
        JSON.stringify(s.toJSON()),
      ).toBe(true);
    }
    const g = setup();
    g.gateway.open('m1', USERS.mallory);
    const fx = g.gateway.submit('m1', {
      id: simId(),
      base: 0,
      steps: [{ stepType: 'replace', from: size + 5, to: size + 9 }],
    });
    expect(fx.send[0]?.msg).toMatchObject({ t: 'sync.reject', code: 'invalid_op' });
  });
});

describe('readers whose class changes (SYN-053; ADR 0019 changes 1 to 3)', () => {
  const revoke = (p: PermissionState): PermissionState => ({
    ...p,
    revision: p.revision + 1,
    grants: p.grants.filter((g) => g.principal !== 'group:legal'),
  });

  it('closes a reader whose class changes with the access-change reason; the next open reloads the new projection', () => {
    const g = setup();
    const bob = connectReader(g, 'b1', USERS.bob);
    expect(JSON.stringify(bob.confirmed!.toJSON())).toContain(SECRET_REGION);
    const oldView = bob.view;
    // The control plane writes the new revision, then notifies the room (07 §9).
    g.run(g.gateway.permissionsChanged(g.storage.changePermissions((p) => revoke(p))));
    const closed = g.to('b1').find((m) => m.t === 'ch.closed');
    expect(closed).toEqual({ t: 'ch.closed', code: 'unavailable', reason: 'access_changed' });
    // The next open resumes with the old token and is a reload under the new view.
    const fx = g.gateway.open('b2', USERS.bob, {
      seq: bob.confirmedSeq,
      incarnation: bob.incarnation,
      inflight: null,
      ...(oldView ? { view: oldView } : {}),
    });
    const opened = fx.send.find((o) => o.channel === 'b2')!.msg;
    expect(opened).toMatchObject({ t: 'ch.opened', catchUp: 'reload' });
    expect(opened.t === 'ch.opened' && opened.view).not.toBe(oldView);
    expect(JSON.stringify(opened)).not.toContain(SECRET_REGION);
    expect(JSON.stringify(opened)).not.toContain(SECRET_TITLE);
  });

  it('answers a resume with a missing or foreign view token with a reload, never a stream', () => {
    const g = setup();
    const key = visibilityKey(visibility(USERS.frank, g.gateway.fullHead, g.room.permissions));
    const resume = { seq: 0, incarnation: g.room.incarnation, inflight: null };
    const catchUp = (channel: string, view?: string) => {
      const fx = g.gateway.open(
        channel,
        USERS.frank,
        view === undefined ? resume : { ...resume, view },
      );
      const m = fx.send.find((o) => o.channel === channel)!.msg;
      return m.t === 'ch.opened' ? m.catchUp : null;
    };
    expect(catchUp('f1')).toBe('reload');
    expect(catchUp('f2', viewToken('another class'))).toBe('reload');
    // Frank is a viewer: under the default `editors` gate he reloads unless he is at the head.
    expect(catchUp('f3', viewToken(key))).toBe('stream');
  });

  it('projects content at the grants revision in storage when the notification was lost', () => {
    const g = setup();
    // Bob's grant on the confidential region is revoked in storage; the room is not told.
    const stored = g.storage.changePermissions((p) => revoke(p));
    expect(g.room.permissions.revision).toBe(1);
    const fx = g.gateway.open('b1', USERS.bob, undefined, stored);
    const opened = fx.send.find((o) => o.channel === 'b1')!.msg;
    expect(opened.t).toBe('ch.opened');
    expect(JSON.stringify(opened)).not.toContain(SECRET_REGION);
    expect(g.room.permissions.revision).toBe(stored.revision);
    // Without the stored state, the old revision would have served the region.
    const h = setup();
    h.storage.changePermissions((p) => revoke(p));
    expect(JSON.stringify(h.gateway.open('b1', USERS.bob).send)).toContain(SECRET_REGION);
  });
});

describe("with the permissions module's visibility (PRM-067; SYN-053)", () => {
  /** The S12 document with the legal region confidential, as ADR 0019 proposes. */
  function confidentialDoc(): Node {
    const json = secretDoc().toJSON() as {
      content: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    for (const block of json.content[1]!.content!)
      if ((block['attrs'] as Record<string, unknown> | undefined)?.['id'] === LEGAL)
        (block['attrs'] as Record<string, unknown>)['policy'] = 'confidential';
    return schema.nodeFromJSON(json);
  }
  const withFrankUntil = (expiresAt: number): PermissionState => ({
    ...basePermissions(),
    grants: [
      ...basePermissions().grants,
      { region: LEGAL, principal: 'user:frank', role: 'viewer', expiresAt },
    ],
  });

  it('closes a reader whose grant expires (Room.expire) and one whose refreshed token changes the class', () => {
    let t = NOW;
    const g = setup(
      confidentialDoc(),
      standardVisibility(() => t),
      withFrankUntil(NOW + 100),
      () => t,
    );
    const frank = connectReader(g, 'f1', USERS.frank);
    const carol = connectReader(g, 'c1', USERS.carol);
    expect(JSON.stringify(frank.confirmed!.toJSON())).toContain(SECRET_REGION);
    expect(JSON.stringify(carol.confirmed!.toJSON())).not.toContain(SECRET_REGION);
    // Frank's grant expires: nothing changed in storage, the room's expiry timer fires.
    t = NOW + 101;
    g.run(g.gateway.expire());
    expect(g.to('f1').find((m) => m.t === 'ch.closed')).toMatchObject({ reason: 'access_changed' });
    // Carol's refreshed token puts her in the legal group: she may now read the region.
    g.run(g.gateway.refresh('c1', { ...USERS.carol, groups: ['legal'] }));
    expect(g.to('c1').find((m) => m.t === 'ch.closed')).toMatchObject({ reason: 'access_changed' });
    const again = g.gateway.open(
      'c2',
      { ...USERS.carol, groups: ['legal'] },
      {
        seq: carol.confirmedSeq,
        incarnation: carol.incarnation,
        inflight: null,
        ...(carol.view ? { view: carol.view } : {}),
      },
    );
    const m = again.send.find((o) => o.channel === 'c2')!.msg;
    expect(m).toMatchObject({ t: 'ch.opened', catchUp: 'reload' });
    expect(JSON.stringify(m)).toContain(SECRET_REGION);
    // The sensitive value stays hidden from both: neither holds the assignee role.
    expect(JSON.stringify(m)).not.toContain(SECRET_VALUE);
  });
});

describe('commits that change visibility (SYN-053; PRM-067)', () => {
  it('closes a reader when a commit makes a region confidential, and the reload hides it', () => {
    const g = setup(
      secretDoc(),
      standardVisibility(() => NOW),
    );
    const frank = connectReader(g, 'f1', USERS.frank);
    expect(JSON.stringify(frank.confirmed!.toJSON())).toContain('Notes go here.');
    g.gateway.open('a1', USERS.alice);
    const notes = posOf(g.gateway.fullHead, 'rNotes000000000C');
    g.run(
      g.gateway.submit('a1', {
        id: simId(),
        base: 0,
        steps: stepsToJson([new AttrStep(notes, 'policy', 'confidential')]),
      }),
    );
    expect(g.to('f1').find((m) => m.t === 'ch.closed')).toMatchObject({ reason: 'access_changed' });
    expect(g.to('f1').some((m) => m.t === 'sync.commit')).toBe(false);
    const again = g.gateway.open('f2', USERS.frank, {
      seq: frank.confirmedSeq,
      incarnation: frank.incarnation,
      inflight: null,
      ...(frank.view ? { view: frank.view } : {}),
    });
    const m = again.send.find((o) => o.channel === 'f2')!.msg;
    expect(m).toMatchObject({ t: 'ch.opened', catchUp: 'reload' });
    expect(JSON.stringify(m)).not.toContain('Notes go here.');
  });
});

describe('every trigger that can change access derives the classes again (PRM-067; SYN-053)', () => {
  /** The S12 document with the legal region confidential, as ADR 0019 proposes. */
  function confidentialLegalDoc(): Node {
    const json = secretDoc().toJSON() as {
      content: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    for (const block of json.content[1]!.content!)
      if ((block['attrs'] as Record<string, unknown> | undefined)?.['id'] === LEGAL)
        (block['attrs'] as Record<string, unknown>)['policy'] = 'confidential';
    return schema.nodeFromJSON(json);
  }

  /** The standard visibility, recording every connection it was asked about. */
  function recording(): { vis: Visibility; asked: string[] } {
    const asked: string[] = [];
    const derive = standardVisibility(() => NOW);
    return {
      asked,
      vis: (conn, doc, perms) => {
        asked.push(conn.sub);
        return derive(conn, doc, perms);
      },
    };
  }

  interface Trigger {
    name: string;
    channel: string;
    conn: Connection;
    /** Whether the reader's class changes, so that the gateway closes the reader. */
    closes: boolean;
    act: (g: ReturnType<typeof setup>) => Effects;
  }

  /** Each change of access the spec lists (PRM-067 criterion 3), except expiry (see the test above). */
  const triggers: Trigger[] = [
    {
      name: 'a grant, with a new grants revision',
      channel: 'f1',
      conn: USERS.frank,
      closes: true,
      act: (g) =>
        g.gateway.permissionsChanged(
          g.storage.changePermissions((p) => ({
            ...p,
            revision: p.revision + 1,
            grants: [
              ...p.grants,
              { region: LEGAL, principal: 'user:frank', role: 'viewer', expiresAt: null },
            ],
          })),
        ),
    },
    {
      name: 'a lease, with a new grants revision',
      channel: 'f1',
      conn: USERS.frank,
      closes: false,
      act: (g) =>
        g.gateway.permissionsChanged(
          g.storage.changePermissions((p) => ({
            ...p,
            revision: p.revision + 1,
            leases: [...p.leases, { region: LEGAL, holder: 'bob', expiresAt: NOW + 60_000 }],
          })),
        ),
    },
    {
      name: 'a region state, with a new grants revision',
      channel: 'f1',
      conn: USERS.frank,
      closes: false,
      act: (g) =>
        g.gateway.permissionsChanged(
          g.storage.changePermissions((p) => ({
            ...p,
            revision: p.revision + 1,
            regionStates: new Map<string, RegionState>([...p.regionStates, [LEGAL, 'in_review']]),
          })),
        ),
    },
    {
      name: 'a workflow transition, with a new grants revision',
      channel: 'f1',
      conn: USERS.frank,
      closes: false,
      act: (g) =>
        g.gateway.permissionsChanged(
          g.storage.changePermissions((p) => ({
            ...p,
            revision: p.revision + 1,
            workflowActive: true,
          })),
        ),
    },
    {
      name: 'a document state, with a new grants revision',
      channel: 'f1',
      conn: USERS.frank,
      closes: false,
      act: (g) =>
        g.gateway.permissionsChanged(
          g.storage.changePermissions((p) => ({
            ...p,
            revision: p.revision + 1,
            documentState: 'locked' as DocumentState,
          })),
        ),
    },
    {
      name: 'a document role, in a refreshed token',
      channel: 'f1',
      conn: USERS.frank,
      closes: true,
      act: (g) => g.gateway.refresh('f1', { ...USERS.frank, role: 'owner' }),
    },
    {
      name: 'a group membership, in a refreshed token',
      channel: 'c1',
      conn: USERS.carol,
      closes: true,
      act: (g) => g.gateway.refresh('c1', { ...USERS.carol, groups: ['legal'] }),
    },
  ];

  it.each(triggers)('re-derives the class of a connected reader after $name', (t) => {
    const { vis, asked } = recording();
    const g = setup(confidentialLegalDoc(), vis);
    connectReader(g, t.channel, t.conn);
    asked.length = 0;
    g.run(t.act(g));
    expect(asked).toContain(t.conn.sub);
    const closed = g.to(t.channel).find((m) => m.t === 'ch.closed');
    if (t.closes) expect(closed).toMatchObject({ t: 'ch.closed', reason: 'access_changed' });
    else expect(closed).toBeUndefined();
  });
});

describe('snapshot commits through the projection (SYN-005; ADR 0019 decision item 2)', () => {
  it('sends readers a reset with their projection of the new content, never the content itself', () => {
    const g = setup();
    connectReader(g, 'f1', USERS.frank);
    connectReader(g, 'a1', USERS.alice);
    const content = secretDoc();
    const at = posInside(content, 'pSecret00000001B');
    const next = new Transform(content).insert(at, schema.text(`${SECRET_REGION}-restored `)).doc;
    g.storage.checkpoints.set('ckpt-1', next);
    g.run(
      g.gateway.snapshot('control', {
        id: simId(),
        reason: 'restore',
        content: next,
        checkpoint: 'ckpt-1',
        as: 'system',
      }),
    );
    const reset = g.to('f1').find((m) => m.t === 'sync.reset');
    expect(reset).toMatchObject({ t: 'sync.reset', seq: 1, reason: 'restore' });
    expect(JSON.stringify(reset)).not.toContain(SECRET_REGION);
    expect(JSON.stringify(reset)).not.toContain(SECRET_VALUE);
    expect(reset?.t === 'sync.reset' && reset.view).toBe(
      viewToken(visibilityKey(visibility(USERS.frank, next, g.room.permissions))),
    );
    // The owner's reset carries the full content.
    expect(JSON.stringify(g.to('a1').find((m) => m.t === 'sync.reset'))).toContain(
      `${SECRET_REGION}-restored`,
    );
    expect(g.to('control')).toContainEqual(expect.objectContaining({ t: 'sync.ack', seq: 1 }));
  });

  it('refuses a reader commit whose base is older than a snapshot with stale_base and rebase', () => {
    const g = setup();
    g.gateway.open('f1', USERS.carol);
    g.storage.checkpoints.set('ckpt-1', secretDoc());
    g.run(
      g.gateway.snapshot('control', {
        id: simId(),
        reason: 'import',
        content: secretDoc(),
        checkpoint: 'ckpt-1',
        as: 'system',
      }),
    );
    const at = posInside(project(secretDoc(), hidden, pschema).doc, 'pIntro0000000001');
    const fx = g.gateway.submit('f1', {
      id: simId(),
      base: 0,
      steps: stepsToJson([
        new ReplaceStep(at, at, new Slice(Fragment.from(pschema.text('x')), 0, 0)),
      ]),
    });
    expect(fx.send[0]?.msg).toMatchObject({
      t: 'sync.reject',
      code: 'stale_base',
      action: 'rebase',
    });
  });
});
