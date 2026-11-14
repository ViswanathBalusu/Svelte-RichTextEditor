/**
 * Property test of the sync client in the editing core (FE-033, FE-121; SYN-017 to SYN-020):
 * random local edits by three users with different access, interleaved with the faults a server
 * produces (writes held, then stored or failed: `unavailable` and `retry`; grant changes:
 * `permission_denied` and `drop`; a locked document: `read_only`; snapshot commits: `sync.reset`
 * and `stale_base` with `rebase`) and with reconnects that resume. backend-mock runs the real
 * `Room`, so every acknowledgement, rebase and rejection is the authority's own.
 *
 * After the run nothing more is injected, and every client must converge (04 G3): nothing
 * unconfirmed, the confirmed and the visible document equal the server's content at its head, and
 * the editor state equals the sync client's visible document.
 */
import fc from 'fast-check';
import { importedDocument } from '@docedit/protocol/contract';
import { TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { settled } from '../src/sync/state.ts';
import { internals, rebuildStats } from '../src/testing.ts';
import type { DocumentCore } from '../src/headless.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, newService, sleep, traffic, until, type Member } from './support.ts';

type Op =
  | { k: 'edit'; c: number; kind: number; a: number; b: number; s: string }
  | { k: 'tick'; ms: number }
  | { k: 'hold' }
  | { k: 'release'; fail: boolean }
  | { k: 'grants' }
  | { k: 'reconnect'; c: number }
  | { k: 'reset' }
  | { k: 'lock' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({
      k: fc.constant('edit' as const),
      c: fc.nat(2),
      kind: fc.nat(9),
      a: fc.nat(500),
      b: fc.nat(500),
      s: fc.stringMatching(/^[a-z]{1,3}$/),
    }),
  },
  { weight: 6, arbitrary: fc.record({ k: fc.constant('tick' as const), ms: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'hold' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('release' as const), fail: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'grants' as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('reconnect' as const), c: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'reset' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'lock' as const }) },
);

/** Positions between the characters of every body paragraph (regions included). */
function textSpots(doc: Node): Array<{ pos: number; start: number; end: number }> {
  const out: Array<{ pos: number; start: number; end: number }> = [];
  const body = doc.lastChild!;
  const bodyStart = doc.content.size - body.nodeSize + 1;
  body.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    const start = bodyStart + pos + 1;
    const end = start + node.content.size;
    for (let p = start; p <= end; p++) out.push({ pos: p, start, end });
    return false;
  });
  return out;
}

/** A random edit through the core's own transactions, so that the region guard applies. */
function edit(core: DocumentCore, op: Extract<Op, { k: 'edit' }>): void {
  const i = internals(core);
  const doc = i.state.doc;
  const spots = textSpots(doc);
  if (!spots.length) return;
  const spot = spots[op.a % spots.length]!;
  const to = Math.min(spot.end, spot.pos + 1 + (op.b % 4));
  const select = (from: number, until = from) =>
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, until)));
  switch (op.kind % 10) {
    case 0:
    case 1:
    case 2:
      select(spot.pos);
      i.dispatch(i.state.tr.insertText(op.s));
      return;
    case 3:
      if (to > spot.pos) i.dispatch(i.state.tr.delete(spot.pos, to));
      return;
    case 4:
      if (to > spot.pos) {
        select(spot.pos, to);
        core.run(op.b % 2 ? 'bold' : 'italic');
      }
      return;
    case 5:
      select(spot.pos);
      i.dispatch(i.state.tr.split(spot.pos));
      return;
    case 6:
      select(spot.pos);
      core.run('paragraphStyle', { style: op.b % 2 ? 'Heading1' : 'Normal' });
      return;
    case 7:
      core.run('undo');
      return;
    case 8: {
      // A new region after a body paragraph: structure (owners only); a paragraph follows it.
      const $p = doc.resolve(spot.pos);
      if ($p.depth !== 2) return;
      const region = i.schema.nodeFromJSON({
        type: 'region',
        attrs: { title: op.s },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: op.s }] }],
      });
      i.dispatch(i.state.tr.insert($p.after(2), region));
      return;
    }
    default:
      select(spot.pos);
      i.dispatch(i.state.tr.insertText(`${op.s}${op.s}`));
      return;
  }
}

