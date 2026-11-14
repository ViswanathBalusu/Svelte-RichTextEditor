/**
 * Ports that fetch and WebSocket refuse ("bad port", Fetch standard, port blocking), at or above
 * 1024. A server on port 0 gets a port the system chooses, and a system whose dynamic range starts
 * at 1024 (the Windows default on some machines: `netsh int ipv4 show dynamicport tcp`) can hand
 * out one of these, which makes every call to the server fail with `bad port`. The helpers here
 * choose again until the port is one fetch accepts.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** Whether fetch refuses the port of `url`. */
export function hasBadPort(url: string): boolean {
  return FETCH_BAD_PORTS.has(Number(new URL(url).port));
}

/** The most attempts before giving up; each lands on a bad port with a small chance only. */
const ATTEMPTS = 20;

/**
 * Starts something on a port the system chooses, again while that port is one fetch refuses.
 * `start` makes a fresh start each time; `close` undoes a start that landed on a bad port.
 */
export async function startOnFetchablePort<T>(
  start: () => Promise<T>,
  urlOf: (started: T) => string,
  close: (started: T) => Promise<unknown>,
): Promise<T> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const started = await start();
    if (!hasBadPort(urlOf(started))) return started;
    await close(started);
  }
  throw new Error(`no port that fetch accepts after ${ATTEMPTS} attempts`);
}

/** `server.listen(0, host)`, again while the port is one fetch refuses; returns the port. */
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
    if (!FETCH_BAD_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`no port that fetch accepts after ${ATTEMPTS} attempts`);
}
