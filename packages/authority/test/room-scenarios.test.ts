// The authority algorithm of 04 §5, rule by rule, through the room (SYN-003 to SYN-016) and the
// outcome check as the room calls it (PRM-009, PRM-010). room.test.ts holds the spike's scenarios;
// these complete the stories' criteria.
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
import { CLIENT_ORIGINS, type Limits } from '../src/codes.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { CommitInput, Effects, StoredCommit, ToClient } from '../src/room/types.ts';
import { commitBytes, stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';

let clock = 1_770_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
    ...extra,
  });
}

const json = (steps: Step[]) => stepsToJson(steps);
const insertAt = (doc = baseDoc(), at = 'pIntro0000000001', text = 'x', offset = 0) => {
  const pos = posInside(doc, at, offset);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};
const insert = (doc = baseDoc(), at = 'pIntro0000000001', text = 'x') =>
  json([insertAt(doc, at, text)]);
/** Several insertions in one commit, each step made on the document after the ones before it. */
function inserts(...targets: Array<[string, string]>): ReturnType<typeof json> {
  const tr = new Transform(baseDoc());
  for (const [at, text] of targets) tr.insert(posInside(tr.doc, at), schema.text(text));
  return json(tr.steps);
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}
function rejectOf(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}
function ackOf(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.ack');
  return m && m.t === 'sync.ack' ? m : null;
}
/** Stores whatever the room wants to write, and returns everything sent. */
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
/** The commits the room has stored, from its broadcasts to an observer channel. */
function stored(fx: Effects, observer: string): StoredCommit[] {
  return msgs(fx, observer).flatMap((m) => (m.t === 'sync.commit' ? [m.commit] : []));
}

const conn = (
  sub: string,
  role: Connection['role'],
  extra: Partial<Connection> = {},
): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
  ...extra,
});

describe('step commits: shape, limits and the allow-list (SYN-003)', () => {
  it('refuses a commit with no steps, and never stores it as a control commit', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const fx = r.submit('c1', { id: id(), base: 0, steps: [] });
    expect(rejectOf(fx, 'c1')).toMatchObject({ code: 'invalid_op', action: 'drop' });
    expect(fx.write).toBeNull();
    expect(r.pendingCount).toBe(0);
    expect(r.head).toBe(0);
  });

  it('refuses the whole commit when one step type is not allowed', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const steps = [...insert(), { stepType: 'docAttr', attr: 'x', value: 1 }];
    const fx = r.submit('c1', { id: id(), base: 0, steps });
    expect(rejectOf(fx, 'c1')?.code).toBe('invalid_op');
    expect(fx.write).toBeNull();
    expect(r.document.eq(baseDoc())).toBe(true);
  });

  it('uses exactly the configured limits for steps and bytes', () => {
    const two = inserts(['pIntro0000000001', 'x'], ['pMiddle000000001', 'y']);
    const commit: CommitInput = { id: id(), base: 0, steps: two };
    const bytes = commitBytes(commit);
    const at = (limits: Limits) => {
      const r = room({ limits });
      r.open('c1', USERS.carol);
      return rejectOf(r.submit('c1', commit), 'c1');
    };
    expect(at({ maxStepsPerCommit: 2, maxCommitBytes: bytes, maxRebaseSteps: 5000 })).toBeNull();
    expect(at({ maxStepsPerCommit: 1, maxCommitBytes: bytes, maxRebaseSteps: 5000 })?.code).toBe(
      'too_large',
    );
    expect(
      at({ maxStepsPerCommit: 2, maxCommitBytes: bytes - 1, maxRebaseSteps: 5000 })?.code,
    ).toBe('too_large');
  });

  it('treats every client origin alike and records it unchanged as the client claim', () => {
    for (const origin of CLIENT_ORIGINS) {
      const r = room();
      r.open('c1', USERS.carol);
      r.open('a1', USERS.alice);
      const ok = flush(r, r.submit('c1', { id: id(), base: 0, steps: insert(), origin }));
      expect(ackOf(ok, 'c1'), origin).not.toBeNull();
      expect(stored(ok, 'a1')[0]?.origin, origin).toBe(origin);
      const denied = r.submit('c1', {
        id: id(),
        base: 1,
        steps: insert(r.document, 'pLegal000000001B'),
        origin,
      });
      expect(rejectOf(denied, 'c1')?.code, origin).toBe('permission_denied');
    }
  });
});

