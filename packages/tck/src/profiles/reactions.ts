/**
 * The `reactions` profile (05 §6.2; 13 §5; ADR 0424; PRO-045). A reaction is addressed by the
 * comment's bare identifier, so a caller whose token covers another document is refused, and
 * nothing the caller tried changes the comment.
 */
import { equal, jsonEqual } from '../assert.ts';
import { scenario, type ProfileDef } from '../scenario.ts';
import { refusedToOutsider, threadOf } from './comments.ts';

export const REACTIONS: ProfileDef = {
  id: 'reactions',
  title: 'Reactions to comments',
  spec: '05 §6.2; 13 §5',
  stories: ['PRO-045'],
  requires: { kind: 'features', features: ['reactions'] },
  scenarios: [
    scenario('reactions', {
      id: 'identifiers',
      title: 'a reaction to a comment is refused to a caller whose token covers another document',
      spec: '05 §6.1; 10 §3.2',
      covers: {
        operations: [
          'POST /comments/{cid}/reactions/{reaction}',
          'DELETE /comments/{cid}/reactions/{reaction}',
        ],
      },
      async run(ctx) {
        const t = await threadOf(ctx);
        const path = `/comments/${t.cid}/reactions/thumbsUp`;
        const before = await ctx.service.as(t.token, 'GET', `/threads/${t.tid}`);
        equal(before.status, 200, 'GET /threads/{tid} as a commenter of its document');
        // The outsider owns another document, so only the document check can refuse them.
        const other = await ctx.document();
        const { token: outsider } = await ctx.token('outsider', { [other]: 'owner' });
        for (const method of ['POST', 'DELETE'])
          refusedToOutsider(
            await ctx.service.as(outsider, method, path),
            `${method} /comments/{cid}/reactions/{reaction}`,
          );
        const after = await ctx.service.as(t.token, 'GET', `/threads/${t.tid}`);
        equal(after.status, 200, 'the thread is still there for its own document');
        jsonEqual(after.json, before.json, 'no reaction was added or taken');
      },
    }),
  ],
};
