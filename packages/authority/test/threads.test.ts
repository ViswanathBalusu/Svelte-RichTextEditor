// Comment threads as mapped ranges (ADR 0015; 07 §6, §12 rows 4 and 5; SYN-032, SYN-033,
// PRM-037 to PRM-040; ADR 0050 item 6), and through the projection gateway for read-restricted
// readers (ADR 0019 decision item 5).
import { canonicalize } from '@docedit/model';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceAroundStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { authoriseComment } from '../src/permissions/comments.ts';
import { computeAccess } from '../src/permissions/access.ts';
import { visibility } from '../src/permissions/visibility.ts';
import { ProjectionGateway } from '../src/projection/gateway.ts';
import { project } from '../src/projection/projection.ts';
import { mapRangesThrough } from '../src/ranges.ts';
import { DEFAULT_THREAD_LIMIT, Room, type RoomInit } from '../src/room/room.ts';
import type { StoredCommit } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  baseDoc,
  basePermissions,
  posInside,
  posOf,
  schema,
} from './fixtures.ts';
import { MORE, morePermissions } from './permission-fixtures.ts';

let counter = 0;
const uid = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;
let clock = 1_770_500_000_000;

function room(
  perms: PermissionState = morePermissions(),
  extra: Partial<RoomInit> = {},
  doc = baseDoc(),
) {
  return new Room({
    schema,
    initial: doc,
    requires: REQUIRES,
    log: [],
    perms,
    initialRevision: perms.revision,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
    ...extra,
  });
}

/** Submits a commit as `conn` on the head and stores it; returns the stored commit. */
function commit(r: Room, conn: Connection, steps: Step[]): StoredCommit {
  const channel = `w-${conn.sub}-${uid()}`;
  r.open(channel, conn);
  const fx = r.submit(channel, { id: uid(), base: r.head, steps: stepsToJson(steps) });
  const reject = fx.send.find((o) => o.msg.t === 'sync.reject');
  if (reject) throw new Error(JSON.stringify(reject.msg));
  const stored = fx.write!.commits[0]!;
  r.writeCompleted({ status: 'ok' });
  r.close(channel);
  return stored;
}

const typeAt = (doc: Node, at: string, text: string, offset = 0) => {
  const pos = posInside(doc, at, offset);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};
const rangeIn = (doc: Node, at: string, from: number, to: number) => {
  const start = posInside(doc, at);
  return { from: start + from, to: start + to };
};
const textOf = (doc: Node, r: { from: number; to: number }) => doc.textBetween(r.from, r.to);