describe('control commits (SYN-004)', () => {
  it('orders control commits and content commits exactly as the room applied them', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('a1', USERS.alice);
    // A content commit waits for storage, then a grants change arrives: the control commit follows.
    let fx = r.submit('c1', { id: id(), base: 0, steps: insert() });
    const change = r.permissionsChanged({ ...basePermissions(), revision: 2 });
    fx = { send: [...fx.send, ...change.send], write: fx.write };
    const first = stored(flush(r, fx), 'a1');
    expect(first.map((c) => [c.seq, c.kind])).toEqual([
      [1, 'steps'],
      [2, 'control'],
    ]);
    // A grants change first, then a content commit: the control commit comes first.
    const second = flush(r, r.permissionsChanged({ ...basePermissions(), revision: 3 }));
    const content = flush(r, r.submit('c1', { id: id(), base: 3, steps: insert(r.document) }));
    expect([...stored(second, 'a1'), ...stored(content, 'a1')].map((c) => [c.seq, c.kind])).toEqual(
      [
        [3, 'control'],
        [4, 'steps'],
      ],
    );
  });

  it('broadcasts a stored control commit to every subscriber, with no steps', () => {
    const r = room();
    for (const [ch, u] of [
      ['a1', USERS.alice],
      ['c1', USERS.carol],
      ['f1', USERS.frank],
    ] as const)
      r.open(ch, u);
    const fx = flush(r, r.permissionsChanged({ ...basePermissions(), revision: 2 }));
    for (const ch of ['a1', 'c1', 'f1']) {
      const commits = stored(fx, ch);
      expect(
        commits.map((c) => [c.kind, c.seq, c.steps.length]),
        ch,
      ).toEqual([['control', 1, 0]]);
    }
  });

  it('lets no client message create a control commit', () => {
    const r = room();
    r.open('c1', USERS.carol);
    for (const origin of ['control', 'restore', 'import', 'migration', 'repair', 'sign', 'rules'])
      expect(
        rejectOf(r.submit('c1', { id: id(), base: 0, steps: insert(), origin }), 'c1')?.code,
      ).toBe('invalid_op');
    expect(r.pendingCount).toBe(0);
  });
});

describe('one at a time, against durable and tentative state (SYN-006)', () => {
  it('orders submissions from different channels by arrival, from seq 1, with no gaps', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);
    r.open('a1', USERS.alice);
    const one = r.submit('c1', {
      id: id(),
      base: 0,
      steps: insert(baseDoc(), 'pIntro0000000001', 'C'),
    });
    const two = r.submit('b1', {
      id: id(),
      base: 0,
      steps: insert(baseDoc(), 'pMiddle000000001', 'B'),
    });
    // Both wait for storage; the durable state is still the document at seq 0.
    expect(r.pendingCount).toBe(2);
    expect(r.head).toBe(0);
    expect(r.document.eq(baseDoc())).toBe(true);
    const all = flush(r, { send: [...one.send, ...two.send], write: one.write });
    expect(stored(all, 'a1').map((c) => [c.seq, c.user])).toEqual([
      [1, 'carol'],
      [2, 'bob'],
    ]);
    expect(r.head).toBe(2);
  });
});

