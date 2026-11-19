// The comment threads through the product (gap G71; ADR 0017 is not involved; ADR 0417; UX-028 to
// UX-032, UX-037, FE-048): the element's thread service over the mock backend's comments port, with
// the real editing core. Two clients share one document. Everything a thread does goes through the
// control plane, so the document's head does not move for it, and a notice reaches the other client
// without a reload. A reader who may not see a region gets none of its threads (ADR 0019).
import { MockService } from '@docedit/backend-mock';
import { internals } from '@docedit/engine/testing';
import { contractDocument, IDS } from '@docedit/protocol/contract';
import type { Backend } from '@docedit/protocol';
import type { ThreadsService } from '@docedit/ui';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import { threadsService } from '../src/threads.ts';
import { coreHost, until } from './core-host.ts';

const immediate = (run: () => void) => queueMicrotask(run);
const text = (t: string) => [{ type: 'text' as const, text: t }];

interface Client {
  readonly service: ThreadsService;
  readonly core: ReturnType<typeof coreHost>['cores'][number];
  readonly backend: Backend;
  readonly session: Session;
}

async function join(
  mock: MockService,
  docId: string,
  sub: string,
  role: 'owner' | 'editor' | 'viewer' | 'commenter',
  groups: readonly string[] = [],
): Promise<Client> {
  const backend = mock.backend({ sub, groups }, { [docId]: role });
  const host = coreHost();
  const session = new Session({ docId, backend, ownsBackend: false, host, scheduler: immediate });
  await session.start();
  const core = host.cores[0]!;
  const service = threadsService(core, {
    port: backend.comments!,
    docId,
    self: () => `user:${sub}`,
  });
  return { service, core, backend, session };
}

const head = async (c: Client, docId: string): Promise<number> =>
  (await c.backend.sync.loadContent(docId)).seq;

/** Selects the first match of `words` in the body, as a reader selects text. */
function select(c: Client, words: string): void {
  c.core.findText(words, { matchCase: true });
  if (!c.core.selectFindMatch(0)) throw new Error(`no match for ${words}`);
}

function posOf(c: Client, id: string): number {
  let found = -1;
  internals(c.core).state.doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  return found;
}