/** Runs a schedule and checks convergence; returns how many pieces of work were set aside. */
async function run(ops: readonly Op[]): Promise<number> {
  const service = newService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const members: Member[] = [
    await join(service, docId, 'eddie', 'editor'),
    await join(service, docId, 'olivia', 'owner'),
    await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] }),
  ];
  let hold: ReturnType<MockServiceT['holdWrites']> | null = null;
  let legal = true;
  let locked = false;
  try {
    for (const op of ops) {
      switch (op.k) {
        case 'edit':
          edit(members[op.c % members.length]!.core, op);
          break;
        case 'tick':
          await sleep(op.ms);
          break;
        case 'hold':
          if (!hold) hold = service.holdWrites(docId);
          break;
        case 'release':
          if (hold) await (op.fail ? hold.fail() : hold.release());
          hold = null;
          break;
        case 'grants':
          legal = !legal;
          service.setGrants(docId, legal ? [LEGAL_GRANT_FOR_TESTS] : []);
          break;
        case 'reconnect':
          members[op.c % members.length]!.core.reconnect();
          break;
        case 'reset':
          if (!hold) service.replaceContent(docId, importedDocument());
          break;
        case 'lock':
          locked = !locked;
          service.setDocumentState(docId, locked ? 'locked' : 'active');
          break;
      }
    }
    // Quiesce: no more faults.
    if (hold) await hold.release();
    if (locked) service.setDocumentState(docId, 'active');
    await until(
      () =>
        members.every((m) => {
          const s = internals(m.core).sync;
          return (
            settled(s) && m.core.connection.get() === 'online' && !internals(m.core).session?.held
          );
        }),
      'every client settled',
      10_000,
    );
    const content = await members[0]!.backend.sync.loadContent(docId);
    await until(
      () => members.every((m) => internals(m.core).sync.seq === content.seq),
      `every client at the head ${content.seq}`,
      10_000,
    );
    for (const m of members) {
      const i = internals(m.core);
      expect(i.sync.confirmed.toJSON(), 'confirmed document (G3)').toEqual(content.doc);
      expect(i.sync.visible.toJSON(), 'visible document').toEqual(content.doc);
      expect(i.state.doc.toJSON(), 'editor state').toEqual(content.doc);
      expect(i.sync.incarnation).toBe(content.incarnation);
    }
    return members.reduce((n, m) => n + m.core.recovered.get().count, 0);
  } finally {
    for (const m of members) m.detach();
    await service.dispose();
  }
}

type MockServiceT = ReturnType<typeof newService>;

describe('sync client: random edits, faults and reconnects converge with the room', () => {
  it('converges (property, 100 schedules)', async () => {
    traffic.clear();
    let recovered = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 60 }), async (ops) => {
        recovered += await run(ops);
      }),
      {
        numRuns: 100,
        interruptAfterTimeLimit: 150_000,
        // Replays a failure: DOCEDIT_SEED and DOCEDIT_PATH from the report.
        ...(process.env['DOCEDIT_SEED'] ? { seed: Number(process.env['DOCEDIT_SEED']) } : {}),
        ...(process.env['DOCEDIT_PATH']
          ? { path: process.env['DOCEDIT_PATH'], endOnFailure: true }
          : {}),
        verbose: process.env['DOCEDIT_SEED'] ? 2 : 0,
      },
    );
    const rejects = Object.fromEntries(traffic.rejects);
    const opens = Object.fromEntries(traffic.opens);
    console.log(
      `sync property: ${traffic.acks} acknowledgements (${traffic.rebasedAcks} rebased), ${traffic.commits} remote commits, rejections ${JSON.stringify(rejects)}, channel opens ${JSON.stringify(opens)}, ${traffic.resets} resets, ${recovered} recovered edits, rebuilds ${JSON.stringify(rebuildStats)}`,
    );
    // Every remote change reached the rebuilt document exactly through its own steps: no
    // correcting step, no fallback, and the editor never differed from the sync client.
    expect(rebuildStats.built).toBeGreaterThan(100);
    expect(rebuildStats.corrected).toBe(0);
    expect(rebuildStats.fallback).toBe(0);
    expect(rebuildStats.mismatch).toBe(0);
    // Not vacuous: every path of 04 §8 that the faults reach was taken at least once.
    expect(traffic.acks).toBeGreaterThan(100);
    expect(traffic.rebasedAcks).toBeGreaterThan(0);
    expect(traffic.rejects.get('unavailable') ?? 0).toBeGreaterThan(0);
    expect(traffic.rejects.get('permission_denied') ?? 0).toBeGreaterThan(0);
    expect(traffic.rejects.get('read_only') ?? 0).toBeGreaterThan(0);
    expect(traffic.rejects.get('stale_base') ?? 0).toBeGreaterThan(0);
    expect(traffic.resets).toBeGreaterThan(0);
    expect(traffic.opens.get('stream') ?? 0).toBeGreaterThan(300);
  }, 200_000);

  it('a fixed schedule with every fault converges', async () => {
    await run([
      { k: 'edit', c: 0, kind: 0, a: 3, b: 1, s: 'ab' },
      { k: 'edit', c: 1, kind: 0, a: 40, b: 2, s: 'cd' },
      { k: 'hold' },
      { k: 'edit', c: 2, kind: 0, a: 60, b: 0, s: 'ef' },
      { k: 'tick', ms: 2 },
      { k: 'release', fail: true },
      { k: 'grants' },
      { k: 'edit', c: 2, kind: 0, a: 61, b: 0, s: 'gh' },
      { k: 'tick', ms: 2 },
      { k: 'reconnect', c: 0 },
      { k: 'edit', c: 0, kind: 5, a: 10, b: 0, s: 'x' },
      { k: 'lock' },
      { k: 'edit', c: 1, kind: 0, a: 5, b: 0, s: 'ij' },
      { k: 'lock' },
      { k: 'reset' },
      { k: 'edit', c: 1, kind: 8, a: 2, b: 0, s: 'r' },
      { k: 'tick', ms: 3 },
    ]);
    expect(IDS.intro).toBeTruthy();
  }, 30_000);
});