describe('authorise, and one commit in flight (SYN-007)', () => {
  it('refuses a connection that can only view or comment with permission_denied and drop', () => {
    for (const u of [USERS.frank, conn('cora', 'commenter')]) {
      const r = room();
      r.open('x1', u);
      expect(rejectOf(r.submit('x1', { id: id(), base: 0, steps: insert() }), 'x1')).toMatchObject({
        code: 'permission_denied',
        action: 'drop',
        head: 0,
      });
    }
  });

  it('refuses on an archived document with read_only and drop', () => {
    const r = room();
    r.open('c1', USERS.carol);
    flush(
      r,
      r.permissionsChanged({ ...basePermissions(), revision: 2, documentState: 'archived' }),
    );
    expect(rejectOf(r.submit('c1', { id: id(), base: 1, steps: insert() }), 'c1')).toMatchObject({
      code: 'read_only',
      action: 'drop',
    });
  });

  it('answers a second submission in flight with busy and retry, and leaves the first alone', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const first = r.submit('c1', { id: id(), base: 0, steps: insert() });
    expect(rejectOf(r.submit('c1', { id: id(), base: 0, steps: insert() }), 'c1')).toMatchObject({
      code: 'busy',
      action: 'retry',
      head: 0,
    });
    expect(ackOf(flush(r, first), 'c1')?.seq).toBe(1);
  });

  it('puts the current head on every rejection', () => {
    const r = room();
    r.open('c1', USERS.carol);
    flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }));
    const cases: CommitInput[] = [
      { id: 'nope', base: 1, steps: insert(r.document) },
      { id: id(), base: 9, steps: insert(r.document) },
      { id: id(), base: 1, steps: [] },
      { id: id(), base: 1, steps: insert(r.document, 'pLegal000000001B') },
      { id: id(), base: 1, steps: [{ stepType: 'nope' }] },
    ];
    for (const c of cases)
      expect(rejectOf(r.submit('c1', c), 'c1')?.head, JSON.stringify(c)).toBe(1);
  });
});

describe('deduplication (SYN-008)', () => {
  it('attaches a resubmission from a second channel to the pending acknowledgement: both get the same seq', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('c2', { ...USERS.carol, session: 's-carol-2' });
    const commit: CommitInput = { id: id(), base: 0, steps: insert() };
    const fx = r.submit('c1', commit);
    expect(r.submit('c2', commit).send).toEqual([]);
    const done = flush(r, fx);
    expect(ackOf(done, 'c1')?.seq).toBe(1);
    expect(ackOf(done, 'c2')?.seq).toBe(1);
    expect(ackOf(done, 'c2')?.steps).toBeDefined(); // a rebuilt acknowledgement carries the steps
    expect(r.head).toBe(1);
  });

  it("refuses another user's identifier while it waits, and leaves the commit unchanged", () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('m1', USERS.mallory);
    r.open('a1', USERS.alice);
    const commit: CommitInput = {
      id: id(),
      base: 0,
      steps: insert(baseDoc(), 'pIntro0000000001', 'mine'),
    };
    const fx = r.submit('c1', commit);
    const evil = { ...commit, steps: insert(baseDoc(), 'pIntro0000000001', 'evil') };
    expect(rejectOf(r.submit('m1', evil), 'm1')?.code).toBe('invalid_op');
    const done = flush(r, fx);
    const [c] = stored(done, 'a1');
    expect(c?.user).toBe('carol');
    expect(r.document.textContent).toContain('mine');
    expect(r.document.textContent).not.toContain('evil');
  });

  it('stores one copy when a user sends the same identifier twice in quick succession', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('c2', { ...USERS.carol, session: 's-carol-2' });
    r.open('a1', USERS.alice);
    const commit: CommitInput = { id: id(), base: 0, steps: insert() };
    const fx = r.submit('c1', commit);
    expect(rejectOf(r.submit('c1', commit), 'c1')?.code).toBe('busy');
    r.submit('c2', commit);
    expect(stored(flush(r, fx), 'a1')).toHaveLength(1);
    expect(r.head).toBe(1);
  });
});

describe('impossible or distant bases (SYN-009)', () => {
  it('consumes no seq for a rejected base', () => {
    const r = room({
      limits: { maxStepsPerCommit: 500, maxCommitBytes: 1 << 20, maxRebaseSteps: 1 },
    });
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);
    r.open('a1', USERS.alice);
    flush(
      r,
      r.submit('c1', { id: id(), base: 0, steps: insert(baseDoc(), 'pIntro0000000001', 'a') }),
    );
    flush(
      r,
      r.submit('c1', { id: id(), base: 1, steps: insert(r.document, 'pIntro0000000001', 'b') }),
    );
    expect(rejectOf(r.submit('b1', { id: id(), base: 0, steps: insert() }), 'b1')?.code).toBe(
      'stale_base',
    );
    expect(rejectOf(r.submit('b1', { id: id(), base: 7, steps: insert() }), 'b1')?.code).toBe(
      'invalid_op',
    );
    const next = flush(r, r.submit('b1', { id: id(), base: 2, steps: insert(r.document) }));
    expect(ackOf(next, 'b1')?.seq).toBe(3);
  });
});