describe('the thread service over the mock backend (G71)', () => {
  it('creates a thread on a range and on a block, with no commit, and the other client sees it live', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner');
    const eddie = await join(mock, docId, 'eddie', 'editor');
    const before = await head(olga, docId);

    // A range: the selection is the anchor, with the seq it was read at (UX-028 criterion 1).
    const start = posOf(olga, IDS.intro) + 1;
    select(olga, 'Hello');
    const anchor = olga.service.anchor();
    expect(anchor?.selection).toEqual({
      kind: 'range',
      from: start,
      to: start + 5,
      baseSeq: before,
    });
    expect(anchor?.scopes).toHaveLength(1);
    expect(anchor?.scopes[0]).toContain('comment');
    const made = await olga.service.create({
      target: { range: { from: start, to: start + 5, baseSeq: before } },
      body: text('Hello?'),
    });
    expect(made.ok).toBe(true);
    const rangeId = made.ok ? made.id : '';
    // A block (UX-028 criterion 2).
    const onBlock = await olga.service.create({ target: { block: IDS.mid }, body: text('Why?') });
    expect(onBlock.ok).toBe(true);

    // No commit was made by either (UX-028 criterion 1; FE-048 criterion 6).
    expect(await head(olga, docId)).toBe(before);

    // The other client lists both without a reload (UX-028 criterion 7).
    await until(() => eddie.service.list().length === 2, 'the threads on the other client');
    const listed = eddie.service.list();
    expect(listed.map((t) => t.replyCount)).toEqual([0, 0]);
    const ranged = listed.find((t) => t.id === rangeId)!;
    expect(ranged.excerpt).toBe('Hello');
    expect(ranged.author).toBe('user:olga');
    expect(eddie.service.count()).toBe(2);
    const blocked = listed.find((t) => t.id !== rangeId)!;
    expect(blocked.blockKind).toBe('paragraph');
    expect(blocked.target).toEqual({ block: IDS.mid });
    olga.session.close();
    eddie.session.close();
  });

  it('keeps the highlight on the same words when the other client edits before it', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner');
    const eddie = await join(mock, docId, 'eddie', 'editor');
    const start = posOf(olga, IDS.intro) + 1;
    const base = await head(olga, docId);
    const made = await olga.service.create({
      target: { range: { from: start + 6, to: start + 11, baseSeq: base } },
      body: text('World?'),
    });
    expect(made.ok).toBe(true);
    await until(() => eddie.service.list().length === 1, 'the thread on the other client');
    expect(eddie.service.list()[0]!.excerpt).toBe('world');
    // Eddie types at the start of the paragraph; his highlight and Olga's both follow the words.
    const i = internals(eddie.core);
    i.dispatch(i.state.tr.insertText('Oh, ', start));
    expect(eddie.service.list()[0]!.excerpt).toBe('world');
    await until(
      () => olga.service.list()[0]?.position === start + 10,
      'the range to move on the first client',
    );
    expect(olga.service.list()[0]!.excerpt).toBe('world');
    olga.session.close();
    eddie.session.close();
  });

  it('shows a reply, a resolve, a reopen and a delete to the other client', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner');
    const eddie = await join(mock, docId, 'eddie', 'editor');
    const made = await olga.service.create({ target: { block: IDS.intro }, body: text('Q') });
    const id = made.ok ? made.id : '';
    await until(() => eddie.service.detail!(id) !== null, 'the thread on the other client');

    // A reply from Eddie (UX-029 criterion 1).
    const first = eddie.service.detail!(id)!;
    const replied = await eddie.service.reply!(id, [{ type: 'text', text: 'A' }], first.etag);
    expect(replied.ok).toBe(true);
    await until(
      () => olga.service.detail!(id)!.comments.length === 2,
      'the reply on the first client',
    );
    expect(olga.service.detail!(id)!.comments.map((c) => c.author)).toEqual([
      'user:olga',
      'user:eddie',
    ]);
    expect(olga.service.list()[0]!.replyCount).toBe(1);

    // Resolve by Olga, shown to Eddie; reopen by Eddie (UX-029 criterion 3).
    const resolved = await olga.service.setState!(id, 'resolved', olga.service.detail!(id)!.etag);
    const resolvedTag = resolved.ok ? resolved.detail.etag : '';
    expect(resolved.ok && resolved.detail.state).toBe('resolved');
    await until(
      () => eddie.service.detail!(id)!.state === 'resolved',
      'the state on the other client',
    );
    const reopened = await eddie.service.setState!(id, 'open', eddie.service.detail!(id)!.etag);
    expect(reopened.ok && reopened.detail.state).toBe('open');
    await until(() => olga.service.detail!(id)!.state === 'open', 'the reopened state');

    // A stale version is refused and the latest thread comes back (UX-029 criterion 6).
    // The tag of the resolved thread is out of date once it was reopened.
    const stale = resolvedTag;
    const refused = await olga.service.setState!(id, 'resolved', stale);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe('precondition_failed');
    expect(!refused.ok && refused.latest?.state).toBe('open');

    // An assignment is shown to the other client (UX-032 criterion 2).
    const assigned = await olga.service.assign!(id, 'user:eddie', olga.service.detail!(id)!.etag);
    expect(assigned.ok && assigned.detail.assignee).toBe('user:eddie');
    await until(() => eddie.service.detail!(id)!.assignee === 'user:eddie', 'the assignee');
    const cleared = await olga.service.assign!(id, null, olga.service.detail!(id)!.etag);
    expect(cleared.ok && cleared.detail.assignee).toBeNull();
    await until(() => eddie.service.detail!(id)!.assignee === null, 'the cleared assignee');

    // The author deletes the thread; the other client drops it.
    const gone = await olga.service.deleteThread!(id, olga.service.detail!(id)!.etag);
    expect(gone.ok).toBe(true);
    await until(() => eddie.service.list().length === 0, 'the deleted thread to leave');
    expect(eddie.service.detail!(id)).toBeNull();
    olga.session.close();
    eddie.session.close();
  });

  it('edits and deletes a comment only as its author, and refuses a viewer', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner');
    const eddie = await join(mock, docId, 'eddie', 'editor');
    const victor = await join(mock, docId, 'victor', 'viewer');
    const fred = await join(mock, docId, 'fred', 'editor');
    const made = await olga.service.create({ target: { block: IDS.intro }, body: text('Q') });
    const id = made.ok ? made.id : '';
    await until(
      () => eddie.service.detail!(id) !== null && fred.service.detail!(id) !== null,
      'sync',
    );
    const reply = await eddie.service.reply!(id, [{ type: 'text', text: 'Mine' }], '');
    const cid = reply.ok ? reply.detail.comments[1]!.id : '';
    await until(
      () => fred.service.detail!(id)!.comments.length === 2,
      'the reply on a third client',
    );

    const other = await fred.service.editComment!(
      id,
      cid,
      [{ type: 'text', text: 'Not yours' }],
      '',
    );
    expect(!other.ok && other.code).toBe('permission_denied');
    const edited = await eddie.service.editComment!(
      id,
      cid,
      [{ type: 'text', text: 'Revised' }],
      '',
    );
    expect(edited.ok && edited.detail.comments[1]!.edited).toBe(true);
    expect(edited.ok && edited.detail.comments[1]!.body).toEqual([
      { type: 'text', text: 'Revised' },
    ]);
    await until(
      () => olga.service.detail!(id)!.comments[1]?.edited === true,
      'the edit on the first client',
    );

    // A viewer may read but not reply (UX-029 criterion 5).
    await until(() => victor.service.detail!(id) !== null, 'the thread for the viewer');
    expect(victor.service.detail!(id)!.caps).not.toContain('comment');
    const denied = await victor.service.reply!(id, [{ type: 'text', text: 'Hi' }], '');
    expect(!denied.ok && denied.code).toBe('permission_denied');

    // The owner deletes the comment of another (`manage`).
    const removed = await olga.service.deleteComment!(id, cid, '');
    expect(removed.ok && removed.detail.comments).toHaveLength(1);
    olga.session.close();
    eddie.session.close();
    victor.session.close();
    fred.session.close();
  });

  it('gives a reader no thread, and no notice, in a region it may not see (ADR 0019)', async () => {
    const mock = new MockService();
    const env = contractDocument();
    const body = (env.doc as unknown as { content: Array<{ type: string; content: unknown[] }> })
      .content[1]!;
    for (const node of body.content as Array<{ type: string; attrs: Record<string, unknown> }>)
      if (node.type === 'region' && node.attrs['id'] === IDS.locked)
        node.attrs['policy'] = 'confidential';
    const docId = mock.createDocument(env, {
      grants: [{ region: IDS.locked, principal: 'group:legal', role: 'editor' }],
    });
    const olga = await join(mock, docId, 'olga', 'owner');
    const eddie = await join(mock, docId, 'eddie', 'editor');
    const grace = await join(mock, docId, 'grace', 'editor', ['legal']);

    const secret = await olga.service.create({
      target: { block: IDS.lockedPara },
      body: text('Privileged'),
    });
    const open = await olga.service.create({ target: { block: IDS.intro }, body: text('Public') });
    expect(secret.ok && open.ok).toBe(true);
    const secretId = secret.ok ? secret.id : '';
    await olga.service.reply!(secretId, [{ type: 'text', text: 'More' }], '');

    await until(() => eddie.service.list().length === 1, 'the public thread for Eddie');
    await until(() => grace.service.list().length === 2, 'both threads for Grace');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Eddie has no grant on the region: he holds the public thread only, and never held the other.
    expect(eddie.service.list().map((t) => t.id)).toEqual([open.ok ? open.id : '']);
    expect(eddie.service.detail!(secretId)).toBeNull();
    expect(eddie.service.count()).toBe(1);
    // Grace, a member of the group the region is granted to, holds both.
    expect(grace.service.detail!(secretId)?.comments).toHaveLength(2);
    // The owner holds both.
    expect(olga.service.count()).toBe(2);
    for (const c of [olga, eddie, grace]) c.session.close();
  });

  it('answers a refused write with the service code and creates nothing', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const victor = await join(mock, docId, 'victor', 'viewer');
    const refused = await victor.service.create({ target: { block: IDS.intro }, body: text('x') });
    expect(refused).toEqual({ ok: false, code: 'permission_denied' });
    expect(victor.service.count()).toBe(0);
    const stale = await victor.service.create({
      target: { range: { from: 1, to: 3, baseSeq: 999 } },
      body: text('x'),
    });
    expect(stale.ok).toBe(false);
    victor.session.close();
  });
});
