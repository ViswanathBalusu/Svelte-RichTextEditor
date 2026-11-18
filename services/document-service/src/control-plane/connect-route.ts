/**
 * `GET /documents/{id}/connect` (05 §6.2; 06 §2.1; BE-061). It tells a client the WebSocket URL of
 * the node that owns the document, so that in the normal case a channel lands where its room lives
 * and nothing is forwarded.
 *
 * The rules this module holds (owner decision 200 of 2026-11-15; ADR 0243):
 *
 * - The address of a node is the one it wrote on its own lease row. A node whose lease has expired
 *   is not live, so its address is never offered.
 * - When the head of the document names an owner that holds a live lease, the hint names that
 *   owner (`source: 'owner'`). Otherwise it names the host that rendezvous routing picks over the
 *   live nodes (`source: 'routing'`), as 06 §2.1 says for a document with no owner.
 * - A node that announced no address cannot be named by URL: the hint then carries the address of
 *   the service itself (`source: 'entry'`, the `ws` of the discovery document), which is how a
 *   single node, or a deployment behind one load balancer, is reached.
 * - The hint is not ownership. It carries no epoch and grants nothing; the channel still wins the
 *   room through the epoch check (BE-017), and one that lands on another node is forwarded
 *   (BE-062). A stale hint costs latency only.
 * - The caller needs `view` on the document (the row that reads the document at its head).
 */
import { json, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { Placement } from './room-routing.ts';

/** The reply of the route. */
export interface ConnectHint {
  url: string;
  node: string;
  source: 'owner' | 'routing' | 'entry';
}

/** The node that should receive a channel for `doc`, with the reason; null when none is live. */
export async function chooseNode(
  placement: Placement,
  owner: string | null,
  doc: string,
  region?: string | null,
): Promise<{ node: string; address: string | null; source: 'owner' | 'routing' } | null> {
  const live = await placement.hosts();
  const own = owner === null ? undefined : live.find((h) => h.node === owner);
  if (own) return { node: own.node, address: own.address, source: 'owner' };
  const routed = await placement.route(doc, region);
  return routed ? { node: routed.node, address: routed.address, source: 'routing' } : null;
}

export function connectRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  /** The service's own WebSocket address: the `ws` of the discovery document. */
  const entry = (): string => {
    const ws = new URL(d.wsPath, d.publicUrl);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    return ws.toString();
  };

  const getConnect: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.head', doc);
    const ref = k.refOf(ctx, doc);
    await k.liveDocument(ctx, doc);
    const hint = (h: ConnectHint) => json(200, h, { 'Cache-Control': 'private, no-store' });
    if (!d.placement) return hint({ url: entry(), node: '', source: 'entry' });
    const head = await d.logs.head(ref);
    const region = d.homeRegions ? await d.homeRegions.resolve(ref) : null;
    const chosen = await chooseNode(d.placement, head.owner, doc, region);
    // A document with a home region is never offered an address outside it (BE-074 criterion 4).
    if (region !== null && !chosen)
      throw new ApiError('unavailable', `no live node in the home region ${region}`);
    if (!chosen || chosen.address === null)
      return hint({ url: entry(), node: chosen?.node ?? '', source: 'entry' });
    return hint({ url: chosen.address, node: chosen.node, source: chosen.source });
  };

  return { getConnect };
}
