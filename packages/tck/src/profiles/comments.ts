/**
 * The `comments` profile (05 §6.2; 07 §6). Its scenarios for threads and comments themselves are
 * phase 2 (PRO-120). What it has today is the rule every route addressed by a bare identifier
 * follows (05 §6.1; 10 §3.2; PRO-045): a thread or a comment is refused to a caller whose token
 * covers another document.
 */
import { check, equal, jsonEqual } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, posIn } from '../documents.ts';
import type { HttpResponse } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { problemOf, readContent } from './support.ts';

const c = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('comments', def);

/**
 * A call with a token of another document must be refused, and must not say more than that: the
 * problem is `forbidden` (403) or `not_found` (404), the two refusals 05 §6.1 gives a caller whose
 * token does not cover the resource's document.
 */
function refusedToOutsider(res: HttpResponse, what: string): void {
  const p = problemOf(res, what);
  check(
    (p.code === 'forbidden' && p.status === 403) || (p.code === 'not_found' && p.status === 404),
    `${what}: refused to a caller of another document (05 §6.1)`,
    'forbidden (403) or not_found (404)',
    `${p.code} (${p.status})`,
  );
}

/** A thread with one more comment on a new document, made by a commenter of that document. */
async function threadOf(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const { token } = await ctx.token('commenter', { [doc]: 'commenter' });
  const content = await readContent(ctx, token, doc);
  const from = posIn(content.doc, IDS.intro);
  const made = await ctx.service.as(token, 'POST', `/documents/${doc}/threads`, {
    body: {
      target: { range: { from, to: from + 1, baseSeq: content.seq } },
      comment: { body: 'kit' },
    },
  });
  equal(made.status, 201, 'POST /documents/{id}/threads as a commenter');
  const tid = (made.json as { id?: unknown }).id;
  check(typeof tid === 'string', 'the created thread has an id', 'a string', made.json);
  const added = await ctx.service.as(token, 'POST', `/threads/${tid}/comments`, {
    body: { body: 'a second comment' },
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
  pending: 'PRO-120: only the bare-identifier rule so far; the rest is phase 2',
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
            ['POST', `/threads/${t.tid}/comments`, { body: { body: 'from another document' } }],
            ['PATCH', `/comments/${t.cid}`, { body: { body: 'changed' }, headers: any }],
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
  ],
};
