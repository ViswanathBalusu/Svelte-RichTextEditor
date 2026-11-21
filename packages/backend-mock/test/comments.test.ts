// The comments port of the mock backend (gap G71, ADR 0417; UX-028 to UX-032, FE-048): threads and
// comments through the room's rules, the entity tags, `thread.*` and `comment.*` notices delivered
// to the other channels, and read restrictions (ADR 0019): a reader that may not see a region gets
// none of its threads, and no notice about them.
import { contractDocument, IDS, posIn } from '@docedit/protocol/contract';
import {
  PortError,
  type Backend,
  type CommentsPort,
  type Notification,
  type SyncChannel,
} from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { MockService } from '../src/index.ts';

const insertText = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});
const deleteRange = (from: number, to: number) => ({ stepType: 'replace', from, to });

const body = (text: string) => ({ body: [{ type: 'text' as const, text }] });

/** The contract document with the locked region made confidential (ADR 0019). */
function confidentialDocument() {
  const env = contractDocument();
  const root = env.doc as unknown as {
    content: Array<{
      type: string;
      content: Array<{ type: string; attrs: Record<string, unknown> }>;
    }>;
  };
  const region = root.content[1]!.content.find(
    (n) => n.type === 'region' && n.attrs['id'] === IDS.locked,
  )!;
  region.attrs['policy'] = 'confidential';
  return env;
}

interface Client {
  b: Backend;
  comments: CommentsPort;
  ch: SyncChannel;
  events: Notification[];
}

