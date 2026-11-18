// The export targets the deployment announces (UX-101; ADR 0382, option 1): the exports port reads
// `exportTargets` from the discovery document, and says null when the deployment does not say.
// Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import { createDepBackend, type DepBackend } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';
import { FileServer } from '../test/support/file-server.ts';

function backend(announced: readonly string[] | undefined): { b: DepBackend; docId: string } {
  const dep = new MockDepServer({
    welcome: (d) => ({
      ...d,
      features: [
        ...new Set([...((d['features'] as string[] | undefined) ?? []), 'assets', 'exports']),
      ],
    }),
    discovery: (d) => ({
      ...d,
      features: [...new Set([...(d['features'] as string[]), 'assets', 'exports'])],
      ...(announced ? { exportTargets: [...announced] } : {}),
    }),
  });
  const files = new FileServer(dep);
  const net = new MemoryNetwork(files);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const b = createDepBackend({
    endpoint: dep.endpoint,
    getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
    features: ['presence', 'regions', 'suggest-enforced', 'assets', 'exports'],
    platform: { random: () => 0, ...net.platform() },
  });
  return { b, docId };
}

describe('the exports port announces the targets of discovery (UX-101)', () => {
  it('lists the targets of the discovery document once connected', async () => {
    const { b } = backend(['pdf', 'tex']);
    await b.connect();
    expect(b.exports!.targets!()).toEqual(['pdf', 'tex']);
    await b.close();
  });

  it('two deployments with different lists give different lists', async () => {
    const one = backend(['pdf']);
    const two = backend(['pdf', 'tex', 'docx']);
    await one.b.connect();
    await two.b.connect();
    expect(one.b.exports!.targets!()).toEqual(['pdf']);
    expect(two.b.exports!.targets!()).toEqual(['pdf', 'tex', 'docx']);
    await one.b.close();
    await two.b.close();
  });

  it('is null when the deployment does not say', async () => {
    const { b } = backend(undefined);
    await b.connect();
    expect(b.exports!.targets!()).toBeNull();
    await b.close();
  });
});
