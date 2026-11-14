/**
 * The socket closes when the page is hidden (PRO-019 criterion 5; 05 §4). The page's `pagehide`
 * event is dispatched on the real window in each browser (Chromium, Firefox, WebKit under
 * `pnpm test:browsers`); the socket is the in-memory network of test/support. Under Node.js there
 * is no window, so the suite is skipped there.
 */
import { describe, expect, it } from 'vitest';
import { createDepBackend, type DepBackend, type DepBackendOptions } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// The browser's window. The Node.js test config has no DOM lib (tsconfig.test.json), so only the
// one member this file uses is declared; in Node.js the value is absent and the suite is skipped.
declare const window: { dispatchEvent(event: Event): boolean };

const inBrowser = typeof window !== 'undefined' && typeof window.dispatchEvent === 'function';

function backendOnMemoryNetwork(): { make(): DepBackend } {
  const server = new MockDepServer();
  const net = new MemoryNetwork(server);
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const options: DepBackendOptions = {
    endpoint: server.endpoint,
    getToken: async () => server.mintToken(USERS.editor, { [docId]: 'editor' }),
    // No jitter, so the reconnect after the close is immediate.
    platform: { random: () => 0, ...net.platform() },
  };
  return { make: () => createDepBackend(options) };
}

describe.skipIf(!inBrowser)('the socket closes when the page is hidden (PRO-019)', () => {
  it('closes on pagehide, reports a lost connection and reconnects', async () => {
    const net = backendOnMemoryNetwork();
    const b = net.make();
    await b.connect();
    expect(b.connection.status).toBe('online');

    const seen: string[] = [];
    b.connection.onStatus((st) => seen.push(st));
    window.dispatchEvent(new Event('pagehide'));

    await until(() => seen.includes('reconnecting'), 'the socket to close after pagehide');
    await until(() => b.connection.status === 'online', 'the reconnect after the page was hidden');
    await b.close();
  });

  it('stops listening for pagehide once the backend is closed', async () => {
    const net = backendOnMemoryNetwork();
    const b = net.make();
    await b.connect();
    await b.close();
    expect(b.connection.status).toBe('offline');

    window.dispatchEvent(new Event('pagehide'));
    await sleep(30);
    expect(b.connection.status).toBe('offline');
  });
});