describe('rebase (SYN-010)', () => {
  it('rejects the whole commit with rebase_failed when a step maps to nothing, applying nothing', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);
    // Carol deletes the first five characters of the intro; Bob, on the old base, bolds them.
    const start = posInside(baseDoc(), 'pIntro0000000001');
    flush(
      r,
      r.submit('c1', {
        id: id(),
        base: 0,
        steps: json([new ReplaceStep(start, start + 5, Slice.empty)]),
      }),
    );
    const before = r.document;
    const bold = new AddMarkStep(start, start + 5, schema.marks['bold']!.create());
    const insertOk = insertAt(baseDoc(), 'pMiddle000000001', 'kept?');
    const fx = r.submit('b1', { id: id(), base: 0, steps: json([insertOk, bold]) });
    expect(rejectOf(fx, 'b1')).toMatchObject({ code: 'rebase_failed', action: 'rebase', head: 1 });
    expect(fx.write).toBeNull();
    expect(r.document).toBe(before);
    expect(r.document.textContent).not.toContain('kept?');
  });

  it('gains a client nothing to send steps inconsistent with its base: the mapped steps are checked', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('m1', USERS.mallory);
    flush(
      r,
      r.submit('c1', { id: id(), base: 0, steps: insert(baseDoc(), 'pIntro0000000001', 'AAAA') }),
    );
    // Mallory claims base 0 but aims at positions of the current document, just before the
    // restricted region: mapped from base 0, the insertion lands inside the restricted paragraph.
    const target = posInside(r.document, 'pLegal000000001B') - 4;
    const step = new ReplaceStep(
      target,
      target,
      new Slice(Fragment.from(schema.text('pwned')), 0, 0),
    );
    const fx = r.submit('m1', { id: id(), base: 0, steps: json([step]) });
    expect(rejectOf(fx, 'm1')).toMatchObject({
      code: 'permission_denied',
      scopes: ['region:rLegal000000000B'],
    });
  });
});

