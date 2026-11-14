// PRO-020 criterion 2 (lane V-PRO-018-034): on a channel on `pm-steps/1`, no binary frame is sent
// in either direction. The frames are read from the memory network, which records every frame the
// client sends and receives; a binary frame would reach it as something other than a string.
// Node.js only (the memory network is shared with the other backend-dep tests).
import { describe, expect, it } from 'vitest';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { IDS, USERS, contractDocument, insertText, posIn } from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

function rig() {
  const dep = new MockDepServer();
  const net = new MemoryNetwork(dep);
  const docId = dep.service.createDocument(contractDocument(), { grants: [] });
  const make = (): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
  return { net, docId, make };
}

describe('no binary frame on pm-steps/1 (PRO-020 criterion 2)', () => {
  it('sends and receives text frames only while commits are exchanged', async () => {
    const s = rig();
    const b = s.make();
    try {
      await b.connect();
      const content = await b.sync.loadContent(s.docId);
      const ch = await b.sync.open(s.docId, {
        resume: { seq: content.seq, incarnation: content.incarnation },
      });
      let base = content.seq;
      for (const [i, text] of ['a', 'bc', 'def'].entries()) {
        const ack = await ch.submit({
          id: `0192f0c4-0000-7000-8000-00000000020${i}`,
          base,
          steps: [insertText(posIn(content.doc, IDS.intro), text)],
        });
        base = ack.seq;
      }
      // The engine on the wire is pm-steps/1, so the check is about that channel.
      expect(s.net.frames.some((f) => f.text.includes('pm-steps/1'))).toBe(true);
      expect(s.net.frames.length).toBeGreaterThan(0);
      for (const f of s.net.frames) expect(typeof f.text).toBe('string');
    } finally {
      await b.close();
    }
  });
});
