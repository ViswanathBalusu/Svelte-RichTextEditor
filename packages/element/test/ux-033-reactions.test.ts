// Reactions to a comment through the element's thread service and the mock backend (UX-033; 13 §5;
// ADR 0424): a reaction reaches the other client live, makes no commit, leaves out the control when
// the backend does not announce the feature, and is refused for a reader without `comment`.
import { MockService } from '@docedit/backend-mock';
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
  readonly backend: Backend;
  readonly session: Session;
}

async function join(
  mock: MockService,
  docId: string,
  sub: string,
  role: 'owner' | 'editor' | 'viewer' | 'commenter',
  announce = true,
): Promise<Client> {
  const backend = mock.backend({ sub }, { [docId]: role });
  const host = coreHost();
  const session = new Session({ docId, backend, ownsBackend: false, host, scheduler: immediate });
  await session.start();
  const service = threadsService(host.cores[0]!, {
    port: backend.comments!,
    docId,
    reactions: announce && backend.features.has('reactions'),
    self: () => `user:${sub}`,
  });
  return { service, backend, session };
}

const head = async (c: Client, docId: string): Promise<number> =>
  (await c.backend.sync.loadContent(docId)).seq;

describe('reactions through the thread service (UX-033)', () => {
  it('reach the other client live, are held once per person, and make no commit', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner');
    const eddie = await join(mock, docId, 'eddie', 'editor');
    expect(mock.features).toContain('reactions');
    const made = await olga.service.create({ target: { block: IDS.mid }, body: text('Why?') });
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : '';
    await until(() => eddie.service.list().length === 1, 'the thread on the other client');
    const before = await head(olga, docId);
    const commentId = olga.service.detail!(id)!.comments[0]!.id;

    const first = await eddie.service.react!(id, commentId, 'heart', true);
    expect(first.ok).toBe(true);
    // The same reaction again changes nothing (idempotent).
    await eddie.service.react!(id, commentId, 'heart', true);
    await until(
      () => olga.service.detail!(id)?.comments[0]?.reactions?.length === 1,
      'the reaction on the first client',
    );
    expect(olga.service.detail!(id)!.comments[0]!.reactions).toEqual([
      { reaction: 'heart', users: ['user:eddie'] },
    ]);

    await olga.service.react!(id, commentId, 'heart', true);
    await olga.service.react!(id, commentId, 'thumbsUp', true);
    const both = olga.service.detail!(id)!.comments[0]!.reactions!;
    expect(both.map((r) => [r.reaction, r.users])).toEqual([
      ['thumbsUp', ['user:olga']],
      ['heart', ['user:eddie', 'user:olga']],
    ]);

    await eddie.service.react!(id, commentId, 'heart', false);
    await until(
      () => olga.service.detail!(id)?.comments[0]?.reactions?.[1]?.users.length === 1,
      'the removal on the first client',
    );
    // No commit was made by any of it, and the comment's tag is the one it had.
    expect(await head(olga, docId)).toBe(before);
    olga.session.close();
    eddie.session.close();
  });

  it('offers no reaction when the feature is not announced', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner', false);
    expect(olga.service.react).toBeUndefined();
    olga.session.close();
  });

  it('is refused for a reader without comment, and for a comment that is gone', async () => {
    const mock = new MockService();
    const docId = mock.createDocument(contractDocument());
    const olga = await join(mock, docId, 'olga', 'owner');
    const vera = await join(mock, docId, 'vera', 'viewer');
    const made = await olga.service.create({ target: { block: IDS.mid }, body: text('Why?') });
    const id = made.ok ? made.id : '';
    await until(() => vera.service.detail!(id) !== null, 'the thread for the viewer');
    const commentId = olga.service.detail!(id)!.comments[0]!.id;
    const refused = await vera.service.react!(id, commentId, 'heart', true);
    expect(refused.ok).toBe(false);
    const gone = await olga.service.react!(id, 'no-such-comment', 'heart', true);
    expect(gone).toEqual({ ok: false, code: 'not_found' });
    olga.session.close();
    vera.session.close();
  });
});
