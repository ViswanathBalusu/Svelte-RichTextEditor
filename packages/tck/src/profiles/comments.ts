/**
 * The `comments` profile (05 §6.2; 07 §6; PRO-120). It checks that the range of a thread follows
 * the text, that `view` may not start a thread and `comment` may, that a `baseSeq` outside the
 * rebase window is refused, that thread and comment changes reach a channel as notices, and the
 * rule every route addressed by a bare identifier follows (05 §6.1; 10 §3.2; PRO-045): a thread or
 * a comment is refused to a caller whose token covers another document.
 */
import { check, equal, jsonEqual } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { expectStatus, type HttpResponse } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, join, knownSeq, problemOf, readContent } from './support.ts';

const c = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('comments', def);

/**
 * A call with a token of another document must be refused, and must not say more than that: the
 * problem is `forbidden` (403) or `not_found` (404), the two refusals 05 §6.1 gives a caller whose
 * token does not cover the resource's document.
 */
export function refusedToOutsider(res: HttpResponse, what: string): void {
  const p = problemOf(res, what);
  check(
    (p.code === 'forbidden' && p.status === 403) || (p.code === 'not_found' && p.status === 404),
    `${what}: refused to a caller of another document (05 §6.1)`,
    'forbidden (403) or not_found (404)',
    `${p.code} (${p.status})`,
  );
}

/** A thread with one more comment on a new document, made by a commenter of that document. */
export async function threadOf(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const { token } = await ctx.token('commenter', { [doc]: 'commenter' });
  const content = await readContent(ctx, token, doc);
  const from = posIn(content.doc, IDS.intro);
  const made = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
    body: {
      target: { range: { from, to: from + 1, baseSeq: content.seq } },
      comment: { body: [{ type: 'text', text: 'kit' }] },
    },
  });
  equal(made.status, 201, 'POST /documents/{id}/threads as a commenter');
  const tid = (made.json as { id?: unknown }).id;
  check(typeof tid === 'string', 'the created thread has an id', 'a string', made.json);
  const added = await ctx.service.as(token, 'POST', `/threads/${tid}/comments`, {
    body: { body: [{ type: 'text', text: 'a second comment' }] },
  });
  equal(added.status, 201, 'POST /threads/{tid}/comments as a commenter');
  const cid = (added.json as { id?: unknown }).id;
  check(typeof cid === 'string', 'the created comment has an id', 'a string', added.json);
  return { doc, token, tid, cid };
}

