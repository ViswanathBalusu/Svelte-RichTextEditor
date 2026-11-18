// FRW-040 through the real service: the evidence of a participant's first view, taken from the
// connection and the server clock. A real WebSocket client opens a channel with a host-signed token
// that carries `wfp`; the data plane tells the workflow service, which stores the first view, writes
// the evidence row (session, address, user agent, `amr`, time) and raises `participant_viewed`. The
// consent, the signing and the completion are recorded by routes that are not built (FRW-044,
// FRW-046, FRW-047), so they are not tested here. Memory storage and, when the test environment is
// up, PostgreSQL in Podman. docs/adr/0392-w4-FRW-040-participant-evidence.md (proposed).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DepDataPlaneInstance } from '../../src/data-plane/index.ts';
import { DepClient } from '../data-plane/client.ts';
import { MemoryEvidenceLedger } from '../../src/workflow/evidence-ledger.ts';
import { PgCaptureSettingsStore } from '../../src/workflow/capture-settings-pg.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'ap', roles: ['landlord'], kind: 'approver', order: 1, sub: 'sub-ap' },
    { id: 'cc', roles: ['landlord'], kind: 'cc', order: 2, sub: 'sub-cc' },
  ],
});

const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`participant evidence of the first view (${storage}; FRW-040)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    let capture = true;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          realDataPlane: true,
          // In memory the tenant's capture setting is this switch; on PostgreSQL it is the table.
          ...(storage === 'memory'
            ? {
                parts: {
                  evidence: new MemoryEvidenceLedger(Date.now, () => ({
                    captureNetworkIdentity: capture,
                  })),
                },
              }
            : {}),
        });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    async function workflow(send = true) {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-040-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      if (send) {
        const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(r.status, r.text).toBe(200);
      }
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    /** Opens a channel as a participant; the client sets only the headers a browser would. */
    async function view(
      doc: string,
      sub: string,
      claims: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, { headers });
      clients.push(c);
      const w = await c.hello(h.userToken({ [doc]: 'filler' }, { sub, ...claims }));
      expect(w.t, JSON.stringify(w.d)).toBe('welcome');
      const o = await c.open(1, doc);
      expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
      return c;
    }

    const rowsOf = (doc: string) => h.parts.evidence!.list(h.tenant, doc);
    /** Waits for the evidence of a view, which is written after the channel opened. */
    async function rowsAfter(doc: string, count: number) {
      for (let i = 0; i < 100; i++) {
        const rows = await rowsOf(doc);
        if (rows.length >= count) return rows;
        await new Promise((r) => setTimeout(r, 50));
      }
      return rowsOf(doc);
    }
    const viewed = (doc: string) =>
      h.events.of('dep.workflow.participant_viewed.v1').filter((e) => e.subject === doc);

    it.skipIf(skip)(
      'records the first view of a filler from the connection and the server clock, and not the client’s say (criteria 1, in part, and 2)',
      async () => {
        const { doc, ref } = await workflow();
        h.advance(5000);
        const before = h.now();
        const plane = h.service.dataPlane as unknown as DepDataPlaneInstance;
        await view(
          doc,
          'sub-p1',
          { wfp: 'p1', amr: ['pwd', 'otp'], auth_time: 1_763_000_000 },
          // What a client may send: a user agent, and a forwarded address the service must not use.
          { 'user-agent': 'FrwTest/1.0', 'x-forwarded-for': '198.51.100.9' },
        );
        const [row, ...more] = await rowsAfter(doc, 1);
        expect(more).toEqual([]);
        expect(row).toMatchObject({ participant: 'p1', item: 'viewed' });
        const e = row!.evidence as unknown as {
          items: { session: string; viewedAtMs: number; amr: string[] };
          ipAddress: string;
          userAgent: string;
        };
        // The session is the connection's; the time is the server's; `amr` is as the token gave it.
        const session = plane.sessions.find((s) => s.identity?.sub === 'sub-p1');
        expect(e.items.session).toBe(session!.id);
        expect(e.items.viewedAtMs).toBeGreaterThanOrEqual(before);
        expect(e.items.viewedAtMs).toBeLessThanOrEqual(h.now());
        expect(e.items.amr).toEqual(['pwd', 'otp']);
        // The address is the socket's, never the forwarded one; the agent is the request's header.
        expect(e.ipAddress).toMatch(LOOPBACK);
        expect(JSON.stringify(row)).not.toContain('198.51.100.9');
        expect(e.userAgent).toBe('FrwTest/1.0');
        // Nothing else: no consent, signing or completion has happened.
        expect(Object.keys(e.items).sort()).toEqual(['amr', 'session', 'viewedAtMs']);

        // The workflow moved, and the view is stored once.
        const stored = (await h.parts.workflows!.read(ref.tenant, ref.doc))!;
        expect(stored.state).toBe('in_progress');
        expect(stored.participants.find((p) => p.id === 'p1')!.firstViewedAt).toBeTypeOf('string');
        // `participant_viewed` is raised once, with identifiers only: no address, agent or amr.
        const events = viewed(doc);
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toMatchObject({ document: doc, participant: 'p1' });
        expect(JSON.stringify(events[0])).not.toMatch(/127\.0\.0\.1|FrwTest|otp|::1/);

        // The same participant opening again, from another connection, adds nothing.
        await view(doc, 'sub-p1', { wfp: 'p1' }, { 'user-agent': 'FrwTest/2.0' });
        await new Promise((r) => setTimeout(r, 300));
        expect(await rowsOf(doc)).toHaveLength(1);
        expect(viewed(doc)).toHaveLength(1);
      },
      60_000,
    );

    it.skipIf(skip)(
      'records for an approver and a cc only the items that apply, and the ledger refuses an item that does not (criterion 4)',
      async () => {
        const { doc } = await workflow();
        await view(doc, 'sub-ap', { wfp: 'ap' }, { 'user-agent': 'FrwTest/ap' });
        await view(doc, 'sub-cc', { wfp: 'cc' }, { 'user-agent': 'FrwTest/cc' });
        const rows = await rowsAfter(doc, 2);
        expect(rows.map((r) => r.participant).sort()).toEqual(['ap', 'cc']);
        for (const r of rows) {
          const e = r.evidence as unknown as { items: Record<string, unknown> };
          // A view has a session and a time; no consent, signing or completion item is invented.
          expect(Object.keys(e.items).sort()).toEqual(['session', 'viewedAtMs']);
          expect(e.items['amr']).toBeUndefined();
        }
        // The single write path refuses what does not apply to the kind.
        const record = (kind: 'approver' | 'cc' | 'filler', items: Record<string, unknown>) =>
          h.parts.evidence!.record(h.tenant, {
            doc,
            participant: 'x',
            kind,
            item: 'probe',
            facts: { items, ipAddress: null, userAgent: null },
          });
        await expect(record('cc', { completedAtMs: 1 })).rejects.toThrow(RangeError);
        await expect(record('cc', { consent: { textId: 't' } })).rejects.toThrow(RangeError);
        await expect(record('approver', { consent: { textId: 't' } })).rejects.toThrow(RangeError);
        await expect(record('approver', { signings: [] })).rejects.toThrow(RangeError);
        await expect(record('filler', { notAnItem: 1 })).rejects.toThrow(RangeError);
        await expect(record('approver', { completedAtMs: 1 })).resolves.toBeDefined();
        await expect(
          record('filler', { signings: [], consent: { textId: 't' } }),
        ).resolves.toBeDefined();
      },
      60_000,
    );

    it.skipIf(skip)(
      'records nothing for a token that binds to no one, for a draft, or for a workflow that is not running',
      async () => {
        const mine = await workflow();
        // A sub that is not the participant's, a wfp that names nobody, and a token with no wfp.
        await view(mine.doc, 'sub-someone-else', { wfp: 'p1' });
        await view(mine.doc, 'sub-p1', { wfp: 'nobody' });
        await view(mine.doc, 'sub-p1', {});
        await new Promise((r) => setTimeout(r, 400));
        expect(await rowsOf(mine.doc)).toEqual([]);
        expect((await h.parts.workflows!.read(mine.ref.tenant, mine.doc))!.state).toBe('sent');
        expect(viewed(mine.doc)).toEqual([]);

        const draft = await workflow(false);
        await view(draft.doc, 'sub-p1', { wfp: 'p1' });
        await new Promise((r) => setTimeout(r, 400));
        expect(await rowsOf(draft.doc)).toEqual([]);

        const voided = await workflow();
        const r = await h.call('POST', `/v1/documents/${voided.doc}/workflow/void`, {
          token: voided.owner,
          body: { reason: 'Stop' },
        });
        expect(r.status, r.text).toBe(200);
        await view(voided.doc, 'sub-p1', { wfp: 'p1' });
        await new Promise((r2) => setTimeout(r2, 400));
        expect(await rowsOf(voided.doc)).toEqual([]);
      },
      60_000,
    );

    it.skipIf(skip)(
      'leaves out the address and the user agent when the tenant switched capture off, and keeps the rest (criterion 6)',
      async () => {
        // The setting of the tenant: on PostgreSQL through the store that audits the change, in
        // memory through the ledger's own setting.
        if (h.db !== null) {
          const settings = new PgCaptureSettingsStore(h.parts.pool!, { now: h.now });
          await settings.change(h.tenant, 'admin-surrogate-1', { captureNetworkIdentity: false });
        } else {
          capture = false;
        }
        const { doc } = await workflow();
        await view(doc, 'sub-p1', { wfp: 'p1', amr: ['pwd'] }, { 'user-agent': 'FrwTest/off' });
        const [row] = await rowsAfter(doc, 1);
        expect(row).toBeDefined();
        const e = row!.evidence as unknown as {
          items: Record<string, unknown>;
          ipAddress?: unknown;
          userAgent?: unknown;
        };
        expect(e).not.toHaveProperty('ipAddress');
        expect(e).not.toHaveProperty('userAgent');
        expect(JSON.stringify(row)).not.toContain('FrwTest/off');
        expect(Object.keys(e.items).sort()).toEqual(['amr', 'session', 'viewedAtMs']);
      },
      60_000,
    );
  });
}
