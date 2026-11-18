// Several data planes over one set of stores, joined by a bus (BE-061, BE-062, BE-063).
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { routeDocument } from '../../src/control-plane/room-routing.ts';
import { MemoryNodeLeases } from '../../src/data-plane/memory-ports.ts';
import type { Bus } from '../../src/data-plane/bus.ts';
import type { DataPlaneDeps } from '../../src/seams.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { MemoryCheckpoints, startPlane, type Plane } from './support.ts';

export const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** Test values of the forwarding and the lease: short, so that a test is quick. */
export const FAST_FORWARDING = {
  retain: 1000,
  repairMs: 30,
  maxNacks: 8,
  retryInMs: 500,
  heartbeatMs: 50,
  silenceMs: 800,
  openTimeoutMs: 2000,
  ownerWatchMs: 100,
} as const;

export interface Cluster {
  readonly mem: MemoryStore;
  readonly leases: MemoryNodeLeases;
  readonly checkpoints: MemoryCheckpoints;
  readonly tenant: string;
  readonly planes: Map<string, Plane>;
  start(
    node: string,
    bus: Bus | undefined,
    forwarding?: Record<string, number>,
    extra?: Partial<DataPlaneDeps>,
  ): Promise<Plane>;
  close(): Promise<void>;
}

export function cluster(): Cluster {
  const mem = new MemoryStore();
  const leases = new MemoryNodeLeases();
  const checkpoints = new MemoryCheckpoints();
  const tenant = crypto.randomUUID();
  const planes = new Map<string, Plane>();
  return {
    mem,
    leases,
    checkpoints,
    tenant,
    planes,
    async start(node, bus, forwarding = {}, extra = {}) {
      const p = await startPlane({
        stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
        checkpoints,
        tenant,
        node,
        deps: {
          leases,
          address: `ws://${node}.test/dep`,
          ...(bus ? { bus } : {}),
          forwarding: { ...FAST_FORWARDING, ...forwarding },
          ...extra,
        },
        settings: { lease: { durationMs: 800, renewMs: 100, marginMs: 100 } },
      });
      planes.set(node, p);
      if (!(await p.plane.ready())) throw new Error(`${node} could not take its lease`);
      return p;
    },
    async close() {
      for (const p of planes.values()) await p.close();
      planes.clear();
    },
  };
}

/** A seeded generator, so that a run of faults can be repeated. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A document that rendezvous routing names `owner` for, among `nodes`, created through `p`. */
export async function docFor(
  p: Plane,
  owner: string,
  nodes: readonly string[] = ['node-a', 'node-b'],
): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const doc = await p.createDocument();
    if (routeDocument(doc, nodes) === owner) return doc;
  }
  throw new Error('no document routes to ' + owner);
}