export const COMMENTS: ProfileDef = {
  id: 'comments',
  title: 'Threads and comments',
  spec: '05 §6.2; 07 §6',
  stories: ['PRO-120', 'PRO-045'],
  requires: { kind: 'features', features: ['comments'] },
  scenarios: [
    c({
      id: 'identifiers',
      title: 'a thread and a comment are refused to a caller whose token covers another document',
      spec: '05 §6.1; 10 §3.2',
      covers: {
        operations: [
          'GET /threads/{tid}',
          'PATCH /threads/{tid}',
          'DELETE /threads/{tid}',
          'POST /threads/{tid}/comments',
          'PATCH /comments/{cid}',
          'DELETE /comments/{cid}',
        ],
      },
      async run(ctx) {
        const t = await threadOf(ctx);
        const before = await ctx.service.as(t.token, 'GET', `/threads/${t.tid}`);
        equal(before.status, 200, 'GET /threads/{tid} as a commenter of its document');
        // The outsider owns another document, so only the document check can refuse them.
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        const any = { 'if-match': '*' };
        const calls: Array<[string, string, { body?: unknown; headers?: Record<string, string> }]> =
          [
            ['GET', `/threads/${t.tid}`, {}],
            ['PATCH', `/threads/${t.tid}`, { body: { state: 'resolved' }, headers: any }],
            [
              'POST',
              `/threads/${t.tid}/comments`,
              { body: { body: [{ type: 'text', text: 'from another document' }] } },
            ],
            [
              'PATCH',
              `/comments/${t.cid}`,
              { body: { body: [{ type: 'text', text: 'changed' }] }, headers: any },
            ],
            ['DELETE', `/comments/${t.cid}`, {}],
            ['DELETE', `/threads/${t.tid}`, {}],
          ];
        for (const [method, path, opts] of calls)
          refusedToOutsider(
            await ctx.service.as(outsider, method, path, opts),
            `${method} ${path.replace(t.tid, '{tid}').replace(t.cid, '{cid}')}`,
          );
        // Nothing the outsider tried took effect.
        const after = await ctx.service.as(t.token, 'GET', `/threads/${t.tid}`);
        equal(after.status, 200, 'the thread is still there for its own document');
        jsonEqual(after.json, before.json, 'the thread is unchanged');
      },
    }),
    c({
      id: 'range.follows-text',
      title: 'the range reported with a thread follows the text when others insert before it',
      spec: '05 §6.2; 07 §6; SYN-032',
      covers: { operations: ['GET /documents/{id}/threads', 'POST /documents/{id}/threads'] },
      async run(ctx) {
        const doc = await ctx.document();
        const { token } = await ctx.token('commenter', { [doc]: 'commenter' });
        const editor = await join(ctx, 'editor', doc, 'editor');
        const content = await readContent(ctx, token, doc);
        const from = posIn(content.doc, IDS.intro, 2);
        const to = from + 3;
        const made = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
          body: {
            target: { range: { from, to, baseSeq: content.seq } },
            comment: { body: [{ type: 'text', text: 'kit' }] },
          },
        });
        expectStatus(made, 201, 'a thread on a range');
        const tid = (made.json as { id: string }).id;
        const text = 'Inserted. ';
        const ack = await acked(editor.wire, editor.ch, {
          base: knownSeq(editor),
          steps: [insertText(posIn(content.doc, IDS.intro, 0), text)],
        });
        const list = await ctx.service.as(token, 'GET', `/documents/${doc}/threads`);
        expectStatus(list, 200, 'the threads of the document');
        const body = list.json as { items: Array<Record<string, unknown>>; seq: number };
        equal(body.seq, ack.seq, 'the list is read at the head');
        const t = body.items.find((x) => x['id'] === tid);
        check(t !== undefined, 'the thread is listed', tid, body.items);
        jsonEqual(
          t!['target'],
          { range: { from: from + text.length, to: to + text.length, baseSeq: ack.seq } },
          'the range moved by the length of the inserted text',
        );
        // At the seq the thread was made, the range is where it was made. An older state is read by
        // a person with `edit`: a commenter's history starts at the head under the default setting
        // (07 §8; PRM-042).
        const { token: historian } = await ctx.token('historian', { [doc]: 'editor' });
        const then = await ctx.service.as(historian, 'GET', `/documents/${doc}/threads`, {
          query: { seq: content.seq },
        });
        expectStatus(then, 200, 'the threads at the earlier seq');
        const old = (then.json as { items: Array<Record<string, unknown>> }).items.find(
          (x) => x['id'] === tid,
        );
        jsonEqual(
          old?.['target'],
          { range: { from, to, baseSeq: content.seq } },
          'the range at the seq it was made',
        );
        await editor.wire.close();
      },
    }),
    c({
      id: 'permissions.comment-scope',
      title: 'a user with only view may not start a thread; a commenter in the scope may',
      spec: '07 §6, §12; 05 §6.2',
      covers: { operations: ['POST /documents/{id}/threads'], errors: ['forbidden'] },
      async run(ctx) {
        const doc = await ctx.document();
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: commenter } = await ctx.token('commenter', { [doc]: 'commenter' });
        const req = {
          body: {
            target: { block: IDS.intro },
            comment: { body: [{ type: 'text', text: 'kit' }] },
          },
        };
        const refused = await ctx.service.as(viewer, 'POST', `/documents/${doc}/threads`, req);
        equal(
          problemOf(refused, 'a thread by a viewer').code,
          'forbidden',
          'the viewer is refused',
        );
        equal(refused.status, 403, 'the status of the refusal');
        const listed = await ctx.service.as(commenter, 'GET', `/documents/${doc}/threads`);
        equal((listed.json as { items: unknown[] }).items.length, 0, 'the refusal stored nothing');
        const made = await ctx.service.as(commenter, 'POST', `/documents/${doc}/threads`, req);
        expectStatus(made, 201, 'a thread by a commenter');
        jsonEqual(
          (made.json as { target: unknown }).target,
          { block: IDS.intro },
          'the thread is on the block',
        );
      },
    }),
    c({
      id: 'permissions.thread-actions',
      title:
        'rows 4 and 5: a reader without comment cannot reply, resolve, reopen, assign or delete; only the author or a manager deletes',
      spec: '07 §6, §12 rows 4 and 5; PRM-037; PRM-039; PRM-058',
      covers: {
        operations: [
          'GET /threads/{tid}',
          'PATCH /threads/{tid}',
          'DELETE /threads/{tid}',
          'POST /threads/{tid}/comments',
          'DELETE /comments/{cid}',
        ],
        errors: ['forbidden'],
      },
      async run(ctx) {
        const { doc, token: author, tid, cid } = await threadOf(ctx);
        const { token: viewer } = await ctx.token('viewer', { [doc]: 'viewer' });
        const { token: other } = await ctx.token('other', { [doc]: 'commenter' });
        const { token: owner } = await ctx.token('owner', { [doc]: 'owner' });
        const refused = (res: HttpResponse, what: string) => {
          equal(problemOf(res, what).code, 'forbidden', `${what} is refused`);
          equal(res.status, 403, `${what}: the status`);
        };
        const tag = async (): Promise<string> => {
          const got = await ctx.service.as(author, 'GET', `/threads/${tid}`);
          expectStatus(got, 200, 'the thread');
          return got.headers.get('etag') ?? '';
        };
        const patch = async (token: string, body: Record<string, unknown>) =>
          ctx.service.as(token, 'PATCH', `/threads/${tid}`, {
            body,
            headers: { 'if-match': await tag() },
          });

        // Row 4: a viewer has no `comment`, so it may not reply to a thread or change its state.
        refused(
          await ctx.service.as(viewer, 'POST', `/threads/${tid}/comments`, {
            body: { body: [{ type: 'text', text: 'from a viewer' }] },
          }),
          'a reply by a viewer',
        );
        refused(await patch(viewer, { state: 'resolved' }), 'a resolve by a viewer');
        refused(await patch(viewer, { assignee: ctx.sub('someone') }), 'an assignment by a viewer');
        // The refusals changed nothing: the thread is open and has its two comments.
        const after = await ctx.service.as(author, 'GET', `/threads/${tid}`);
        expectStatus(after, 200, 'the thread after the refusals');
        equal((after.json as { state?: unknown }).state, 'open', 'the thread is still open');

        // Controls: a commenter resolves, reopens and replies.
        expectStatus(await patch(author, { state: 'resolved' }), 200, 'a resolve by a commenter');
        expectStatus(await patch(author, { state: 'open' }), 200, 'a reopen by a commenter');
        expectStatus(
          await ctx.service.as(other, 'POST', `/threads/${tid}/comments`, {
            body: { body: [{ type: 'text', text: 'from another commenter' }] },
          }),
          201,
          'a reply by a commenter',
        );

        // Row 5: a comment is deleted by its author or by a holder of `manage`, nobody else.
        refused(await ctx.service.as(viewer, 'DELETE', `/comments/${cid}`), 'a delete by a viewer');
        refused(
          await ctx.service.as(other, 'DELETE', `/comments/${cid}`),
          'a delete of another user comment',
        );
        refused(
          await ctx.service.as(other, 'DELETE', `/threads/${tid}`),
          'a delete of another user thread',
        );
        const gone = await ctx.service.as(owner, 'DELETE', `/comments/${cid}`);
        check(gone.status < 300, 'a manager deletes a comment', '2xx', gone.status);
        const removed = await ctx.service.as(author, 'DELETE', `/threads/${tid}`);
        check(removed.status < 300, 'the author deletes the thread', '2xx', removed.status);
      },
    }),
    c({
      id: 'range.base-seq-window',
      title: 'a thread whose baseSeq lies outside the rebase window is refused',
      spec: '05 §6.2; 04 §12; ADR 0015',
      covers: { operations: ['POST /documents/{id}/threads'], errors: ['validation_failed'] },
      async run(ctx) {
        const doc = await ctx.document();
        const editor = await join(ctx, 'editor', doc, 'editor');
        const { token } = await ctx.token('commenter', { [doc]: 'commenter' });
        const window = editor.welcome.limits.maxRebaseSteps;
        if (window > 200)
          ctx.skip(
            `the server's rebase window is ${window} steps; the kit goes past it only up to 200 (start the server with a smaller maxRebaseSteps)`,
          );
        const at = posIn(editor.content.doc, IDS.intro, 0);
        let head = knownSeq(editor);
        for (let i = 0; i <= window; i++)
          head = (await acked(editor.wire, editor.ch, { base: head, steps: [insertText(at, 'x')] }))
            .seq;
        const range = (baseSeq: number) => ({
          target: { range: { from: at, to: at + 1, baseSeq } },
          comment: { body: [{ type: 'text', text: 'kit' }] },
        });
        const outside = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
          body: range(head - window - 1),
        });
        equal(
          problemOf(outside, 'a baseSeq outside the window').code,
          'validation_failed',
          'a baseSeq more than the window behind the head',
        );
        const ahead = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
          body: range(head + 1),
        });
        equal(
          problemOf(ahead, 'a baseSeq above the head').code,
          'validation_failed',
          'a baseSeq above the head',
        );
        const inside = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
          body: range(head - window),
        });
        expectStatus(inside, 201, 'a baseSeq exactly at the edge of the window');
        await editor.wire.close();
      },
    }),
    c({
      id: 'events.thread-and-comment',
      title: 'thread and comment changes reach the channel as notices',
      spec: '05 §5.6, §6.2; 07 §6',
      covers: {
        messages: ['event'],
        events: [
          'thread.created',
          'thread.updated',
          'thread.resolved',
          'thread.reopened',
          'thread.deleted',
          'comment.created',
          'comment.updated',
          'comment.deleted',
        ],
        operations: [
          'PATCH /threads/{tid}',
          'DELETE /threads/{tid}',
          'POST /threads/{tid}/comments',
          'PATCH /comments/{cid}',
          'DELETE /comments/{cid}',
        ],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const listener = await join(ctx, 'listener', doc, 'editor');
        const { token } = await ctx.token('commenter', { [doc]: 'commenter' });
        const hear = async (type: string, resource: string, from: number) => {
          const ev = await listener.wire.next(
            (x) => x.t === 'event' && x.d.type === type,
            `event ${type}`,
            { from },
          );
          if (ev.t === 'event') equal(ev.d.resource, resource, `the resource of ${type}`);
        };
        const as = (method: string, path: string, opts: Record<string, unknown> = {}) =>
          ctx.service.as(token, method, path, opts);
        const etag = (res: HttpResponse) => res.headers.get('etag') ?? '';

        let from = listener.wire.mark();
        const made = await as('POST', `/documents/${doc}/threads`, {
          body: {
            target: { block: IDS.intro },
            comment: { body: [{ type: 'text', text: 'first' }] },
          },
        });
        expectStatus(made, 201, 'a thread');
        const tid = (made.json as { id: string }).id;
        await hear('thread.created', `/threads/${tid}`, from);

        from = listener.wire.mark();
        const added = await as('POST', `/threads/${tid}/comments`, {
          body: { body: [{ type: 'text', text: 'second' }] },
        });
        expectStatus(added, 201, 'a comment');
        const cid = (added.json as { id: string }).id;
        await hear('comment.created', `/comments/${cid}`, from);

        from = listener.wire.mark();
        const edited = await as('PATCH', `/comments/${cid}`, {
          body: { body: [{ type: 'text', text: 'edited' }] },
          headers: { 'if-match': etag(added) },
        });
        expectStatus(edited, 200, 'an edited comment');
        await hear('comment.updated', `/comments/${cid}`, from);

        from = listener.wire.mark();
        const resolved = await as('PATCH', `/threads/${tid}`, {
          body: { state: 'resolved' },
          headers: { 'if-match': etag(made) },
        });
        expectStatus(resolved, 200, 'a resolved thread');
        await hear('thread.resolved', `/threads/${tid}`, from);

        from = listener.wire.mark();
        const reopened = await as('PATCH', `/threads/${tid}`, {
          body: { state: 'open' },
          headers: { 'if-match': etag(resolved) },
        });
        expectStatus(reopened, 200, 'a reopened thread');
        await hear('thread.reopened', `/threads/${tid}`, from);

        from = listener.wire.mark();
        const assigned = await as('PATCH', `/threads/${tid}`, {
          body: { assignee: ctx.sub('assignee') },
          headers: { 'if-match': etag(reopened) },
        });
        expectStatus(assigned, 200, 'an assigned thread');
        await hear('thread.updated', `/threads/${tid}`, from);

        from = listener.wire.mark();
        expectStatus(
          await as('DELETE', `/comments/${cid}`, { headers: { 'if-match': '*' } }),
          204,
          'a deleted comment',
        );
        await hear('comment.deleted', `/comments/${cid}`, from);

        from = listener.wire.mark();
        expectStatus(await as('DELETE', `/threads/${tid}`), 204, 'a deleted thread');
        await hear('thread.deleted', `/threads/${tid}`, from);
        await listener.wire.close();
      },
    }),
  ],
};
