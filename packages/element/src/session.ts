/**
 * One loaded document: the steps from a document identifier and a backend to a live editor, and
 * the events the host sees on the way (05 §2, §5.2, §8.1; PRO-074, PRO-075, PRO-087, PRO-088).
 *
 *   backend → connect() → sync.loadContent(docId) → mount the editor → sync.open(docId, resume)
 *   → hand the channel to the editing core, in the same task → de-ready { docId, seq }
 *
 * Content is fetched first and the channel opened with `resume` at its `seq`, so the server streams
 * what is missing (05 §5.2 "Joining"). The core's sync client then owns the channel and reopens it
 * after a gap or a close, so the connection, the save state and the access come from the core's
 * views; the channel's own access messages are read too, so that each `perm.changed` is raised.
 * Each step checks that the session is still current, so a document change or `destroy()` in the
 * middle leaves nothing behind. No DOM: the element supplies `emit` and `mount`, so the sequence
 * runs in Node.js tests against the mock backend.
 */
import type {
  Access,
  Backend,
  Content,
  ErrorCode,
  Limits,
  PresencePort,
  Resume,
  SyncChannel,
  SyncPort,
  Unsubscribe,
} from '@docedit/protocol';
import type {
  Connection,
  DocEditorEventMap,
  DocEditorEventName,
  StatusDetail,
  SyncState,
} from './events.ts';
import type { AssetsPort as PictureAssetsPort, JournalPort } from '@docedit/engine';
import { pictureAssets } from './assets.ts';
import { type IdbJournal, openIdbJournal } from './journal-idb.ts';
import { AUTH_CODES, codeOf, messageOf } from './errors.ts';
import { manifestFamilyLookup, registerManifestFonts } from './font-loader.ts';
import type { HostApi } from './host-api.ts';
import {
  DEFAULT_PRESENCE_BASELINE_MS,
  PresenceWatch,
  type PeerLike,
  type PresenceChange,
} from './presence-notices.ts';
import { ChangeReporter, StatusReporter, type Scheduler } from './status.ts';
import { SelectionEvents, type SelectionWatch } from './selection-events.ts';
import { HeaderEvents, type HeaderWatch } from './header-events.ts';

export interface ReadView<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export interface AttachAt {
  seq: number;
  incarnation: string;
  view?: string;
  /** The recovery journal (FE-008); absent where the browser keeps none. */
  journal?: JournalPort;
  /** Lets the core reopen the channel and reload content on its own (FE-033). */
  sync?: Pick<SyncPort, 'open' | 'loadContent'>;
  limits?: Partial<Limits>;
  /** The backend's presence port: the core publishes the selection and lists the peers (04 §11). */
  presence?: PresencePort;
  /** This session (`welcome.session`), never listed as a peer. */
  session?: string;
  /** The user (`welcome.user.id`), whom suggestion marks name (03 §5; FE-042). */
  user?: string;
  /** The features both sides support, for the shell (05 §8.3). */
  features?: readonly string[];
  /** Uploads pasted pictures through the backend's assets port (FE-053; assets.ts). */
  assets?: PictureAssetsPort;
}

/** What the session needs from the mounted editor (the editing core and the shell). */
export interface EditorHandle {
  /** Hands the channel to the core's sync client; returns the function that takes it back. */
  attach(channel: SyncChannel, at: AttachAt): () => void;
  setAccess(access: Access): void;
  /** Resolves once the journal holds all unconfirmed work requested so far (FE-011). */
  flushJournal?(): Promise<void>;
  readonly saveState: ReadView<SyncState>;
  /** The confirmed `seq` (04 §7). */
  readonly confirmedSeq: ReadView<number> | null;
  /** The access in force, also after the core reopened the channel. */
  readonly access: ReadView<Access | null> | null;
  /** Connection and save state as `de-status` shows them (FE-007). */
  readonly status: ReadView<StatusDetail> | null;
  /** Work set aside (02 §2.2): `de-recovered-edits` carries the count. */
  readonly recovered: ReadView<{ count: number }> | null;
  /** The other sessions this reader may see (FE-107 criterion 3); absent in stand-in editors. */
  readonly presence?: ReadView<readonly PeerLike[]> | null;
  /** Something the core could not do (`n` counts them), raised as `de-error`. */
  readonly problem: ReadView<{
    n: number;
    code: string;
    message: string;
    fatal: boolean;
  } | null> | null;
  focus(): void;
  destroy(): void;
  /** The embedding API's core members (PRO-083 to PRO-085); absent in stand-in editors. */
  readonly api?: HostApi;
  /** The selection and command state the `de-selection` and `de-command-state` events watch (FE-028). */
  readonly watch?: SelectionWatch;
  /** What `de-mode-change`, `de-presence` and `de-counts` watch (UX-014; ADR 0361); absent in stand-in editors. */
  readonly header?: HeaderWatch;
}

