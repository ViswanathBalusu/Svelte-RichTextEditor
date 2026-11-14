/**
 * SEC-032 criterion 4 (lane SEC-027-039): a pinned, cacheable content read by a user below the
 * visibility gate is refused, even when a shared copy of the same state is held (10 §3.3; 06 §7;
 * BE-075; ADR 0019 SR-C4).
 *
 * The subject is the real `PinnedCache` (services/document-service/src/control-plane/pinned-cache.ts)
 * with the real gate (`gateOf`, `stateAllowed` of data-plane/gate.ts). The copies are made by a
 * reader that may see every state (the warm-up), and every later request uses the same visibility
 * class, so the cache key cannot tell the readers apart: only the per-request check can. The home
 * region, the switch and the routes are stubs; this proves the cache's use of the gate, not the route.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  HISTORY_VISIBILITIES,
  type HistoryVisibility,
  type RoomConnection,
} from '@docedit/authority';
import {
  PinnedCache,
  type PinnedRequest,
} from '../../../services/document-service/src/control-plane/pinned-cache.ts';
import {
  gateOf,
  stateAllowed,
  type StoredState,
} from '../../../services/document-service/src/data-plane/gate.ts';
import { CAROL, FRANK, fieldsDoc, permissions } from './support/authority-fixtures.ts';

const HEAD = 10;
/** Commit `seq` was stored at `seq * 1000` ms. */
const LOG = Array.from({ length: HEAD }, (_, i) => ({ seq: i + 1, time: (i + 1) * 1000 }));
const TENANT = 'tenant-pinned';
const DOC = 'doc-pinned';

/** A commenter: holds `comment` on the body and no `edit` anywhere. */
const COMMENTER: RoomConnection = {
  sub: 'cora',
  session: 's-cora',
  role: 'commenter',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

/** The readers the test asks as. `warm` stands for a copy made by a user who may see every state. */
const READERS: Record<string, RoomConnection> = {
  viewer: FRANK,
  commenter: COMMENTER,
  editor: CAROL,
  warm: CAROL,
};

function stored(setting: HistoryVisibility): StoredState {
  return {
    setting,
    head: fieldsDoc(),
    headSeq: HEAD,
    perms: permissions(),
    log: LOG,
    now: 0,
  };
}

const bodyOf = (seq: number) => new TextEncoder().encode(`state ${seq}`);

function request(reader: string, seq: number): PinnedRequest {
  return {
    resource: { kind: 'content', doc: { tenant: TENANT, doc: DOC }, seq },
    visibilityClass: 'full',
    restricted: false,
    reader,
  };
}

/** A cache whose check is the gate of the reader's connection, and whose home region counts reads. */
function rig(setting: HistoryVisibility) {
  const s = stored(setting);
  const homeReads: number[] = [];
  const cache = new PinnedCache({
    cachingEnabled: () => true,
    authorise: async (req) => {
      if (req.resource.kind !== 'content') return false;
      if (req.reader === 'warm') return true;
      const conn = READERS[req.reader];
      if (!conn) return false;
      return stateAllowed(gateOf(conn, s), req.resource.seq, HEAD);
    },
    fromHome: async (req) => {
      if (req.resource.kind === 'content') homeReads.push(req.resource.seq);
      return bodyOf(req.resource.kind === 'content' ? req.resource.seq : 0);
    },
  });
  return { cache, homeReads };
}

describe('SEC-032 criterion 4: a copy held for the cache does not bypass the gate', () => {
  it('a viewer asking for a state the editor cached is refused, and the home region is not read', async () => {
    const { cache, homeReads } = rig('editors');
    const warmed = await cache.serve(request('warm', 3));
    expect(warmed.status === 'served' && warmed.from).toBe('home');
    expect(cache.entries(TENANT)).toBe(1);
    const reads = homeReads.length;

    // Under `editors` a viewer reads the head only, so seq 3 is refused although the copy is held.
    expect(await cache.serve(request('viewer', 3))).toEqual({ status: 'refused' });
    expect(homeReads.length).toBe(reads);

    // The head is allowed for a viewer, so the same route serves it (from the home region here).
    const head = await cache.serve(request('viewer', HEAD));
    expect(head.status).toBe('served');
  });

  it('for every setting, role and state: a refusal is exactly where the gate refuses, and a served body is the home body', async () => {
    const settingArb = fc.constantFrom(...HISTORY_VISIBILITIES);
    const readerArb = fc.constantFrom('viewer', 'commenter', 'editor');
    const askArb = fc.tuple(readerArb, fc.integer({ min: 1, max: HEAD }));
    await fc.assert(
      fc.asyncProperty(
        settingArb,
        fc.array(askArb, { minLength: 1, maxLength: 40 }),
        async (setting, asks) => {
          const s = stored(setting);
          const { cache } = rig(setting);
          // The warm-up holds a copy of every state, so each later ask finds one to (not) serve.
          for (let seq = 1; seq <= HEAD; seq++) {
            const w = await cache.serve(request('warm', seq));
            expect(w.status).toBe('served');
          }
          expect(cache.entries(TENANT)).toBe(HEAD);

          let refusedExpected = 0;
          const refusedBefore = cache.stats.refused;
          for (const [reader, seq] of asks) {
            const allowed = stateAllowed(gateOf(READERS[reader]!, s), seq, HEAD);
            const out = await cache.serve(request(reader, seq));
            if (allowed) {
              expect(out).toEqual({ status: 'served', body: bodyOf(seq), from: 'cache' });
            } else {
              expect(out).toEqual({ status: 'refused' });
              refusedExpected++;
            }
          }
          expect(cache.stats.refused - refusedBefore).toBe(refusedExpected);
        },
      ),
      { numRuns: 150 },
    );
  });
});
