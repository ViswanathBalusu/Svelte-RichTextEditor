/**
 * The `<doc-editor>` element (02 §2, §2.1, §3; 05 §8.1; ADR 0002, ADR 0039): one hand-written class
 * that extends `HTMLElement`, attaches an open shadow root and mounts an ordinary Svelte 5
 * application into it. It is not produced by Svelte's `customElement` option.
 *
 * Lifecycle (02 §2.1):
 * - constructor: attaches the root and captures properties a framework set before the class was
 *   defined (FE-003);
 * - loading starts in a microtask once the element is connected and has a document identifier
 *   (`doc-id`) and a token source (`getToken` with `endpoint`, or `backend`), in whatever order
 *   they were set; it starts once for one document and source (FE-003; PRO-075);
 * - a later connection resumes; `connectedMoveCallback` does nothing;
 * - `disconnectedCallback` waits one microtask, then suspends, and destroys after the grace period
 *   (default 30 seconds) unless `keep-alive` is present (FE-004, FE-006);
 * - `destroy()` releases everything and nothing more is raised (PRO-076).
 *
 * The module reads no browser global when there is no DOM, so importing it on a server is safe
 * (FE-001): the base class is chosen with an existence check, and the editor code (engine, shell,
 * Svelte, styles) is a separate chunk loaded with the first document.
 */
import { hasPort } from '@docedit/protocol';
import type {
  Backend,
  Content,
  ExportJob,
  ResolveUsers,
  SearchPrincipals,
} from '@docedit/protocol';
import type { ExportService } from '@docedit/ui';
import type {
  CdmFragment,
  CommandArgs,
  CommandName,
  CommandState,
  EditMode,
  InsertResult,
} from '@docedit/engine/headless';
import { endpointBackend } from './backend-source.ts';
import { normaliseConfig, type DocEditorConfig, type NormalConfig } from './config.ts';
import type { HostExtension } from './extensions.ts';
import { exportEvent, startExport, type ExportRequest } from './export.ts';
import { exportService } from './export-service.ts';
import type { SigningSource } from './signing.ts';
import type { WorkflowSendSource } from './workflow-send.ts';
import type { CompleteFillingOutcome } from './fill-actions.ts';
import type { PrintOutcome } from './print.ts';
import {
  elementMethods,
  type ConfirmedContent,
  type ExecOutcome,
  type FieldFillOutcome,
  type FieldReport,
  type HostApi,
} from './host-api.ts';
import type * as EditorChunk from './editor.ts';
import type { IconOverrides, MountedEditor, SettingsStore, StringOverrides } from './editor.ts';

type EditorModule = typeof EditorChunk;
import { emit, type DocEditorEventMap, type DocEditorEventName } from './events.ts';
import type { StatusDetail } from './events.ts';
import { headerSnapshot, type HeaderSnapshot } from './header-events.ts';
import { INTERNALS } from './internals.ts';
import { Announcer, DEFAULT_SETTLE_MS } from './announcer.ts';
import { mountLiveRegion, type LiveRegion } from './live-region.ts';
import type { AssetImageLookup } from '@docedit/engine';
import { assetImageLookup } from './assets.ts';
import { equationDrawer } from './equation-drawer.ts';
import { Session } from './session.ts';
import { failureView, mountFailure, type FailureInfo, type FailureSurface } from './failure.ts';
import type { MountedReadView } from './read-view-element.ts';
import { loadLayoutReport, pageGuideBlockIds, type LayoutReport } from './page-guides.ts';
import { selectView, VIEW_STRINGS, type ViewName } from './view-select.ts';
import { frameScheduler } from './status.ts';
import { chooseMeasurementProvider, noticeReason, showPageViewNotice } from './kernel-fallback.ts';
import { ElementKernel } from './layout-kernel-request.ts';
import { EMBEDDING_VERSION, RELEASE } from './version.ts';

/** `getToken` (05 §8.1): returns a token for the document, held in memory only. */
export type GetToken = (ctx: { docId: string }) => Promise<string>;

/**
 * The PDF viewer's page, relative to this module (the library build puts it in `viewer/`). A
 * variable, not a literal, so the bundler leaves the URL to be resolved where the module is served.
 */
const VIEWER_PAGE = './viewer/pdf-viewer.html';

// No DOM (a server import): the class extends a plain class and is never registered.
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

/** Properties a framework may set before the element is upgraded (FE-003). */
const CAPTURED = [
  'getToken',
  'backend',
  'config',
  'searchPrincipals',
  'resolveUsers',
  'extensions',
  'strings',
  'icons',
] as const;

/**
 * The attributes of 05 §8.1, and the proposed `header` (`default` or `none`; UX-014, ADR 0041 and
 * ADR 0361), which 05 §8.1 does not name yet.
 */
export const OBSERVED_ATTRIBUTES = [
  'doc-id',
  'endpoint',
  'mode',
  'view',
  'locale',
  'theme',
  'toolbar',
  'header',
  'keep-alive',
] as const;

/** The values of `mode` (05 §8.1), kept here so the element's module imports no engine code. */
const MODES: readonly EditMode[] = ['edit', 'review', 'view', 'fill'];

/**
 * The requested mode of a `mode` attribute. Absent or unknown, it is `edit`, the core's default: the
 * spec does not state the default (PRO-077 Notes), and the server's permissions still apply.
 */
export function modeFrom(value: string | null): EditMode {
  const v = value?.trim().toLowerCase();
  return MODES.find((m) => m === v) ?? 'edit';
}

type Source =
  | { kind: 'backend'; backend: Backend; key: Backend }
  | { kind: 'endpoint'; endpoint: string; getToken: GetToken; key: string };