describe('apply and invariants (SYN-011, SYN-012)', () => {
  it('rejects a step that fails to apply with invalid_op and validates the next submission against the same state', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const size = baseDoc().content.size;
    const bad = r.submit('c1', {
      id: id(),
      base: 0,
      steps: json([insertAt()]).concat([{ stepType: 'replace', from: size - 1, to: size + 9 }]),
    });
    expect(rejectOf(bad, 'c1')).toMatchObject({ code: 'invalid_op', head: 0 });
    expect(r.document.eq(baseDoc())).toBe(true);
    expect(ackOf(flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() })), 'c1')?.seq).toBe(
      1,
    );
  });

  /** A commit by Alice (owner, so the outcome check never decides) that breaks one invariant. */
  const cases: Array<[string, (doc: ReturnType<typeof baseDoc>) => Step[], Partial<RoomInit>?]> = [
    [
      'I1 (a node of a feature that requires does not list)',
      (doc) => {
        const at = posInside(doc, 'pIntro0000000001');
        const atom = schema.nodes['preserved_inline']!.create({
          label: 'box',
          fragment: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
        });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(atom), 0, 0))];
      },
    ],
    [
      'I2 (two nodes share an identifier)',
      (doc) => {
        const at = posOf(doc, 'pEnd00000000001Z');
        const copy = schema.nodeFromJSON({ type: 'paragraph', attrs: { id: 'pIntro0000000001' } });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(copy), 0, 0))];
      },
    ],
    [
      'I3 (a region inside a table cell)',
      (doc) => {
        const at = posOf(doc, 'pEnd00000000001Z');
        const table = schema.nodeFromJSON({
          type: 'table',
          attrs: { id: 'tTable0000000001', grid: [1000] },
          content: [
            {
              type: 'table_row',
              attrs: { id: 'trRow0000000001' },
              content: [
                {
                  type: 'table_cell',
                  attrs: { id: 'tcCell000000001' },
                  content: [{ type: 'paragraph', attrs: { id: 'pCell00000000001' } }],
                },
              ],
            },
          ],
        });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(table), 0, 0))];
      },
    ],
    [
      'I4 (a style that does not exist)',
      (doc) => [new AttrStep(posOf(doc, 'pIntro0000000001'), 'style', 'Missing')],
    ],
    ['I5 (a basedOn cycle)', (doc) => [new AttrStep(posOf(doc, 'Normal'), 'basedOn', 'LegalBody')]],
    [
      'I6 (a row that does not cover the grid)',
      (doc) => {
        const at = posOf(doc, 'pEnd00000000001Z');
        const table = schema.nodeFromJSON({
          type: 'table',
          attrs: { id: 'tTable0000000001', grid: [1000, 1000] },
          content: [
            {
              type: 'table_row',
              attrs: { id: 'trRow0000000001' },
              content: [
                {
                  type: 'table_cell',
                  attrs: { id: 'tcCell000000001' },
                  content: [{ type: 'paragraph', attrs: { id: 'pCell00000000001' } }],
                },
              ],
            },
          ],
        });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(table), 0, 0))];
      },
    ],
    [
      'I7 (more than 500 regions)',
      (doc) => {
        const at = posOf(doc, 'pEnd00000000001Z');
        const regions = Array.from({ length: 498 }, (_, i) =>
          schema.nodeFromJSON({
            type: 'region',
            attrs: { id: `r${String(i).padStart(15, '0')}` },
            content: [{ type: 'paragraph', attrs: { id: `p${String(i).padStart(15, '0')}` } }],
          }),
        );
        return [new ReplaceStep(at, at, new Slice(Fragment.from(regions), 0, 0))];
      },
    ],
    [
      'I8 (LaTeX the math gate refuses)',
      (doc) => {
        const at = posInside(doc, 'pIntro0000000001');
        const eq = schema.nodes['equation']!.create({ latex: '\\input{/etc/passwd}' });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(eq), 0, 0))];
      },
      { mathGate: (l: string) => (l.includes('\\input') ? '\\input is not allowed' : null) },
    ],
    [
      'I9 (a link scheme that is not allowed)',
      (doc) => {
        const at = posInside(doc, 'pIntro0000000001');
        return [
          new AddMarkStep(
            at,
            at + 4,
            schema.marks['link']!.create({ href: 'javascript:alert(1)' }),
          ),
        ];
      },
    ],
    [
      'I10 (a page break inside a table cell)',
      (doc) => {
        const at = posOf(doc, 'pEnd00000000001Z');
        const table = schema.nodeFromJSON({
          type: 'table',
          attrs: { id: 'tTable0000000001', grid: [1000] },
          content: [
            {
              type: 'table_row',
              attrs: { id: 'trRow0000000001' },
              content: [
                {
                  type: 'table_cell',
                  attrs: { id: 'tcCell000000001' },
                  content: [
                    {
                      type: 'paragraph',
                      attrs: { id: 'pCell00000000001' },
                      content: [{ type: 'break', attrs: { kind: 'page' } }],
                    },
                  ],
                },
              ],
            },
          ],
        });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(table), 0, 0))];
      },
    ],
    [
      'I11 (a colour in lower case)',
      (doc) => [new AttrStep(posOf(doc, 'LegalBody'), 'color', '#ff0000')],
    ],
    [
      'I12 (an extension payload over 16 KiB)',
      (doc) => {
        const at = posOf(doc, 'pEnd00000000001Z');
        const block = schema.nodes['extension_block']!.create({
          id: 'xBlock0000000001',
          extension: 'com.example.big',
          payload: { data: 'x'.repeat(17_000) },
        });
        return [new ReplaceStep(at, at, new Slice(Fragment.from(block), 0, 0))];
      },
      { requires: ['fields', 'extensions'] },
    ],
  ];
  it.each(cases)('rejects a result that violates %s with invalid_op', (_name, make, init) => {
    const r = room(init ?? {});
    r.open('a1', USERS.alice);
    const fx = r.submit('a1', { id: id(), base: 0, steps: json(make(baseDoc())) });
    const rej = rejectOf(fx, 'a1');
    expect(rej?.code).toBe('invalid_op');
    // The steps applied; the invariant check refused the result. I9 and I12, and the latex and
    // column limits of I7, are attribute grammars and are reported as I11.
    expect(rej?.reason).toMatch(/^I\d+ /);
    expect(fx.write).toBeNull();
  });

  it('I3: rejects re-creating a region whose identifier was retired', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const doc = baseDoc();
    const at = posOf(doc, 'rNotes000000000C');
    const region = doc.nodeAt(at)!;
    flush(
      r,
      r.submit('a1', {
        id: id(),
        base: 0,
        steps: json([new ReplaceStep(at, at + region.nodeSize, Slice.empty)]),
      }),
    );
    const end = posOf(r.document, 'pEnd00000000001Z');
    const back = new ReplaceStep(end, end, new Slice(Fragment.from(region), 0, 0));
    expect(rejectOf(r.submit('a1', { id: id(), base: 1, steps: json([back]) }), 'a1')?.code).toBe(
      'invalid_op',
    );
  });

  it('I13: rejects a duplicate field key, an assignee that is no role, and deleting a role still used', () => {
    const doc = baseDoc();
    const field = schema.nodes['form_field']!.create({
      id: 'fAnotherField001',
      key: 'tenant.name',
      label: 'Again',
    });
    const at = posInside(doc, 'pIntro0000000001');
    const role = posOf(doc, 'role_tenant');
    const steps: Step[][] = [
      [new ReplaceStep(at, at, new Slice(Fragment.from(field), 0, 0))],
      [new AttrStep(posOf(doc, 'fTenantName00001'), 'assignee', 'role_nobody')],
      [new ReplaceStep(role, role + doc.nodeAt(role)!.nodeSize, Slice.empty)],
    ];
    for (const s of steps) {
      const r = room();
      r.open('a1', USERS.alice);
      expect(rejectOf(r.submit('a1', { id: id(), base: 0, steps: json(s) }), 'a1')?.code).toBe(
        'invalid_op',
      );
    }
  });

  it('checks the result of all seven step types, including those with empty position maps', () => {
    const doc = baseDoc();
    const p = posOf(doc, 'pIntro0000000001');
    const t0 = posInside(doc, 'pIntro0000000001');
    const region = posOf(doc, 'rTerms000000000A');
    const del = schema.marks['del']!.create({ id: 'sSuggestion00001', user: 'alice' });
    const wrapped = (() => {
      // A replaceAround that rewraps the paragraph with a style that does not exist (I4).
      const node = doc.nodeAt(p)!;
      const copy = schema.nodes['paragraph']!.create({ ...node.attrs, style: 'Missing' });
      return new ReplaceAroundStep(
        p,
        p + node.nodeSize,
        p + 1,
        p + node.nodeSize - 1,
        new Slice(Fragment.from(copy), 0, 0),
        1,
        true,
      );
    })();
    const link = schema.marks['link']!.create({ href: 'javascript:x' });
    const violating: Array<[string, Step[]]> = [
      [
        'replace',
        [
          new ReplaceStep(
            t0,
            t0,
            new Slice(
              Fragment.from(
                schema.nodes['preserved_inline']!.create({
                  label: 'x',
                  fragment: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
                }),
              ),
              0,
              0,
            ),
          ),
        ],
      ],
      ['replaceAround', [wrapped]],
      ['addMark', [new AddMarkStep(t0, t0 + 3, link)]],
      ['addNodeMark', [new AddNodeMarkStep(region, del)]], // node marks only on paragraphs, rows and tables
      ['attr', [new AttrStep(p, 'style', 'Missing')]],
      // Removing a mark cannot break a valid document; a commit that ends with a removal is still
      // validated in full, so a violation made earlier in the same commit is caught.
      [
        'removeMark',
        [
          new AddMarkStep(t0, t0 + 3, link),
          new RemoveMarkStep(t0, t0 + 3, schema.marks['bold']!.create()),
        ],
      ],
      [
        'removeNodeMark',
        [
          new AttrStep(p, 'style', 'Missing'),
          new AddNodeMarkStep(p, del),
          new RemoveNodeMarkStep(p, del),
        ],
      ],
    ];
    for (const [type, steps] of violating) {
      const r = room();
      r.open('a1', USERS.alice);
      const fx = r.submit('a1', { id: id(), base: 0, steps: json(steps) });
      expect(rejectOf(fx, 'a1')?.code, type).toBe('invalid_op');
      expect(rejectOf(fx, 'a1')?.reason, type).toMatch(/^I\d+ /); // the invariants, not apply
    }
  });
});