export interface SessionHost {
  emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]): void;
  /** Creates the core and mounts the shell; rejects with a registry code the document cannot be read. */
  mount(
    content: Content,
    fontAlias?: (family: string) => string | undefined,
  ): Promise<EditorHandle>;
}

export interface SessionOptions {
  docId: string;
  /** The host's backend, or a function that creates one (the DEP client for an endpoint). */
  backend: Backend | (() => Promise<Backend>);
  /** True when the session created the backend, so that it closes it with itself. */
  ownsBackend: boolean;
  host: SessionHost;
  scheduler?: Scheduler;
  /** Interval of `de-change` (05 §8.1 says "debounced" without a value; ADR 0039). */
  changeIntervalMs?: number;
  /** Another session arrived or left (FE-107 criterion 3); `user` is its user identifier. */
  onPresence?: (change: PresenceChange, user: string) => void;
  /**
   * How long after the channel is attached the first `presence.state` is taken as the peers already
   * there, not announced (FE-107; ADR 0208). Default `DEFAULT_PRESENCE_BASELINE_MS`.
   */
  presenceBaselineMs?: number;
  /**
   * Registers the manifest's fonts on the page under hash aliases (FE-061). Default:
   * `registerManifestFonts` on `document.fonts`, which does nothing where there is no page.
   */
  registerFonts?: (port: NonNullable<Backend['fonts']>) => Promise<unknown>;
  /**
   * The directory, ending in `/`, the host serves KaTeX's `.woff2` files from (FE-069 criterion 3).
   * When given, the session registers them on the page under hash aliases (`loadKatexFonts`). How a
   * host supplies it (a `config` member) is not decided; absent, no KaTeX font is registered.
   */
  katexFontsUrl?: string;
}

export type Phase =
  'idle' | 'connecting' | 'loading' | 'mounting' | 'opening' | 'ready' | 'failed' | 'closed';

/** The DEP client's socket status (`@docedit/backend-dep`); other backends have none. */
interface ConnectionMember {
  readonly status: Connection;
  onStatus(cb: (status: Connection) => void): Unsubscribe;
}

function connectionMember(backend: Backend): ConnectionMember | null {
  const c = (backend as { connection?: unknown }).connection;
  if (c !== null && typeof c === 'object' && typeof (c as ConnectionMember).onStatus === 'function')
    return c as ConnectionMember;
  return null;
}

/** A provisional default, not a measurement (ADR 0039). */
export const DEFAULT_CHANGE_INTERVAL_MS = 500;