function isBackend(value: unknown): value is Backend {
  if (value === null || typeof value !== 'object') return false;
  const b = value as Partial<Backend>;
  return typeof b.connect === 'function' && typeof b.close === 'function' && !!b.sync;
}

/** The `headerState` property: `status` is null where the editor reports none. */
export interface HeaderState extends HeaderSnapshot {
  readonly status: StatusDetail | null;
}

export class DocEditorElement extends Base {
  /** The embedding API version (05 §8), separate from the protocol version. */
  static readonly version: string = EMBEDDING_VERSION;
  /** The release of this package (FE-001; ADR 0039). */
  static readonly release: string = RELEASE;

  static get observedAttributes(): string[] {
    return [...OBSERVED_ATTRIBUTES];
  }

  readonly #root: ShadowRoot;
  #getToken: GetToken | null = null;
  #backend: Backend | null = null;
  #configInput: DocEditorConfig | null = null;
  #config: NormalConfig = normaliseConfig(null);
  #resolveUsers: ResolveUsers | null = null;
  #searchPrincipals: SearchPrincipals | null = null;
  #extensions: readonly HostExtension[] = [];
  #strings: StringOverrides | null = null;
  #icons: IconOverrides | null = null;

  #session: Session | null = null;
  #sessionKey: Backend | string | null = null;
  /** `toolbar` and `locale` for the shell, kept current from the attributes (FE-003). */
  #settings: SettingsStore | null = null;
  #editorModule: EditorModule | null = null;
  /**
   * The editor the last mount returned. The session holds it only after its mount resolves, so a
   * `mode` change in between would be lost if it were read from the session.
   */
  #mounted: MountedEditor | null = null;
  #loadQueued = false;
  /** Bumped by destroy(), so that a load scheduled before it does not run after it. */
  #generation = 0;
  #reload = false;
  #suspended = false;
  /** Whether focus was inside the shadow root when it was last connected (FE-005). */
  #focusWithin = false;
  /** The read view of `view="read"` and what it shows (FE-072); no session exists while it does. */
  #readView: MountedReadView | null = null;
  /** The `layout.json` the completed export of the current session reported (FE-068). */
  #layout: LayoutReport | null = null;
  /** The web view's label, while the web view is shown (FE-065 criterion 1). */
  #webLabel: HTMLElement | null = null;
  /** The message of a load that failed (PRO-039; failure.ts); removed when a new load starts. */
  #failure: FailureSurface | null = null;
  #readViewOf: { docId: string; key: unknown } | null = null;
  #readToken: object | null = null;
  /**
   * The view the element shows in place of the one the `view` attribute asks for, after the user
   * selected an export diagnostic in the read view (FE-072 criterion 4). The attribute keeps the
   * host's value; setting it again clears this.
   */
  #viewOverride: ViewName | null = null;
  /** The message that says the page view is not available because the kernel did not start (WASM-003). */
  #kernelNotice: HTMLElement | null = null;
  /** The element's layout kernel: its worker runs while the page view is asked for (WASM-004). */
  #kernel: ElementKernel | null = null;
  /** The block the editor moves to as soon as the web view is shown (FE-072 criterion 4). */
  #pendingBlock: string | null = null;
  #grace: ReturnType<typeof setTimeout> | null = null;
  /** flush, getContent, exec and queryCommand over the current session (src/host-api.ts). */
  readonly #methods: HostApi = elementMethods(() => this.#session);
  /** The live region of the announcements, in the shadow root (FE-107). */
  readonly #live: LiveRegion;
  /** Announces the current session's save-state changes, one sentence per frame (FE-107). */
  #announcer: Announcer | null = null;

