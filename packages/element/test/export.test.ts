// requestExport (PRO-086, criterion 1): the element creates an export job through the backend's
// exports port and resolves its identifier. The job itself is the server's (PRO-063); here the
// port is a stand-in, and the mock backend (which has no exports port) runs the refusal path.
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { PortError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import { startExport, type ExportRequest } from '../src/export.ts';
import { backendFor, fakeEditor, recordingHost, service, settle } from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);

/** A stand-in exports port that records each request and answers with a job. */
function recordingExports(jobId = 'job-1') {
  const calls: Array<{ docId: string; body: ExportRequest }> = [];
  const port: ExportsPort = {
    async request(docId, body) {
      calls.push({ docId, body });
      return { id: jobId } as unknown as ExportJob;
    },
    async get() {
      throw new Error('not used');
    },
    async cancel() {},
  };
  return { port, calls };
}

function withExports(backend: Backend, port: ExportsPort, announce = true): Backend {
  Object.assign(backend, { exports: port });
  if (announce) (backend.features as Set<string>).add('exports');
  return backend;
}

describe('requestExport (PRO-086)', () => {
  it('creates a job through the exports port with the options unchanged, and resolves its id', async () => {
    const { port, calls } = recordingExports('job-42');
    const docId = 'doc-1';
    const backend = withExports({ features: new Set<string>() } as unknown as Backend, port);
    const options: ExportRequest = {
      target: 'pdf',
      seq: 7,
      options: { paper: 'A4' },
    } as ExportRequest;
    await expect(startExport({ docId, backend }, options)).resolves.toEqual({ jobId: 'job-42' });
    expect(calls).toEqual([{ docId, body: options }]);
    expect(calls[0]!.body).toBe(options);
  });

  it('refuses with unavailable and sends nothing when no document is loaded', async () => {
    await expect(startExport(null, { target: 'pdf' })).rejects.toMatchObject({
      name: 'PortError',
      code: 'unavailable',
    });
    await expect(
      startExport({ docId: 'd', backend: null }, { target: 'pdf' }),
    ).rejects.toBeInstanceOf(PortError);
  });

  it('refuses without sending when the backend has no exports port, or did not announce it', async () => {
    const { port, calls } = recordingExports();
    const bare = { features: new Set<string>() } as unknown as Backend;
    await expect(
      startExport({ docId: 'd', backend: bare }, { target: 'pdf' }),
    ).rejects.toMatchObject({ code: 'unsupported_feature' });
    const unannounced = withExports(
      { features: new Set<string>() } as unknown as Backend,
      port,
      false,
    );
    await expect(
      startExport({ docId: 'd', backend: unannounced }, { target: 'pdf' }),
    ).rejects.toMatchObject({ code: 'unsupported_feature' });
    expect(calls).toEqual([]);
  });

  it('passes a refusal from the server to the host with its own code', async () => {
    const port: ExportsPort = {
      async request() {
        throw new PortError('validation_failed', 'target not supported');
      },
      async get() {
        throw new Error('not used');
      },
      async cancel() {},
    };
    const backend = withExports({ features: new Set<string>() } as unknown as Backend, port);
    await expect(
      startExport({ docId: 'd', backend }, { target: 'pdf' } as ExportRequest),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('runs through the session: the mock backend has no exports port, so the element refuses', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host: recordingHost(editor),
      scheduler: immediate,
    });
    await session.start();
    await settle();
    expect(session.phase).toBe('ready');
    await expect(
      startExport({ docId: session.docId, backend: session.backend }, { target: 'pdf' }),
    ).rejects.toMatchObject({ code: 'unsupported_feature' });
    await session.close();
    await s.dispose();
  });
});
