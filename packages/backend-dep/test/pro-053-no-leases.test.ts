// A client whose server does not announce `leases` calls no lease route (PRO-053 criterion 5;
// 05 section 1 rule 4; 07 section 10). The client asks for `leases` in hello, as a host that wants
// region leases would, and the server's welcome leaves it out. The test then checks the wire: no
// request to a `/lease` route, and no `leases` port on the backend. A second run announces the
// feature, so that the check is not vacuous. In-memory network, Node.js only.
import { describe, expect, it } from 'vitest';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const BASE = ['presence', 'regions', 'suggest-enforced'];

function setup(features: string[]) {
  const server = new MockDepServer({
    welcome: (d) => ({ ...d, features }),
  });
  const net = new MemoryNetwork(server);
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const b: DepBackend = createDepBackend({
    endpoint: server.endpoint,
    getToken: async () => server.mintToken(USERS.editor, { [docId]: 'editor' }),
    features: [...BASE, 'leases'],
    platform: { random: () => 0, ...net.platform() },
  });
  return { server, net, docId, b };
}

describe('a server that does not announce leases (PRO-053 criterion 5)', () => {
  it('makes no lease request and offers no leases port', async () => {
    const s = setup(BASE);
    await s.b.connect();
    expect(s.b.features.has('leases')).toBe(false);
    expect(s.b.leases).toBeUndefined();
    const leaseCalls = s.net.requests.filter((r) => r.url.includes('/lease'));
    expect(leaseCalls).toEqual([]);
    const leaseFrames = s.net.decoded('c2s').filter((f) => String(f['t']).includes('lease'));
    expect(leaseFrames).toEqual([]);
    await s.b.close();
  });

  it('is not vacuous: when the server announces leases, the port is there', async () => {
    const s = setup([...BASE, 'leases']);
    await s.b.connect();
    expect(s.b.features.has('leases')).toBe(true);
    expect(s.b.leases).toBeDefined();
    await s.b.close();
  });
});
