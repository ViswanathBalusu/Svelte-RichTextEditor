// BE-019 criterion 2 (lane V-BE-015-028): when a room opens, the position maps of recent steps are
// derived from the stored steps at least `maxRebaseSteps` back, and the indexes of node identifiers,
// region ranges, definitions in use per region, fields and comment ranges are built.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, StoredCommit, ToClient } from '../src/room/types.ts';
import type { ThreadAnchor } from '../src/room/threads.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_760_000_000_000;
let counter = 0;
const uid = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const INTRO = 'pIntro0000000001';
/** One insertion at the start of the intro paragraph. Its position never moves, so every base agrees. */
const insertAtIntro = () => {
  const pos = posInside(baseDoc(), INTRO);
  return stepsToJson([new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0))]);
};

function open(log: StoredCommit[], threads?: readonly ThreadAnchor[]): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log,
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
    ...(threads ? { threads } : {}),
  });
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}

describe('room opening: indexes and position maps (BE-019 criterion 2)', () => {
  it('builds the node-identifier index of the content it opens, at each node position', () => {
    const r = open([]);
    const index = r.nodeIndex;
    let identified = 0;
    r.document.descendants((node, pos) => {
      const id: unknown = node.attrs['id'];
      if (typeof id !== 'string' || id === '') return true;
      identified++;
      expect(index.get(id)).toEqual({ type: node.type.name, pos, size: node.nodeSize });
      return true;
    });
    expect(identified).toBeGreaterThan(0);
    expect(index.size).toBe(identified);
    expect(index.duplicates).toBe(0);
    expect(index.get('rLegal000000000B')?.type).toBe('region');
    expect(index.get('fTenantName00001')?.type).toBe('form_field');
    expect(index.get('no-such-node')).toBeUndefined();
  });

  it('builds the region, definition and field indexes and keeps the comment ranges it opens with', () => {
    const anchor: ThreadAnchor = {
      id: uid(),
      author: 'carol',
      target: { block: INTRO },
      seq: 0,
      detached: false,
    };
    const r = open([], [anchor]);
    // Region ranges: the three regions of the fixture, one of them restricted (07 §5).
    expect(r.indexes.regionList().map((x) => x.id)).toEqual([
      'rTerms000000000A',
      'rLegal000000000B',
      'rNotes000000000C',
    ]);
    // Fields: the form field inside the restricted region is found in constant time (P7).
    expect(r.indexes.field('fTenantName00001')).toBeDefined();
    expect(r.indexes.fieldCount).toBe(1);
    // Definitions in use per region (07 §5.3): the restricted region uses the body style, and the
    // style it is based on; the terms region uses only the default paragraph style.
    const use = r.indexes.definitionUse(r.document);
    expect(use.get('rLegal000000000B')?.has('defs:style_def/LegalBody')).toBe(true);
    expect(use.get('rLegal000000000B')?.has('defs:style_def/Normal')).toBe(true);
    expect(use.get('rTerms000000000A')?.has('defs:style_def/LegalBody')).toBe(false);
    // Comment ranges: the anchor the room was given is held, attached, at the opening head.
    expect(r.threadCount).toBe(1);
    expect(r.threadAnchors()).toEqual([
      expect.objectContaining({ id: anchor.id, detached: false }),
    ]);
  });

  it('derives position maps back to maxRebaseSteps steps and refuses a base further back', () => {
    // 5,002 stored commits, each one step: the default window is 5,000 steps (03 §11; 06 §2.2).
    const N = 5002;
    const first = open([]);
    first.open('c1', USERS.carol);
    const stored: StoredCommit[] = [];
    for (let i = 0; i < N; i++) {
      const fx = first.submit('c1', {
        id: uid(),
        base: first.head,
        steps: insertAtIntro(),
      } as CommitInput);
      expect(fx.write).not.toBeNull();
      stored.push(...(fx.write?.commits ?? []));
      const done = first.writeCompleted({ status: 'ok' });
      expect(msgs(done, 'c1')[0]?.t).toBe('sync.ack');
    }
    expect(stored).toHaveLength(N);
    expect(stored[N - 1]?.seq).toBe(N);

    // The room opens from the stored log alone: its maps come from the stored steps.
    const second = open(stored);
    expect(second.head).toBe(N);
    second.open('c2', USERS.carol);

    // Base 2 is 5,000 steps back: inside the window, so it is rebased and stored.
    const inside = second.submit('c2', {
      id: uid(),
      base: 2,
      steps: insertAtIntro(),
    } as CommitInput);
    expect(inside.write).not.toBeNull();
    const ack = msgs(second.writeCompleted({ status: 'ok' }), 'c2')[0];
    expect(ack?.t === 'sync.ack' && ack.rebased).toBe(true);

    // Base 1 is 5,001 steps back: beyond the window, refused with stale_base.
    const beyond = second.submit('c2', {
      id: uid(),
      base: 1,
      steps: insertAtIntro(),
    } as CommitInput);
    expect(beyond.write).toBeNull();
    const reject = msgs(beyond, 'c2').find((m) => m.t === 'sync.reject');
    expect(reject && reject.t === 'sync.reject' ? reject.code : null).toBe('stale_base');
  }, 180_000);

  it('rebuilds the node index when the head moves, so it names the new content', () => {
    const r = open([]);
    r.open('c1', USERS.carol);
    const before = r.nodeIndex;
    r.submit('c1', { id: uid(), base: 0, steps: insertAtIntro() } as CommitInput);
    r.writeCompleted({ status: 'ok' });
    const after = r.nodeIndex;
    expect(after).not.toBe(before);
    // The intro paragraph grew by one character; its entry keeps its position and its size grows.
    expect(after.get(INTRO)?.pos).toBe(before.get(INTRO)?.pos);
    expect(after.get(INTRO)?.size).toBe((before.get(INTRO)?.size ?? 0) + 1);
    expect(after.get('rLegal000000000B')?.pos).toBe((before.get('rLegal000000000B')?.pos ?? 0) + 1);
  });
});