describe('the outcome check and the grants revision (SYN-013, PRM-009)', () => {
  // Alma is a commenter with an editor grant on the Terms region only.
  const alma = conn('alma', 'commenter');
  const almaPerms = (): PermissionState => ({
    ...basePermissions(),
    grants: [
      ...basePermissions().grants,
      { region: 'rTerms000000000A', principal: 'user:alma', role: 'editor', expiresAt: null },
    ],
  });

  it('accepts a commit that changes only the one region the user may edit', () => {
    const r = room({ perms: almaPerms() });
    r.open('x1', alma);
    r.open('a1', USERS.alice);
    const done = flush(
      r,
      r.submit('x1', { id: id(), base: 0, steps: insert(baseDoc(), 'pTerms000000001A') }),
    );
    expect(ackOf(done, 'x1')?.seq).toBe(1);
    expect(stored(done, 'a1')[0]).toMatchObject({
      scopes: ['region:rTerms000000000A'],
      revision: 1,
    });
  });

  it('refuses a commit that changes a writable and a non-writable region, naming only the latter', () => {
    const r = room({ perms: almaPerms() });
    r.open('x1', alma);
    const steps = inserts(['pTerms000000001A', 'mine '], ['pNotes000000001C', 'theirs ']);
    const fx = r.submit('x1', { id: id(), base: 0, steps });
    expect(rejectOf(fx, 'x1')).toMatchObject({
      code: 'permission_denied',
      action: 'drop',
      head: 0,
      scopes: ['region:rNotes000000000C'],
    });
    expect(fx.write).toBeNull();
    expect(r.pendingCount).toBe(0);
    expect(r.document.eq(baseDoc())).toBe(true);
  });

  it('checks a rebased commit against the permissions in force now, not at its base', () => {
    const r = room();
    r.open('b1', USERS.bob);
    // Bob edited the legal region under revision 1; the grant is revoked before his commit arrives.
    flush(r, r.permissionsChanged({ ...basePermissions(), revision: 2, grants: [] }));
    const fx = r.submit('b1', { id: id(), base: 0, steps: insert(baseDoc(), 'pLegal000000001B') });
    expect(rejectOf(fx, 'b1')).toMatchObject({
      code: 'permission_denied',
      scopes: ['region:rLegal000000000B'],
    });
  });

  it("checks a rebased commit against the document now: another user's structural change counts", () => {
    const r = room();
    r.open('a1', USERS.alice);
    r.open('c1', USERS.carol);
    // Alice wraps the intro paragraph in a new restricted region.
    const tr = new Transform(baseDoc());
    const $p = tr.doc.resolve(posInside(tr.doc, 'pIntro0000000001'));
    tr.wrap($p.blockRange()!, [
      { type: schema.nodes['region']!, attrs: { id: 'rWrapped0000000W', policy: 'restricted' } },
    ]);
    expect(
      ackOf(flush(r, r.submit('a1', { id: id(), base: 0, steps: json(tr.steps) })), 'a1'),
    ).not.toBeNull();
    // Carol, still on the old base, types into the intro: after rebasing it is inside the new region.
    const fx = r.submit('c1', { id: id(), base: 0, steps: insert(baseDoc(), 'pIntro0000000001') });
    expect(rejectOf(fx, 'c1')).toMatchObject({
      code: 'permission_denied',
      scopes: ['region:rWrapped0000000W'],
    });
  });

  it('stamps the scopes the check found and the grants revision it used (PRM-009, SYN-014)', () => {
    const r = room({ perms: { ...basePermissions(), revision: 7 }, initialRevision: 7 });
    r.open('c1', USERS.carol);
    r.open('a1', USERS.alice);
    const steps = inserts(['pIntro0000000001', 'x'], ['pTerms000000001A', 'y']);
    const done = flush(r, r.submit('c1', { id: id(), base: 0, steps }));
    expect(stored(done, 'a1')[0]).toMatchObject({
      scopes: ['body', 'region:rTerms000000000A'],
      revision: 7,
      cdm: 1,
      engine: 'pm-steps/1',
    });
  });
});

