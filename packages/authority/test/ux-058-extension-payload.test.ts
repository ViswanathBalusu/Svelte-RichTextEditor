// UX-058 criterion 2 (Node.js): an edit made elsewhere in the document is saved through the room,
// and the payload of an extension block that the reader may not have registered is kept unchanged.
// The authority does not know which extensions a reader has registered (availability is the
// client's, UX-058); the server stores what the commit did not touch. `resolveExtensionNode` in
// packages/ui/src/extensions/custom-nodes.ts reads a node and never changes it (its own test).
import { ReplaceStep, type Step } from 'prosemirror-transform';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, USERS, basePermissions, posInside, schema } from './fixtures.ts';

type J = Record<string, unknown>;

let clock = 1_772_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const PAYLOAD = { kind: 'chart', series: [1, 2, 3], label: 'Dépôt €', nested: { ok: true } };
const BLOCK: J = {
  type: 'extension_block',
  attrs: {
    id: 'xBlock0000000001',
    extension: 'com.example.chart',
    payload: PAYLOAD,
    fallbackAsset: null,
    fallbackText: 'Chart from an unavailable extension',
  },
};

/** The base document with one extension block at the end of the body (requires `extensions`). */
function docWithBlock(): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: J[] };
  const body = json.content.find((b) => b['type'] === 'body') as unknown as { content: J[] };
  body.content.push(structuredClone(BLOCK));
  return schema.nodeFromJSON(json);
}

function blockOf(doc: Node): { payload: unknown; extension: string; fallbackText: unknown } {
  const found: Array<{ payload: unknown; extension: string; fallbackText: unknown }> = [];
  doc.descendants((n) => {
    if (n.type.name === 'extension_block')
      found.push({
        payload: n.attrs['payload'],
        extension: n.attrs['extension'],
        fallbackText: n.attrs['fallbackText'],
      });
  });
  const block = found[0];
  if (block === undefined) throw new Error('no extension block in the document');
  return block;
}

function room(doc: Node): Room {
  return new Room({
    schema,
    initial: doc,
    requires: ['fields', 'extensions'],
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-ux-058',
    now: () => ++clock,
  });
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}

/** Stores whatever the room asks to write, as the other room tests do, and returns every send. */
function flush(r: Room, fx: Effects): Effects {
  const all: Effects = { send: [...fx.send], write: null };
  let write = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    all.send.push(...done.send);
    write = done.write;
  }
  return all;
}

describe('an edit elsewhere keeps an extension payload unchanged (UX-058 criterion 2)', () => {
  it('stores an editor commit that edits another paragraph and leaves the block as it was', () => {
    const doc = docWithBlock();
    const before = blockOf(doc);
    const r = room(doc);
    r.open('a1', USERS.alice);
    r.open('c1', USERS.carol);

    const at = posInside(doc, 'pIntro0000000001', 0);
    const steps: Step[] = [
      new ReplaceStep(at, at, new Slice(Fragment.from(schema.text('Edited elsewhere. ')), 0, 0)),
    ];
    const fx = flush(
      r,
      r.submit('c1', { id: id(), base: 0, steps: stepsToJson(steps) } as CommitInput),
    );
    expect(msgs(fx, 'c1').some((m) => m.t === 'sync.ack')).toBe(true);
    expect(msgs(fx, 'c1').some((m) => m.t === 'sync.reject')).toBe(false);

    // The edit landed where it was made...
    expect(r.document.textContent).toContain('Edited elsewhere. This agreement');
    // ...and the block still holds the payload, the extension and the fallback it had.
    expect(blockOf(r.document)).toEqual(before);
    expect(blockOf(r.document).payload).toEqual(PAYLOAD);
  });
});
