// HIS-037 criterion 4 through the service path (lane V-SYN-037-053, fixing the hollow test of lane
// V-HIS-033-046): the log bundle and the audit segment hold surrogate identifiers only, never the
// host's `sub` values.
//
// Two people with host subs connect over a real WebSocket to the real data plane, which resolves
// each sub through the real PgUserDirectory and stamps the commits it accepts. The bundle is then
// read from the stored rows of the PostgreSQL commit log (the same columns `PgLogStore.verify`
// reads), the audit segment is cut from it with `@docedit/history`, and both are scanned. The host
// subs are inputs of this path: if the room stamped a sub, or the chain hashed one, the scan fails.
// The segment is also verified offline: since the chain hash covers `user`, a bundle that swapped
// the surrogates for subs could not verify, so the stored chain itself carries no sub.
//
// A type-level check adds that none of `ChainMetadata`, `BundleCommit`, `LogBundle`,
// `SegmentCommit` and `AuditSegment` has a `sub` member (checked by `tsc` over the test folder).
//
// No service route for the audit export exists yet (HIS-037 Notes): the bundle is read here as such
// a route would read it, from the stores. Runs against the PostgreSQL of the test environment
// (infra/test-env.ps1 up); the harness creates and drops its own database and tenant.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuditSegment,
  auditSegment,
  type SegmentCommit,
  verifySegment,
} from '../../../../packages/history/src/audit-segment.ts';
import type {
  BundleCommit,
  ChainMetadata,
  LogBundle,
} from '../../../../packages/history/src/chain.ts';
import { inTenant } from '../../src/storage/db.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import { skipReason, startHarness, type Harness } from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';

/** True when `T` has no `sub` member, at any of the levels a bundle is read at. */
type NoSub<T> = 'sub' extends keyof T ? false : true;
const typesHaveNoSub: [
  NoSub<ChainMetadata>,
  NoSub<BundleCommit>,
  NoSub<LogBundle>,
  NoSub<LogBundle['head']>,
  NoSub<SegmentCommit>,
  NoSub<AuditSegment>,
] = [true, true, true, true, true, true];

const LANE = 'V-SYN-037-053';
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A position inside the first text block of the document, where a text step can go. */
function textPosition(doc: unknown): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (found < 0 && n.isTextblock) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error('no text block');
  return found;
}

interface Row {
  seq: string;
  kind: string;
  commit_id: string;
  user_id: string;
  session_id: string | null;
  agent: string | null;
  server_ts: Date;
  origin: string;
  base: string | null;
  rebased: boolean | null;
  access_rev: string;
  token_jti: string | null;
  cdm_version: number;
  engine: string;
  size: number;
  payload_hash: Buffer;
  prev_hash: Buffer | null;
  hash: Buffer;
  scopes: string[];
}

/** The log bundle of a document, read from the stored rows as the service role reads them. */
async function bundleFromStore(h: Harness, doc: string): Promise<LogBundle> {
  return inTenant(
    h.db!.service,
    h.tenant,
    async (c) => {
      const rows = await c.query<Row>(
        `SELECT c.*, coalesce(s.scopes, '{}') AS scopes
           FROM doc_commits c
           LEFT JOIN LATERAL (
             SELECT array_agg(cs.scope ORDER BY cs.scope COLLATE "C") AS scopes
               FROM commit_scopes cs WHERE cs.doc_id = c.doc_id AND cs.seq = c.seq
           ) s ON true
          WHERE c.doc_id = $1 ORDER BY c.seq`,
        [doc],
      );
      const head = await c.query<{ head_seq: string; chain_head: Buffer | null }>(
        'SELECT head_seq, chain_head FROM doc_heads WHERE doc_id = $1',
        [doc],
      );
      const commits: BundleCommit[] = rows.rows.map((r) => ({
        meta: {
          doc,
          seq: Number(r.seq),
          kind: r.kind,
          id: r.commit_id,
          user: r.user_id,
          session: r.session_id,
          agent: r.agent,
          time: r.server_ts.toISOString(),
          origin: r.origin,
          scopes: r.scopes,
          base: r.base === null ? null : Number(r.base),
          rebased: r.rebased,
          revision: Number(r.access_rev),
          jti: r.token_jti,
          cdm: r.cdm_version,
          engine: r.engine,
          size: r.size,
        },
        payloadHash: r.payload_hash.toString('hex'),
        prevHash: r.prev_hash ? r.prev_hash.toString('hex') : null,
        hash: r.hash.toString('hex'),
      }));
      const hr = head.rows[0]!;
      return {
        format: 'docedit-log-bundle/1',
        doc,
        head: {
          seq: Number(hr.head_seq),
          chainHead: hr.chain_head ? hr.chain_head.toString('hex') : null,
        },
        commits,
      };
    },
    { readOnly: true },
  );
}

