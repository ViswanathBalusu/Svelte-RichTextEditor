/**
 * A server on a port that `fetch` accepts. The Fetch standard blocks nineteen ports from 1024 up
 * ("bad port"); a system whose dynamic range starts at 1024 (Windows can) may hand one out for
 * `listen(0)`, and every call to the server then fails. This chooses again while the port is one
 * of them. It is the same list as `services/document-service/src/listen.ts`.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
const ATTEMPTS = 20;

/** `server.listen(0, host)`, again while the port is one that `fetch` blocks; returns the port. */
export async function listenOnFetchablePort(server: Server, host = '127.0.0.1'): Promise<number> {
  for (let i = 0; i < ATTEMPTS; i++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`no port that fetch accepts after ${ATTEMPTS} attempts`);
}
