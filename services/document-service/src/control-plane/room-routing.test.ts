// Routing a document to one room host by rendezvous hashing (BE-060 criteria 1 and 2). The routing
// function is the subject; the lease store is a stub. The epoch check (BE-017), the bus (BE-059)
// and forwarding (BE-062) are not built here.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { liveRoomHosts, routeDocument } from './room-routing.ts';

const HOSTS = ['room-1', 'room-2', 'room-3', 'room-4', 'room-5', 'room-6'] as const;
const hostSetArb = fc.subarray([...HOSTS], { minLength: 1 });
const docArb = fc.string({ minLength: 1, maxLength: 24 });

describe('a document is routed to a live host (BE-060 criterion 1)', () => {
  it('names one of the hosts it was given, the same way every time and in any order', () => {
    fc.assert(
      fc.property(docArb, hostSetArb, (doc, hosts) => {
        const owner = routeDocument(doc, hosts);
        expect(hosts).toContain(owner);
        expect(routeDocument(doc, [...hosts].reverse())).toBe(owner);
        expect(routeDocument(doc, hosts)).toBe(owner);
      }),
    );
  });

  it('refuses to route when no host is live', () => {
    expect(() => routeDocument('d', [])).toThrow(RangeError);
  });

  it('keeps only the hosts whose node lease is alive, in the order given', async () => {
    const alive = new Set(['room-2', 'room-5']);
    const leases = { alive: async (h: string) => alive.has(h) };
    expect(await liveRoomHosts(['room-1', 'room-2', 'room-5'], leases)).toEqual([
      'room-2',
      'room-5',
    ]);
    expect(await liveRoomHosts([], leases)).toEqual([]);
  });
});

describe('a host joining or leaving moves only the documents that hash to it (BE-060 criterion 2)', () => {
  it('moves a document to a joining host only when that host becomes its owner', () => {
    fc.assert(
      fc.property(docArb, hostSetArb, fc.constantFrom(...HOSTS), (doc, hosts, joiner) => {
        const before = routeDocument(doc, hosts);
        const after = routeDocument(doc, [...new Set([...hosts, joiner])]);
        if (after !== before) expect(after).toBe(joiner);
      }),
    );
  });

  it('moves a document away from a leaving host only when that host owned it', () => {
    fc.assert(
      fc.property(docArb, hostSetArb, (doc, hosts) => {
        fc.pre(hosts.length > 1);
        const before = routeDocument(doc, hosts);
        const leaving = hosts[0]!;
        const rest = hosts.slice(1);
        const after = routeDocument(doc, rest);
        if (before !== leaving) expect(after).toBe(before);
        else expect(rest).toContain(after);
      }),
    );
  });
});