const storage = 'postgres' as const;
const skip = await skipReason(storage);
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)(
  'the audit export holds surrogates only, through the service path (HIS-037 criterion 4, PostgreSQL)',
  () => {
    let h: Harness;
    const clients: DepClient[] = [];

    beforeAll(async () => {
      h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const connect = async (token: string): Promise<DepClient> => {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      const w = await c.hello(token);
      expect(w.t, JSON.stringify(w.d)).toBe('welcome');
      return c;
    };

    it('has no `sub` member in any bundle or segment type', () => {
      expect(typesHaveNoSub.every(Boolean)).toBe(true);
    });

    it('stamps, stores, exports and cuts the surrogates of the real user directory, and no host sub', async () => {
      const doc = await h.createDocument({ title: `${LANE} surrogates` });
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      expect(content.status).toBe(200);
      const pos = textPosition(content.json.doc);

      // Host subs shaped as hosts often send them, unique to this run and lane.
      const subs = [`${LANE}-alice-${unique()}@example.test`, `${LANE}-bob-${unique()}`];
      const alice = await connect(h.userToken({ [doc]: 'editor' }, { sub: subs[0], jti: uuid7() }));
      const bob = await connect(h.userToken({ [doc]: 'editor' }, { sub: subs[1], jti: uuid7() }));
      expect((await alice.open(1, doc)).t).toBe('ch.opened');
      expect((await bob.open(1, doc)).t).toBe('ch.opened');
      const a = await alice.submit(1, { base: 0, steps: [insertText(pos, 'A')] });
      expect(a.t, JSON.stringify(a.d)).toBe('sync.ack');
      const b = await bob.submit(1, { base: 1, steps: [insertText(pos, 'B')] });
      expect(b.t, JSON.stringify(b.d)).toBe('sync.ack');
      const a2 = await alice.submit(1, { base: 2, steps: [insertText(pos, 'C')] });
      expect(a2.t, JSON.stringify(a2.d)).toBe('sync.ack');

      // The mapping the room used: the real PgUserDirectory of the service.
      const surrogates = await Promise.all(
        subs.map(async (s) => (await h.parts.users.resolve(h.tenant, s)).surrogate),
      );
      for (const [i, s] of surrogates.entries()) expect(s).not.toBe(subs[i]);

      // The stored chain is whole, as the service checks it.
      const ref = { tenant: h.tenant, doc };
      expect(await (h.parts.logs as PgLogStore).verify(ref)).toMatchObject({ ok: true });

      const bundle = await bundleFromStore(h, doc);
      const authored = bundle.commits.filter((c) => c.meta.kind === 'steps');
      expect(authored.map((c) => c.meta.user)).toEqual([
        surrogates[0],
        surrogates[1],
        surrogates[0],
      ]);
      const bundleJson = JSON.stringify(bundle);
      for (const sub of subs) expect(bundleJson).not.toContain(sub);

      const first = authored[0]!.meta.seq;
      const cut = auditSegment(bundle, { fromSeq: first, toSeq: bundle.head.seq });
      if (!cut.ok) throw new Error(`refused: ${cut.code}`);
      const segmentJson = JSON.stringify(cut.segment);
      for (const sub of subs) expect(segmentJson).not.toContain(sub);
      for (const s of surrogates) expect(segmentJson).toContain(s);

      // The segment verifies offline from its JSON alone: the hashed `user` is the surrogate.
      const report = await verifySegment(JSON.parse(segmentJson) as AuditSegment);
      expect(report.status).toBe('intact');
    }, 60_000);
  },
);
