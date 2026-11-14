// PRO-016 criterion 5 (lane V-PRO-001-017): a revoked socket session makes backend-dep ask getToken
// for a new token, and a failure raises onAuthRequired (the element's de-auth-required). Node.js only.
import { describe, expect, it } from 'vitest';
import { createDepBackend } from '../src/index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function rig(failAfterFirst: () => boolean) {
  const server = new MockDepServer();
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const net = new MemoryNetwork({
    accept: (s) => server.accept(s),
    http: (req) => server.http(req),
  });
  let calls = 0;
  const b = createDepBackend({
    endpoint: server.endpoint,
    getToken: async () => {
      calls += 1;
      if (calls > 1 && failAfterFirst()) throw new Error('no session for this user');
      return server.mintToken(USERS.editor, { [docId]: 'editor' });
    },
    platform: net.platform(),
  });
  return { server, b, calls: () => calls };
}

describe('revoked socket session asks getToken (PRO-016 criterion 5)', () => {
  it('calls getToken again after auth.revoked and does not raise when it succeeds', async () => {
    const r = rig(() => false);
    const events: string[] = [];
    r.b.auth.onAuthRequired((e) => events.push(e.code));
    await r.b.connect();
    expect(r.calls()).toBe(1);
    await r.server.service.revokeSessions(USERS.editor.sub);
    await until(() => r.calls() === 2, 'the getToken call after the revocation');
    await sleep(20);
    expect(r.b.connection.status).toBe('offline');
    expect(events).toEqual([]);
    await r.b.close();
  });

  it('raises onAuthRequired when getToken fails after the revocation', async () => {
    const r = rig(() => true);
    const events: string[] = [];
    r.b.auth.onAuthRequired((e) => events.push(e.code));
    await r.b.connect();
    await r.server.service.revokeSessions(USERS.editor.sub);
    await until(() => events.length === 1, 'onAuthRequired after a failed getToken');
    expect(events).toEqual(['unauthenticated']);
    expect(r.calls()).toBe(2);
    expect(r.b.connection.status).toBe('offline');
    await r.b.close();
  });
});