  constructor() {
    super();
    // Open, without delegatesFocus (02 §3): ProseMirror's focus handling and testing tools need an
    // open root, and focus is moved explicitly so a click on the page reaches the text (FE-013).
    this.#root = this.attachShadow({ mode: 'open' });
    this.#live = mountLiveRegion(this.#root);
    // A same-task move drops the selection and the scroll position with the removed subtree, so
    // both are kept as they change and put back when the element connects again (FE-005).
    this.#root.addEventListener('focusin', () => {
      this.#focusWithin = true;
    });
    // The blur that a removal causes has no new target, so the flag holds through the move. Focus
    // that goes to another element, or a press outside the element (see #onOutsidePress), clears it.
    this.#root.addEventListener('focusout', (ev) => {
      if ((ev as FocusEvent).relatedTarget !== null) this.#focusWithin = false;
    });
    // A framework that set a property before the class was defined created an own property that
    // shadows the accessor: take its value and remove it (FE-003).
    for (const name of CAPTURED) {
      if (Object.prototype.hasOwnProperty.call(this, name)) {
        const value = (this as Record<string, unknown>)[name];
        Reflect.deleteProperty(this, name);
        (this as Record<string, unknown>)[name] = value;
      }
    }
    INTERNALS.set(this, () => ({
      root: this.#root,
      session: this.#session,
      editor: (this.#session?.editor as MountedEditor | null | undefined) ?? null,
      suspended: this.#suspended,
      graceScheduled: this.#grace !== null,
      liveRegion: this.#live.element,
      announcer: this.#announcer,
      settings: this.#settings,
    }));
  }

  // --- Properties (05 §8.1) -----------------------------------------------------------------

  /** Called with `{ docId }` at start and when the token must be renewed. */
  get getToken(): GetToken | null {
    return this.#getToken;
  }

  set getToken(value: GetToken | null) {
    this.#getToken = typeof value === 'function' ? value : null;
    // A load that failed (for example on a refused token) is retried with the new source.
    if (this.#session?.phase === 'failed') this.#reload = true;
    this.#scheduleLoad();
  }

  /** Any implementation of the backend ports (05 §8.3); `endpoint` is then ignored. */
  get backend(): Backend | null {
    return this.#backend;
  }

  set backend(value: Backend | null) {
    this.#backend = isBackend(value) ? value : null;
    this.#scheduleLoad();
  }

  /** The configuration as the host set it; unknown keys are ignored (PRO-081). */
  get config(): DocEditorConfig {
    return this.#configInput ?? {};
  }

  set config(value: DocEditorConfig) {
    this.#configInput = value;
    this.#config = normaliseConfig(value);
    this.#applyPageGuides();
  }

  get resolveUsers(): ResolveUsers | null {
    return this.#resolveUsers;
  }

  /** Names and avatars from the host's directory (PRO-080); read whenever the shell asks. */
  set resolveUsers(value: ResolveUsers | null) {
    this.#resolveUsers = typeof value === 'function' ? value : null;
  }

  get searchPrincipals(): SearchPrincipals | null {
    return this.#searchPrincipals;
  }

  /** Users and groups for the grants dialog and mentions (PRO-080), which arrive in phase 1b. */
  set searchPrincipals(value: SearchPrincipals | null) {
    this.#searchPrincipals = typeof value === 'function' ? value : null;
  }

  /**
   * The host's replacement strings by key (UX-063). A key the host omits falls back to the source
   * table; a key no table knows is reported to the console.
   */
  get strings(): StringOverrides | null {
    return this.#strings;
  }

  set strings(value: StringOverrides | null) {
    const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
    this.#strings = plain ? value : null;
    // A change while the shell is mounted takes effect without remounting it (UX-064).
    this.#mounted?.setStrings(this.#strings ?? {});
  }

  /**
   * The host's replacement icons by the command's icon name (UX-063): SVG path data, or a drawing
   * ({ paths, viewBox?, fill? }). An icon the host omits, or gives as anything but path data, keeps
   * the built-in drawing. Icons are shown once the host gives a set (an empty object asks for the
   * built-in drawings alone); without one, commands show labels only. Icons are drawn by the shell
   * and never inserted as markup.
   */
  get icons(): IconOverrides | null {
    return this.#icons;
  }

  set icons(value: IconOverrides | null) {
    const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
    this.#icons = plain ? value : null;
    this.#mounted?.setIcons(this.#icons);
  }

  /**
   * Host-registered extensions (13 §7, 05 §8.1; the entry type is `HostExtension`). A change while the
   * shell is mounted is applied at once (UX-050). A value that is not an array gives no extensions.
   */
  get extensions(): readonly HostExtension[] {
    return this.#extensions;
  }

  set extensions(value: readonly HostExtension[]) {
    this.#extensions = Array.isArray(value) ? Object.freeze([...value]) : [];
    this.#mounted?.setExtensions(this.#extensions);
  }

  /**
   * What a host-drawn header shows, as it is now (UX-014 criterion 5; proposed, ADR 0361): the
   * connection and save state of `de-status`, and the details of `de-mode-change`, `de-presence`
   * and `de-counts`. Null until the editor is live. Read-only: identifiers, states and counts, no
   * content and no token.
   */
  get headerState(): HeaderState | null {
    const editor = this.#session?.editor;
    if (!editor?.header) return null;
    const status = editor.status?.get() ?? null;
    return {
      status: status ? { connection: status.connection, sync: status.sync } : null,
      ...headerSnapshot(editor.header),
    };
  }

  // --- Lifecycle (02 §2.1) ------------------------------------------------------------------

  connectedCallback(): void {
    this.#cancelGrace();
    // A move that removed the focused editor and put it back in the same task: the browser has
    // dropped the selection with the subtree, so focus is put back with it (FE-005).
    const refocus = this.#focusWithin;
    // Resuming keeps the session, its core and its shell, and reopens the channel with a resume
    // (FE-005). A change made while disconnected is picked up by the same reconciliation.
    if (this.#suspended) this.#session?.resume();
    this.#suspended = false;
    this.#scheduleLoad();
    if (refocus && !this.#root.activeElement) this.focus();
    document.addEventListener('pointerdown', this.#onOutsidePress, true);
  }

  /** A press outside the element ends its focus: a later move must not take focus back. */
  readonly #onOutsidePress = (ev: Event): void => {
    if (!ev.composedPath().includes(this)) this.#focusWithin = false;
  };

  /** Moving the element without disconnecting it changes nothing (02 §2.1). */
  connectedMoveCallback(): void {}

  disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.#onOutsidePress, true);
    // A framework that moves the element disconnects and reconnects it in one task.
    queueMicrotask(() => {
      if (!this.isConnected) this.#suspend();
    });
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value) return;
    switch (name) {
      case 'doc-id':
      case 'endpoint':
        this.#scheduleLoad();
        break;
      case 'keep-alive':
        if (this.#suspended) {
          if (value === null) this.#startGrace();
          else this.#cancelGrace();
        }
        break;
      case 'toolbar':
      case 'header':
      case 'locale':
      case 'theme':
        // Reflected into the mounted shell without remounting it (FE-003; PRO-079).
        if (this.#settings && this.#editorModule)
          this.#settings.set(this.#editorModule.settingsFrom(this.#attributes()));
        break;
      case 'mode':
        // The same core takes the new mode: no reload, and unconfirmed work stays (FE-029). The
        // attribute keeps the host's value; the effective mode is the core's.
        this.#mounted?.setMode(modeFrom(value));
        break;
      case 'view':
        // A change of `view` is reflected by the reconcile a new document takes (FE-065). Between web and
        // print the session is kept; the read view has no core, so a change to or from it is a new mount.
        this.#viewOverride = null;
        this.#pendingBlock = null;
        this.#scheduleLoad();
        this.#prepareKernel(value);
        break;
      default:
        break;
    }
  }

  /**
   * The page view needs the layout kernel (WebAssembly; WASM-002), so asking for it loads the kernel,
   * and nothing else does: a session that only uses the web or read view fetches no WebAssembly. The
   * page view is not mounted yet (`pageViewAvailable` is false in `#viewChoice`), so the editor shows
   * the web view meanwhile and the kernel waits for it. Touch devices never get the page view (FE-113).
   */
  #prepareKernel(view: string | null): void {
    this.#kernelNotice?.remove();
    this.#kernelNotice = null;
    if (view !== 'print') return;
    if (typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches) return;
    // One kernel for each element: it owns the layout worker (WASM-004) and keeps its lifecycle.
    this.#kernel ??= new ElementKernel((detail) => {
      this.#emit('de-diagnostic', detail);
      if (detail.kind === 'load-failed') this.#degradeKernel(detail);
    });
    void this.#kernel.start();
  }

  /**
   * The kernel did not start (WASM-003). The host hears which feature degraded and which directive it
   * lacks. Where canvas measurement is an acceptable fallback (S5), the page view will use it and
   * nothing is shown; in Firefox the page view is not available, and a plain message says why and
   * offers the web view and the read view. Editing, saving and the read view are not affected.
   */
  #degradeKernel(failure: DocEditorEventMap['de-diagnostic']): void {
    const provider = chooseMeasurementProvider('unavailable', navigator.userAgent);
    const fallback = provider === 'canvas' ? 'canvas-measurement' : 'web-view';
    this.#emit('de-diagnostic', { ...failure, kind: 'degraded', ms: null, fallback });
    if (fallback !== 'web-view' || this.getAttribute('view') !== 'print') return;
    this.#kernelNotice?.remove();
    this.#kernelNotice = showPageViewNotice(this.#root, noticeReason(failure), (view) =>
      this.setAttribute('view', view),
    );
  }

  #attributes(): {
    toolbar: string | null;
    locale: string | null;
    theme: string | null;
    header: string | null;
  } {
    return {
      header: this.getAttribute('header'),
      toolbar: this.getAttribute('toolbar'),
      locale: this.getAttribute('locale'),
      theme: this.getAttribute('theme'),
    };
  }

  #suspend(): void {
    // The layout worker stops with the element; the first use after a resume creates it again (WASM-004).
    this.#kernel?.stop();
    if (!this.#session || this.#suspended) return;
    this.#suspended = true;
    // Listeners on the page, observers and the channel go; the core and the journal stay (FE-005).
    this.#session.suspend();
    if (!this.hasAttribute('keep-alive')) this.#startGrace();
  }

  #startGrace(): void {
    this.#cancelGrace();
    this.#grace = setTimeout(() => {
      this.#grace = null;
      this.destroy();
    }, this.#config.graceMs);
  }

  #cancelGrace(): void {
    if (this.#grace !== null) clearTimeout(this.#grace);
    this.#grace = null;
  }

  // --- Loading (FE-003; PRO-074, PRO-075) ---------------------------------------------------

  #source(): Source | null {
    if (this.#backend) return { kind: 'backend', backend: this.#backend, key: this.#backend };
    const endpoint = this.getAttribute('endpoint');
    const getToken = this.#getToken;
    if (endpoint && getToken) return { kind: 'endpoint', endpoint, getToken, key: endpoint };
    return null;
  }

  #scheduleLoad(): void {
    if (this.#loadQueued) return;
    this.#loadQueued = true;
    const generation = this.#generation;
    queueMicrotask(() => {
      this.#loadQueued = false;
      // destroy() in between cancels it: nothing starts until the next connect or load().
      if (generation === this.#generation) this.#reconcile();
    });
  }

  /** Starts, replaces or keeps the session so that it matches the attributes and properties. */
  #reconcile(): void {
    if (!this.isConnected || this.#suspended) return;
    const docId = this.getAttribute('doc-id');
    const source = this.#source();
    if (!docId || !source) return;
    // `view="read"` (FE-072): no session and no editing core for this view (read-view-element.ts).
    if (this.#viewChoice() === 'read') {
      this.#reconcileRead(docId, source);
      return;
    }
    this.#closeReadView();
    const current = this.#session;
    if (
      current &&
      !this.#reload &&
      current.docId === docId &&
      this.#sessionKey === source.key &&
      current.phase !== 'closed'
    ) {
      // Back from the read view: the same core is shown again (FE-065 criterion 3).
      this.#setEditorHidden(false);
      if (this.#mounted !== null) this.#showWebLabel();
      this.#revealPendingBlock();
      return;
    }
    this.#reload = false;
    this.#clearFailure();
    void current?.close();
    // The faces the kernel holds belong to the document that is closed (a tenant's own fonts go
    // with its documents; WASM-005). The next document names the faces it needs.
    if (current && this.#kernel?.running) void this.#kernel.releaseFaces(null).catch(() => {});
    const session: Session = new Session({
      docId,
      backend:
        source.kind === 'backend' ? source.backend : () => this.#endpointBackend(source, docId),
      ownsBackend: source.kind === 'endpoint',
      host: {
        emit: (name, detail) => {
          if (this.#session === session) this.#emit(name, detail);
        },
        mount: (content, fontAlias) => this.#mount(content, docId, fontAlias),
        failed: (info) => {
          if (this.#session === session) this.#showFailure(info);
        },
      },
      // Arrivals and departures of other sessions are announced (FE-107 criterion 3); the
      // announcer is the one of the current session, as the session is torn down with its own.
      onPresence: (change, user) => {
        if (this.#session === session)
          this.#announcer?.notify({ kind: 'presence', change, userId: user });
      },
    });
    this.#layout = null;
    this.#session = session;
    this.#sessionKey = source.key;
    this.#startAnnouncer();
    void session.start();
  }

  /**
   * A new announcer for a new session (FE-107): it starts from the state the status starts from,
   * `saved`, which is not announced. Sentences the previous session had queued are dropped with it.
   */
  #startAnnouncer(): void {
    this.#announcer?.close();
    // destroy() takes the region out of the root; a later load puts it back, before the shell.
    this.#live.attach();
    this.#announcer = new Announcer({
      sink: (text) => this.#live.announce(text),
      schedule: frameScheduler,
      // The property as it is when a name is needed: a host may set it after loading (PRO-080).
      resolveUsers: (ids) => this.#resolveUsers?.(ids) ?? Promise.resolve(ids.map(() => null)),
      initialSync: 'saved',
      // Typing flips the save state at every commit; only a state that holds is said (criterion 7).
      settleMs: DEFAULT_SETTLE_MS,
      // The shell's catalogue, once the shell exists: the locale and the host's strings apply.
      translate: (key, params) => this.#mounted?.text(key, params) ?? null,
    });
  }

  /**
   * The load failed and the host has its fatal `de-error`: the editor area says why, with one
   * action (PRO-039 criteria 2 to 4; decision 45). The action asks for the document again, or, when
   * the component is too old for the document, loads the page again.
   */
  #showFailure(info: FailureInfo): void {
    this.#clearFailure();
    this.#failure = mountFailure(
      this.#root as unknown as Parameters<typeof mountFailure>[0],
      failureView(info.code, info.retryAfterMs),
      (action) => {
        if (action === 'reload-page') location.reload();
        else this.load();
      },
    );
  }

  #clearFailure(): void {
    this.#failure?.remove();
    this.#failure = null;
  }

  /** The view the `view` attribute asks for now (FE-065; view-select.ts). Touch devices get the web view. */
  #viewChoice(): ViewName {
    if (this.#viewOverride !== null) return this.#viewOverride;
    const touch = typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches;
    return selectView(this.getAttribute('view'), { touch, pageViewAvailable: false }).view;
  }

  /**
   * The user selected a diagnostic of the read view's export and may edit (FE-072 criterion 4): the
   * web view is shown in place of the read view and moves its caret to the block. The core is the
   * session's own, kept behind the read view or started now.
   */
  #openBlockInEditor(blockId: string): void {
    this.#viewOverride = 'web';
    this.#pendingBlock = blockId;
    this.#scheduleLoad();
  }

  /** Moves the editor to the block a selected diagnostic named, once the web view is shown. */
  #revealPendingBlock(): void {
    const blockId = this.#pendingBlock;
    const mounted = this.#mounted;
    if (blockId === null || mounted === null || this.#readViewOf !== null) return;
    this.#pendingBlock = null;
    // False when the block is not in the body or a region the reader can see; the web view then
    // stays where it was.
    mounted.core.selectBlock(blockId);
  }

  /**
   * `view="read"` (FE-072): the read view runs its own export with a backend, without a session or
   * an editing core. Asked again for the same document and source, it keeps the view it has.
   */
  #reconcileRead(docId: string, source: Source): void {
    if (
      this.#readViewOf &&
      this.#readViewOf.docId === docId &&
      this.#readViewOf.key === source.key &&
      !this.#reload
    )
      return;
    const reload = this.#reload;
    this.#reload = false;
    this.#closeReadView();
    this.#hideWebLabel();
    const current = this.#session;
    if (
      current &&
      !reload &&
      current.docId === docId &&
      this.#sessionKey === source.key &&
      current.phase !== 'closed'
    ) {
      // The session stays open behind the read view, so that a return to the web view finds the
      // same editing core and no unconfirmed work is lost (FE-065 criterion 3; ADR 0304 item 1,
      // option a, proposed default).
      this.#setEditorHidden(true);
    } else {
      this.#session = null;
      this.#sessionKey = null;
      void current?.close();
    }
    const token = {};
    this.#readToken = token;
    this.#readViewOf = { docId, key: source.key };
    const ownsBackend = source.kind === 'endpoint';
    void (async () => {
      const backend =
        source.kind === 'backend' ? source.backend : await this.#endpointBackend(source, docId);
      // The read view and the PDF viewer frame are their own chunk, as the editor is: the element
      // entry never reaches them statically (02 §2; critical-path.test.ts).
      // If the chunk fails to load, the backend this view opened is closed rather than left open.
      const chunk = await import('./read-view-element.ts').catch(() => null);
      if (!chunk || this.#readToken !== token || !this.isConnected) {
        if (ownsBackend) void backend.close().catch(() => {});
        return;
      }
      this.#readView = chunk.mountReadView({
        root: this.#root,
        docId,
        backend,
        viewerUrl: this.#config.pdfViewerUrl ?? new URL(VIEWER_PAGE, import.meta.url).href,
        ownsBackend,
        onOpenInEditor: (blockId) => {
          if (this.#readToken === token) this.#openBlockInEditor(blockId);
        },
      });
    })().catch(() => {});
  }

  /** Reads the `layout.json` of a completed export for the session that asked for it (FE-068). */
  async #readLayout(session: Session | null, url: string): Promise<void> {
    const report = await loadLayoutReport(url);
    if (report === null || this.#session !== session) return;
    this.#layout = report;
    this.#applyPageGuides();
  }

  /** Sends the guides that the config and the last layout ask for to the web view (FE-068). */
  #applyPageGuides(): void {
    this.#mounted?.core.setPageGuides(pageGuideBlockIds(this.#layout, this.#config.pageGuides));
  }

  /** The web view's label, drawn above its editing surface (FE-065 criterion 1). */
  #showWebLabel(): void {
    if (this.#webLabel !== null) return;
    const label = document.createElement('p');
    label.className = 'de-view-label';
    label.dataset['view'] = 'web';
    label.textContent = VIEW_STRINGS.web;
    this.#root.prepend(label);
    this.#webLabel = label;
  }

  /**
   * Hides or shows the editing shell without unmounting it (FE-065 criterion 3). The rule is set
   * through the style object, which a strict `style-src` policy allows (FE-017).
   */
  #setEditorHidden(hidden: boolean): void {
    const shell = this.#root.querySelector<HTMLElement>('.de-shell');
    if (shell === null) return;
    if (hidden) shell.style.setProperty('display', 'none', 'important');
    else shell.style.removeProperty('display');
    shell.toggleAttribute('inert', hidden);
  }

  #hideWebLabel(): void {
    this.#webLabel?.remove();
    this.#webLabel = null;
  }

  /** Removes the read view, if one is shown, and forgets which document it showed. */
  #closeReadView(): void {
    this.#readToken = null;
    this.#readViewOf = null;
    this.#readView?.close();
    this.#readView = null;
  }

  #endpointBackend(source: Extract<Source, { kind: 'endpoint' }>, docId: string): Promise<Backend> {
    return endpointBackend({
      endpoint: source.endpoint,
      docId,
      // The token source the backend calls: always the element's current getToken, with the
      // document identifier (PRO-075). The element never reads or keeps the token.
      getToken: (ctx) => {
        const getToken = this.#getToken ?? source.getToken;
        return Promise.resolve(getToken({ docId: ctx.docId ?? docId }));
      },
    });
  }

  #assetImage(docId: string): { assetImage?: AssetImageLookup } {
    const session = this.#session;
    const backend = session?.docId === docId ? session.backend : undefined;
    if (!backend?.assets || !backend.features.has('assets')) return {};
    return { assetImage: assetImageLookup(backend.assets, docId) };
  }

  async #mount(
    content: Content,
    docId: string,
    fontAlias?: (family: string) => string | undefined,
  ): Promise<MountedEditor> {
    const module = await import('./editor.ts');
    const { mountEditor, settingsFrom } = module;
    this.#editorModule = module;
    const settings = new module.SettingsStore(settingsFrom(this.#attributes()));
    this.#settings = settings;
    const mounted = mountEditor({
      root: this.#root,
      content,
      config: this.#config,
      // The manifest's family lookup (FE-062 criterion 1), when the session read one.
      ...(fontAlias ? { fontAlias } : {}),
      // Pictures are drawn from the signed URLs of the assets port, when the backend has one (FE-067).
      ...this.#assetImage(docId),
      // The export dialog's jobs go through the backend's exports port, when it has one (UX-101).
      ...this.#exportService(docId),
      // The send dialog goes through the backend's workflow port, when it has one (FRW-028).
      ...this.#workflowSource(docId),
      ...this.#signingSource(docId),
      // Equations are drawn by KaTeX, loaded with the first equation (FE-069; equation-drawer.ts).
      drawEquation: equationDrawer({ fontsUrl: this.#config.katexFontsUrl }),
      mathFontsUrl: this.#config.katexFontsUrl,
      viewerUrl: this.#config.pdfViewerUrl ?? new URL(VIEWER_PAGE, import.meta.url).href,
      resolveUsers: () => this.#resolveUsers,
      // The host's directory search and the document it is asked about (PRO-080 criterion 2).
      searchPrincipals: () => this.#searchPrincipals,
      docId,
      // The session's backend is connected before the editor is mounted (session.ts).
      permissions:
        this.#session?.docId === docId ? (this.#session.backend?.permissions ?? null) : null,
      settings,
      mode: modeFrom(this.getAttribute('mode')),
      // The share command asks the host (PRO-089). Only the session that is current raises it.
      // The print command prints the typeset PDF (UX-040 criterion 3); a refusal is shown on the command.
      onPrintRequest: () => {
        if (this.#session?.docId !== docId) return;
        this.print().catch((error: unknown) =>
          this.#emit('de-error', {
            code: 'internal',
            message: `printing failed: ${error instanceof Error ? error.message : String(error)}`,
            fatal: false,
          }),
        );
      },
      onShareRequest: () => {
        if (this.#session?.docId === docId) this.#emit('de-share-request', { docId });
      },
      // The user chose to copy a version into a new document; fork is the host's call (HIS-022).
      onForkRequest: ({ atSeq }) => {
        if (this.#session?.docId === docId) this.#emit('de-fork-request', { docId, atSeq });
      },
      // A reader's request for hidden content goes to the host (UX-104, ADR 0019); identifiers only.
      onAccessRequest: ({ scope }) => {
        if (this.#session?.docId === docId) this.#emit('de-access-request', { docId, scope });
      },
      strings: () => this.#strings,
      icons: () => this.#icons,
      // The host's extensions are read at mount and then applied on each change (UX-050).
      extensions: () => this.#extensions,
      // A problem with one extension is raised as a non-fatal `de-error`; the others still load.
      onExtensionError: ({ extension, message }) =>
        this.#emit('de-error', {
          code: 'internal',
          message: `extension ${extension} was not loaded: ${message}`,
          fatal: false,
        }),
    });
    this.#mounted = mounted;
    // A shell that mounts while the read view is shown stays hidden until the view returns.
    if (this.#readViewOf !== null) this.#setEditorHidden(true);
    else this.#showWebLabel();
    this.#applyPageGuides();
    this.#revealPendingBlock();
    return mounted;
  }

  #emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]): void {
    // The save state of `de-status` is announced once per change (FE-107 criterion 1). Refusals and
    // recovered edits are announced by the shell's own live region (ui App.svelte, NoticeTracker),
    // so they are not fed here: the reader would hear them twice.
    if (name === 'de-status')
      this.#announcer?.notify({
        kind: 'sync',
        sync: (detail as DocEditorEventMap['de-status']).sync,
      });
    emit(this, name, detail);
  }

  // --- Methods (05 §8.1) --------------------------------------------------------------------

  /**
   * Loads `docId` as if `doc-id` had changed; without an argument, or with the current one,
   * reloads the current document (PRO-076).
   */
  load(docId?: string): void {
    if (typeof docId === 'string' && docId !== '' && docId !== this.getAttribute('doc-id')) {
      this.setAttribute('doc-id', docId);
      return;
    }
    this.#reload = true;
    this.#scheduleLoad();
  }

  /** Moves keyboard focus into the editing surface, with its last selection (FE-013; PRO-076). */
  override focus(options?: FocusOptions): void {
    // A host closes its share dialog and gives focus back by calling focus(): the share button
    // takes it when a share request is waiting (UX-039 criterion 2).
    if (this.#mounted?.restoreShareFocus()) return;
    if (!this.#session?.focus()) super.focus(options);
  }

  /**
   * Resolves when nothing is in flight or queued; rejects at `timeoutMs` with the number of
   * unconfirmed commits (PRO-083). With no document loaded nothing can be unconfirmed.
   */
  flush(opts?: { timeoutMs?: number }): Promise<void> {
    return this.#methods.flush(opts);
  }

  /** The confirmed document with its `seq` (PRO-084). Rejects when no document is loaded. */
  getContent(): Promise<ConfirmedContent> {
    return this.#methods.getContent();
  }

  /**
   * Runs a command through the path the toolbar uses (PRO-085). The answer is `{ ok, reason }`
   * (owner decision 188): `ok` is false when the command is unknown, is not allowed for this user or
   * mode, changed nothing, or no document is loaded, and `reason` is a code that says which (see
   * `ExecReason`). `command` is an identifier of the command registry such as `format.bold` (UX-005),
   * or a name of the editing core such as `bold`.
   */
  exec(command: CommandName | (string & {}), args?: CommandArgs): ExecOutcome {
    return this.#methods.exec(command, args);
  }

  /** Whether a command is enabled and active for the user's access now (PRO-085). */
  queryCommand(command: CommandName | (string & {}), args?: CommandArgs): CommandState {
    return this.#methods.queryCommand(command, args);
  }

  /**
   * Moves focus to the next field the user may fill, after the one that last had focus (the first
   * when none had). False when no field took focus, and with no document loaded (FRW-069).
   */
  nextField(): boolean {
    return this.#methods.nextField();
  }

  /**
   * Moves focus to the field with `key`. For a key no field has it throws nothing and answers false,
   * as it does with no document loaded (FRW-069).
   */
  focusField(key: string): boolean {
    return this.#methods.focusField(key);
  }

  /** The values of the form fields by key, as the document holds them now (FRW-069). */
  getFieldValues(): Record<string, unknown> {
    return this.#methods.getFieldValues();
  }

  /**
   * Fills the field with `key` as the current user, as typing into its control does; the server's
   * permissions apply. Resolves with `{ ok: true, confirmed }`, or `{ ok: false, code, message }` with
   * `permission_denied`, `field_invalid`, `conflict` or `not_found`; it does not reject (FRW-069).
   */
  setFieldValue(key: string, value: unknown): Promise<FieldFillOutcome> {
    return this.#methods.setFieldValue(key, value);
  }

  /**
   * The fields that are required and empty, or whose entry has a problem, in document order, with
   * keys and reasons. It changes nothing (FRW-069).
   */
  validateFields(): FieldReport[] {
    return this.#methods.validateFields();
  }

  /**
   * Validates the fields and completes this participant's part (FRW-071). When a field fails, focus
   * moves to the first problem and the promise resolves `{ ok: false, failures }` without calling the
   * server; otherwise it calls the participant's `/complete` endpoint and resolves `{ ok: true, result }`.
   * It rejects with a `FillActionError` (its `reason` says why) when the participant is not active, and
   * with the port's error when the server refuses.
   */
  completeFilling(): Promise<CompleteFillingOutcome> {
    return this.#methods.completeFilling();
  }

  /**
   * Declines the workflow as this participant (FRW-071). Rejects with a `FillActionError` of reason
   * `reason_required`, and calls nothing, when no reason is given; rejects the same way when the
   * participant is not active.
   */
  decline(reason: string): Promise<unknown> {
    return this.#methods.decline(reason);
  }

  /** The selection as a CDM fragment (PRO-084); null when no document is loaded. */
  getSelectionContent(): CdmFragment | null {
    return this.#methods.getSelectionContent();
  }

  /**
   * Inserts a CDM fragment at the selection through the same guards as typing (PRO-084). Nothing
   * changes unless the result is `ok`; the result says why when it is not.
   */
  insertContent(fragment: CdmFragment): InsertResult {
    return this.#methods.insertContent(fragment);
  }

  /**
   * Prints the typeset PDF of the loaded document (02 §9.8; FE-073). When the access lists
   * `no-print`, nothing is requested and nothing is printed, and the outcome says why (FE-055; UX-040
   * criterion 3). Otherwise the export job runs and its PDF is printed through a hidden frame.
   * Both print modules load on first use, so neither is on the connect-time path (FE-119).
   */
  async print(): Promise<PrintOutcome> {
    const session = this.#session;
    const source = session
      ? { docId: session.docId, backend: session.backend, access: session.access }
      : null;
    const [{ printTypesetPdf }, { printPdfAtUrl }] = await Promise.all([
      import('./print.ts'),
      import('./print-frame.ts'),
    ]);
    return printTypesetPdf({
      source,
      access: session?.access ?? null,
      printPdf: (url) => printPdfAtUrl(url, this.#root),
      onError: (detail) => this.#emit('de-error', detail),
      // The job's reports reach the host as `de-export-*` events, as for `requestExport` (FE-073
      // criterion 4): a failed job raises `de-export-failed` and then `de-error`. A replaced session raises nothing.
      onExportEvent: (event) => {
        if (this.#session === session) this.#emit(event.name, event.detail);
      },
    });
  }

  /**
   * Starts an export job of the loaded document and resolves `{ jobId }` (PRO-086). Refused when no
   * document is loaded or the backend has no exports port (src/export.ts). The job's reports raise
   * `de-export-progress`, `de-export-completed` or `de-export-failed` while the session that started
   * it is still the current one (PRO-086).
   */
  requestExport(options: ExportRequest): Promise<{ jobId: string }> {
    const session = this.#session;
    const source = session && {
      docId: session.docId,
      backend: session.backend,
      access: session.access,
    };
    return startExport(source, options, (job) => this.#onExportJob(session, job));
  }

  /** A report of a job started by the session `session`: raised as an event while it is current. */
  #onExportJob(session: Session | null, job: ExportJob): void {
    if (this.#session !== session) return;
    const ev = exportEvent(job);
    this.#emit(ev.name, ev.detail);
    // A completed export's `layout.json` says where pages start; guides are optional (FE-068).
    if (job.state === 'completed' && job.result?.layout)
      void this.#readLayout(session, job.result.layout);
  }

  /**
   * The adoption and signing step's source (FRW-045, FRW-046), when the session's backend has the
   * assets port and the fields port and announced both features; otherwise nothing, and a signature
   * field is not offered for signing.
   */
  #signingSource(docId: string): { signing?: () => SigningSource | null } {
    const session = this.#session;
    const backend = session?.docId === docId ? session.backend : undefined;
    if (!backend?.assets || !backend.fields) return {};
    if (!hasPort(backend, 'assets') || !hasPort(backend, 'fields')) return {};
    return {
      signing: () => {
        const live = this.#session === session ? session?.backend : undefined;
        return live?.assets && live.fields && session
          ? { assets: live.assets, fields: live.fields, docId: session.docId }
          : null;
      },
    };
  }

  /**
   * The send dialog's source (FRW-028), when the session's backend has the workflow port and
   * announced the feature; otherwise nothing, and the shell offers no "send for completion" command.
   */
  #workflowSource(docId: string): { workflow?: () => WorkflowSendSource | null } {
    const session = this.#session;
    const backend = session?.docId === docId ? session.backend : undefined;
    if (!backend?.workflow || !hasPort(backend, 'workflow')) return {};
    return {
      workflow: () =>
        this.#session === session && session?.backend?.workflow
          ? { port: session.backend.workflow, docId: session.docId }
          : null,
    };
  }

  /**
   * The shell's export service (UX-101), when the session's backend has the exports port and
   * announced the feature; otherwise nothing, and the shell offers no export command.
   */
  #exportService(docId: string): { exports?: ExportService } {
    const session = this.#session;
    const backend = session?.docId === docId ? session.backend : undefined;
    if (!backend?.exports || !hasPort(backend, 'exports')) return {};
    return {
      exports: exportService({
        source: () =>
          this.#session === session && session
            ? { docId: session.docId, backend: session.backend, access: session.access }
            : null,
        onJob: (job) => this.#onExportJob(session, job),
      }),
    };
  }

  /**
   * Unmounts the shell, destroys the editing core, closes the channel and the backend and stops
   * every timer of the element; nothing more is raised (02 §2.1; PRO-076). Connecting the element
   * again, or calling `load()`, starts afresh (ADR 0039).
   */
  destroy(): void {
    this.#generation++;
    this.#cancelGrace();
    // Connected elements hold this listener on the host document (see connectedCallback); the
    // disconnect path removes it, but destroy() on a connected element must remove it too (PRO-076).
    document.removeEventListener('pointerdown', this.#onOutsidePress, true);
    this.#suspended = false;
    this.#reload = false;
    this.#viewOverride = null;
    this.#pendingBlock = null;
    this.#closeReadView();
    this.#hideWebLabel();
    this.#clearFailure();
    // The worker and its memory are released (WASM-004).
    this.#kernel?.destroy();
    this.#kernel = null;
    const session = this.#session;
    this.#session = null;
    this.#sessionKey = null;
    this.#settings = null;
    this.#mounted = null;
    this.#announcer?.close();
    this.#announcer = null;
    this.#live.remove();
    void session?.close({ closeBackend: true });
  }
}
