// FRW-055 criteria 1 and 3 through the real service: `GET /documents/{id}/workflow/evidence` answers
// the bundle of a completed workflow (the log segment from `sentSeq`, the control commits with their
// payload, the evidence record and the instructions) to a caller with `manage`, audits the retrieval,
// and the bundle verifies with `verifyWorkflowEvidenceBundle` and with the command
// `packages/history/scripts/verify-log.ts`; one record or one evidence item altered fails and is named.
// Memory storage and, when the test environment is up, PostgreSQL in Podman.
// docs/adr/0402-w4-FRW-055-evidence-bundle.md (proposed).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyWorkflowEvidenceBundle, type WorkflowEvidenceBundle } from '@docedit/history';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const FIELD = 'ff00000000000055';

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
    attrs: { id: 'pFinal0000000055' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: FIELD,
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: 'Ada',
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c55',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

const SCRIPT = join(import.meta.dirname, '../../../../packages/history/scripts/verify-log.ts');

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the evidence bundle of a workflow (${storage}; FRW-055)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'frw-055-'));
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    /** A workflow whose only participant has completed, so that it is `completed`. */
    async function completed() {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-055-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      expect(
        (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
      ).toBe(200);
      const tok = h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1', wfp: 'p1' });
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(tok)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const early = await h.call('GET', `/v1/documents/${doc}/workflow/evidence`, { token: owner });
      expect(early.status).toBe(404);
      const done = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
        token: tok,
        body: {},
      });
      expect(done.status, done.text).toBe(200);
      expect(done.json.state).toBe('completed');
      return {
        doc,
        owner,
        tok,
        workflow: done.json.id as string,
        sentSeq: done.json.sentSeq as number,
      };
    }

    const fetchBundle = async (doc: string, token: string) => {
      const res = await h.call('GET', `/v1/documents/${doc}/workflow/evidence`, { token });
      expect(res.status, res.text).toBe(200);
      return res.json as WorkflowEvidenceBundle;
    };
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    const runTool = (name: string, bundle: unknown) => {
      const file = join(dir, `${name}.json`);
      writeFileSync(file, JSON.stringify(bundle));
      const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
      return {
        code: r.status,
        out: JSON.parse(r.stdout) as { ok?: boolean; findings?: unknown[] },
      };
    };
    const retrievals = (doc: string) =>
      h.parts.audit!.query(h.tenant, { doc, kind: 'workflow.evidence_retrieved', limit: 20 });

    it.skipIf(skip !== null)(
      'answers a bundle with the segment, the control commits, the evidence record and the instructions (criterion 1)',
      async () => {
        const w = await completed();
        const bundle = await fetchBundle(w.doc, w.owner);
        expect(bundle).toMatchObject({
          format: 'docedit-workflow-evidence/1',
          doc: w.doc,
          workflow: w.workflow,
        });
        // `sentSeq` is the head at the send, 0 here, and the log starts at 1.
        expect(bundle.log.from).toBe(Math.max(1, w.sentSeq));
        expect(bundle.log.commits[0]!.meta.seq).toBe(Math.max(1, w.sentSeq));
        expect(bundle.log.commits.at(-1)!.meta.seq).toBe(bundle.log.to);
        const controls = bundle.log.commits.filter((c) => c.meta.kind === 'control');
        expect(controls.length).toBeGreaterThan(0);
        // Only a control commit carries its payload, and it holds no steps.
        for (const c of bundle.log.commits) {
          if (c.meta.kind === 'control') expect(c.payload).toMatchObject({ steps: [] });
          else expect(c.payload).toBeUndefined();
        }
        expect(bundle.evidence.items.length).toBeGreaterThan(0);
        expect(bundle.instructions.join(' ')).toContain('does not prove who any participant is');
        // The retrieval is audited.
        const entries = await retrievals(w.doc);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ data: { workflow: w.workflow, state: 'completed' } });
        // A participant, who has no `manage`, gets no bundle, and nothing is audited for it.
        const denied = await h.call('GET', `/v1/documents/${w.doc}/workflow/evidence`, {
          token: w.tok,
        });
        expect(denied.status).toBe(403);
        expect(await retrievals(w.doc)).toHaveLength(1);
      },
    );

    it.skipIf(skip !== null)(
      'verifies in the library and with the command, and names one altered record or item (criterion 3)',
      async () => {
        const w = await completed();
        const bundle = await fetchBundle(w.doc, w.owner);
        const ok = await verifyWorkflowEvidenceBundle(bundle);
        expect(ok, JSON.stringify(ok.findings)).toMatchObject({ ok: true, findings: [] });
        expect(runTool('intact', bundle)).toMatchObject({ code: 0, out: { ok: true } });

        const commit = clone(bundle);
        const victim = commit.log.commits.find((c) => c.meta.kind === 'control')!;
        victim.meta.user = 'someone-else';
        const named = await verifyWorkflowEvidenceBundle(commit);
        expect(named.ok).toBe(false);
        expect(named.findings.some((f) => f.kind === 'commit' && f.ref === victim.meta.seq)).toBe(
          true,
        );
        expect(runTool('commit', commit).code).toBe(1);

        const item = clone(bundle);
        const target = item.evidence.items[0]!;
        (target as { canonical: string }).canonical = `${target.canonical} `;
        const namedItem = await verifyWorkflowEvidenceBundle(item);
        expect(namedItem.failedEvidence).toEqual([target.id]);
        expect(namedItem.findings).toEqual([
          { kind: 'evidence', ref: target.id, reason: 'mismatch' },
        ]);
        const run = runTool('item', item);
        expect(run.code).toBe(1);
        expect(JSON.stringify(run.out.findings)).toContain(target.id);
      },
    );
  });
}
