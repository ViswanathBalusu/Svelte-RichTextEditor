// The embedding API's core members (PRO-083 flush, PRO-084 getContent, PRO-085 exec and
// queryCommand), run against the headless editing core in Node.js, first on the core alone and
// then through `elementMethods` over a Session against the mock backend, which is the element's
// own path (`DocEditorElement` forwards each method to it). The custom element itself needs a DOM.
import { DocumentCore } from '@docedit/engine/headless';
import { SPIKE_IDS, spikeDocument } from '@docedit/engine/testing';
import type { Access, Content } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import {
  NOT_LOADED_COMMAND,
  elementMethods,
  hostApi,
  type MountedSession,
} from '../src/host-api.ts';
import { Session, type EditorHandle, type SessionHost } from '../src/session.ts';
import { backendFor, fakeEditor, recordingHost, service } from './support.ts';

const schedule = (run: () => void) => queueMicrotask(run);
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;

/** An editor of the spike document: the body, not the restricted region (07 §4). */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: {
      doc: ['view'],
      body: [...EDIT],
      defs: ['view'],
      [`story:${SPIKE_IDS.header}`]: ['view'],
      [`region:${SPIKE_IDS.region}`]: [...READ],
    },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** A reader: view and comment only, everywhere. */
function readerAccess(): Access {
  return {
    ...editorAccess(),
    docRole: 'commenter',
    caps: [...READ],
    scopes: { doc: ['view'], body: [...READ], defs: ['view'] },
  };
}

describe('getContent (PRO-084)', () => {
  it('resolves the confirmed document, not the visible one, with its CDM version and seq', async () => {
    const loaded = spikeDocument();
    const core = new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule });
    const api = hostApi(core);
    // The document as loaded, with the defaults the schema fills in (the visible one, before any edit).
    const asLoaded = core.getContent().doc;
    expect(JSON.stringify(asLoaded)).toContain('Last paragraph.');
    // Nothing attached: the confirmed document is the one the core was given, at seq 0.
    expect(await api.getContent()).toEqual({
      cdm: loaded.cdm,
      requires: [...loaded.requires],
      doc: asLoaded,
      seq: 0,
    });
    // A local edit changes the visible document only: it is not confirmed.
    expect(core.pastePlainText('unconfirmed')).toBe(true);
    expect(core.getContent().doc).not.toEqual(asLoaded);
    expect(JSON.stringify(core.getContent().doc)).toContain('unconfirmed');
    const after = await api.getContent();
    expect(after.doc).toEqual(asLoaded);
    expect(JSON.stringify(after.doc)).not.toContain('unconfirmed');
    expect(after.seq).toBe(0);
  });
});

describe('flush (PRO-083)', () => {
  it('resolves at once when nothing is in flight or queued, with or without a timeout', async () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule });
    const api = hostApi(core);
    await expect(api.flush()).resolves.toBeUndefined();
    await expect(api.flush({ timeoutMs: 50 })).resolves.toBeUndefined();
  });
});

describe('exec and queryCommand (PRO-085)', () => {
  it('reports a command enabled for an editor and disabled for a reader, by the access in force', () => {
    const editor = new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule });
    const reader = new DocumentCore({ doc: spikeDocument(), access: readerAccess(), schedule });
    expect(hostApi(editor).queryCommand('bold').enabled).toBe(true);
    expect(hostApi(reader).queryCommand('bold').enabled).toBe(false);
  });

  it('runs an applicable command through the core: the mark becomes active at the caret', () => {
    const core = new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule });
    expect(core.activeMarks()).not.toContain('bold');
    expect(hostApi(core).exec('bold')).toBe(true);
    expect(core.activeMarks()).toContain('bold');
    expect(hostApi(core).queryCommand('bold').active).toBe(true);
  });

  it('refuses a command the access does not allow and changes nothing', () => {
    const core = new DocumentCore({ doc: spikeDocument(), access: readerAccess(), schedule });
    const before = JSON.stringify(core.getContent().doc);
    expect(hostApi(core).exec('bold')).toBe(false);
    expect(JSON.stringify(core.getContent().doc)).toBe(before);
  });

  it('answers disabled and inactive when no document is loaded', () => {
    expect(NOT_LOADED_COMMAND).toEqual({ enabled: false, active: false });
  });
});

