/**
 * Listening on a port the system chooses (`port: 0`) without ending up on a port that `fetch`, a
 * WebSocket client and a browser refuse to talk to.
 *
 * The Fetch standard blocks a list of ports ("bad ports", https://fetch.spec.whatwg.org/#port-blocking):
 * a request to one fails before anything is sent. Most are below 1024, nineteen are not, and an
 * operating system may hand those out as free ports. On Windows the dynamic range can start at
 * 1024 (`netsh int ipv4 show dynamicport tcp`). It does on the development machine, where it is
 * 1024 to 15000 and so holds all nineteen; a service that got one had every call to it fail with
 * `bad port`. So a port the system chose that is on the list is given back, and another is taken.
 * A port the operator named is the operator's choice and is never changed.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The ports from 1024 up that the Fetch standard blocks. */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** The most binds before the last port is kept whatever it is; each is blocked with a small chance. */
const ATTEMPTS = 20;

/**
 * `server.listen(port, host)`. With `port` 0 it listens again while the port the system chose is
 * one that `refused` names; by default those are the ports `fetch` blocks.
 */
export async function listenOn(
  server: Server,
  port: number,
  host: string,
  refused: (port: number) => boolean = (p) => FETCH_BLOCKED_PORTS.has(p),
): Promise<AddressInfo> {
  for (let attempt = 1; ; attempt++) {
    let failed: (e: Error) => void = () => {};
    await new Promise<void>((resolve, reject) => {
      failed = reject;
      server.once('error', failed);
      server.listen(port, host, () => resolve());
    });
    const address = server.address() as AddressInfo;
    if (port !== 0 || attempt >= ATTEMPTS || !refused(address.port)) return address;
    // The listener of the port that is kept stays, as it did before this function existed; the
    // one of a port that is given back goes with it.
    server.off('error', failed);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
