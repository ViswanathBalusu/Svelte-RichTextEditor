// A service on a port the system chose is reachable with fetch (BE-001): a chosen port that fetch
// blocks is given back and another is taken, and a port the operator named is kept.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FETCH_BAD_PORTS } from '../test/support/ports.ts';
import { FETCH_BLOCKED_PORTS, listenOn } from './listen.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((done) => {
      s.close(() => done());
      s.closeAllConnections();
    });
});
const server = (): Server => {
  const s = createServer((_req, res) => void res.end('ok'));
  servers.push(s);
  return s;
};

describe('listening on a port the system chooses', () => {
  it('keeps a port that is not blocked', async () => {
    const s = server();
    const asked: number[] = [];
    const address = await listenOn(s, 0, '127.0.0.1', (p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toEqual([address.port]);
    expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe('ok');
  });

  it('gives a blocked port back and takes another, on which it answers', async () => {
    const s = server();
    const refusedOnce: number[] = [];
    // The first two ports the system chooses count as blocked here, whatever they are.
    const address = await listenOn(s, 0, '127.0.0.1', (p) => {
      if (refusedOnce.length < 2) {
        refusedOnce.push(p);
        return true;
      }
      return false;
    });
    expect(refusedOnce).toHaveLength(2);
    expect(s.listening).toBe(true);
    expect((s.address() as { port: number }).port).toBe(address.port);
    expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe('ok');
  });

  it('never changes a port the operator named', async () => {
    // A free port, found by asking for one and giving it back.
    const probe = server();
    const { port } = await listenOn(probe, 0, '127.0.0.1');
    await new Promise<void>((done) => probe.close(() => done()));
    const s = server();
    const asked: number[] = [];
    const address = await listenOn(s, port, '127.0.0.1', (p) => {
      asked.push(p);
      return true;
    });
    expect(address.port).toBe(port);
    expect(asked).toEqual([]);
  });

  it('stops after twenty binds and keeps the last port, so a start never hangs', async () => {
    const s = server();
    let asked = 0;
    const address = await listenOn(s, 0, '127.0.0.1', () => {
      asked++;
      return true;
    });
    // Nineteen ports were given back; the twentieth is kept without asking.
    expect(asked).toBe(19);
    expect(s.listening).toBe(true);
    expect(address.port).toBeGreaterThan(0);
  });

  it('reports a port that is taken as an error', async () => {
    const taken = server();
    const { port } = await listenOn(taken, 0, '127.0.0.1');
    await expect(listenOn(server(), port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});

describe('the ports that fetch blocks', () => {
  it('are ports this runtime refuses before it sends anything', async () => {
    // The check comes before any connection is made, so nothing needs to listen on these ports.
    for (const port of FETCH_BLOCKED_PORTS) {
      const failure = await fetch(`http://127.0.0.1:${port}/`).then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string } },
      );
      expect(failure?.cause?.message, String(port)).toBe('bad port');
    }
  });

  it('are the list the test helpers use', () => {
    expect([...FETCH_BLOCKED_PORTS].sort((a, b) => a - b)).toEqual(
      [...FETCH_BAD_PORTS].sort((a, b) => a - b),
    );
  });
});
