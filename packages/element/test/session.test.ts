// The load sequence of one document against the mock backend, which runs the real authority
// (PRO-074, PRO-075, PRO-087, PRO-088; FE-007). The editor is a stand-in, so these run in Node.js.
import { PortError, type Access } from '@docedit/protocol';
import { definition } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/events.ts';
import { Session } from '../src/session.ts';
import {
  IDS,
  USERS,
  backendFor,
  fakeEditor,
  manualFrames,
  names,
  recordingHost,
  service,
  settle,
} from './support.ts';

const immediate = (run: () => void) => queueMicrotask(run);

describe('Session: loading a document', () => {
  it('connects, loads content, mounts, opens the channel and raises de-ready { docId, seq }', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    expect(session.phase).toBe('ready');
    expect(editor.mounted).toHaveLength(1);
    expect(editor.attached).toHaveLength(1);
    expect(names(host.events)).toEqual(['de-ready', 'de-permission-change', 'de-status']);
    expect(host.events[0]!.detail).toEqual({ docId, seq: 0 });
    expect(host.events[2]!.detail).toEqual({ connection: 'online', sync: 'saved' });
    const access = host.events[1]!.detail as Access;
    expect(access.docRole).toBe('editor');
    // The core got the channel with the loaded seq and incarnation, the sync port to reopen it
    // and the session's limits (FE-033).
    const at = editor.attachedWith[0]!;
    expect(at.seq).toBe(0);
    expect(at.incarnation).toBe(editor.mounted[0]!.incarnation);
    expect(at.sync).toBe(session.backend!.sync);
    expect(at.limits?.maxCommitBytes).toBeGreaterThan(0);
    await session.close();
    await s.dispose();
  });

  it('raises de-error for each problem the core reports, fatal or not', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    editor.problem.set({
      n: 1,
      code: 'unsupported_feature',
      message: 'needs x-future',
      fatal: true,
    });
    editor.problem.set({
      n: 1,
      code: 'unsupported_feature',
      message: 'needs x-future',
      fatal: true,
    });
    editor.problem.set({
      n: 2,
      code: 'rebase_failed',
      message: 'a step was dropped',
      fatal: false,
    });
    expect(host.events.filter((e) => e.name === 'de-error').map((e) => e.detail)).toEqual([
      { code: 'unsupported_feature', message: 'needs x-future', fatal: true },
      { code: 'rebase_failed', message: 'a step was dropped', fatal: false },
    ]);
    await session.close();
    await s.dispose();
  });

  it('raises de-recovered-edits { count } when the core sets work aside', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    editor.recovered.set({ count: 1 });
    editor.recovered.set({ count: 1 });
    editor.recovered.set({ count: 2 });
    expect(host.events.filter((e) => e.name === 'de-recovered-edits').map((e) => e.detail)).toEqual(
      [{ count: 1 }, { count: 2 }],
    );
    await session.close();
    await s.dispose();
  });

  it('raises de-permission-change once per access message, with the new complete access (PRO-088)', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    s.setGrants(docId, [
      { region: IDS.locked, principal: `user:${USERS.editor.sub}`, role: 'editor' },
    ]);
    await settle();
    s.setGrants(docId, []);
    await settle();
    const changes = host.events.filter((e) => e.name === 'de-permission-change');
    expect(changes).toHaveLength(3);
    const scopes = changes.map((e) => (e.detail as Access).scopes[`region:${IDS.locked}`]);
    expect(scopes[1]).toContain('edit');
    expect(scopes[2]).not.toContain('edit');
    const revs = changes.map((e) => (e.detail as Access).rev);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
    expect(new Set(revs).size).toBe(3);
    await session.close();
    await s.dispose();
  });

  it('reports readonly when the access allows no change (FE-007)', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'viewer', 'viewer'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    expect(host.events.find((e) => e.name === 'de-status')?.detail).toEqual({
      connection: 'online',
      sync: 'readonly',
    });
    await session.close();
    await s.dispose();
  });

  it('follows the save state of the core, independently of the connection (FE-007)', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const frames = manualFrames();
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: frames.schedule,
    });
    await session.start();
    await settle();
    frames.flush();
    editor.saveState.set('saving');
    editor.saveState.set('saved');
    editor.saveState.set('saving');
    // Three changes in one frame: one event, with the last state.
    expect(frames.pending()).toBe(1);
    frames.flush();
    editor.saveState.set('saved');
    frames.flush();
    expect(host.events.filter((e) => e.name === 'de-status').map((e) => e.detail)).toEqual([
      { connection: 'online', sync: 'saved' },
      { connection: 'online', sync: 'saving' },
      { connection: 'online', sync: 'saved' },
    ]);
    await session.close();
    await s.dispose();
  });

  it('follows the DEP socket connection, independently of the save state (FE-007)', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const frames = manualFrames();
    // A DEP-style backend: its socket reports online, reconnecting or offline (PRO-093).
    let socketStatus: Connection = 'online';
    const socketListeners = new Set<(status: Connection) => void>();
    const socket = {
      get status(): Connection {
        return socketStatus;
      },
      onStatus(cb: (status: Connection) => void) {
        socketListeners.add(cb);
        return () => socketListeners.delete(cb);
      },
    };
    const setSocket = (status: Connection) => {
      socketStatus = status;
      for (const cb of [...socketListeners]) cb(status);
    };
    const backend = Object.assign(backendFor(s, docId, 'editor', 'editor'), { connection: socket });
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host,
      scheduler: frames.schedule,
    });
    await session.start();
    await settle();
    frames.flush();
    setSocket('reconnecting');
    frames.flush();
    editor.saveState.set('saving');
    frames.flush();
    setSocket('offline');
    frames.flush();
    // The connection returns while the save state is still saving: the two move independently.
    setSocket('online');
    frames.flush();
    editor.saveState.set('saved');
    frames.flush();
    expect(host.events.filter((e) => e.name === 'de-status').map((e) => e.detail)).toEqual([
      { connection: 'online', sync: 'saved' },
      { connection: 'reconnecting', sync: 'saved' },
      { connection: 'reconnecting', sync: 'saving' },
      { connection: 'offline', sync: 'saving' },
      { connection: 'online', sync: 'saving' },
      { connection: 'online', sync: 'saved' },
    ]);
    await session.close();
    await s.dispose();
  });

  it('raises de-change { seq } for confirmed changes, at most once per interval', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
      changeIntervalMs: 30,
    });
    await session.start();
    for (let seq = 1; seq <= 5; seq++) editor.confirmed.set(seq);
    await settle(60);
    editor.confirmed.set(6);
    await settle(60);
    expect(host.events.filter((e) => e.name === 'de-change').map((e) => e.detail)).toEqual([
      { seq: 5 },
      { seq: 6 },
    ]);
    await session.close();
    await s.dispose();
  });

  it('raises de-error forbidden or not_found when the document cannot be opened (PRO-074)', async () => {
    const { service: s, docId } = service();
    const ghost = '0192f0c4-7b1e-7c3a-9a54-00000000beef';
    const cases = [
      // The token covers `docId` only: opening another document is forbidden.
      { target: ghost, docs: { [docId]: 'editor' as const }, code: 'forbidden' },
      // The token covers a document that does not exist.
      { target: ghost, docs: { [ghost]: 'editor' as const }, code: 'not_found' },
    ];
    for (const c of cases) {
      const editor = fakeEditor();
      const host = recordingHost(editor);
      const session = new Session({
        docId: c.target,
        backend: s.backend(USERS.editor, c.docs),
        ownsBackend: true,
        host,
      });
      await session.start();
      expect(session.phase).toBe('failed');
      expect(names(host.events)).toEqual(['de-error']);
      const detail = host.events[0]!.detail as { code: string; fatal: boolean };
      expect([detail.code, detail.fatal]).toEqual([c.code, true]);
      expect(editor.mounted).toHaveLength(0);
    }
    await s.dispose();
  });

  it('raises de-error unavailable when the backend cannot be reached (discovery)', async () => {
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId: 'd1',
      backend: async () => {
        throw new PortError('unavailable', 'discovery: GET /.well-known/dep failed');
      },
      ownsBackend: true,
      host,
    });
    await session.start();
    expect(host.events).toEqual([
      {
        name: 'de-error',
        detail: {
          code: 'unavailable',
          message: 'connecting: discovery: GET /.well-known/dep failed',
          fatal: true,
        },
      },
    ]);
  });

  it('raises one de-auth-required, without the token, when the token source fails (PRO-075)', async () => {
    const { service: s, docId } = service();
    s.denyTokens(USERS.editor.sub);
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: true,
      host,
    });
    await session.start();
    await settle();
    expect(host.events).toEqual([
      { name: 'de-auth-required', detail: { docId, code: 'unauthenticated' } },
    ]);
    await s.dispose();
  });

  it('raises de-auth-required when the host revokes the session', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
      scheduler: immediate,
    });
    await session.start();
    await settle();
    s.revokeSessions(USERS.editor.sub);
    await settle();
    const after = host.events.slice(3);
    expect(after.filter((e) => e.name === 'de-auth-required')).toEqual([
      { name: 'de-auth-required', detail: { docId, code: 'revoked' } },
    ]);
    expect(after.find((e) => e.name === 'de-status')?.detail).toMatchObject({
      connection: 'offline',
    });
    await session.close();
    await s.dispose();
  });

  it('stops at any step when closed, raises nothing more and closes a backend it created', async () => {
    const { service: s, docId } = service();
    for (const steps of [0, 1, 2, 3]) {
      const editor = fakeEditor();
      const host = recordingHost(editor);
      const backend = backendFor(s, docId, 'editor', 'editor');
      let closed = 0;
      const close = backend.close.bind(backend);
      backend.close = async () => {
        closed++;
        await close();
      };
      const session = new Session({ docId, backend: async () => backend, ownsBackend: true, host });
      const started = session.start();
      for (let i = 0; i < steps; i++) await Promise.resolve();
      await session.close();
      await started;
      await settle();
      expect(host.events, `closed after ${steps} microtasks`).toEqual([]);
      expect(closed).toBeGreaterThanOrEqual(1);
      expect(editor.mounted.length).toBe(editor.destroyed);
    }
    await s.dispose();
  });

  it('closes the backend on close({ closeBackend }) even when the host passed it (PRO-090)', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const backend = backendFor(s, docId, 'editor', 'editor');
    let closed = 0;
    const close = backend.close.bind(backend);
    backend.close = async () => {
      closed++;
      await close();
    };
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host: recordingHost(editor),
    });
    await session.start();
    await session.close({ closeBackend: true });
    await session.close({ closeBackend: true });
    expect(closed).toBe(1);
    expect(editor.destroyed).toBe(1);
    await s.dispose();
  });

  it('raises only registry codes and never document text or a token in any detail (PRO-087)', async () => {
    const { service: s, docId } = service();
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const backend = backendFor(s, docId, 'editor', 'editor');
    const session = new Session({ docId, backend, ownsBackend: false, host, scheduler: immediate });
    await session.start();
    await settle();
    s.setGrants(docId, []);
    s.revokeSessions(USERS.editor.sub);
    await settle();
    await session.close();
    const failing = new Session({
      docId,
      backend: async () => {
        throw new PortError('rate_limited', 'slow down');
      },
      ownsBackend: true,
      host,
    });
    await failing.start();
    const text = ['Hello world', 'Open region', 'Between', 'Restricted text'];
    const all = JSON.stringify(host.events.map((e) => e.detail));
    for (const t of text) expect(all).not.toContain(t);
    // Mock tokens carry `jti`, `iat` and `exp`; none of them, nor a token member, reaches a detail.
    for (const key of ['"jti"', '"iat"', '"exp"', '"token"']) expect(all).not.toContain(key);
    expect(names(host.events)).toEqual(
      expect.arrayContaining(['de-ready', 'de-permission-change', 'de-status', 'de-auth-required']),
    );
    const codes = new Set(definition.ERROR_CODES);
    for (const e of host.events) {
      const code = (e.detail as { code?: string }).code;
      if (code !== undefined) expect(codes.has(code), code).toBe(true);
    }
    await s.dispose();
  });
});