/**
 * A host whose mount does what `src/editor.ts` does for the core, without the shell: a headless
 * core from the loaded content, attached by the session, with `api: hostApi(core)`.
 */
function coreHost(): SessionHost & { cores: DocumentCore[]; mounted: Content[] } {
  const cores: DocumentCore[] = [];
  const mounted: Content[] = [];
  return {
    cores,
    mounted,
    emit() {},
    async mount(content) {
      mounted.push(content);
      const core = new DocumentCore({
        doc: { cdm: content.cdm, requires: [...content.requires], doc: content.doc },
        schedule,
      });
      cores.push(core);
      const handle: EditorHandle = {
        attach: (channel, at) => core.attach(channel, at),
        setAccess: (access) => core.setAccess(access),
        saveState: core.saveState,
        confirmedSeq: core.confirmedSeq,
        access: core.permissions,
        status: null,
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

describe('the element methods over the session (PRO-083, PRO-084, PRO-085)', () => {
  // `elementMethods(() => session)` is what DocEditorElement builds with its own session, so this
  // runs the element's path: session, mounted editor, its `api`, the core.
  it('reach the mounted core: confirmed content and seq, commands, flush', async () => {
    const { service: s, docId } = service();
    const host = coreHost();
    let session: Session | null = null;
    const methods = elementMethods(() => session);
    session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
    });
    await session.start();
    expect(session.phase).toBe('ready');
    const core = host.cores[0]!;
    const loaded = host.mounted[0]!;

    const first = await methods.getContent();
    expect(first.seq).toBe(loaded.seq);
    expect(first.doc).toEqual(loaded.doc);
    expect(first.cdm).toBe(loaded.cdm);

    // The editor's access came from the channel: bold applies at the caret.
    expect(methods.queryCommand('bold')).toEqual({ enabled: true, active: false });
    expect(methods.exec('bold')).toBe(true);
    expect(methods.queryCommand('bold').active).toBe(true);

    // A local edit is visible at once but not confirmed: getContent still gives the loaded doc.
    expect(core.pastePlainText('pending')).toBe(true);
    expect(JSON.stringify(core.getContent().doc)).toContain('pending');
    const during = await methods.getContent();
    expect(during.doc).toEqual(loaded.doc);
    expect(during.seq).toBe(loaded.seq);

    // flush resolves once the commit is acknowledged; the confirmed document then holds the edit.
    await methods.flush({ timeoutMs: 5_000 });
    const confirmed = await methods.getContent();
    const owner = backendFor(s, docId, 'owner', 'owner');
    await owner.connect();
    const server = await owner.sync.loadContent(docId);
    await owner.close();
    expect(confirmed.seq).toBe(loaded.seq + 1);
    expect(confirmed.seq).toBe(server.seq);
    expect(confirmed.doc).toEqual(server.doc);
    expect(confirmed.doc).toEqual(core.getContent().doc);

    // A second session loads at the new seq, and getContent gives that seq.
    await session.close();
    const later = coreHost();
    const next = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host: later,
    });
    session = next;
    await next.start();
    const reloaded = await methods.getContent();
    expect(reloaded.seq).toBe(server.seq);
    expect(reloaded.doc).toEqual(server.doc);
    await next.close();
  });

  it('answer as not loaded with no session, a stand-in editor without api, and after close', async () => {
    let current: MountedSession | null = null;
    const methods = elementMethods(() => current);
    const notLoaded = async () => {
      expect(methods.exec('bold')).toBe(false);
      expect(methods.queryCommand('bold')).toEqual(NOT_LOADED_COMMAND);
      await expect(methods.flush()).resolves.toBeUndefined();
      await expect(methods.getContent()).rejects.toThrow('no document is loaded');
    };
    await notLoaded();

    const { service: s, docId } = service();
    const editor = fakeEditor();
    const session = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host: recordingHost(editor),
    });
    current = session;
    await session.start();
    expect(session.phase).toBe('ready');
    expect(session.editor?.api).toBeUndefined();
    await notLoaded();

    const host = coreHost();
    const live = new Session({
      docId,
      backend: backendFor(s, docId, 'editor', 'editor'),
      ownsBackend: false,
      host,
    });
    current = live;
    await live.start();
    expect(methods.queryCommand('bold').enabled).toBe(true);
    await live.close();
    await notLoaded();
    await session.close();
  });
});