describe('mapping a requested range from its base to the head (SYN-033; PRM-037)', () => {
  it('maps the range from baseSeq to the head, checks comment there, and changes nothing in the document', () => {
    const r = room();
    const base = r.document;
    const range = rangeIn(base, 'pIntro0000000001', 5, 14); // "agreement"
    commit(r, USERS.carol, [typeAt(base, 'pIntro0000000001', 'Hereby: ')]);
    const head = r.head;
    const json = canonicalize(r.document.toJSON());
    const o = r.createThread({
      id: uid(),
      as: MORE.cora,
      target: { range: { ...range, baseSeq: 0 } },
    });
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    expect(o.thread).toMatchObject({ seq: head, detached: false, author: 'cora' });
    expect('range' in o.thread.target && textOf(r.document, o.thread.target.range)).toBe(
      'agreement',
    );
    // Commenting never changes the document: no step, commit or seq (SYN-032 criterion 5).
    expect(r.head).toBe(head);
    expect(r.pendingCount).toBe(0);
    expect(canonicalize(r.document.toJSON())).toBe(json);
  });

  it('refuses a range that covers a scope where the caller lacks comment, at the head and now', () => {
    const r = room();
    const doc = r.document;
    // Rita is a viewer with an editor grant on Terms: she may comment there and nowhere else.
    const inTerms = rangeIn(doc, 'pTerms000000001A', 0, 4);
    expect(
      r.createThread({ id: uid(), as: MORE.rita, target: { range: { ...inTerms, baseSeq: 0 } } })
        .ok,
    ).toBe(true);
    const across = {
      from: posInside(doc, 'pIntro0000000001'),
      to: posInside(doc, 'pTerms000000001A', 4),
    };
    expect(
      r.createThread({ id: uid(), as: MORE.rita, target: { range: { ...across, baseSeq: 0 } } }),
    ).toMatchObject({
      ok: false,
      code: 'permission_denied',
      scopes: ['body'],
    });
    // The owner unwraps Terms after Rita's base: her range is now in the body, where she lacks
    // comment, and the check is made at the head.
    const at = posOf(doc, 'rTerms000000000A');
    const size = doc.nodeAt(at)!.nodeSize;
    commit(r, USERS.alice, [
      new ReplaceAroundStep(at, at + size, at + 1, at + size - 1, Slice.empty, 0, true),
    ]);
    expect(
      r.createThread({ id: uid(), as: MORE.rita, target: { range: { ...inTerms, baseSeq: 0 } } }),
    ).toMatchObject({
      ok: false,
      code: 'permission_denied',
      scopes: ['body'],
    });
  });

  it('needs only comment in the scope of a targeted block, and the block must exist at the head', () => {
    const r = room();
    const o = r.createThread({ id: uid(), as: MORE.rita, target: { block: 'pTerms000000002A' } });
    expect(o).toMatchObject({ ok: true, thread: { target: { block: 'pTerms000000002A' } } });
    expect(
      r.createThread({ id: uid(), as: MORE.rita, target: { block: 'pNoSuchBlock0001' } }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('refuses a baseSeq older than the rebase window, and a viewer altogether', () => {
    const r = room(morePermissions(), {
      limits: { maxStepsPerCommit: 500, maxCommitBytes: 1 << 20, maxRebaseSteps: 1 },
    });
    const base = r.document;
    commit(r, USERS.carol, [typeAt(base, 'pIntro0000000001', 'a')]);
    commit(r, USERS.carol, [typeAt(r.document, 'pIntro0000000001', 'b')]);
    const range = rangeIn(base, 'pIntro0000000001', 0, 4);
    expect(
      r.createThread({ id: uid(), as: MORE.cora, target: { range: { ...range, baseSeq: 0 } } }),
    ).toMatchObject({
      ok: false,
      code: 'stale_base',
    });
    expect(
      r.createThread({
        id: uid(),
        as: USERS.frank,
        target: { range: { ...rangeIn(r.document, 'pIntro0000000001', 0, 4), baseSeq: r.head } },
      }),
    ).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('needs comment in the scopes of the target to reply (07 §12 row 4)', () => {
    const r = room();
    const o = r.createThread({
      id: uid(),
      as: MORE.rita,
      target: { range: { ...rangeIn(r.document, 'pTerms000000001A', 0, 4), baseSeq: 0 } },
    });
    if (!o.ok) throw new Error(o.reason);
    expect(r.threadAccess(o.thread.id, MORE.cora, 'reply').ok).toBe(true);
    expect(r.threadAccess(o.thread.id, USERS.frank, 'reply')).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });
});

describe('mapping comment ranges through every commit (SYN-032)', () => {
  it('advances ranges with the durable state, and keeps a block target by its identifier', () => {
    const r = room();
    const doc = r.document;
    const t = r.createThread({
      id: uid(),
      as: MORE.cora,
      target: { range: { ...rangeIn(doc, 'pIntro0000000001', 5, 14), baseSeq: 0 } },
    });
    const b = r.createThread({ id: uid(), as: MORE.cora, target: { block: 'pMiddle000000001' } });
    if (!t.ok || !b.ok) throw new Error('not created');
    commit(r, USERS.carol, [typeAt(doc, 'pTitle0000000001', 'The ')]);
    // Move the targeted paragraph: delete it and insert it again before the title.
    const at = posOf(r.document, 'pMiddle000000001');
    const node = r.document.nodeAt(at)!;
    commit(r, USERS.carol, [
      new ReplaceStep(at, at + node.nodeSize, Slice.empty),
      new ReplaceStep(
        posOf(r.document, 'pTitle0000000001'),
        posOf(r.document, 'pTitle0000000001'),
        new Slice(Fragment.from(node), 0, 0),
      ),
    ]);
    const anchors = new Map(r.threadAnchors().map((a) => [a.id, a]));
    const range = anchors.get(t.thread.id)!;
    expect(range.seq).toBe(r.head);
    expect('range' in range.target && textOf(r.document, range.target.range)).toBe('agreement');
    expect(anchors.get(b.thread.id)).toMatchObject({
      detached: false,
      target: { block: 'pMiddle000000001' },
    });
    expect(r.threadScopes(b.thread.id)).toEqual(['body']);
  });

  it('collapses a range whose text is deleted, reports it detached, and keeps it so after an undo', () => {
    const r = room();
    const doc = r.document;
    const t = r.createThread({
      id: uid(),
      as: MORE.cora,
      target: { range: { ...rangeIn(doc, 'pTerms000000001A', 0, 4), baseSeq: 0 } },
    });
    if (!t.ok) throw new Error(t.reason);
    const from = posInside(doc, 'pTerms000000001A');
    const removed = doc.slice(from, from + 4);
    commit(r, USERS.carol, [new ReplaceStep(from, from + 4, Slice.empty)]);
    const after = r.threadAnchors()[0]!;
    expect(after).toMatchObject({ detached: true, scopes: ['region:rTerms000000000A'] });
    // The undo puts the text back; the range stays collapsed (ADR 0015).
    commit(r, USERS.carol, [new ReplaceStep(from, from, removed)]);
    const undone = r.threadAnchors()[0]!;
    expect(undone.detached).toBe(true);
    expect('range' in undone.target && undone.target.range.from === undone.target.range.to).toBe(
      true,
    );
    // Who may act on it follows the scopes it covered when last attached.
    expect(r.threadAccess(t.thread.id, MORE.rita, 'resolve').ok).toBe(true);
  });

  it('maps ranges and presence positions through stored commits with no document (mapRanges)', () => {
    const r = room();
    const doc = r.document;
    const observer = 'observer';
    r.open(observer, USERS.frank);
    const s1 = commit(r, USERS.carol, [typeAt(doc, 'pIntro0000000001', 'Hey ')]);
    const s2 = commit(r, USERS.carol, [typeAt(r.document, 'pTitle0000000001', 'A ')]);
    const range = rangeIn(doc, 'pIntro0000000001', 5, 14);
    const caret = { from: range.from, to: range.from };
    const [mapped, point] = mapRangesThrough([range, caret], [s1, s2], schema);
    expect(textOf(r.document, mapped!)).toBe('agreement');
    expect(point).toMatchObject({ collapsed: true });
    expect(point!.from).toBe(mapped!.from);
  });

  it('saves the anchors with the checkpoint before a snapshot, and a new room maps them on', () => {
    const r = room();
    const doc = r.document;
    const t = r.createThread({
      id: uid(),
      as: MORE.cora,
      target: { range: { ...rangeIn(doc, 'pIntro0000000001', 5, 14), baseSeq: 0 } },
    });
    if (!t.ok) throw new Error(t.reason);
    const fx = r.snapshot('control', {
      id: uid(),
      reason: 'restore',
      content: baseDoc(),
      checkpoint: 'ckpt-1',
      as: USERS.alice,
    });
    expect(fx.checkpoints?.[0]?.threads).toEqual([t.thread]);
    r.writeCompleted({ status: 'ok' });
    // Across a snapshot a range cannot follow: the thread is detached.
    expect(r.threadAnchors()[0]).toMatchObject({ detached: true });
    // A room started from a checkpoint and a log gets the anchors at their seq and maps them.
    const later = room();
    const c = commit(later, USERS.carol, [typeAt(later.document, 'pTitle0000000001', 'The ')]);
    const restarted = room(morePermissions(), { log: [c], threads: [t.thread] });
    const a = restarted.threadAnchors()[0]!;
    expect(a.seq).toBe(1);
    expect('range' in a.target && textOf(restarted.document, a.target.range)).toBe('agreement');
  });
});

describe('commenting never changes the document (PRM-038)', () => {
  it('works on a locked document, an approved region and under a workflow lock; not on an archived one', () => {
    const states: Array<[Partial<PermissionState>, boolean | string]> = [
      [{ documentState: 'locked' }, true],
      [{ regionStates: new Map([['rTerms000000000A', 'approved' as const]]) }, true],
      [{ documentState: 'locked', workflowActive: true }, true],
      [{ documentState: 'archived' }, 'read_only'],
    ];
    for (const [extra, expected] of states) {
      const r = room(morePermissions(extra));
      const o = r.createThread({
        id: uid(),
        as: MORE.cora,
        target: { range: { ...rangeIn(r.document, 'pTerms000000001A', 0, 4), baseSeq: 0 } },
      });
      if (expected === true) expect(o.ok, JSON.stringify(extra)).toBe(true);
      else expect(o).toMatchObject({ ok: false, code: expected });
    }
    // A commit from a connection that only comments is refused (P6).
    const r = room();
    r.open('k1', MORE.cora);
    const fx = r.submit('k1', {
      id: uid(),
      base: 0,
      steps: stepsToJson([typeAt(r.document, 'pIntro0000000001', 'x')]),
    });
    expect(fx.send.find((o) => o.msg.t === 'sync.reject')?.msg).toMatchObject({
      code: 'permission_denied',
    });
  });

  it('offers no way to move or re-point a thread', () => {
    const r = room();
    const o = r.createThread({ id: uid(), as: MORE.cora, target: { block: 'pMiddle000000001' } });
    if (!o.ok) throw new Error(o.reason);
    for (const who of [USERS.alice, USERS.carol, MORE.cora])
      expect(r.threadAccess(o.thread.id, who, 'retarget')).toMatchObject({
        ok: false,
        code: 'permission_denied',
      });
  });
});

describe('resolving, reopening, assigning and deleting threads (PRM-039)', () => {
  it('needs comment in the thread’s scopes to resolve, reopen or assign; deleting needs the author or manage', () => {
    const r = room();
    const o = r.createThread({
      id: uid(),
      as: MORE.rita,
      target: { range: { ...rangeIn(r.document, 'pTerms000000001A', 0, 4), baseSeq: 0 } },
    });
    if (!o.ok) throw new Error(o.reason);
    for (const action of ['resolve', 'reopen', 'assign'] as const) {
      expect(r.threadAccess(o.thread.id, MORE.cora, action).ok, action).toBe(true);
      expect(r.threadAccess(o.thread.id, USERS.frank, action), action).toMatchObject({
        ok: false,
        code: 'permission_denied',
      });
    }
    expect(r.threadAccess(o.thread.id, MORE.cora, 'delete')).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    expect(r.threadAccess(o.thread.id, MORE.rita, 'delete').ok).toBe(true);
    expect(r.threadAccess(o.thread.id, USERS.alice, 'delete').ok).toBe(true);
    expect(r.deleteThread(o.thread.id)).toBe(true);
    expect(r.threadAccess(o.thread.id, USERS.alice, 'read')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('lets only a comment’s author or a holder of manage edit or delete it', () => {
    const scopes = ['body'];
    const ctx = (conn: Connection) => ({
      access: computeAccess(conn, [], morePermissions(), 0),
      user: conn.sub,
      scopes,
      archived: false,
      commentAuthor: 'cora',
    });
    expect(authoriseComment(ctx(MORE.cora), 'edit').ok).toBe(true);
    expect(authoriseComment(ctx(USERS.carol), 'delete')).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    expect(authoriseComment(ctx(USERS.alice), 'delete').ok).toBe(true);
  });

  it('resolves on a locked document and in an approved region', () => {
    const r = room(
      morePermissions({
        documentState: 'locked',
        regionStates: new Map([['rTerms000000000A', 'approved' as const]]),
      }),
    );
    const o = r.createThread({
      id: uid(),
      as: MORE.cora,
      target: { range: { ...rangeIn(r.document, 'pTerms000000001A', 0, 4), baseSeq: 0 } },
    });
    if (!o.ok) throw new Error(o.reason);
    expect(r.threadAccess(o.thread.id, MORE.cora, 'resolve').ok).toBe(true);
  });
});

describe('the thread limit (PRM-040)', () => {
  it(`accepts up to ${DEFAULT_THREAD_LIMIT} threads, refuses the next with quota_exceeded, and still lets threads be answered`, () => {
    const r = room();
    const range = { ...rangeIn(r.document, 'pIntro0000000001', 0, 4), baseSeq: 0 };
    let first = '';
    for (let i = 0; i < DEFAULT_THREAD_LIMIT; i++) {
      const o = r.createThread({ id: uid(), as: MORE.cora, target: { range } });
      if (!o.ok) throw new Error(`thread ${i}: ${o.reason}`);
      if (i === 0) first = o.thread.id;
    }
    expect(r.threadCount).toBe(DEFAULT_THREAD_LIMIT);
    expect(r.createThread({ id: uid(), as: MORE.cora, target: { range } })).toMatchObject({
      ok: false,
      code: 'quota_exceeded',
    });
    expect(r.threadCount).toBe(DEFAULT_THREAD_LIMIT);
    for (const action of ['reply', 'resolve', 'reopen'] as const)
      expect(r.threadAccess(first, MORE.cora, action).ok).toBe(true);
  });
});

describe('threads for read-restricted readers (ADR 0019; PRM-037, PRM-039)', () => {
  const now = () => 1_770_600_000_000;
  const confidential = () => {
    const json = structuredClone(BASE_JSON) as unknown as {
      content: Array<{ content: Array<Record<string, unknown>> }>;
    };
    for (const b of json.content[1]!.content)
      if ((b['attrs'] as Record<string, unknown> | undefined)?.['id'] === 'rLegal000000000B')
        (b['attrs'] as Record<string, unknown>)['policy'] = 'confidential';
    return schema.nodeFromJSON(json);
  };
  const setup = () => {
    const doc = confidential();
    const r = new Room({
      schema,
      initial: doc,
      requires: REQUIRES,
      log: [],
      perms: basePermissions(),
      initialRevision: 1,
      epoch: 1,
      incarnation: 'inc-1',
      now,
    });
    const g = new ProjectionGateway(r, schema, visibility(now));
    return { r, g, doc };
  };

  it('maps a reader’s projected range to full positions and back, and refuses a range over a placeholder', () => {
    const { g, doc } = setup();
    const hidden = {
      regions: new Set(['rLegal000000000B']),
      values: new Set<string>(),
      titles: false,
    };
    const view = project(doc, hidden).doc;
    const after = posInside(view, 'pAfter0000000001');
    const o = g.createThread({
      id: uid(),
      as: USERS.carol,
      target: { range: { from: after, to: after + 5, baseSeq: 0 } },
    });
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok || !('range' in o.thread.target)) return;
    expect(view.textBetween(o.thread.target.range.from, o.thread.target.range.to)).toBe('After');
    const legal = posOf(view, 'rLegal000000000B');
    expect(
      g.createThread({
        id: uid(),
        as: USERS.carol,
        target: { range: { from: legal - 3, to: legal + 3, baseSeq: 0 } },
      }),
    ).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('hides threads in hidden content: not listed and not_found for readers without access', () => {
    const { g, doc } = setup();
    const inLegal = rangeIn(doc, 'pLegal000000001B', 0, 9);
    const o = g.createThread({
      id: uid(),
      as: USERS.bob,
      target: { range: { ...inLegal, baseSeq: 0 } },
    });
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    expect(g.threadsFor(USERS.bob).map((t) => t.id)).toContain(o.thread.id);
    expect(g.threadsFor(USERS.carol).map((t) => t.id)).not.toContain(o.thread.id);
    expect(g.threadAccess(o.thread.id, USERS.carol, 'reply')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(g.threadAccess(o.thread.id, USERS.carol, 'delete')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
