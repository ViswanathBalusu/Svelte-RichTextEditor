// PRO-083 `flush`, through the element's own path: the session, the mounted core and its `api`,
// against backend-mock (criteria 1 and 3), and against a bare headless core for the timeout (the
// rejection with the count of criterion 2; the journal half of that criterion is FE-008, not built).
import { DocumentCore } from '@docedit/engine/headless';
import { spikeDocument } from '@docedit/engine/testing';
import { describe, expect, it } from 'vitest';
import { elementMethods, hostApi, type MountedSession } from '../src/host-api.ts';
import { Session } from '../src/session.ts';
import { coreHost } from './core-host.ts';
import { backendFor, service } from './support.ts';

const schedule = (run: () => void) => queueMicrotask(run);

describe('flush (PRO-083) over a live session', () => {
  it('resolves once nothing is in flight or queued (criterion 1)', async () => {
    const { service: s, docId } = service();
    const host = coreHost();
    let current: MountedSession | null = null;
    const methods = elementMethods(() => current);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
    });
    current = session;
    await session.start();
    const core = host.cores[0]!;

    expect(core.pastePlainText('flushed ')).toBe(true);
    await methods.flush({ timeoutMs: 5_000 });
    // Resolved after the acknowledgement: the room already holds the edit, read by another client.
    const owner = backendFor(s, docId, 'owner', 'owner');
    await owner.connect();
    const server = await owner.sync.loadContent(docId);
    await owner.close();
    expect(JSON.stringify(server.doc)).toContain('flushed');
    expect((await methods.getContent()).seq).toBe(server.seq);
    await session.close();
  });

  it('a fresh load after flush shows every change the host flushed (criterion 3)', async () => {
    const { service: s, docId } = service();
    const host = coreHost();
    let current: MountedSession | null = null;
    const methods = elementMethods(() => current);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
    });
    current = session;
    await session.start();
    const core = host.cores[0]!;

    expect(core.pastePlainText('alpha ')).toBe(true);
    await methods.flush({ timeoutMs: 5_000 });
    expect(core.pastePlainText('beta ')).toBe(true);
    await methods.flush({ timeoutMs: 5_000 });
    await session.close();

    // A later visit: a new core loaded from the server's confirmed document.
    const later = coreHost();
    const next = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host: later,
    });
    current = next;
    await next.start();
    const reloaded = await methods.getContent();
    const text = JSON.stringify(reloaded.doc);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(JSON.stringify(later.cores[0]!.getContent().doc)).toContain('alpha');
    await next.close();
  });
});

describe('flush (PRO-083, criterion 2) on a core that cannot confirm', () => {
  it('rejects at the timeout with the count, and the local edit stays in the visible document', async () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule });
    const api = hostApi(core);
    expect(core.pastePlainText('pending ')).toBe(true);
    const error = await api.flush({ timeoutMs: 20 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ count: 1 });
    expect((error as Error).message).toBe('1 unconfirmed commits remain');
    expect(JSON.stringify(core.getContent().doc)).toContain('pending');
  });
});
