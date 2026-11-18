// FRW-030 criteria 1 and 2 through the real service: every transition of a workflow (send, first
// open, correct, resume, a participant's completion, completed, finalised, and decline, void and
// expiry) appends one control commit with no steps to the log, in the same total order as the
// content commits around it; the owner's channel advances its `seq` on receiving each; and, in a run
// with a fill, a signature and a correction, the order of those commits is read back from the log
// and the hash chain verifies across them. The real token service and data plane, the asset worker
// (the signature image), memory storage and, when the test environment is up, PostgreSQL in Podman.
// docs/adr/0382-w4-FRW-030-transition-record.md (proposed).
import { createHash } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import { finaliseSealed } from '../../src/workflow/finalise-sealed.ts';
import { sweepTenant } from '../../src/workflow/schedule-sweep.ts';
import { MemorySealedPdfStore } from '../../src/workflow/sealed-store.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TEXT_ID = 'esign-consent';
const VERSION = 1;
const HOUR = 3_600_000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const PDF = new TextEncoder().encode('%PDF-1.7 sealed test bytes');
const id = (n: number) => `fs${String(n).padStart(14, '0')}`;
const F = { name: id(1), sig: id(2), date: id(3) };

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  const ff = (n: number, key: string, kind: string, assignee: string) => ({
    type: 'form_field',
    attrs: { id: id(n), key, kind, label: key, assignee, required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pTrans0000000001' },
    content: [
      ff(1, 'tenant.name', 'text', 'tenant'),
      { type: 'text', text: ' ' },
      ff(2, 'tenant.sig', 'signature', 'tenant'),
      { type: 'text', text: ' ' },
      ff(3, 'tenant.date', 'dateSigned', 'tenant'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string, extra: Record<string, unknown> = {}) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c30',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  consent: { textId: TEXT_ID, version: VERSION },
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
  ],
  ...extra,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`every transition is a control commit (${storage}; FRW-030 criteria 1 and 2)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    const sealed = new MemorySealedPdfStore();
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        realDataPlane: true,
        views: FULL_VIEWS,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: { jobIdleMs: 20 },
        parts: { consentTexts: texts, sealedPdfs: sealed },
      });
      texts.put(h.tenant, TEXT_ID, VERSION, 'I agree to sign electronically. Test text only.');
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const tree = () => schema.nodeFromJSON((document() as { doc: unknown }).doc);
    const tokenOf = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });

    async function connect(doc: string, token: string): Promise<DepClient> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      return c;
    }

    /** A sent or draft workflow, with the owner connected so that the room is open. */
    async function started(extra: Record<string, unknown> = {}, send = true) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-030-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc, extra),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const oc = await connect(doc, owner);
      const ref = { tenant: h.tenant, doc };
      if (send)
        expect(
          (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
        ).toBe(200);
      return { doc, owner, oc, ref };
    }

    const log = async (ref: { tenant: string; doc: string }) => h.parts.logs.read(ref);
    /** What the log holds, once it has stopped growing (the room writes after the route answers). */
    async function settled(ref: { tenant: string; doc: string }) {
      let last = (await log(ref)).length;
      for (let stable = 0; stable < 4;) {
        await new Promise((r) => setTimeout(r, 50));
        const now = (await log(ref)).length;
        stable = now === last ? stable + 1 : 0;
        last = now;
      }
      return log(ref);
    }
    // A control commit that anchors the salted hash of evidence (FRW-041) is told from the one that
    // records a transition.
    const label = (c: { kind: string; origin: string; evidence?: unknown }) =>
      c.kind === 'control' ? (c.evidence === undefined ? 'control' : 'evidence') : c.origin;

    /** The commits a step added: they are the ones after `seen`, and each is a step of the log's order. */
    async function added(ref: { tenant: string; doc: string }, seen: number) {
      const all = await settled(ref);
      return all.filter((c) => c.seq > seen).map(label);
    }

    it.skipIf(skip)(
      'writes a control commit with no steps for each transition of a run, between the fill, the signature and the correction, and the chain verifies (criteria 1 and 2)',
      async () => {
        const { doc, owner, oc, ref } = await started({}, false);
        const seen = async () => (await h.parts.logs.head(ref)).seq;
        const run: Array<[string, string[]]> = [];
        const step = async (name: string, act: () => Promise<void>) => {
          const from = await seen();
          await act();
          run.push([name, await added(ref, from)]);
        };

        await step('send', async () => {
          const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
          expect(r.status, r.text).toBe(200);
        });
        let p1!: DepClient;
        await step('first open', async () => {
          p1 = await connect(doc, tokenOf(doc, 'p1'));
          // The first view was recorded when the channel opened; wait for the workflow to say so.
          for (let i = 0; i < 100; i++) {
            const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
            if (w.json.state === 'in_progress') break;
            await new Promise((r) => setTimeout(r, 30));
          }
        });
        await step('fill', async () => {
          const ack = await p1.submit(1, {
            base: await seen(),
            steps: [{ stepType: 'attr', pos: posOf(tree(), F.name), attr: 'value', value: 'Ada' }],
          });
          expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
        });
        await step('consent and signature', async () => {
          const c = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/consent`, {
            token: tokenOf(doc, 'p1'),
            body: {},
          });
          expect(c.status, c.text).toBe(200);
          const upload = await h.call('POST', `/v1/documents/${doc}/assets`, {
            token: tokenOf(doc, 'p1'),
            body: { filename: 'sig.png', mime: 'image/png', size: PNG.length },
          });
          expect(upload.status, upload.text).toBe(201);
          const asset = upload.json.asset as string;
          await h.service.assets.putQuarantined(h.tenant, asset, PNG);
          expect(
            (await h.call('POST', `/v1/assets/${asset}/complete`, { token: tokenOf(doc, 'p1') }))
              .status,
          ).toBe(202);
          for (let i = 0; i < 300; i++) {
            if ((await h.parts.assetRegistry.get(h.tenant, asset))?.state === 'ready') break;
            await new Promise((r) => setTimeout(r, 20));
          }
          const signed = await h.call('POST', `/v1/documents/${doc}/fields/${F.sig}/sign`, {
            token: tokenOf(doc, 'p1'),
            body: { asset, mode: 'drawn' },
          });
          expect(signed.status, signed.text).toBe(200);
        });
        await step('correct', async () => {
          const r = await h.call('POST', `/v1/documents/${doc}/workflow/correct`, { token: owner });
          expect(r.status, r.text).toBe(200);
        });
        await step('the owner edits the text', async () => {
          const ack = await oc.submit(1, {
            base: await seen(),
            steps: [insertText(posOf(tree(), 'pIntro0000000001') + 1, 'Dear ')],
          });
          expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
        });
        await step('resume', async () => {
          const r = await h.call('POST', `/v1/documents/${doc}/workflow/resume`, { token: owner });
          expect(r.status, r.text).toBe(200);
        });
        await step('p1 completes', async () => {
          const r = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
            token: tokenOf(doc, 'p1'),
            body: {},
          });
          expect(r.status, r.text).toBe(200);
        });
        await step('p2 opens', async () => {
          await connect(doc, tokenOf(doc, 'p2'));
        });
        await step('p2 completes: completed', async () => {
          const r = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p2/complete`, {
            token: tokenOf(doc, 'p2'),
            body: {},
          });
          expect(r.status, r.text).toBe(200);
          expect(r.json.state).toBe('completed');
        });
        await step('finalised', async () => {
          const out = await finaliseSealed(
            {
              workflows: h.parts.workflows!,
              grants: h.parts.grants,
              logs: h.parts.logs,
              notifier: h.service.dataPlane,
              audit: h.parts.audit,
              now: h.now,
              controlWaitMs: 5000,
              sealed,
            },
            {
              ref,
              actor: 'system',
              bytes: PDF,
              sealedHash: createHash('sha256').update(PDF).digest('hex'),
              timestamped: true,
              retainUntilMs: Date.UTC(2040, 0, 1),
            },
          );
          expect(out.ok).toBe(true);
        });

        // Criterion 1: each transition added exactly one commit, a control commit; a fill and a
        // signature added content commits with their own origins; an edit by the owner too.
        expect(Object.fromEntries(run.map(([n, a]) => [n, a]))).toMatchObject({
          send: ['control'],
          'first open': ['control'],
          fill: ['input'],
          'consent and signature': ['sign', 'evidence'],
          correct: ['control'],
          'the owner edits the text': ['input'],
          resume: ['control'],
          'p1 completes': ['control', 'evidence'],
          'p2 completes: completed': ['control', 'evidence'],
          finalised: ['control'],
        });
        // The control commits have no steps, and they and the others are one total order: the seqs
        // are 1, 2, 3 ... with no gap and no repeat.
        const all = await log(ref);
        expect(all.map((c) => c.seq)).toEqual(all.map((_, i) => i + 1));
        expect(all.filter((c) => c.kind === 'control').every((c) => c.steps.length === 0)).toBe(
          true,
        );

        // Criterion 2: the order of the fill, the signature and the correction is the log's order.
        const order = all.map(label);
        const fillAt = order.indexOf('input'); // the participant's fill is the first content commit
        const signAt = order.indexOf('sign');
        const editAt = order.lastIndexOf('input'); // the owner's edit during the correction
        const correctAt = editAt - 1; // the control commit of `correct` comes right before it
        expect(order[correctAt]).toBe('control');
        expect(fillAt).toBeLessThan(signAt);
        expect(signAt).toBeLessThan(correctAt);
        expect(editAt).toBeLessThan(order.lastIndexOf('control'));
        // The order of the whole run, as the log reads it back.
        const names = run.flatMap(([, a]) => a);
        expect(order.slice(-names.length)).toEqual(names);
        // The hash chain is one chain across all of them: it has a head, and where the store can
        // recompute it from the first commit (PostgreSQL), it does.
        expect((await h.parts.logs.state!(ref)).chainHead).toMatch(/^[0-9a-f]{64}$/);
        const verify = (
          h.parts.logs as unknown as { verify?: (r: unknown) => Promise<{ ok: boolean }> }
        ).verify;
        if (storage === 'postgres') {
          expect(verify).toBeTypeOf('function');
          expect(await verify!.call(h.parts.logs, ref)).toMatchObject({ ok: true });
        }
        // The owner's channel advanced its seq to the end of the log, control commits included.
        const seqsSeen = oc.log
          .filter((m) => m.t === 'sync.commit')
          .flatMap((m) => JSON.stringify(m.d).match(/"seq":(\d+)/g) ?? [])
          .map((s) => Number(s.slice(6)));
        expect(Math.max(...seqsSeen)).toBe(all.length);
        for (const c of all.filter((x) => x.kind === 'control'))
          expect(seqsSeen, `control commit ${c.seq}`).toContain(c.seq);
      },
      120_000,
    );

    for (const end of ['declined', 'voided', 'expired'] as const) {
      it.skipIf(skip)(
        `writes one control commit with no steps when a workflow is ${end} (criterion 1)`,
        async () => {
          const { doc, owner, ref } = await started(
            end === 'expired' ? { deadline: new Date(h.now() + HOUR).toISOString() } : {},
          );
          const p1 = await connect(doc, tokenOf(doc, 'p1'));
          for (let i = 0; i < 100; i++) {
            const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
            if (w.json.state === 'in_progress') break;
            await new Promise((r) => setTimeout(r, 30));
          }
          const from = (await settled(ref)).at(-1)!.seq;
          if (end === 'voided') {
            const r = await h.call('POST', `/v1/documents/${doc}/workflow/void`, {
              token: owner,
              body: { reason: 'Stop' },
            });
            expect(r.status, r.text).toBe(200);
          } else if (end === 'declined') {
            const r = await h.call(
              'POST',
              `/v1/documents/${doc}/workflow/participants/p1/decline`,
              { token: tokenOf(doc, 'p1'), body: { reason: 'No' } },
            );
            expect(r.status, r.text).toBe(200);
          } else {
            h.advance(HOUR);
            const done = await sweepTenant(
              {
                workflows: h.parts.workflows!,
                reminders: h.parts.reminders!,
                grants: h.parts.grants,
                logs: h.parts.logs,
                notifier: h.service.dataPlane,
                audit: h.parts.audit,
                now: h.now,
                controlWaitMs: 5000,
                events: h.events,
              },
              h.tenant,
            );
            expect(done.expired).toContain(doc);
          }
          expect((await h.parts.workflows!.read(h.tenant, doc))!.state).toBe(end);
          expect(await added(ref, from)).toEqual(['control']);
          const last = (await log(ref)).at(-1)!;
          expect(last.steps).toEqual([]);
          void p1;
        },
        60_000,
      );
    }
  });
}
