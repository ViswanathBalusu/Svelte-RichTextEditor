/**
 * Which room host should own a document (BE-060; 06 §2.1, §6). Each document is routed to one host
 * by rendezvous (highest-random-weight) hashing over the hosts that hold a live node lease. The
 * rules this module holds:
 *
 * - The route is a hint. Ownership is decided by the epoch check of BE-017, never by this module;
 *   a host that is named here still has to win the epoch to own the room.
 * - Routing depends only on the document identifier and the set of live hosts. When a host joins
 *   or leaves, only the documents whose highest score moves change owner, and they move to or from
 *   that host alone.
 * - "Live" means the node lease store reports the host alive (BE-018, judged by the database clock).
 *
 * This module has no tie to a transport: the bus and forwarding are BE-059 and BE-062.
 */
import { createHash } from 'node:crypto';
import type { NodeLeaseStore } from '../storage/types.ts';

/** The score of a host for a document: the first eight bytes of SHA-256 over both names. */
export function rendezvousScore(doc: string, host: string): bigint {
  const digest = createHash('sha256')
    .update(doc, 'utf8')
    .update('\0', 'utf8')
    .update(host, 'utf8')
    .digest();
  return digest.readBigUInt64BE(0);
}

/**
 * The host that should try to own `doc` among `hosts`: the one with the highest score, ties broken
 * by the host's name. Throws when there is no host to route to.
 */
export function routeDocument(doc: string, hosts: readonly string[]): string {
  if (hosts.length === 0) throw new RangeError('no live room host to route to');
  let best: string | undefined;
  let bestScore = -1n;
  for (const host of new Set(hosts)) {
    const s = rendezvousScore(doc, host);
    if (best === undefined || s > bestScore || (s === bestScore && host < best)) {
      best = host;
      bestScore = s;
    }
  }
  return best!;
}

/** The candidate hosts whose node lease the store reports alive, in the order given. */
export async function liveRoomHosts(
  candidates: readonly string[],
  leases: Pick<NodeLeaseStore, 'alive'>,
): Promise<string[]> {
  const alive = await Promise.all(candidates.map((h) => leases.alive(h)));
  return candidates.filter((_, i) => alive[i]);
}
