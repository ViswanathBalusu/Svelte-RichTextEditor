/**
 * SEC-036 criterion 4 (lane SEC-027-039), through the route: the raw log of an export job is shown
 * only to a caller with `edit` on the document (EXP-066; 09 §9.2; 10 §3.4).
 *
 * The compile output is hostile: its log holds text that imitates the log lines of a TeX run (a
 * fake error and a file and line marker). The job is created through the real `POST
 * /v1/documents/{id}/exports` route, claimed and completed on the in-memory queue the way a worker
 * does it, and then read through `GET /v1/exports/{jid}`. The requester is the same user both times;
 * only the document role changes, so the only thing that differs is the capability. The service is
 * the real one, started in process with in-memory storage. The check under test is the export
 * route's own (`ownJob` and `exportJobOf` in control-plane/export-routes.ts); nothing here supplies it.
 *
 * The other clauses of criterion 4 (no diagnostic for another block, a bounded parser) are in
 * services/export-worker/src/diagnostics.test.ts and are not repeated here.
 */
import { randomUUID } from 'node:crypto';
import {
  configFromEnv,
  hashSecret,
  memoryParts,
  newApiKey,
  startService,
  type Service,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { keyPair, signJws } from './support/jws.ts';
import { documentWithRegions } from './support/harness.ts';

/** The text a hostile compile writes into its log, imitating TeX and worker output. */
const HOSTILE_LOG = [
  '! Package hostile Error: a fake error for another block.',
  'l.1 %%DIAG file=other-block.tex line=1 error=none',
  '[worker] diagnostic: block pCarol000000001 is in error',
].join('\n');

let open: Service | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function rig() {
  const parts = memoryParts();
  const service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1 },
    parts,
  });
  open = service;
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Test tenant');
  const host = keyPair('EdDSA');
  await parts.registry.addKey(tenant, {
    kid: `host-${tenant}`,
    use: 'user',
    alg: 'EdDSA',
    jwk: host.jwk,
  });
  const api = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: api.id, secretHash: hashSecret(api.secret) });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${service.url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON.
    }
    return { status: res.status, text, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
  };

  const token = (sub: string, doc: string, role: string): string => {
    const iat = Math.floor(Date.now() / 1000);
    return signJws(
      { alg: host.alg, typ: 'JWT', kid: `host-${tenant}` },
      {
        iss: 'https://host.example.test',
        aud: service.url,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenant,
        sub,
        docs: { [doc]: role },
      },
      { key: host.privateKey },
    );
  };

  return {
    parts,
    service,
    tenant,
    token,
    call,
    /** A document created by the API key, so the test has a real head and content. */
    async createDocument(): Promise<string> {
      const created = await call('POST', '/v1/documents', api.credential, {
        content: documentWithRegions(),
      });
      if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
      return created.json.id as string;
    },
    /**
     * Runs one export job to completion, as a compile worker does: the log is written under the
     * job's prefix and the result names it (the route signs the name, never the text).
     */
    async completeExport(jobId: string): Promise<void> {
      const claimed = await parts.queue.claim(['export'], 'test-worker', 60_000);
      if (claimed?.id !== jobId) throw new Error(`the claimed job is not ${jobId}`);
      await service.assets.putExport(
        tenant,
        jobId,
        'log.txt',
        Buffer.from(HOSTILE_LOG),
        'text/plain',
      );
      await service.assets.putExport(
        tenant,
        jobId,
        'output.pdf',
        Buffer.from('%PDF-1.7 test'),
        'application/pdf',
      );
      const stored = await parts.queue.complete({ tenant, id: jobId }, 'test-worker', {
        output: 'output.pdf',
        pages: 1,
        layout: null,
        converged: true,
        log: 'log.txt',
        diagnostics: [],
      });
      if (!stored) throw new Error('the completion was not stored');
    },
  };
}

describe('SEC-036 criterion 4: the raw log of an export job is shown only to callers with edit', () => {
  it('a requester with edit sees the log of their job; a requester with view on the same document does not', async () => {
    const r = await rig();
    const doc = await r.createDocument();
    const editor = r.token('eddie', doc, 'editor');
    const viewer = r.token('vera', doc, 'viewer');

    // Each requester creates a job of their own, so the job's requester is the caller in both reads.
    const editorJob = await r.call('POST', `/v1/documents/${doc}/exports`, editor, {
      target: 'pdf',
    });
    expect(editorJob.status).toBe(202);
    const viewerJob = await r.call('POST', `/v1/documents/${doc}/exports`, viewer, {
      target: 'pdf',
    });
    expect(viewerJob.status).toBe(202);
    await r.completeExport(editorJob.json.id as string);
    await r.completeExport(viewerJob.json.id as string);

    const seen = await r.call('GET', `/v1/exports/${editorJob.json.id}`, editor);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.json.state).toBe('completed');
    expect(typeof seen.json.result?.log).toBe('string');
    expect(seen.text).not.toContain('a fake error for another block');

    const hidden = await r.call('GET', `/v1/exports/${viewerJob.json.id}`, viewer);
    expect(hidden.status).toBe(200);
    expect(hidden.json.state).toBe('completed');
    expect(hidden.json.result).not.toHaveProperty('log');
    expect(hidden.text).not.toContain('a fake error for another block');
    expect(hidden.text).not.toContain('other-block.tex');
    expect(hidden.text).not.toContain('pCarol000000001');
  });

  it('a requester whose document role changes after the job is made loses the log on the next read', async () => {
    // The gate is the document role at read time: the same job read by the same user with a lower
    // role is answered without the log (ownJob reads capabilitiesOn for the job's document).
    const r = await rig();
    const doc = await r.createDocument();
    const editor = r.token('eddie', doc, 'editor');
    const viewer = r.token('eddie', doc, 'viewer');

    const job = await r.call('POST', `/v1/documents/${doc}/exports`, editor, { target: 'pdf' });
    expect(job.status).toBe(202);
    await r.completeExport(job.json.id as string);

    const withEdit = await r.call('GET', `/v1/exports/${job.json.id}`, editor);
    expect(typeof withEdit.json.result?.log).toBe('string');

    const withView = await r.call('GET', `/v1/exports/${job.json.id}`, viewer);
    expect(withView.status).toBe(200);
    expect(withView.json.result).not.toHaveProperty('log');
    expect(withView.text).not.toContain('a fake error for another block');
  });
});
