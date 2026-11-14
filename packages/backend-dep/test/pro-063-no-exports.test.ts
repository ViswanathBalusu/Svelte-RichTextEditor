// A client whose server does not announce `exports` calls no export route (PRO-063 criterion 3;
// 05 section 1 rule 4; 05 section 6.2). Lane V-PRO-052-068 round 3. The client asks for `exports`
// in hello, as an editor host that offers exports would, and the server's welcome leaves it out.
// The test checks the wire: no request to an `/exports` route, and no `exports` port on the
// backend. A second run announces the feature, so that the check is not vacuous. In-memory
// network, Node.js only.
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
    features: [...BASE, 'exports'],
    platform: { random: () => 0, ...net.platform() },
  });
  return { server, net, docId, b };
}

describe('a server that does not announce exports (PRO-063 criterion 3)', () => {
  it('makes no export request and offers no exports port', async () => {
    const s = setup(BASE);
    await s.b.connect();
    expect(s.b.features.has('exports')).toBe(false);
    expect(s.b.exports).toBeUndefined();
    const exportCalls = s.net.requests.filter((r) => r.url.includes('/exports'));
    expect(exportCalls).toEqual([]);
    await s.b.close();
  });

  it('is not vacuous: when the server announces exports, the port is there', async () => {
    const s = setup([...BASE, 'exports']);
    await s.b.connect();
    expect(s.b.features.has('exports')).toBe(true);
    expect(s.b.exports).toBeDefined();
    await s.b.close();
  });
});
