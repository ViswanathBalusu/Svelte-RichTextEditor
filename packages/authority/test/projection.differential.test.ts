// S12 (SPK-029), criterion 3: a reader's commit made on their projection passes or fails the room's
// checks (04 §5 steps 5 to 7) exactly as the same edit made on the full document would. Two rooms
// start from the same document and permissions: room A behind the projection gateway, room B
// without one. Each edit is made once on the reader's projection and sent through the gateway, and
// once at the corresponding full positions and sent straight to room B.
import fc from 'fast-check';
import type { Node, Schema } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/permissions/model.ts';
import { ProjectionGateway, type Visibility } from '../src/projection/gateway.ts';
import {
  type Projection,
  project,
  projToFull,
  projectionSchema,
} from '../src/projection/projection.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, WriteResult } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, basePermissions, schema } from './fixtures.ts';
import { resetIds, simId } from './harness/client.ts';
import { INCOME, LEGAL, canReadRegion, canReadValue, secretDoc } from './harness/projection-sim.ts';
import { MemoryStorage } from './harness/storage.ts';

const NOW = 1_760_000_000_000;
const pschema = projectionSchema();
const READERS = ['carol', 'erin', 'frank', 'mallory', 'bob', 'dave'] as const;

const visibility: Visibility = (conn, _doc, perms) => ({
  regions: canReadRegion(conn, perms, NOW) ? new Set() : new Set([LEGAL]),
  values: canReadValue(conn) ? new Set() : new Set([INCOME]),
  titles: false,
});

function makeRoom(storage: MemoryStorage): Room {
  return new Room({
    schema,
    initial: storage.initial,
    requires: storage.requires,
    log: storage.log,
    perms: storage.perms,
    initialRevision: storage.initialRevision,
    epoch: storage.epoch,
    incarnation: storage.incarnation,
    now: () => NOW,
  });
}

/** The answer a channel gets for one submission, completing storage writes as needed. */
function verdict(
  channel: string,
  first: Effects,
  storage: MemoryStorage,
  complete: (r: WriteResult) => Effects,
): string {
  let fx = first;
  for (let round = 0; round < 3; round++) {
    for (const o of fx.send) {
      if (o.channel !== channel) continue;
      if (o.msg.t === 'sync.ack') return 'accepted';
      if (o.msg.t === 'sync.reject') return o.msg.code;
    }
    if (!fx.write) break;
    fx = complete(storage.write(fx.write, 'none'));
  }
  throw new Error(`no answer on ${channel}`);
}

type Plan =
  | { k: 'insert'; at: number; text: string }
  | { k: 'delete' | 'bold'; from: number; to: number }
  | { k: 'split'; at: number }
  | { k: 'fill'; at: number; value: string; field: string }
  | { k: 'placeholder'; from: number; to: number };

interface Edit {
  who: number;
  k: number;
  a: number;
  b: number;
  s: string;
}

function textPositions(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.isTextblock) for (let i = 0; i <= n.content.size; i++) out.push(pos + 1 + i);
    return true;
  });
  return out;
}

/** An edit in projected positions. */
function planOn(p: Projection, e: Edit): Plan | null {
  const positions = textPositions(p.doc);
  const at = positions[e.a % positions.length]!;
  switch (e.k % 6) {
    case 0:
      return { k: 'insert', at, text: e.s };
    case 1:
    case 2: {
      const to = Math.min(p.doc.resolve(at).end(), at + (e.b % 6));
      return to > at ? { k: e.k % 6 === 1 ? 'delete' : 'bold', from: at, to } : null;
    }
    case 3:
      return { k: 'split', at };
    case 4: {
      const fields: Array<{ pos: number; id: string }> = [];
      p.doc.descendants((n, pos) => {
        if (n.type.name === 'form_field') fields.push({ pos, id: String(n.attrs['id']) });
        return true;
      });
      const f = fields[e.a % Math.max(1, fields.length)];
      return f ? { k: 'fill', at: f.pos, value: e.s, field: f.id } : null;
    }
    default: {
      const span = p.spans[0];
      if (!span) return null;
      // Delete the placeholder itself, or a range that runs across it.
      if (e.b % 2 === 0) return { k: 'placeholder', from: span.projStart, to: span.projStart + 1 };
      const before = positions.filter((x) => x < span.projStart);
      const after = positions.filter((x) => x > span.projStart + 1);
      if (!before.length || !after.length) return null;
      return { k: 'placeholder', from: before[before.length - 1]!, to: after[0]! };
    }
  }
}

function mapPlan(plan: Plan, f: (pos: number) => number): Plan {
  switch (plan.k) {
    case 'insert':
    case 'split':
      return { ...plan, at: f(plan.at) };
    case 'fill':
      return { ...plan, at: f(plan.at) };
    default:
      return { ...plan, from: f(plan.from), to: f(plan.to) };
  }
}