async function join(
  service: MockService,
  doc: string,
  sub: string,
  role: 'owner' | 'editor' | 'viewer' | 'commenter',
): Promise<Client> {
  const b = service.backend({ sub }, { [doc]: role });
  await b.connect();
  const content = await b.sync.loadContent(doc);
  const ch = await b.sync.open(doc, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const events: Notification[] = [];
  ch.onEvent((n) => events.push(n));
  return { b, comments: b.comments!, ch, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the comments port of the mock backend', () => {
  it('announces comments and offers the port', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const owner = await join(service, doc, 'olga', 'owner');
    expect(service.features).toContain('comments');
    expect(owner.b.features.has('comments')).toBe(true);
    expect(owner.comments).toBeDefined();
    await service.dispose();
  });

  it('creates a thread on a block with its first comment, tags it, and lists it', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const made = await olga.comments.createThread(doc, {
      target: { block: IDS.intro },
      comment: body('Is this right?'),
    });
    expect(made.value).toMatchObject({
      state: 'open',
      assignee: null,
      createdBy: 'user:olga',
      target: { block: IDS.intro },
      comments: [
        { author: 'user:olga', editedAt: null, body: [{ type: 'text', text: 'Is this right?' }] },
      ],
    });
    expect(made.etag).toBe(`"${made.value.id}:open:"`);
    const page = await olga.comments.threads(doc);
    expect(page.items.map((t) => t.id)).toEqual([made.value.id]);
    expect((await olga.comments.thread(made.value.id)).value.comments).toHaveLength(1);
    // Nothing was committed: the head is where it was.
    expect((await olga.b.sync.loadContent(doc)).seq).toBe(0);
    await service.dispose();
  });

  it('delivers thread.created, resolved, reopened and deleted to another channel', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const eddie = await join(service, doc, 'eddie', 'editor');
    const { value, etag } = await olga.comments.createThread(doc, {
      target: { block: IDS.intro },
      comment: body('First'),
    });
    await settle();
    expect(eddie.events.map((e) => [e.type, e.resource])).toEqual([
      ['thread.created', `/threads/${value.id}`],
    ]);
    expect(eddie.events[0]!.data).toMatchObject({ block: IDS.intro, state: 'open' });
    const resolved = await olga.comments.updateThread(
      value.id,
      { state: 'resolved' },
      { ifMatch: etag },
    );
    await olga.comments.updateThread(value.id, { state: 'open' }, { ifMatch: resolved.etag });
    const reply = await eddie.comments.reply(value.id, body('A reply'));
    await olga.comments.deleteThread(value.id);
    await settle();
    expect(eddie.events.map((e) => e.type)).toEqual([
      'thread.created',
      'thread.resolved',
      'thread.reopened',
      'comment.created',
      'thread.deleted',
    ]);
    expect(eddie.events[3]).toMatchObject({
      resource: `/comments/${reply.value.id}`,
      data: { thread: value.id },
    });
    expect(await olga.comments.threads(doc)).toMatchObject({ items: [] });
    await service.dispose();
  });

  it('refuses a stale If-Match and keeps the thread', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const { value, etag } = await olga.comments.createThread(doc, {
      target: { block: IDS.intro },
      comment: body('x'),
    });
    await olga.comments.updateThread(value.id, { state: 'resolved' }, { ifMatch: etag });
    const stale = await olga.comments
      .updateThread(value.id, { state: 'open' }, { ifMatch: etag })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(PortError);
    expect((stale as PortError).code).toBe('precondition_failed');
    expect((await olga.comments.thread(value.id)).value.state).toBe('resolved');
    await service.dispose();
  });

  it('lets only the author or the owner edit or delete a comment, and tags an edit', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const eddie = await join(service, doc, 'eddie', 'editor');
    const fred = await join(service, doc, 'fred', 'editor');
    const { value } = await olga.comments.createThread(doc, {
      target: { block: IDS.intro },
      comment: body('First'),
    });
    const reply = await eddie.comments.reply(value.id, body('Mine'));
    expect(reply.etag).toBe(`"${reply.value.id}:0"`);
    const other = await fred.comments
      .updateComment(reply.value.id, body('Not yours'), { ifMatch: reply.etag })
      .catch((e: unknown) => e);
    expect((other as PortError).code).toBe('forbidden');
    const edited = await eddie.comments.updateComment(reply.value.id, body('Revised'), {
      ifMatch: reply.etag,
    });
    expect(edited.value.body).toEqual([{ type: 'text', text: 'Revised' }]);
    expect(edited.value.editedAt).not.toBeNull();
    expect(edited.etag).not.toBe(reply.etag);
    const stale = await eddie.comments
      .updateComment(reply.value.id, body('Again'), { ifMatch: reply.etag })
      .catch((e: unknown) => e);
    expect((stale as PortError).code).toBe('precondition_failed');
    // The owner may delete any comment (manage).
    await olga.comments.deleteComment(reply.value.id);
    expect((await olga.comments.thread(value.id)).value.comments).toHaveLength(1);
    await service.dispose();
  });

  it('refuses a viewer, a body that is not text and mentions, and an unknown thread', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const victor = await join(service, doc, 'victor', 'viewer');
    const denied = await victor.comments
      .createThread(doc, { target: { block: IDS.intro }, comment: body('hi') })
      .catch((e: unknown) => e);
    expect((denied as PortError).code).toBe('forbidden');
    const empty = await olga.comments
      .createThread(doc, { target: { block: IDS.intro }, comment: { body: [] } })
      .catch((e: unknown) => e);
    expect((empty as PortError).code).toBe('validation_failed');
    const bad = await olga.comments
      .createThread(doc, {
        target: { block: IDS.intro },
        comment: { body: [{ type: 'mention', principal: 'ann' }] } as never,
      })
      .catch((e: unknown) => e);
    expect((bad as PortError).code).toBe('validation_failed');
    const missing = await olga.comments
      .thread('0192f0c4-7b1e-7c3a-9a54-000000000009')
      .catch((e: unknown) => e);
    expect((missing as PortError).code).toBe('not_found');
    // A commenter may comment, a viewer may read.
    const cora = await join(service, doc, 'cora', 'commenter');
    const ok = await cora.comments.createThread(doc, {
      target: { block: IDS.intro },
      comment: body('ok'),
    });
    expect((await victor.comments.thread(ok.value.id)).value.id).toBe(ok.value.id);
    await service.dispose();
  });

  it('keeps a range on its text through edits and detaches it when the text is deleted', async () => {
    const service = new MockService();
    const doc = service.createDocument(contractDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const eddie = await join(service, doc, 'eddie', 'editor');
    const content = await olga.b.sync.loadContent(doc);
    const from = posIn(content.doc, IDS.intro, 0);
    const made = await olga.comments.createThread(doc, {
      target: { range: { from, to: from + 5, baseSeq: content.seq } },
      comment: body('Hello?'),
    });
    expect(made.value.target).toEqual({ range: { from, to: from + 5, baseSeq: 0 } });
    // Text inserted before the range moves it right; the thread is announced with its new place.
    await eddie.ch.submit({
      id: '0192f0c4-7b1e-7c3a-9a54-000000000010',
      base: 0,
      steps: [insertText(from, 'Oh, ')],
    });
    await settle();
    const moved = (await olga.comments.threads(doc)).items[0]!;
    expect(moved.target).toEqual({ range: { from: from + 4, to: from + 9, baseSeq: 1 } });
    // Deleting the text collapses the range: the thread stays, detached (ADR 0015).
    await eddie.ch.submit({
      id: '0192f0c4-7b1e-7c3a-9a54-000000000011',
      base: 1,
      steps: [deleteRange(from + 4, from + 9)],
    });
    await settle();
    const gone = (await olga.comments.threads(doc)).items[0]!;
    const range = (gone.target as { range: { from: number; to: number } }).range;
    expect(range.from).toBe(range.to);
    expect(gone.comments).toHaveLength(1);
    await service.dispose();
  });

  it('hides a thread in a confidential region from a reader, and sends it no notice', async () => {
    const service = new MockService();
    const doc = service.createDocument(confidentialDocument());
    const olga = await join(service, doc, 'olga', 'owner');
    const eddie = await join(service, doc, 'eddie', 'editor');
    const secret = await olga.comments.createThread(doc, {
      target: { block: IDS.lockedPara },
      comment: body('Privileged'),
    });
    const open = await olga.comments.createThread(doc, {
      target: { block: IDS.intro },
      comment: body('Public'),
    });
    await olga.comments.reply(secret.value.id, body('Still privileged'));
    await olga.comments.updateThread(
      secret.value.id,
      { state: 'resolved' },
      { ifMatch: secret.etag },
    );
    await settle();
    // The editor has no grant on the region: it hears about the public thread only.
    expect(eddie.events.map((e) => e.resource)).toEqual([`/threads/${open.value.id}`]);
    expect((await eddie.comments.threads(doc)).items.map((t) => t.id)).toEqual([open.value.id]);
    const get = await eddie.comments.thread(secret.value.id).catch((e: unknown) => e);
    expect((get as PortError).code).toBe('not_found');
    const reply = await eddie.comments
      .reply(secret.value.id, body('Can I see?'))
      .catch((e: unknown) => e);
    expect((reply as PortError).code).toBe('not_found');
    // The owner sees both.
    expect((await olga.comments.threads(doc)).items).toHaveLength(2);
    await service.dispose();
  });

  it('follows a new reader grant: a grantee of the region sees its threads', async () => {
    const service = new MockService();
    const doc = service.createDocument(confidentialDocument(), {
      grants: [{ region: IDS.locked, principal: 'group:legal', role: 'editor' }],
    });
    const olga = await join(service, doc, 'olga', 'owner');
    const secret = await olga.comments.createThread(doc, {
      target: { block: IDS.lockedPara },
      comment: body('Privileged'),
    });
    const grace = service.backend({ sub: 'grace', groups: ['legal'] }, { [doc]: 'editor' });
    await grace.connect();
    const content = await grace.sync.loadContent(doc);
    const ch = await grace.sync.open(doc, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const events: Notification[] = [];
    ch.onEvent((n) => events.push(n));
    expect((await grace.comments!.threads(doc)).items.map((t) => t.id)).toEqual([secret.value.id]);
    await olga.comments.reply(secret.value.id, body('Hello Grace'));
    await settle();
    expect(events.map((e) => e.type)).toEqual(['comment.created']);
    await service.dispose();
  });
});
