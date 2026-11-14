// UX-040 criterion 1 (client half): requestExport refuses without sending when the access lists
// `no-export` (PRM-056), and sends the request otherwise. The exports port is a stand-in that
// records each request; the service half is in services/document-service (ux-040-no-export.test.ts).
import type { Access, Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { PortError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { startExport, type ExportRequest } from '../src/export.ts';

function recordingExports() {
  const calls: Array<{ docId: string; body: ExportRequest }> = [];
  const port: ExportsPort = {
    async request(docId, body) {
      calls.push({ docId, body });
      return { id: 'job-ux-040' } as unknown as ExportJob;
    },
    async get() {
      throw new Error('not used');
    },
    async cancel() {},
  };
  return { port, calls };
}

function backendWith(port: ExportsPort): Backend {
  return { features: new Set<string>(['exports']), exports: port } as unknown as Backend;
}

function accessWith(restrictions: string[]): Access {
  return { rev: 1, restrictions } as unknown as Access;
}

const request = { target: 'pdf' } as ExportRequest;

describe('UX-040 no-export on the client (requestExport)', () => {
  it('refuses with a reason and sends nothing when the access lists no-export', async () => {
    const { port, calls } = recordingExports();
    const source = {
      docId: 'doc-ux-040',
      backend: backendWith(port),
      access: accessWith(['no-export']),
    };
    const err = await startExport(source, request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect((err as PortError).code).toBe('forbidden');
    expect((err as PortError).details).toEqual({ reason: 'no-export' });
    expect(calls).toHaveLength(0);
  });

  it('sends the export when the access has no restriction', async () => {
    const { port, calls } = recordingExports();
    const source = { docId: 'doc-ux-040', backend: backendWith(port), access: accessWith([]) };
    await expect(startExport(source, request)).resolves.toEqual({ jobId: 'job-ux-040' });
    expect(calls).toHaveLength(1);
  });

  it('does not refuse for other restrictions: no-copy and no-print leave export open', async () => {
    const { port, calls } = recordingExports();
    const source = {
      docId: 'doc-ux-040',
      backend: backendWith(port),
      access: accessWith(['no-copy', 'no-print']),
    };
    await expect(startExport(source, request)).resolves.toEqual({ jobId: 'job-ux-040' });
    expect(calls).toHaveLength(1);
  });

  it('sends the export when the source carries no access (existing callers)', async () => {
    const { port, calls } = recordingExports();
    const source = { docId: 'doc-ux-040', backend: backendWith(port) };
    await expect(startExport(source, request)).resolves.toEqual({ jobId: 'job-ux-040' });
    expect(calls).toHaveLength(1);
  });
});
