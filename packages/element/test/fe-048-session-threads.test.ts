// FE-048 criterion 1 through the session (02 §5.2; 05 §6.2): the session hands the backend's comment
// port to the core when both sides support `comments`, the core lists the threads at the seq of the
// content it holds, and the range is drawn from the answer. The core is the real one (coreHost); the
// backend is the mock service's with a comment port added, because the mock has none.
import type { Backend, CommentsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import { coreHost, until } from './core-host.ts';
import { backendFor, service } from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);
const THREAD = '0190f000-0000-7000-8000-000000000481';

function withComments(backend: Backend, port: Partial<CommentsPort>, announce: boolean): Backend {
  const features = new Set([...backend.features, ...(announce ? ['comments'] : [])]);
  return new Proxy(backend, {
    get(target, key) {
      if (key === 'comments') return port;
      if (key === 'features') return features;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('FE-048: the session gives the core the comment port', () => {
  it('lists the threads at the content seq and draws the range', async () => {
    const { service: s, docId } = service();
    const queries: unknown[] = [];
    const port = {
      threads: async (_doc: string, query?: { seq?: number }) => {
        queries.push(query);
        return {
          items: [
            {
              id: THREAD,
              state: 'open',
              target: { range: { from: 3, to: 8, baseSeq: query?.seq ?? 0 } },
            },
          ],
          nextCursor: null,
        };
      },
    } as unknown as Partial<CommentsPort>;
    const host = coreHost();
    const backend = withComments(backendFor(s, docId, 'editor', 'editor'), port, true);
    const session = new Session({ docId, backend, ownsBackend: false, host, scheduler: immediate });
    await session.start();
    const core = host.cores[0]!;
    await until(() => core.threadRanges.get().length === 1, 'the thread range');
    expect(core.threadRanges.get()[0]).toMatchObject({
      id: THREAD,
      from: 3,
      to: 8,
      detached: false,
    });
    expect(queries).toHaveLength(1);
    expect(typeof (queries[0] as { seq: number }).seq).toBe('number');
    session.close();
  });

  it('does not list when the feature is not announced', async () => {
    const { service: s, docId } = service();
    let listed = 0;
    const port = {
      threads: async () => {
        listed++;
        return { items: [], nextCursor: null };
      },
    } as unknown as Partial<CommentsPort>;
    const host = coreHost();
    const backend = withComments(backendFor(s, docId, 'editor', 'editor'), port, false);
    const session = new Session({ docId, backend, ownsBackend: false, host, scheduler: immediate });
    await session.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(listed).toBe(0);
    expect(host.cores[0]!.threadRanges.get()).toEqual([]);
    session.close();
  });
});
