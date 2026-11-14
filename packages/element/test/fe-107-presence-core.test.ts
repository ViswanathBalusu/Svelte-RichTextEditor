// FE-107 criterion 3 through the real path: a Session mounts the headless editing core, hands it
// the backend's presence port, and reports arrivals and departures from the core's `presence` view.
// The peers are plain mock-backend sessions that publish `presence.update` themselves. Node.js only.
//
// backend-mock relays updates only; it sends no list of the peers already there when a channel
// opens. The document service does (`services/document-service/src/data-plane/presence.ts`, `join`:
// the peers that have published, right after `ch.opened`, and nothing when there are none). The
// first case adds that list to the reader's port, built from what the mock itself relayed to a
// listening session, so the reader meets a busy document as it would against the service.
import { MockService } from '@docedit/backend-mock';
import type { Backend, PresencePeers, PresencePort } from '@docedit/protocol';
import { DocumentCore } from '@docedit/engine/headless';
import { describe, expect, it } from 'vitest';
import type { EditorHandle, SessionHost } from '../src/session.ts';
import { Session } from '../src/session.ts';
import { until } from './core-host.ts';
import { LEGAL_GRANT, contractDocument } from './support.ts';

const BASELINE_MS = 50;

/** Mounts the core as `src/editor.ts` does, with its presence view on the handle. */
function presenceHost(): SessionHost & { cores: DocumentCore[]; atAttach: unknown[] } {
  const cores: DocumentCore[] = [];
  const atAttach: unknown[] = [];
  return {
    cores,
    atAttach,
    emit() {},
    async mount(content) {
      const core = new DocumentCore({
        doc: { cdm: content.cdm, requires: [...content.requires], doc: content.doc },
        schedule: (run) => queueMicrotask(run),
      });
      cores.push(core);
      const handle: EditorHandle = {
        attach: (channel, at) => {
          const detach = core.attach(channel, at);
          // The session starts watching right after this, in the same task.
          atAttach.push(core.presence.get());
          return detach;
        },
        setAccess: (access) => core.setAccess(access),
        saveState: core.saveState,
        confirmedSeq: core.confirmedSeq,
        access: core.permissions,
        status: null,
        recovered: null,
        problem: null,
        presence: core.presence,
        focus() {},
        destroy: () => core.destroy(),
      };
      return handle;
    },
  };
}

interface Peer {
  backend: Backend;
  close(): void;
  publish(anchor: number): void;
}

/** A session that opens the document and publishes its selection itself. */
async function peer(service: MockService, docId: string, sub: string): Promise<Peer> {
  const backend = service.backend({ sub, name: sub.toUpperCase() }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  return {
    backend,
    close: () => channel.close(),
    publish: (anchor) =>
      backend.presence!.update(docId, {
        seq: content.seq,
        state: { selection: { anchor, head: anchor }, scope: 'body', status: 'active' },
      }),
  };
}

/** The document service's list on joining (`PresenceRelay.join`), put before the port's own messages. */
function withJoinList(port: PresencePort, list: () => PresencePeers['peers']): PresencePort {
  return {
    update: (docId, update) => port.update(docId, update),
    onPeers: (docId, cb) => {
      const stop = port.onPeers(docId, cb);
      const peers = list();
      if (peers.length) queueMicrotask(() => cb({ peers, left: [] }));
      return stop;
    },
  };
}

async function reader(
  service: MockService,
  docId: string,
  joinList?: () => PresencePeers['peers'],
): Promise<{
  session: Session;
  core: () => DocumentCore;
  changes: string[];
  atAttach: unknown[];
}> {
  const backend = service.backend({ sub: 'rita', name: 'RITA' }, { [docId]: 'editor' });
  if (joinList) {
    const own = backend.presence!;
    Object.defineProperty(backend, 'presence', { value: withJoinList(own, joinList) });
  }
  const host = presenceHost();
  const changes: string[] = [];
  const session = new Session({
    docId,
    backend,
    ownsBackend: true,
    host,
    scheduler: (run) => queueMicrotask(run),
    onPresence: (change, user) => changes.push(`${change}:${user}`),
    presenceBaselineMs: BASELINE_MS,
  });
  await session.start();
  expect(session.phase).toBe('ready');
  return { session, core: () => host.cores[0]!, changes, atAttach: host.atAttach };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const service = new MockService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  return { service, docId };
}

describe('presence notices through the core and backend-mock (FE-107 criterion 3)', () => {
  it('does not announce the peers already in a busy document, and announces a later arrival and departure', async () => {
    const { service, docId } = setup();
    // A listening session records what the mock relays, as the service's relay keeps it.
    const listener = await peer(service, docId, 'lena');
    const published = new Map<string, PresencePeers['peers'][number]>();
    listener.backend.presence!.onPeers(docId, (state) => {
      for (const p of state.peers) published.set(p.session, p);
      for (const s of state.left) published.delete(s);
    });
    const ann = await peer(service, docId, 'ann');
    const bob = await peer(service, docId, 'bob');
    ann.publish(1);
    bob.publish(2);
    await until(() => published.size === 2, 'both peers relayed');

    const r = await reader(service, docId, () => [...published.values()]);
    // When the session started watching, the core's list was still empty: a baseline read then
    // would have announced both peers as arrivals.
    expect(r.atAttach).toEqual([[]]);
    await until(() => r.core().presence.get().length === 2, 'the two peers in the core');
    await pause(BASELINE_MS * 3);
    expect(r.changes).toEqual([]);

    ann.publish(3); // a peer already there moves: no notice
    const carl = await peer(service, docId, 'carl');
    carl.publish(1);
    await until(() => r.core().presence.get().length === 3, 'the third peer in the core');
    expect(r.changes).toEqual(['arrived:carl']);

    bob.close();
    await until(() => r.core().presence.get().length === 2, 'bob gone from the core');
    expect(r.changes).toEqual(['arrived:carl', 'left:bob']);

    await r.session.close();
    for (const p of [ann, carl, listener]) p.close();
    await service.dispose();
  });

  it('announces the first arrival to a reader who opened the document alone (no list on joining)', async () => {
    const { service, docId } = setup();
    const r = await reader(service, docId);
    await pause(BASELINE_MS * 3);
    const ann = await peer(service, docId, 'ann');
    ann.publish(1);
    await until(() => r.core().presence.get().length === 1, 'ann in the core');
    expect(r.changes).toEqual(['arrived:ann']);
    await r.session.close();
    ann.close();
    await service.dispose();
  });

  // Ann opens first but publishes only after the window: with no list on joining (backend-mock),
  // the reader learns of her then, and announces her. The service would have sent no list either.
  it('reports nothing after close, though the core empties its list on detach', async () => {
    const { service, docId } = setup();
    const ann = await peer(service, docId, 'ann');
    const r = await reader(service, docId);
    await pause(BASELINE_MS * 3);
    ann.publish(1);
    await until(() => r.core().presence.get().length === 1, 'ann in the core');
    await r.session.close();
    await pause(5);
    expect(r.changes).toEqual(['arrived:ann']);
    ann.close();
    await service.dispose();
  });
});
