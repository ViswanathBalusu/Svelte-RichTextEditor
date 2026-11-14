// PRO-010 criterion 4 (05 §3.1, §4, §6.2; BE-029): when `backend-dep` connects or calls REST, the
// user token travels only in the `hello` frame and in the `Authorization: Bearer` header, and no
// URL it requests or opens carries it. This file covers connecting, opening a channel, committing
// and reading the permission resources. `auth.refresh` also carries the token, by design (PRO-014),
// and is outside this criterion, so it is not exercised here.
import { describe, expect, it } from 'vitest';
import { createDepBackend } from '../src/index.ts';
import {
  IDS,
  LEGAL_GRANT,
  USERS,
  contractDocument,
  insertText,
  posIn,
} from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('the token on connect and REST (PRO-010 criterion 4)', () => {
  it('appears only in hello and in Authorization headers, never in a URL or another frame', async () => {
    const server = new MockDepServer();
    const net = new MemoryNetwork(server);
    const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const tokens: string[] = [];
    const b = createDepBackend({
      endpoint: server.endpoint,
      getToken: async () => {
        const t = server.mintToken(USERS.owner, { [docId]: 'owner' });
        tokens.push(t);
        return t;
      },
      platform: { random: () => 0, ...net.platform() },
    });

    await b.connect();
    const content = await b.sync.loadContent(docId);
    const ch = await b.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    let live = false;
    ch.onState((s) => {
      if (s.status === 'live') live = true;
    });
    for (let waited = 0; !live; waited += 5) {
      if (waited > 3000) throw new Error('timed out waiting for live');
      await sleep(5);
    }
    await ch.submit({
      id: '0192f0c4-0000-7000-8000-000000000001',
      base: content.seq,
      steps: [insertText(posIn(content.doc, IDS.intro), 'x')],
    });
    await b.permissions.regions!(docId);
    await b.permissions.grants!(docId);
    await b.close();

    expect(tokens.length).toBeGreaterThan(0);
    let inHello = 0;
    for (const f of net.frames)
      for (const t of tokens)
        if (f.text.includes(t)) {
          expect(f.dir).toBe('c2s');
          expect((JSON.parse(f.text) as { t: string }).t).toBe('hello');
          inHello++;
        }
    expect(inHello).toBeGreaterThan(0);
    let inHeader = 0;
    for (const r of net.requests) {
      for (const t of tokens) expect(r.url.includes(t), r.url).toBe(false);
      for (const [k, v] of Object.entries(r.headers))
        for (const t of tokens)
          if (v.includes(t)) {
            expect(k).toBe('authorization');
            expect(v).toBe(`Bearer ${t}`);
            inHeader++;
          }
    }
    expect(inHeader).toBeGreaterThan(0);
    for (const sock of net.sockets)
      for (const t of tokens) expect(sock.url.includes(t)).toBe(false);
  });
});
