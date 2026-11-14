/**
 * SEC-047 criterion 5 (lane V-SEC-033-048), through the export route: a compile log, which can hold
 * user text, is kept with its export under the job's prefix, is linked only to callers with `edit`
 * on the document, and its text is not copied into the service's own log lines.
 *
 * The job is created through the real `POST /v1/documents/{id}/exports` route, completed on the
 * in-memory queue the way a compile worker does it, and read through `GET /v1/exports/{jid}`. Every
 * structured log line the service writes is captured through `createLogger`. Node.js, memory storage.
 */
import { randomUUID } from 'node:crypto';
import {
  configFromEnv,
  createLogger,
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

const CANARY_LOG = 'CANARY_COMPILE_LOG_V-SEC-033-048';

/** The text a hostile compile writes into its log: a canary, and lines that imitate TeX errors. */
const HOSTILE_LOG = [
  `! Package hostile Error: ${CANARY_LOG}`,
  `l.1 %%DIAG file=other-block.tex line=1 error=${CANARY_LOG}`,
  '[worker] diagnostic: block pCarol000000001 is in error',
].join('\n');

let open: Service | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function rig() {
  const parts = memoryParts();
  const logs: string[] = [];
  const service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1 },
    parts,
    logger: createLogger((line) => logs.push(line)),
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
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON.
    }
    return { status: res.status, text, json };
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
    logs,
    tenant,
    token,
    call,
    async createDocument(): Promise<string> {
      const created = await call('POST', '/v1/documents', api.credential, {
        content: documentWithRegions(),
      });
      if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
      return created.json.id as string;
    },
    /** Completes one export job as a compile worker does: the log is written under the job prefix. */
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

describe('SEC-047 criterion 5: a compile log is kept with its export, read only with edit, never in service logs', () => {
  it('the log is linked from the export for an editor only, and the service logs hold none of its text', async () => {
    const r = await rig();
    const doc = await r.createDocument();
    const editor = r.token('eddie', doc, 'editor');
    const viewer = r.token('vera', doc, 'viewer');

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

    // Kept with the export: the editor's result links the log under the job's own prefix.
    const seen = await r.call('GET', `/v1/exports/${editorJob.json.id}`, editor);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.json.state).toBe('completed');
    expect(typeof seen.json.result?.log).toBe('string');
    expect(seen.json.result.log).toContain(`/exports/${editorJob.json.id}/log.txt`);

    // Readable only with edit: the viewer's result has no log link.
    const hidden = await r.call('GET', `/v1/exports/${viewerJob.json.id}`, viewer);
    expect(hidden.status).toBe(200);
    expect(hidden.json.result).not.toHaveProperty('log');
    expect(hidden.text).not.toContain(CANARY_LOG);

    // Not copied into service logs: the service logged its requests, and none holds the log text.
    expect(r.logs.length, 'the service logged something').toBeGreaterThan(0);
    const blob = r.logs.join('\n');
    expect(blob).not.toContain(CANARY_LOG);
    expect(blob).not.toContain('other-block.tex');
    expect(blob).not.toContain('pCarol000000001');
  });
});