describe('attribution (SYN-014)', () => {
  it('stamps user, session and server time from the connection and the clock, ignoring claims', () => {
    let t = 1_780_000_000_000;
    const r = room({ now: () => t });
    r.open('c1', USERS.carol);
    r.open('a1', USERS.alice);
    t = 1_780_000_000_123;
    const forged = {
      id: id(),
      base: 0,
      steps: insert(),
      user: 'alice',
      session: 's-alice',
      agent: 'bot',
      time: 0,
      serverTime: 0,
    } as unknown as CommitInput;
    const [c] = stored(flush(r, r.submit('c1', forged)), 'a1');
    expect(c).toMatchObject({ user: 'carol', session: 's-carol', time: 1_780_000_000_123 });
    expect(c).not.toHaveProperty('agent');
  });

  it('takes the agent from the authenticated identity; an assistant origin alone carries none', () => {
    const r = room();
    const assistant = { ...USERS.carol, session: 's-assist', agent: 'assistant:drafting' };
    r.open('x1', assistant);
    r.open('c1', USERS.carol);
    r.open('a1', USERS.alice);
    // An agent connection holds at most `suggest` (UX-044, UX-046), so its text arrives as a suggestion.
    const doc = baseDoc();
    const pos = posInside(doc, 'pIntro0000000001');
    const mark = schema.marks['ins']!.create({ id: 'sAgent0000000001', user: 'carol' });
    const suggested = json([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x', [mark])), 0, 0)),
    ]);
    const one = stored(
      flush(r, r.submit('x1', { id: id(), base: 0, steps: suggested, origin: 'assistant' })),
      'a1',
    );
    expect(one[0]).toMatchObject({
      user: 'carol',
      agent: 'assistant:drafting',
      origin: 'assistant',
    });
    const two = stored(
      flush(
        r,
        r.submit('c1', { id: id(), base: 1, steps: insert(r.document), origin: 'assistant' }),
      ),
      'a1',
    );
    expect(two[0]).toMatchObject({ user: 'carol', origin: 'assistant' });
    expect(two[0]).not.toHaveProperty('agent');
    expect(two[0]!.seq).toBe(one[0]!.seq + 1);
  });
});

describe('the base rules as the room applies them (PRM-010)', () => {
  it('refuses a view-only connection before reading its steps', () => {
    const r = room();
    r.open('f1', USERS.frank);
    let read = false;
    const commit = {
      id: id(),
      base: 0,
      get steps() {
        read = true;
        return insert();
      },
    };
    expect(rejectOf(r.submit('f1', commit), 'f1')?.code).toBe('permission_denied');
    expect(read).toBe(false);
  });

  it('refuses and does not store a change of a non-null identifier, including a region', () => {
    for (const target of ['pIntro0000000001', 'rNotes000000000C']) {
      const r = room();
      r.open('a1', USERS.alice);
      const fx = r.submit('a1', {
        id: id(),
        base: 0,
        steps: json([new AttrStep(posOf(baseDoc(), target), 'id', 'xRenamed0000000X')]),
      });
      expect(rejectOf(fx, 'a1')?.code, target).toBe('invalid_op');
      expect(fx.write, target).toBeNull();
    }
  });
});
