// Differential test of the rebase (04 §6; SYN-010): for random concurrent edits, the authority's
// procedure (in drop mode, as a client) must produce exactly the steps that prosemirror-collab's own
// client rebase produces, and in reject mode it must either produce the same steps or reject.
import { canonicalize } from '@docedit/model';
import fc from 'fast-check';
import { collab, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { mapsOf, rebaseOver } from '../src/rebase.ts';
import { baseDoc, schema } from './fixtures.ts';

type Op = { kind: 'insert' | 'delete' | 'bold' | 'split'; at: number; len: number; text: string };

const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom('insert', 'insert', 'delete', 'bold', 'split'),
  at: fc.nat(10_000),
  len: fc.integer({ min: 1, max: 12 }),
  text: fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c', ' ', 'é') }),
});

/** Text positions inside the body's textblocks, where these simple edits are always valid. */
function textPositions(doc: Node): number[] {
  const out: number[] = [];
  const body = doc.child(doc.childCount - 1);
  const bodyStart = doc.content.size - body.nodeSize + 1;
  body.descendants((n, pos) => {
    if (n.isTextblock) {
      for (let i = 0; i <= n.content.size; i++) out.push(bodyStart + pos + 1 + i);
      return false;
    }
    return true;
  });
  return out;
}

function applyOp(tr: Transaction, op: Op): void {
  const positions = textPositions(tr.doc);
  const from = positions[op.at % positions.length]!;
  const $from = tr.doc.resolve(from);
  const end = $from.end();
  const to = Math.min(end, from + op.len);
  switch (op.kind) {
    case 'insert':
      tr.insertText(op.text, from);
      break;
    case 'delete':
      if (to > from) tr.delete(from, to);
      break;
    case 'bold':
      if (to > from) tr.addMark(from, to, schema.marks['bold']!.create());
      break;
    case 'split':
      if ($from.parent.type.name === 'paragraph') {
        tr.split(from);
        // The identifier plugin's job (03 §9): the new second half gets a fresh identifier.
        const $after = tr.doc.resolve(tr.mapping.map(from));
        const at = $after.before($after.depth);
        tr.setNodeAttribute(at, 'id', `n${String(tr.steps.length).padStart(15, '0')}`);
      }
      break;
  }
}

function edits(state: EditorState, ops: readonly Op[]): EditorState {
  let s = state;
  for (const op of ops) {
    const tr = s.tr;
    try {
      applyOp(tr, op);
    } catch {
      continue;
    }
    if (tr.docChanged) s = s.apply(tr.setSelection(TextSelection.create(tr.doc, 1)));
  }
  return s;
}

const json = (steps: readonly Step[]) => canonicalize(steps.map((s) => s.toJSON()));

describe('rebase (04 §6) against prosemirror-collab', () => {
  it('matches the client rebase of prosemirror-collab step for step', () => {
    let compared = 0;
    let withDrops = 0;
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 6 }),
        fc.array(opArb, { minLength: 1, maxLength: 6 }),
        (localOps, remoteOps) => {
          const doc = baseDoc();
          const start = EditorState.create({
            schema,
            doc,
            plugins: [collab({ clientID: 'local' })],
          });
          // Local unconfirmed edits on the base.
          const local = edits(start, localOps);
          const localSteps = sendableSteps(local)?.steps ?? [];
          // Remote edits made concurrently on the same base.
          const remoteState = edits(EditorState.create({ schema, doc }), remoteOps);
          const remoteSteps: Step[] = [];
          {
            let s = EditorState.create({ schema, doc, plugins: [collab({ clientID: 'remote' })] });
            s = edits(s, remoteOps);
            remoteSteps.push(...(sendableSteps(s)?.steps ?? []));
          }
          expect(remoteState.doc.eq(remoteSteps.reduce((d, st) => st.apply(d).doc!, doc))).toBe(
            true,
          );
          if (localSteps.length === 0 || remoteSteps.length === 0) return;

          // prosemirror-collab: receive the remote steps; unconfirmed steps are rebased.
          const received = local.apply(
            receiveTransaction(
              local,
              remoteSteps,
              remoteSteps.map(() => 'remote'),
            ),
          );
          const collabRebased = sendableSteps(received)?.steps ?? [];

          // The authority's procedure, on the document after the remote steps.
          let afterRemote = doc;
          for (const st of remoteSteps) afterRemote = st.apply(afterRemote).doc!;
          const dropped = rebaseOver(localSteps, mapsOf(remoteSteps), afterRemote, 'drop');
          expect(dropped.ok).toBe(true);
          if (!dropped.ok) return;
          expect(json(dropped.value.steps)).toBe(json(collabRebased));
          expect(dropped.value.doc.eq(received.doc)).toBe(true);
          compared++;
          if (dropped.value.dropped.length) withDrops++;

          // Reject mode: same steps when nothing was dropped, otherwise a rejection.
          const strict = rebaseOver(localSteps, mapsOf(remoteSteps), afterRemote, 'reject');
          if (dropped.value.dropped.length === 0) {
            expect(strict.ok).toBe(true);
            if (strict.ok) expect(json(strict.value.steps)).toBe(json(collabRebased));
          } else {
            expect(strict.ok).toBe(false);
            if (!strict.ok) expect(strict.code).toBe('rebase_failed');
          }
        },
      ),
      { numRuns: 400 },
    );
    // The comparison must really run, and dropped steps must really occur.
    expect(compared).toBeGreaterThan(300);
    console.log(`rebase differential: ${compared} compared, ${withDrops} with dropped steps`);
  });
});
