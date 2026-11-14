// UX-016 criteria 4 and 6, on the element's own path: the session, the mounted headless core and
// its status view, against backend-mock. The host below mirrors `src/editor.ts`: `de-status` reads
// the core's connection and save state, and the core's connection is `reconnecting` while the
// channel is down. The room is taken down with the mock's own `unavailable` close, so the answer
// is the mock room's, not a stand-in. Node.js only; no browser run is claimed here.
import { DocumentCore } from '@docedit/engine/headless';
import type { Content, SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { elementMethods, hostApi, type MountedSession } from '../src/host-api.ts';
import type { Connection, DocEditorEventName, StatusDetail } from '../src/events.ts';
import type { EditorHandle, SessionHost } from '../src/session.ts';
import { Session } from '../src/session.ts';
import { until } from './core-host.ts';
import { backendFor, service } from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);

/** `CONNECTION` in `src/editor.ts`: the core's connection as `de-status` names it. */
const CONNECTION: Record<string, Connection> = {
  detached: 'offline',
  online: 'online',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

interface Recorded {
  name: DocEditorEventName;
  detail: unknown;
}

/** A session host that mounts the core and gives it the status view the editor gives (FE-007). */
function editorHost(): SessionHost & { cores: DocumentCore[]; events: Recorded[] } {
  const cores: DocumentCore[] = [];
  const events: Recorded[] = [];
  return {
    cores,
    events,
    emit(name, detail) {
      events.push({ name, detail });
    },
    async mount(content: Content) {
      const core = new DocumentCore({
        doc: { cdm: content.cdm, requires: [...content.requires], doc: content.doc },
        schedule: immediate,
      });
      cores.push(core);
      const status = {
        get: (): StatusDetail => ({
          connection: CONNECTION[core.connection.get()] ?? 'offline',
          sync: core.saveState.get(),
        }),
        subscribe: (update: () => void) => {
          const a = core.connection.subscribe(update);
          const b = core.saveState.subscribe(update);
          return () => {
            a();
            b();
          };
        },
      };
      const handle: EditorHandle = {
        attach: (channel, at) => core.attach(channel, at),
        setAccess: (access) => core.setAccess(access),
        saveState: core.saveState,
        confirmedSeq: core.confirmedSeq,
        access: core.permissions,
        status: status as unknown as EditorHandle['status'],
        recovered: null,
        problem: null,
        focus() {},
        destroy: () => core.destroy(),
        api: hostApi(core),
      };
      return handle;
    },
  };
}

/** The statuses the host heard, in order, as `connection/sync`. */
function statuses(host: { events: Recorded[] }): string[] {
  return host.events
    .filter((e) => e.name === 'de-status')
    .map((e) => {
      const d = e.detail as StatusDetail;
      return `${d.connection}/${d.sync}`;
    });
}

/** The document as another client loads it from the room (the server's confirmed content). */
async function serverText(
  s: ReturnType<typeof service>['service'],
  docId: string,
): Promise<string> {
  const owner = backendFor(s, docId, 'owner', 'owner');
  await owner.connect();
  const loaded = await owner.sync.loadContent(docId);
  await owner.close();
  return JSON.stringify(loaded.doc);
}

describe('UX-016 criterion 6: the host awaits flush(), and the indicator then shows saved', () => {
  it('after flush resolves, the last de-status the host heard reads saved, after a saving', async () => {
    const { service: s, docId } = service();
    const host = editorHost();
    let current: MountedSession | null = null;
    const methods = elementMethods(() => current);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    current = session;
    await session.start();
    const core = host.cores[0]!;

    expect(core.pastePlainText('pending ')).toBe(true);
    expect(core.saveState.get()).toBe('saving');
    await methods.flush({ timeoutMs: 5_000 });

    // The promise resolved: the indicator reads the status view, which shows saved at once.
    expect(session.editor!.status!.get()).toEqual({ connection: 'online', sync: 'saved' });
    expect(statuses(host)).toContain('online/saving');
    // `de-status` follows in the next frame (the status reporter coalesces per frame), so the
    // host hears saved a moment after the promise, not before.
    await until(() => statuses(host).at(-1) === 'online/saved', 'de-status saved', 2_000);
    expect(await serverText(s, docId)).toContain('pending');
    await session.close();
  });
});

describe('UX-016 criterion 4: the database is unavailable and the room answers unavailable', () => {
  it('editing goes on, the indicator shows unsaved, and it returns to saved without any action', async () => {
    const { service: s, docId } = service();
    const host = editorHost();
    // Keep a handle on the sync channels the session opens, so the test can take the room down
    // with the mock's own `unavailable` close (05 §5.8). The session reopens it after `retryInMs`.
    const backend = backendFor(s, docId, 'editor', 'editor');
    const channels: SyncChannel[] = [];
    const sync = backend.sync as unknown as { open: (...a: unknown[]) => Promise<SyncChannel> };
    const open = sync.open.bind(backend.sync);
    sync.open = async (...a: unknown[]) => {
      const channel = await open(...a);
      channels.push(channel);
      return channel;
    };
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    const core = host.cores[0]!;

    // The database holds the author's commit: writes are held, so the commit is in flight.
    const hold = s.holdWrites(docId);
    expect(core.pastePlainText('kept ')).toBe(true);
    expect(core.saveState.get()).toBe('saving');

    // The room answers unavailable; the channel is down for 400 ms.
    const channel = channels[0] as unknown as {
      serverClosed(code: 'unavailable', reason: string, retryInMs?: number): void;
    };
    channel.serverClosed('unavailable', 'the database is unavailable', 400);
    await until(() => core.saveState.get() === 'unsaved', 'the indicator to show unsaved');
    expect(core.connection.get()).toBe('reconnecting');
    expect(statuses(host)).toContain('reconnecting/unsaved');

    // The author keeps typing while the database is unavailable.
    expect(core.pastePlainText('typed on ')).toBe(true);
    expect(core.saveState.get()).toBe('unsaved');

    // The database comes back: the held writes go through, and the channel reopens by itself.
    await hold.release();
    await until(() => core.saveState.get() === 'saved', 'the indicator to return to saved', 5_000);
    expect(channels.length).toBeGreaterThanOrEqual(2);
    expect(statuses(host).at(-1)).toBe('online/saved');
    const text = await serverText(s, docId);
    expect(text).toContain('kept');
    expect(text).toContain('typed on');
    await session.close();
  });
});
