// FRW-041 criteria 2 and 3 through the real service: a signing and a completion each leave one
// control commit in the log that carries the origin and the salted hash of their evidence and
// nothing else. The evidence stays in the workflow table; a verifier who holds a stored row and its
// salt recomputes the hash and finds it in the chain; after a purge of the rows the chain verifies
// as before; a repeat of the request anchors nothing twice; a connected client is not sent the
// hash. Memory storage and, when the test environment is up, PostgreSQL in Podman.
// docs/adr/0391-w4-FRW-041-evidence-ledger.md (proposed).
import { unsandboxed } from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { verifyWorkflowEvidenceBundle } from '@docedit/history';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import { PgEvidenceRowStore } from '../../src/workflow/evidence-store.ts';
import { buildWorkflowEvidenceBundle } from '../../src/workflow/evidence-bundle.ts';
import {
  recomputeCommitment,
  verifyAgainstChain,
  type MemoryEvidenceLedger,
} from '../../src/workflow/evidence-ledger.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SIG = 'fd00000000000041';
const TEXT_ID = 'esign-consent';
const TEXT = 'I agree to sign electronically. Test text only.';
const AGENT = `AnchorTest/41-${uuid7().slice(-12)}`;

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pAnchor000000041' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: SIG,
          key: 'tenant.sig',
          kind: 'signature',
          label: 'sig',
          assignee: 'tenant',
          required: false,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`evidence anchored in the chain (${storage}; FRW-041 criteria 2 and 3)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    const clients: DepClient[] = [];
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        realDataPlane: true,
        views: FULL_VIEWS,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: { jobIdleMs: 20 },
        parts: { consentTexts: texts },
      });
      texts.put(h.tenant, TEXT_ID, 1, TEXT);
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    async function readyAsset(doc: string, tok: string): Promise<string> {
      const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token: tok,
        body: { filename: 's.png', mime: 'image/png', size: PNG.length },
      });
      expect(r.status, r.text).toBe(201);
      const asset = r.json.asset as string;
      await h.service.assets.putQuarantined(h.tenant, asset, PNG);
      expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: tok })).status).toBe(
        202,
      );
      let row = await h.parts.assetRegistry.get(h.tenant, asset);
      for (let i = 0; i < 300 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        row = await h.parts.assetRegistry.get(h.tenant, asset);
      }
      expect(row?.state).toBe('ready');
      return asset;
    }

    it.skipIf(skip)(
      'puts one control commit with the origin and the salted hash after the signing and after the completion, and the chain holds nothing else of the evidence',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const ref = { tenant: h.tenant, doc };
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-041a-${uuid7()}` });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: {
            id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c41',
            doc,
            state: 'draft',
            rev: 0,
            timeZone: 'UTC',
            consent: { textId: TEXT_ID, version: 1 },
            participants: [
              { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-p1' },
            ],
          },
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        expect(
          (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
        ).toBe(200);

        const tok = h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1', wfp: 'p1' });
        const client = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, {
          headers: { 'user-agent': AGENT },
        });
        clients.push(client);
        expect((await client.hello(tok)).t).toBe('welcome');
        expect((await client.open(1, doc)).t).toBe('ch.opened');
        for (let i = 0; i < 100; i++) {
          const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
          if (w.json.state === 'in_progress') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        const agent = { 'user-agent': AGENT };
        const consent = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/consent`,
          {
            token: tok,
            body: {},
            headers: agent,
          },
        );
        expect(consent.status, consent.text).toBe(200);
        const asset = await readyAsset(doc, tok);
        const sign = () =>
          h.call('POST', `/v1/documents/${doc}/fields/${SIG}/sign`, {
            token: tok,
            body: { asset, mode: 'drawn' },
            headers: agent,
          });
        const signed = await sign();
        expect(signed.status, signed.text).toBe(200);
        // A repeat of the signing is the same commit and anchors nothing twice.
        expect((await sign()).status).toBe(200);
        const done = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/complete`,
          {
            token: tok,
            body: {},
            headers: agent,
          },
        );
        expect(done.status, done.text).toBe(200);
        // A second completion is a no-op: nothing more is anchored.
        expect(
          (
            await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
              token: tok,
              body: {},
              headers: agent,
            })
          ).status,
        ).toBe(200);

        // The log: one anchor after the signing commit (origin sign) and one after the completion
        // (origin rules), each a control commit with no steps and nothing but the two members.
        const commits = await h.parts.logs.read(ref);
        const anchors = commits.filter((c) => c.evidence !== undefined);
        expect(anchors.map((a) => a.evidence!.origin)).toEqual(['sign', 'rules']);
        for (const a of anchors) {
          expect(a.kind).toBe('control');
          expect(a.steps).toEqual([]);
          expect(Object.keys(a.evidence!).sort()).toEqual(['evidenceHash', 'origin']);
          expect(a.evidence!.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
        }
        const signCommit = commits.find((c) => c.origin === 'sign')!;
        expect(anchors[0]!.seq).toBeGreaterThan(signCommit.seq);
        expect(commits.some((c) => c.origin === 'rules' || c.kind === 'control')).toBe(true);

        // No evidence in the log: not the agent, not the address, not the consent text.
        const text = JSON.stringify(commits);
        expect(text).not.toContain(AGENT);
        expect(text).not.toContain('127.0.0.1');
        expect(text).not.toContain(TEXT);

        // The client on the channel was sent no hash.
        expect(JSON.stringify(client.log)).not.toContain(anchors[0]!.evidence!.evidenceHash);

        // Criterion 3: a verifier with the stored rows and their salts recomputes each hash and
        // finds it in the chain.
        const rows = await h.parts.evidence!.list(h.tenant, doc);
        const proven = rows.filter((r) => r.item === 'signed' || r.item === 'completed');
        expect(proven.map((r) => r.item)).toEqual(['signed', 'completed']);
        const chain = new Set(anchors.map((a) => a.evidence!.evidenceHash));
        for (const row of proven) expect(await recomputeCommitment(row)).toBe(row.hash);
        expect(await verifyAgainstChain(proven, chain)).toEqual({
          matched: proven.map((r) => r.id),
          unmatched: [],
        });
        expect(proven.map((r) => r.hash)).toEqual(anchors.map((a) => a.evidence!.evidenceHash));
        // Other evidence, or the same under another salt, is not in the chain.
        const first = proven[0]!;
        const other = {
          ...first,
          evidence: { ...first.evidence, ipAddress: '198.51.100.9' },
        };
        const resalted = { ...first, salt: new Uint8Array(16) };
        expect((await verifyAgainstChain([other, resalted], chain)).unmatched).toHaveLength(2);

        // The bundle for a third party verifies, the anchors in it included.
        const workflow = (await h.parts.workflows!.read(h.tenant, doc))!;
        const built = await buildWorkflowEvidenceBundle(
          { logs: h.parts.logs, evidence: h.parts.evidence! },
          ref,
          workflow,
        );
        expect(built.ok).toBe(true);
        if (built.ok) {
          expect((await verifyWorkflowEvidenceBundle(built.bundle)).ok).toBe(true);
          const held = built.bundle.log.commits.filter((c) => {
            const p = c.payload as { evidence?: unknown } | undefined;
            return p?.evidence !== undefined;
          });
          expect(held).toHaveLength(2);
        }

        // A purge removes the rows. The hashes stay in the chain, which verifies as before.
        const headBefore = await h.parts.logs.state?.(ref);
        const logBefore = JSON.stringify(await h.parts.logs.read(ref));
        if (h.db !== null) {
          await new PgEvidenceRowStore(h.parts.pool!, h.tenant).deleteRows(
            doc,
            rows.map((r) => r.id),
          );
        } else (h.parts.evidence as MemoryEvidenceLedger).purge(h.tenant, doc);
        expect(await h.parts.evidence!.list(h.tenant, doc)).toEqual([]);
        expect(await h.parts.logs.state?.(ref)).toEqual(headBefore);
        expect(JSON.stringify(await h.parts.logs.read(ref))).toBe(logBefore);
        const verify = (h.parts.logs as unknown as { verify?: (r: typeof ref) => Promise<unknown> })
          .verify;
        if (verify) expect(await verify.call(h.parts.logs, ref)).toMatchObject({ ok: true });
        const again = await h.parts.logs.read(ref);
        expect(again.filter((c) => c.evidence !== undefined).map((a) => a.evidence)).toEqual(
          anchors.map((a) => a.evidence),
        );
      },
      90_000,
    );
  });
}
