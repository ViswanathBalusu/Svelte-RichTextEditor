// The close code 4500 on the data plane (PRO-037 criterion 3; lane V-PRO-035-051). A handler that
// throws is an internal failure: the session reports `internal` as a fatal error and closes with
// 4500, and the server reports the thrown error to its error sink. The verifier is the handler of
// `hello` here; a failure inside a room is answered as `unavailable` on the channel instead (the
// room catches it), so the verifier is the place a bug reaches the session's own catch. The other
// eight codes of the nine are triggered in session.test.ts, session-1b.test.ts and
// drain-handover.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const INJECTED = 'pro037 injected verifier failure';
let planes: Plane[] = [];

afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('the close code 4500 (PRO-037 criterion 3)', () => {
  it('reports internal as a fatal error and closes with 4500 when a handler throws', async () => {
    // The quota check runs in the hello handler outside any catch of its own, so a throw there
    // reaches the session's queue (`#enqueue`), which closes with 4500.
    const p = await startPlane({
      deps: {
        quotas: {
          admitConnection: () => {
            throw new Error(INJECTED);
          },
        } as never,
      },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    const c = await DepClient.connect(p.url);
    try {
      // A failure outside a reply carries no `re`, so the helper finds no answer to its hello and
      // rejects once the close arrives; the error frame itself is what the test checks.
      await c.hello(token).catch(() => undefined);
      const e = await c.take((m) => m.t === 'error', 3000, 'the internal error');
      expect(e.d).toMatchObject({ code: 'internal', fatal: true });
      expect(await c.closed.then((x) => x.code)).toBe(4500);
      // The error went to the server's error sink, and the client never saw its text.
      expect(p.errors.some((x) => x instanceof Error && x.message === INJECTED)).toBe(true);
      expect(JSON.stringify(c.log)).not.toContain(INJECTED);
    } finally {
      c.terminate();
    }
  });
});