export class Session {
  readonly docId: string;
  readonly ownsBackend: boolean;
  readonly #options: SessionOptions;
  #phase: Phase = 'idle';
  #backend: Backend | null = null;
  #editor: EditorHandle | null = null;
  #detach: (() => void) | null = null;
  /** The recovery journal in IndexedDB (FE-008), when the browser gives one; closed on teardown. */
  #idbJournal: IdbJournal | null = null;
  #channel: SyncChannel | null = null;
  readonly #unsubscribe: Unsubscribe[] = [];
  readonly #status: StatusReporter;
  #change: ChangeReporter | null = null;
  #access: Access | null = null;
  #socket: Connection | null = null;
  #recovered = 0;
  #lastAuthCode: ErrorCode | null = null;
  /** FE-107: whether the core has taken a `presence.state`, and the watch that announces changes. */
  #peersAwaited = false;
  #peersTaken = false;
  #presenceWatch: PresenceWatch | null = null;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.docId = options.docId;
    this.ownsBackend = options.ownsBackend;
    // A backend the host passed is known at once, so that close() reaches it however early it runs.
    if (typeof options.backend !== 'function') this.#backend = options.backend;
    this.#status = new StatusReporter(
      (status) => this.#emit('de-status', status),
      { connection: 'offline', sync: 'saved' },
      options.scheduler,
    );
  }

  get phase(): Phase {
    return this.#phase;
  }

  get backend(): Backend | null {
    return this.#backend;
  }

  get editor(): EditorHandle | null {
    return this.#editor;
  }

  get access(): Access | null {
    return this.#access;
  }

  get closed(): boolean {
    return this.#phase === 'closed';
  }

  #emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]): void {
    // After close() the host hears nothing more from this session (PRO-076).
    if (this.#phase !== 'closed') this.#options.host.emit(name, detail);
  }

  /** Runs the load sequence. Resolves when the editor is live or the load has failed. */
  async start(): Promise<void> {
    if (this.#phase !== 'idle') return;
    try {
      this.#phase = 'connecting';
      const source = this.#options.backend;
      const backend = typeof source === 'function' ? await source() : source;
      if (this.closed) return this.#release(backend);
      this.#backend = backend;
      await backend.connect();
      if (this.closed) return;
      this.#watchBackend(backend);
      // FE-061: the manifest's files go on the page under hash aliases, alongside the load. A
      // manifest that cannot be read leaves the editor on its fallback fonts; the load goes on.
      // FE-062 criterion 1: the family lookup the engine draws with is read alongside it.
      const families = backend.fonts ? manifestFamilyLookup(backend.fonts) : undefined;
      if (backend.fonts) {
        const register = this.#options.registerFonts ?? registerManifestFonts;
        void register(backend.fonts).catch(() => {});
      }
      // FE-069 criterion 3: the KaTeX files, from the host's directory, under hash aliases. Loaded
      // lazily, so a session without it never loads KaTeX's sheet.
      const katexFontsUrl = this.#options.katexFontsUrl;
      if (katexFontsUrl !== undefined)
        void import('./katex-fonts.ts')
          .then((m) => m.loadKatexFonts(katexFontsUrl))
          .catch(() => {});

      this.#phase = 'loading';
      const content = await backend.sync.loadContent(this.docId);
      if (this.closed) return;

      this.#phase = 'mounting';
      const fontAlias = families ? await families : undefined;
      if (this.closed) return;
      const editor = await this.#options.host.mount(content, fontAlias);
      if (this.closed) return editor.destroy();
      this.#editor = editor;

      // The journal opens before the channel, so that the attach below stays in the task that
      // opened the channel (D21).
      const journal = await openDefaultJournal();
      if (this.closed) {
        journal?.close();
        return;
      }
      this.#idbJournal = journal;
      this.#phase = 'opening';
      const resume: Resume = { seq: content.seq, incarnation: content.incarnation };
      if (content.view !== undefined) resume.view = content.view;
      const channel = await backend.sync.open(this.docId, { resume });
      if (this.closed) return channel.close();
      // In the same task as open() resolved, before anything else is awaited: the core reads
      // `channel.opened` and subscribes first, so no message passes it by (decision D21).
      const at: AttachAt = {
        seq: content.seq,
        incarnation: content.incarnation,
        sync: backend.sync,
      };
      if (content.view !== undefined) at.view = content.view;
      if (journal) at.journal = journal;
      const welcome = backend.auth.session;
      if (welcome) {
        at.limits = welcome.limits;
        at.session = welcome.session;
        at.user = welcome.user.id;
      }
      if (backend.presence && backend.features.has('presence'))
        at.presence = this.#presencePort(backend.presence);
      if (backend.assets && backend.features.has('assets'))
        at.assets = pictureAssets(backend.assets, this.docId);
      at.features = [...backend.features];
      this.#channel = channel;
      this.#detach = editor.attach(channel, at);
      this.#watchEditor(channel, editor);

      this.#phase = 'ready';
      this.#emit('de-ready', { docId: this.docId, seq: content.seq });
      this.#onAccess(channel.opened.access);
      this.#updateStatus();
    } catch (e) {
      if (!this.closed) this.#fail(e);
    }
  }

  #watchBackend(backend: Backend): void {
    this.#unsubscribe.push(
      backend.auth.onAuthRequired((e) => this.#authRequired(e.code)),
      backend.auth.onRevoked(() => this.#authRequired('revoked')),
    );
    const socket = connectionMember(backend);
    if (socket) {
      this.#socket = socket.status;
      this.#unsubscribe.push(
        socket.onStatus((status) => {
          this.#socket = status;
          if (status === 'online') this.#lastAuthCode = null;
          this.#updateStatus();
        }),
      );
    }
  }

  #watchEditor(channel: SyncChannel, editor: EditorHandle): void {
    // Every `perm.changed` of the channel the session opened, and whatever the core takes later
    // from a channel it reopened itself: both raise each revision once.
    this.#unsubscribe.push(channel.onAccess((access) => this.#onAccess(access)));
    // When the page is hidden, every pending journal write is started and awaited (FE-011). This
    // does not wait for `pagehide`, which browsers do not reliably deliver.
    if (typeof document !== 'undefined' && editor.flushJournal) {
      const flush = editor.flushJournal.bind(editor);
      const onHidden = () => {
        if (document.visibilityState === 'hidden') void flush().catch(() => {});
      };
      document.addEventListener('visibilitychange', onHidden);
      this.#unsubscribe.push(() => document.removeEventListener('visibilitychange', onHidden));
    }
    const access = editor.access;
    if (access)
      this.#unsubscribe.push(
        access.subscribe(() => {
          const a = access.get();
          if (a) this.#onAccess(a);
        }),
      );
    if (editor.status) this.#unsubscribe.push(editor.status.subscribe(() => this.#updateStatus()));
    else this.#unsubscribe.push(editor.saveState.subscribe(() => this.#updateStatus()));
    // `de-selection` and `de-command-state` (FE-028): one check per core notification, so one
    // event of each kind at most per frame. Torn down with the other subscriptions at close().
    if (editor.watch) {
      const selection = new SelectionEvents(editor.watch, {
        selection: (detail) => this.#emit('de-selection', detail),
        commandState: (detail) => this.#emit('de-command-state', detail),
      });
      this.#unsubscribe.push(selection.start());
    }
    // What a host-drawn header shows besides `de-status` (UX-014 criterion 5): the state now, then
    // each change. Torn down with the other subscriptions at close().
    if (editor.header) {
      const header = new HeaderEvents(editor.header, {
        mode: (detail) => this.#emit('de-mode-change', detail),
        presence: (detail) => this.#emit('de-presence', detail),
        counts: (detail) => this.#emit('de-counts', detail),
      });
      this.#unsubscribe.push(header.start());
    }
    const confirmed = editor.confirmedSeq;
    if (confirmed) {
      const change = new ChangeReporter(
        (seq) => this.#emit('de-change', { seq }),
        confirmed.get(),
        this.#options.changeIntervalMs ?? DEFAULT_CHANGE_INTERVAL_MS,
      );
      this.#change = change;
      this.#unsubscribe.push(confirmed.subscribe(() => change.confirmed(confirmed.get())));
    }
    const problem = editor.problem;
    if (problem) {
      let seen = problem.get()?.n ?? 0;
      this.#unsubscribe.push(
        problem.subscribe(() => {
          const p = problem.get();
          if (!p || p.n === seen) return;
          seen = p.n;
          // A reload or reset that brought content this build cannot read, a divergence, dropped
          // steps: the core reports them; fatal ones have stopped its sync client.
          this.#emit('de-error', {
            code: codeOf(p),
            message: messageOf(p.message),
            fatal: p.fatal,
          });
        }),
      );
    }
    const recovered = editor.recovered;
    if (recovered) {
      this.#recovered = recovered.get().count;
      this.#unsubscribe.push(
        recovered.subscribe(() => {
          const count = recovered.get().count;
          if (count === this.#recovered) return;
          this.#recovered = count;
          this.#emit('de-recovered-edits', { count });
        }),
      );
    }
    // Other sessions arriving and leaving are announced by the host (FE-107 criterion 3). The core's
    // list is empty until the backend's first `presence.state` arrives, later than this: the peers
    // in that first state are the baseline, not arrivals (#presencePort). Without a presence port,
    // or once a state has been taken, the list in hand is the baseline; when no state comes within
    // the opening window (the service sends none to a reader who is alone), the list then is.
    const presence = editor.presence;
    if (presence) {
      const watch = new PresenceWatch(null, (change, user) =>
        this.#options.onPresence?.(change, user),
      );
      this.#presenceWatch = watch;
      this.#unsubscribe.push(presence.subscribe(() => watch.update(presence.get())));
      if (this.#peersTaken || !this.#peersAwaited) watch.settle(presence.get());
      else {
        const ms = this.#options.presenceBaselineMs ?? DEFAULT_PRESENCE_BASELINE_MS;
        const timer = setTimeout(() => watch.settle(presence.get()), ms);
        this.#unsubscribe.push(() => clearTimeout(timer));
      }
    }
  }

  /**
   * The presence port handed to the core: the same port, and after each `presence.state` the core
   * has taken (its list is then current, its notification may still be queued) the watch is settled
   * with that list if it has no baseline yet (FE-107; ADR 0208).
   */
  #presencePort(port: PresencePort): PresencePort {
    this.#peersAwaited = true;
    return {
      update: (docId, update) => port.update(docId, update),
      onPeers: (docId, cb) =>
        port.onPeers(docId, (state) => {
          cb(state);
          this.#peersTaken = true;
          const peers = this.#editor?.presence;
          if (peers) this.#presenceWatch?.settle(peers.get());
        }),
    };
  }

  /** `access` from `ch.opened`, then from each `perm.changed`: raised once per revision. */
  #onAccess(access: Access): void {
    if (this.#access && access.rev <= this.#access.rev) return;
    this.#access = access;
    // A core that takes access from the channel itself needs no copy.
    if (this.#editor && !this.#editor.access) this.#editor.setAccess(access);
    this.#emit('de-permission-change', access);
    this.#updateStatus();
  }

  #updateStatus(): void {
    if (this.#phase !== 'ready' || !this.#editor) return;
    const core = this.#editor.status?.get() ?? null;
    let connection: Connection = core?.connection ?? 'online';
    // The DEP client's socket is the earlier witness of a lost connection.
    if (connection === 'online' && this.#socket !== null && this.#socket !== 'online')
      connection = this.#socket;
    if (connection === 'online') this.#lastAuthCode = null;
    const sync = core?.sync ?? this.#editor.saveState.get();
    this.#status.update({ connection, sync });
  }

  /** One `de-auth-required` per failure, even when the backend reports it twice (05 §5.8). */
  #authRequired(code: ErrorCode): void {
    if (this.#lastAuthCode === code) return;
    this.#lastAuthCode = code;
    this.#emit('de-auth-required', { docId: this.docId, code });
  }

  #fail(e: unknown): void {
    const code = codeOf(e);
    const phase = this.#phase;
    this.#phase = 'failed';
    this.#teardown();
    if (this.ownsBackend && this.#backend) void this.#release(this.#backend);
    if (AUTH_CODES.has(code)) {
      // The load ends here; the host gets a new token and calls load() (13 §11.1).
      this.#options.host.emit('de-auth-required', { docId: this.docId, code });
      return;
    }
    this.#options.host.emit('de-error', {
      code,
      message: `${phase}: ${messageOf(e)}`,
      fatal: true,
    });
  }

  /** Focus moves into the editing surface, if one is mounted. */
  focus(): boolean {
    if (!this.#editor) return false;
    this.#editor.focus();
    return true;
  }

  #teardown(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#detach?.();
    this.#detach = null;
    this.#channel?.close();
    this.#channel = null;
    this.#idbJournal?.close();
    this.#idbJournal = null;
    this.#editor?.destroy();
    this.#editor = null;
    this.#status.close();
    this.#change?.close();
    this.#change = null;
  }

  async #release(backend: Backend): Promise<void> {
    if (this.ownsBackend) await backend.close().catch(() => {});
  }

  /**
   * Ends the session: the channel and the editor go, and nothing more is raised. The backend is
   * closed when the session created it, or when `closeBackend` is set (the element is destroyed).
   */
  async close(opts: { closeBackend?: boolean } = {}): Promise<void> {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    this.#teardown();
    const backend = this.#backend;
    this.#backend = null;
    if (backend && (this.ownsBackend || opts.closeBackend)) await backend.close().catch(() => {});
  }
}

/**
 * The journal in the browser's IndexedDB (FE-008). Where it cannot be opened the element carries on
 * without one, as it did before the journal existed: unconfirmed work is then not kept.
 */
async function openDefaultJournal(): Promise<IdbJournal | null> {
  try {
    return await openIdbJournal(globalThis.indexedDB);
  } catch {
    return null;
  }
}