function run(doc: Node, plan: Plan, s: Schema): Transform | null {
  const tr = new Transform(doc);
  try {
    switch (plan.k) {
      case 'insert':
        tr.insert(plan.at, s.text(plan.text));
        break;
      case 'delete':
      case 'placeholder':
        tr.delete(plan.from, plan.to);
        break;
      case 'bold':
        tr.addMark(plan.from, plan.to, s.marks['bold']!.create());
        break;
      case 'split':
        tr.split(plan.at);
        break;
      case 'fill':
        tr.setNodeAttribute(plan.at, 'value', plan.value);
        break;
    }
  } catch {
    return null;
  }
  return tr.steps.length ? tr : null;
}

describe('S12: mapped commits meet the same checks as full ones', () => {
  it('passes or fails steps 5 to 7 exactly as the equivalent full commit, and refuses hidden content', () => {
    const totals = {
      same: 0,
      accepted: 0,
      refusedHidden: 0,
      stricter: 0,
      byCode: new Map<string, number>(),
      stricterBy: new Map<string, number>(),
    };
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            who: fc.nat(100),
            k: fc.nat(5),
            a: fc.nat(10_000),
            b: fc.nat(10),
            s: fc.string({ minLength: 1, maxLength: 3, unit: fc.constantFrom('x', 'y', ' ') }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (edits) => {
          resetIds();
          const storeA = new MemoryStorage(secretDoc(), REQUIRES, basePermissions());
          const storeB = new MemoryStorage(secretDoc(), REQUIRES, basePermissions());
          const roomA = makeRoom(storeA);
          const gateway = new ProjectionGateway(roomA, schema, visibility, pschema, {
            initial: storeA.initial,
            log: storeA.log,
          });
          const roomB = makeRoom(storeB);
          for (const r of READERS) {
            gateway.open(`A-${r}`, USERS[r]);
            roomB.open(`B-${r}`, USERS[r]);
          }
          for (const e of edits) {
            const who = READERS[e.who % READERS.length]!;
            const conn: Connection = USERS[who];
            const full = gateway.fullHead;
            const hidden = visibility(conn, full, roomA.permissions);
            const p = project(full, hidden, pschema);
            const plan = planOn(p, e);
            if (!plan) continue;
            const pTr = run(p.doc, plan, pschema);
            if (!pTr) continue;
            const fTr = run(
              full,
              mapPlan(plan, (pos) => projToFull(p, pos)),
              schema,
            );
            const id = simId();
            const head = roomA.head;
            const a = verdict(
              `A-${who}`,
              gateway.submit(`A-${who}`, { id, base: head, steps: stepsToJson(pTr.steps) }),
              storeA,
              (r) => gateway.writeCompleted(r),
            );
            const touchesHidden =
              plan.k === 'placeholder' || (plan.k === 'fill' && hidden.values.has(plan.field));
            if (touchesHidden) {
              // The projection layer refuses it before the room sees it.
              expect(a).toBe('permission_denied');
              totals.refusedHidden++;
              // The same edit made on the full document, for the record: the room refuses it too
              // unless the projection layer is stricter than the permissions (counted, not failed).
              if (fTr) {
                const b = verdict(
                  `B-${who}`,
                  roomB.submit(`B-${who}`, { id, base: head, steps: stepsToJson(fTr.steps) }),
                  storeB,
                  (r) => roomB.writeCompleted(r),
                );
                if (b === 'accepted') {
                  totals.stricter++;
                  const k = `${plan.k} by ${conn.role}`;
                  totals.stricterBy.set(k, (totals.stricterBy.get(k) ?? 0) + 1);
                  // Room A never received this commit, so the rooms now differ: end this run.
                  return;
                }
              }
              continue;
            }
            expect(fTr, `the full equivalent of ${plan.k} could not be built`).not.toBeNull();
            const b = verdict(
              `B-${who}`,
              roomB.submit(`B-${who}`, { id, base: head, steps: stepsToJson(fTr!.steps) }),
              storeB,
              (r) => roomB.writeCompleted(r),
            );
            expect(a, `${who} ${plan.k}`).toBe(b);
            totals.same++;
            totals.byCode.set(a, (totals.byCode.get(a) ?? 0) + 1);
            if (a === 'accepted') totals.accepted++;
            expect(gateway.fullHead.eq(roomB.document), 'the rooms hold different documents').toBe(
              true,
            );
          }
        },
      ),
      { numRuns: Number(process.env['S12_RUNS'] ?? 300) },
    );
    console.log(
      `S12 differential: ${JSON.stringify({ ...totals, byCode: Object.fromEntries(totals.byCode), stricterBy: Object.fromEntries(totals.stricterBy) })}`,
    );
    expect(totals.accepted).toBeGreaterThan(100);
    expect(totals.same - totals.accepted).toBeGreaterThan(20);
    expect(totals.refusedHidden).toBeGreaterThan(20);
  });
});
