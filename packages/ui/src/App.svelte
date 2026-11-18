<!--
  The shell of the editor (02 §4; 13 §3): the header (UX-014) with the mode switcher (UX-015), the
  compact or full toolbar generated from the command registry (UX-006, UX-007), the fill bar
  (FRW-076), the page surface that hosts the body view with collaborators' carets (UX-027), the
  panel for the footnote and header sub-editors, the pane host (UX-019), the status bar (UX-018),
  the context menu (UX-008), the shell's dialogs and a polite live region. The registry's keys are
  bound here, on the shadow root (UX-013), with the shell's own keys: landmarks (UX-023), the
  context menu and the format painter (UX-009).

  Every string comes from the string tables (UX-064); the styles are in `styles/shell.css`, which
  the element adopts into its shadow root (02 §3), so no file here has a style block. Everything
  the element passes beyond `core` is optional, so the element of spike S1 still mounts it
  unchanged: the shell then makes its own registry, catalogue and directory.
-->
<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import type { Component } from 'svelte';
  import { on } from 'svelte/events';
  import { accessChangeAnnouncement } from './commands/access.ts';
  import { commandDecision } from './commands/output-restrictions.ts';
  import {
    SHELL_QUERY_NAMES,
    shellCommands,
    layoutViews,
    shellCommands1b,
  } from './commands/builtin.ts';
  import { createCommandRegistry } from './commands/index.ts';
  import { ShellQueries } from './commands/queries.ts';
  import type { CommandRegistry } from './commands/registry.ts';
  import { bindShortcuts } from './commands/shortcuts.ts';
  import type { CommandEntry, ContextTarget } from './commands/types.ts';
  import Carets from './components/Carets.svelte';
  import CommandSearch from './components/CommandSearch.svelte';
  import AccessKeyTips from './components/AccessKeyTips.svelte';
  import { pressAccessKey } from './commands/access-keys.ts';
  import {
    AccessKeyGesture,
    resolveShownKey,
    type AccessKeyTip,
    type ShownAccessKey,
  } from './shell/access-key-mode.ts';
  import MiniToolbar from './components/MiniToolbar.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import FillBar from './components/FillBar.svelte';
  import FullToolbar from './components/FullToolbar.svelte';
  import Header from './components/Header.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import { provideShell } from './context.ts';
  import type { FilterRegistry } from './extensions/filters.ts';
  import type { StatusItemRegistry } from './extensions/contributions.ts';
  import {
    afterPaint,
    connectHooks,
    type ExtensionHooks,
    type HookQueueStats,
  } from './extensions/hooks.ts';
  import { ExtensionHost, type ExtensionReport } from './extensions/host.ts';
  import type { ExtensionDocumentApi } from './extensions/document-api.ts';
  import type {
    AccessSummary,
    CommentAnchor,
    EquationRef,
    CoreApi,
    EditorMode,
    OutlineItem,
    PaneName,
    ProofingFindingView,
    ReadView,
    ResolveUsers,
    SearchPrincipals,
    ViewName,
  } from './core-api.ts';
  import type { StringKey } from './i18n/en-GB.ts';
  import { findingSentence } from './proofing/present.ts';
  import { Strings } from './i18n/strings.ts';
  import type { MessageParams } from './i18n/types.ts';
  import { live } from './live.ts';
  import { PeopleDirectory } from './people/directory.ts';
  import { commentCommandState } from './shell/comment-create.ts';
  import { fillProgress } from './shell/fill.ts';
  import { focusTarget, landmarkKeys, landmarksIn, nextLandmark } from './shell/landmarks.ts';
  import { modeOptions } from './shell/modes.ts';
  import { START_TRACK, stepMode, type ModeTrack } from './shell/suggest-mode.ts';
  import { NoticeTracker, type Notice } from './shell/notices.ts';
  import { PaneRegistry, type PaneComponent } from './shell/panes.ts';
  import { regionLabels, scopeAnnouncement } from './shell/regions.ts';
  import { DEFAULT_SETTINGS, type ShellSettings } from './shell/settings.ts';
  import { provideSuspension } from './shell/suspension.ts';
  import { resolveTheme, watchColourScheme } from './shell/theme.ts';
  import { contextMenuGroups, contextTargets } from './shell/toolbar-groups.ts';
  import { canZoom, DEFAULT_ZOOM, stepZoom } from './shell/zoom.ts';
  import { resolveCommentLink } from './shell/comment-threads.ts';
  import type { LinkedTarget } from './shell/linked-comment.ts';
  import { writable } from 'svelte/store';

  type OutlinePane = Component<{ items: readonly OutlineItem[] }>;
  type HostPane = Component<{ core: CoreApi }>;

  interface Props {
    core: CoreApi;
    /** The navigation pane's loader, as the element of phase 1a passes it. */
    loadPane?: (name: PaneName) => Promise<OutlinePane>;
    /** Fallback title when the host fills no `title` slot. */
    title?: string;
    /** The registry the element answers `exec` and `queryCommand` from (UX-003). */
    registry?: CommandRegistry;
    /** The string catalogue; the element sets its locale from the `locale` attribute. */
    strings?: Strings;
    /** The people directory; or `resolveUsers`, from which the shell makes one (UX-025). */
    people?: PeopleDirectory;
    resolveUsers?: ResolveUsers;
    /** The host's directory search, for the permissions pane (05 §8.1; PRM-035). */
    searchPrincipals?: SearchPrincipals;
    /** The document's identifier, for `searchPrincipals`. */
    docId?: string;
    /** Attribute-driven settings: `toolbar`, `header`, `locale`, `theme`, `pageTheme`. */
    settings?: ReadView<Partial<ShellSettings>>;
    /** Loaders the host gives for panes whose content it or another story supplies. */
    panes?: Partial<Record<string, () => Promise<HostPane>>>;
    /** The pane registry, for panes contributed later (extensions, UX-052). */
    paneRegistry?: PaneRegistry;
    /** The share command exists only when the host can handle `de-share-request` (13 §5). */
    onShareRequest?: () => void;
    /** The print command exists only when the host can print (UX-040 criterion 3); the element prints the typeset PDF. */
    onPrintRequest?: () => void;
    /** The host handles requests for access to hidden content (UX-104; ADR 0019). */
    onAccessRequest?: (detail: { scope: string }) => void;
    /** Client import and export filters of the host's extensions (UX-055; 13 §7.1). */
    filters?: FilterRegistry;
    /** Hooks of the host's extensions, called after the paint and never waited for (UX-054). */
    hooks?: ExtensionHooks;
    /** Status-bar items of the host's extensions, shown in the bar's start and end edges (UX-052). */
    statusItems?: StatusItemRegistry;
    /** Receives each problem with a host extension (UX-050); the element raises it as `de-error`. */
    onExtensionError?: (report: ExtensionReport) => void;
    /**
     * Gives each extension the range-based document API (UX-053) when the core offers it. `maxRanges` is
     * the most ranges one extension holds; the spec gives no number, so the host sets it (ADR 0136).
     */
    documentApi?: { maxRanges: number };
  }

  let props: Props = $props();
  const core = untrack(() => props.core);

  // Fixed for the shell's lifetime, like the core: created once, from the first props.
  const ownsRegistry = untrack(() => !props.registry);
  const strings = untrack(() => props.strings ?? new Strings());
  const people = untrack(
    () =>
      props.people ??
      new PeopleDirectory(props.resolveUsers ? { resolveUsers: props.resolveUsers } : {}),
  );
  const registry = untrack(
    () => props.registry ?? createCommandRegistry(core, { hasString: (k) => strings.has(k) }),
  );

  const translator = live(strings.view);
  const tr = $derived(translator.current);
  const settings = $derived(live(props.settings ?? { get: () => ({}), subscribe: () => () => {} }));
  const mode = $derived({ ...DEFAULT_SETTINGS, ...settings.current });

  // The interface language follows the `locale` setting; strings load on demand.
  $effect(() => {
    const locale = props.settings ? mode.locale : null;
    if (locale) void strings.setLocale(locale);
  });

  // Themes (UX-061, UX-062): resolved before the first paint, `auto` following the browser.
  const scheme = watchColourScheme((dark) => (prefersDark = dark));
  let prefersDark = $state(scheme.dark);
  onDestroy(scheme.stop);
  // The watcher in force: the first one, or the one started again after a suspension (FE-005).
  // Stopping the first one a second time at destruction is harmless.
  let stopWatching: () => void = scheme.stop;
  onDestroy(() => stopWatching());

  // Suspension (FE-005; 02 §2.1): while the element is out of the document the shell keeps its
  // state and stops what watches the page (shell/suspension.ts).
  let suspended = $state(false);
  provideSuspension(() => suspended);

  /** Stops, or starts again, the shell's observers and its colour-scheme listener. */
  export function setSuspended(on: boolean): void {
    if (on === suspended) return;
    suspended = on;
    stopWatching();
    stopWatching = () => {};
    if (on) return;
    const again = watchColourScheme((dark) => (prefersDark = dark));
    prefersDark = again.dark;
    stopWatching = again.stop;
  }
  const theme = $derived(resolveTheme(mode.theme, prefersDark));

  const panel = live(core.panel);
  const selection = live(core.selection);
  const direction = core.direction ? live(core.direction) : null;

  let announcement = $state('');
  let announceSerial = 0;

  async function say(text: string): Promise<void> {
    const serial = ++announceSerial;
    // Cleared first, so that the same message twice is announced twice.
    announcement = '';
    await tick();
    if (serial === announceSerial) announcement = text;
  }

  function announce(key: StringKey, params?: MessageParams): void {
    void say(tr.t(key, params));
  }

  // The pane host (UX-019): one registry for built-in and contributed panes, one open at a time.
  const paneRegistry = untrack(() => props.paneRegistry ?? new PaneRegistry());

  /** Opens a pane by identifier, as a command of an extension would; false when not offered. */
  export function openPaneById(id: string): Promise<boolean> {
    return openPane(id);
  }

  // A followed comment link (UX-034): the comments pane shows and focuses the thread, or the message
  // that it cannot be shown. A deleted comment and one the user cannot view look the same here: the
  // document's thread list holds only the threads this user may view.
  const linkedThread = writable<LinkedTarget | null>(null);

  /** Follows a link to a comment by its identifier; resolves to what the pane showed. */
  export async function openLinkedComment(commentId: string): Promise<'open' | 'unavailable'> {
    const found = core.threads?.list().find((t) => t.id === commentId);
    const outcome = resolveCommentLink(
      found
        ? {
            status: 'visible',
            thread: { id: found.id, author: found.author, createdAt: found.createdAt, state: found.state },
          }
        : { status: 'deleted' },
    );
    linkedThread.set(
      outcome.kind === 'open' ? { kind: 'thread', id: outcome.thread.id } : { kind: 'unavailable' },
    );
    const opened = await openPane('comments');
    if (!opened) linkedThread.set(null);
    return outcome.kind === 'open' && opened ? 'open' : 'unavailable';
  }
  untrack(() => {
    const loadOutline = props.loadPane;
    if (loadOutline)
      paneRegistry.register({
        id: 'outline',
        label: 'pane.outline',
        load: async () => (await loadOutline('outline')) as unknown as PaneComponent,
      });
    for (const [id, load] of Object.entries(props.panes ?? {}))
      if (load)
        paneRegistry.register({
          id,
          label: `pane.${id}`,
          load: async () => (await load()) as unknown as PaneComponent,
        });
  });

  let pane = $state.raw<{ id: string; component: PaneComponent } | null>(null);
  let paneFailed = $state(false);
  let paneEl: HTMLElement | undefined = $state();
  let tabOriginEl: HTMLElement | undefined = $state();
  let paneReturn: HTMLElement | null = null;
  let shellEl: HTMLElement | undefined = $state();
  const loadedPanes = new Map<string, PaneComponent>();

  function rootOf(): ShadowRoot | Document | null {
    return (shellEl?.getRootNode() as ShadowRoot | Document | undefined) ?? null;
  }

  function activeElement(): HTMLElement | null {
    return (rootOf()?.activeElement as HTMLElement | null | undefined) ?? null;
  }

  function featureList(): readonly string[] {
    return core.features?.get() ?? [];
  }

  async function focusPane(selector?: string): Promise<void> {
    await tick();
    if (!paneEl) return;
    const content = paneEl.querySelector('.de-pane-content');
    const wanted = selector ? paneEl.querySelector<HTMLElement>(selector) : null;
    const target = wanted ?? (content ? focusTarget(content as HTMLElement) : paneEl);
    target.focus();
  }

  async function openPane(id: string, focus?: string): Promise<boolean> {
    const descriptor = paneRegistry.get(id);
    if (!descriptor?.load || !paneRegistry.offered(id, core, featureList())) return false;
    if (pane?.id === id) {
      await focusPane(focus);
      return true;
    }
    const active = activeElement();
    if (!pane || !paneEl?.contains(active)) paneReturn = active;
    let component = loadedPanes.get(id);
    if (!component) {
      announce('pane.loading', { pane: tr.text(descriptor.label) });
      try {
        component = await descriptor.load();
      } catch {
        paneFailed = true;
        return false;
      }
      loadedPanes.set(id, component);
    }
    paneFailed = false;
    pane = { id, component };
    await focusPane(focus);
    return true;
  }

  function closePane(): void {
    if (!pane) return;
    pane = null;
    const back = paneReturn;
    paneReturn = null;
    if (back?.isConnected) back.focus();
    else core.focus();
  }

  function togglePane(id: string, focus?: string): boolean {
    if (pane?.id === id) {
      closePane();
      return true;
    }
    if (!paneRegistry.offered(id, core, featureList())) return false;
    void openPane(id, focus);
    return true;
  }

  function onPaneKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    closePane();
  }

  provideShell({
    core,
    registry,
    people,
    strings: translator,
    announce,
    announceText: (text) => void say(text),
    idPrefix: `de${Math.random().toString(36).slice(2, 8)}`,
    panes: {
      toggle: (id, options) => togglePane(id, options?.focus),
      close: closePane,
      isOpen: (id) => pane?.id === id,
    },
    linkedThread,
    searchPrincipals: untrack(() => props.searchPrincipals),
    docId: untrack(() => props.docId),
  });

  // The core's own surfaces get their names in the interface's language (UX-064).
  $effect(() => {
    core.setLabels?.({
      body: tr.t('surface.body'),
      footnote: tr.t('surface.footnote'),
      story: tr.t('surface.story'),
    });
  });

  // Who can edit a region, for the core's lock indicators (PRM-026), with the host's names.
  const directory = live(people.view);
  const regions = core.regions ? live(core.regions) : null;
  const permissions = core.permissions ? live(core.permissions) : null;

  function nameOf(principal: string): string {
    if (principal === 'everyone') return tr.t('principal.everyone');
    if (principal.startsWith('group:')) return tr.t('principal.group');
    if (principal.startsWith('role:')) return tr.t('principal.role');
    const user = principal.startsWith('user:') ? principal.slice(5) : principal;
    people.request([user]);
    return people.lookup(user).name ?? tr.t('people.fallback');
  }

  $effect(() => {
    if (!core.setRegionLabels || !regions) return;
    void directory.current;
    core.setRegionLabels(regionLabels(regions.current, permissions?.current, tr, nameOf));
  });

  // Access at the selection (UX-004; PRM-026; UX-104): a permission change in the same scope, a
  // read-only region the caret enters, hidden content.
  let accessRequested = $state(false);
  if (core.access) {
    const access = core.access;
    let previous: AccessSummary | undefined = access.get();
    const stop = access.subscribe(() => {
      const next = access.get();
      const key = accessChangeAnnouncement(previous, next);
      if (key) announce(key);
      else {
        const text = scopeAnnouncement(previous, next, regions?.current ?? [], tr, nameOf);
        if (text) void say(text);
      }
      if (previous?.scope !== next.scope) accessRequested = false;
      previous = next;
    });
    onDestroy(stop);
  }

  function requestAccess(): void {
    const scope = core.access?.get().scope;
    if (!scope || !props.onAccessRequest) return;
    props.onAccessRequest({ scope });
    accessRequested = true;
    announce('hidden.requested');
  }

  // Changes that did not happen: a refusal of the region guard, work the server rejected or the
  // client set aside (11 §3; 07 §9). Shown in the status bar and announced; never naming content.
  let notice: Notice | null = $state.raw(null);
  if (core.refusal || core.recovered || core.trimmed) {
    const refusal = core.refusal;
    const recovered = core.recovered;
    const trimmed = core.trimmed;
    const tracker = new NoticeTracker(refusal?.get(), recovered?.get(), trimmed?.get());
    const show = (next: Notice | null) => {
      if (!next) return;
      notice = next;
      announce(next.key, { count: next.count });
    };
    const stops: Array<() => void> = [];
    if (refusal) stops.push(refusal.subscribe(() => show(tracker.refusal(refusal.get()))));
    if (recovered) stops.push(recovered.subscribe(() => show(tracker.recovered(recovered.get()))));
    if (trimmed) stops.push(trimmed.subscribe(() => show(tracker.trimmed(trimmed.get()))));
    onDestroy(() => {
      for (const stop of stops) stop();
    });
  }

  // The mode in effect is announced when it changes (UX-015 criterion 6).
  if (core.mode) {
    const view = core.mode;
    let before = view.get();
    const stop = view.subscribe(() => {
      const next = view.get();
      if (next === before) return;
      before = next;
      announce('announce.mode', { mode: tr.t(`command.mode.${next}`) });
    });
    onDestroy(stop);
  }

  // Zoom (UX-018 criterion 5): a scale of the page, never a change of the document.
  let zoom = $state(DEFAULT_ZOOM);

  // The format painter (UX-009): armed by its command, applied by the next pointer selection or by
  // Enter, cancelled by Escape; the armed state is the command's pressed state.
  /** How long a pointer gesture waits for the core's view of its selection (UX-009). */
  const PAINTER_SETTLE_MS = 120;
  let painterArmed = $state(false);

  function painter(): boolean {
    if (painterArmed) {
      painterArmed = false;
      announce('announce.painter.off');
      return true;
    }
    if (!(core.runNamed?.('copyFormat') ?? false)) return false;
    painterArmed = true;
    announce('announce.painter.armed');
    return true;
  }

  function paint(): void {
    painterArmed = false;
    const result = registry.exec('format.applyFormat');
    if (result.ran) announce('announce.painter.applied');
    else {
      const state = registry.state('format.applyFormat');
      if (state.reasonKey) void say(tr.text(state.reasonKey));
      else announce('announce.painter.off');
    }
  }

  // Dialogs of the shell.
  let dialog = $state<'language' | 'region' | 'export' | 'comment' | 'math' | null>(null);
  // The equation the math editor is open on (FE-070): taken when the request arrives.
  let equation = $state.raw<EquationRef | null>(null);
  if (core.mathEditor) {
    const editor = core.mathEditor;
    let seen = editor.request.get()?.n ?? 0;
    const stop = editor.request.subscribe(() => {
      const request = editor.request.get();
      if (!request || request.n === seen) return;
      seen = request.n;
      equation = { pos: request.pos, latex: request.latex, display: request.display };
      dialog = 'math';
    });
    onDestroy(stop);
  }
  // Their code is one chunk, requested the first time a dialog opens (13 §9; FE-002).
  // A type query, not an import: a static import here could pull the chunk into the first load.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  type DialogComponents = typeof import('./components/dialogs.ts');
  let dialogs = $state.raw<DialogComponents | null>(null);
  let dialogsLoading = false;
  $effect(() => {
    if (dialog === null || dialogs || dialogsLoading) return;
    dialogsLoading = true;
    import('./components/dialogs.ts').then(
      (m) => {
        dialogs = m;
      },
      () => {
        // Not loaded (offline, say): the dialog does not open, and the next attempt tries again.
        dialogsLoading = false;
        dialog = null;
      },
    );
  });
  // What the comment command was run on (UX-028): taken when it runs, before focus leaves the text.
  let commentAnchor = $state.raw<CommentAnchor | null>(null);

  function commentPosted(): void {
    dialog = null;
    commentAnchor = null;
    announce('announce.comment.created');
  }

  // Closes the math editor (FE-070). Focus goes back to the editing surface, which collapses its
  // selection to the start; the equation is selected again once that has happened.
  function closeMath(): void {
    const pos = equation?.pos;
    dialog = null;
    equation = null;
    const editor = core.mathEditor;
    if (pos === undefined || !editor) return;
    void tick().then(() =>
      requestAnimationFrame(() => {
        editor.select(pos);
        core.focus();
      }),
    );
  }

  function applyLanguage(lang: string | null): void {
    dialog = null;
    const done = core.runNamed?.('setLanguage', { lang }) ?? false;
    announce(done ? 'announce.language.set' : 'announce.language.failed');
  }

  function markRegion(title: string): void {
    dialog = null;
    const done = core.runNamed?.('markRegion', { title }) ?? false;
    announce(done ? 'announce.region.created' : 'announce.region.failed');
  }

  // Sharing (UX-039): the host shows its own dialog; focus comes back to the share button.
  let shareReturn: HTMLElement | null = null;

  /**
   * Puts focus back where the host's dialog took it from (the share button), when the element's
   * `focus()` is called after the host closed it. False when there is nothing to restore.
   */
  export function restoreFocus(): boolean {
    const target = shareReturn;
    shareReturn = null;
    if (!target?.isConnected) return false;
    target.focus();
    return true;
  }

  // Shell queries and commands (UX-003: one registry for every surface).
  const shellQueries = new ShellQueries(SHELL_QUERY_NAMES);
  const removeSource = registry.addSource(shellQueries);

  $effect(() => {
    const open = pane?.id ?? null;
    shellQueries.set('shell.outlineOpen', open === 'outline');
    for (const id of ['styles', 'recovered', 'shortcuts', 'permissions', 'fill', 'checker', 'sources', 'roles', 'fields'])
      shellQueries.set(`shell.pane.${id}`, open === id);
    shellQueries.set('shell.painterArmed', painterArmed);
    shellQueries.set('shell.zoomInPossible', canZoom(zoom, 'in'));
    shellQueries.set('shell.zoomOutPossible', canZoom(zoom, 'out'));
    shellQueries.set('shell.zoomChanged', zoom !== DEFAULT_ZOOM);
    shellQueries.set('shell.storyOpen', panel.current?.kind === 'story');
  });

  // The comment command's state (UX-028 criterion 3): `comment` in every scope the selection covers.
  $effect(() => {
    if (!core.threads) return;
    void selection.current;
    void revision?.current;
    void accessView?.current;
    const state = commentCommandState(core.threads.anchor());
    shellQueries.set('shell.commentAllowed', state.allowed, state.allowed ? null : state.reason);
  });

  // The export command's state (UX-040 criterion 1): `no-export` in the access restrictions
  // disables it with the reason, and the registry publishes the change at once (criterion 4).
  $effect(() => {
    const decision = commandDecision('document.export', permissions?.current?.restrictions ?? []);
    shellQueries.set(
      'shell.exportAllowed',
      decision.allowed,
      decision.allowed ? null : decision.reason,
    );
    const printDecision = commandDecision('document.print', permissions?.current?.restrictions ?? []);
    shellQueries.set(
      'shell.printAllowed',
      printDecision.allowed,
      printDecision.allowed ? null : printDecision.reason,
    );
  });

  const revision = core.revision ? live(core.revision) : null;

  // Extension hooks (UX-054; 13 §7.2): the revision's subscriber only enqueues, one bounded queue
  // per hook, and each hook runs after the paint. Nothing a hook does reaches the transaction.
  const connectedHooks = untrack(() =>
    core.revision && props.hooks ? connectHooks(core.revision, props.hooks) : null,
  );
  onDestroy(() => connectedHooks?.stop());

  /** The hook queues' counters, one entry per hook, for the host's diagnostics. */
  export function hookStats(): HookQueueStats[] {
    return connectedHooks?.stats() ?? [];
  }

  // Host extensions (UX-050; 13 §7.1): each entry is checked and activated on its own, and its
  // commands go with it when it is removed (UX-051). A problem is reported and never stops the shell.
  interface ExtensionApi {
    registerCommand(entry: Parameters<CommandRegistry['register']>[0]): void;
    /** The range-based document API, or null when the core or the host does not offer it (UX-053). */
    readonly document: ExtensionDocumentApi | null;
  }
  const extensionHost = untrack(
    () =>
      new ExtensionHost<ExtensionApi>({
        apiVersions: ['1'],
        createApi: (id, track) => {
          const options = props.documentApi;
          const docApi =
            options && core.extensionApi
              ? core.extensionApi({
                  maxRanges: options.maxRanges,
                  later: afterPaint,
                  onError: (error, event) =>
                    props.onExtensionError?.({
                      extension: id,
                      reason: 'handler-failed',
                      message: `${event}: ${error instanceof Error ? error.message : String(error)}`,
                      fatal: false,
                    }),
                })
              : null;
          if (docApi) track(() => docApi.dispose());
          return {
            document: docApi,
            registerCommand(entry) {
              track(registry.register(entry));
            },
          };
        },
        onError: (report) => props.onExtensionError?.(report),
      }),
  );
  onDestroy(() => extensionHost.dispose());

  /** Brings the host's extensions in line with `list`, at mount and on each change (UX-050). */
  export function setExtensions(list: readonly unknown[]): void {
    extensionHost.sync(list);
  }

  /** The client export filters, when the core can give them the document (UX-055). */
  function exportFilters(): boolean {
    return !!props.filters && !!core.getContent && props.filters.choices('export').length > 0;
  }
  $effect(() => {
    void selection.current;
    void revision?.current;
    const copyable = core.query?.('canCopyFormat');
    shellQueries.set(
      'shell.painterEnabled',
      painterArmed || copyable !== false,
      painterArmed ? null : (core.queryReason?.('canCopyFormat') ?? null),
    );
  });

  const modeView = core.mode ? live(core.mode) : null;
  const modesView = core.modes ? live(core.modes) : null;
  const accessView = core.access ? live(core.access) : null;
  const viewView = core.view ? live(core.view) : null;

  $effect(() => {
    if (!modeView) return;
    const current = modeView.current;
    for (const option of modeOptions(modesView?.current, permissions?.current, accessView?.current)) {
      shellQueries.set(`shell.mode.${option.mode}`, option.mode === current);
      shellQueries.set(`shell.modeAvailable.${option.mode}`, option.available, option.reason);
    }
  });

  // Suggestion mode where the user may only suggest (PRM-031; 07 §7): the core is asked for `review`
  // in such a scope and for the chosen `edit` again in an editable one. The rules are in suggest-mode.ts.
  let modeTrack: ModeTrack = START_TRACK;
  $effect(() => {
    if (!modeView || !core.setMode) return;
    const step = stepMode(modeTrack, modeView.current, accessView?.current);
    modeTrack = step.track;
    if (step.target) core.setMode(step.target);
  });

  $effect(() => {
    if (!viewView) return;
    for (const v of ['web', 'read', 'print'] as const)
      shellQueries.set(`shell.view.${v}`, viewView.current === v);
  });

  const host1a = shellCommands({
    toggleOutline: () => togglePane('outline'),
    openPane: (name) => togglePane(name),
    requestShare: () => {
      if (!props.onShareRequest) return false;
      shareReturn = activeElement();
      props.onShareRequest();
      return true;
    },
  });
  const host1b = shellCommands1b({
    togglePane: (id) => togglePane(id),
    find: () => {
      if (!paneRegistry.offered('outline', core, featureList())) return false;
      void openPane('outline', '[data-search]');
      return true;
    },
    painter,
    print: () => {
      if (!props.onPrintRequest) return false;
      props.onPrintRequest();
      return true;
    },
    applyFormat: () => core.runNamed?.('pasteFormat') ?? false,
    openDialog: (name) => {
      if (name === 'export' && !core.exports && !exportFilters()) return false;
      if (name === 'comment') {
        const anchor = core.threads?.anchor() ?? null;
        if (!anchor) return false;
        commentAnchor = anchor;
      }
      dialog = name;
      return true;
    },
    zoom: (step) => {
      const next = stepZoom(zoom, step);
      if (next === zoom) return false;
      zoom = next;
      return true;
    },
    setMode: (m: EditorMode) => core.setMode?.(m) ?? false,
    setView: (v: ViewName) => core.setView?.(v) ?? false,
    closeStory: () => {
      if (panel.current?.kind !== 'story') return false;
      core.closePanel();
      return true;
    },
    commandSearch: () => {
      commandSearchOpen = true;
      return true;
    },
    // Moves the caret to the next or previous finding and says what it is (UX-041 criterion 6).
    proofingStep: (direction) => {
      if (!core.proofingStep?.(direction)) {
        announce('proofing.none');
        return false;
      }
      const current = core.proofing?.get().current ?? null;
      if (current) void say(findingSentence(current, (key, params) => tr.t(key, params)));
      return true;
    },
  });

  const unregister: Array<() => void> = [];
  untrack(() => {
    /** A pane with content whose data the core offers (its feature, if any, gates the command). */
    const offered = (id: string) => {
      const d = paneRegistry.get(id);
      return !!d?.load && (d.available ? d.available(core) : true);
    };
    const add = (entry: CommandEntry | undefined) => {
      if (entry && registry.backs(entry)) unregister.push(registry.register(entry));
    };
    add(host1a.outline);
    if (paneRegistry.get('comments')?.load) add(host1a.comments);
    if (paneRegistry.get('catch-up')?.load) add(host1a.catchUp);
    if (offered('history')) add(host1a.history);
    if (props.onShareRequest) add(host1a.share);
    if (core.search) add(host1b['view.find']);
    if (offered('styles')) add(host1b['view.styles']);
    if (offered('recovered')) add(host1b['view.recovered']);
    if (offered('checker')) add(host1b['view.checker']);
    if (offered('sources')) add(host1b['view.sources']);
    if (offered('roles')) add(host1b['view.roles']);
    if (offered('fields')) add(host1b['view.fieldProperties']);
    add(host1b['view.shortcuts']);
    add(host1b['view.commandSearch']);
    if (offered('permissions')) add(host1b['view.permissions']);
    if (offered('fill')) add(host1b['view.fillSummary']);
    if (
      registry.backs(host1b['format.applyFormat']!) &&
      registry.queryNames().includes('canCopyFormat')
    )
      add(host1b['format.painter']);
    add(host1b['format.applyFormat']);
    add(host1b['format.language']);
    add(host1b['insert.region']);
    if (core.threads) add(host1b['review.comment']);
    // The proofing commands exist only while a proofing port is attached (UX-041 criterion 5).
    const proofing = core.proofing;
    if (proofing) {
      let held: Array<() => void> = [];
      const sync = () => {
        const attached = proofing.get().available;
        if (attached && held.length === 0) {
          for (const id of ['proofing.next', 'proofing.previous']) {
            const entry = host1b[id];
            if (entry && registry.backs(entry)) held.push(registry.register(entry));
          }
        } else if (!attached && held.length > 0) {
          for (const off of held) off();
          held = [];
        }
      };
      sync();
      const stop = proofing.subscribe(sync);
      unregister.push(() => {
        stop();
        for (const off of held) off();
      });
    }
    if (core.exports || (props.filters && core.getContent)) add(host1b['document.export']);
    if (props.onPrintRequest && core.exports) add(host1b['document.print']);
    add(host1b['view.zoomIn']);
    add(host1b['view.zoomOut']);
    add(host1b['view.zoomReset']);
    add(host1b['page.closeStory']);
    if (core.mode && core.setMode) {
      const supported = core.modes?.get() ?? ['edit', 'view'];
      for (const m of supported) add(host1b[`mode.${m}`]);
    }
    if (core.view && core.setView)
      for (const v of layoutViews(core.views?.get())) add(host1b[`view.layout.${v}`]);
  });

  onDestroy(() => {
    for (const off of unregister) off();
    removeSource();
    if (ownsRegistry) registry.destroy();
  });

  // Command search (UX-011): opened by its command; closing returns focus to the text, unless the
  // command it ran took focus for a pane or a dialog.
  // Access keys (UX-012; 13 §4). Alt pressed and released alone starts the mode: the keys shown on
  // the toolbars run their commands, Escape leaves. The gesture is proposed (ADR 0325-lane-U).
  const accessGesture = new AccessKeyGesture();
  let accessMode = $state(false);
  let accessTips: AccessKeyTip[] = $state.raw([]);
  let accessShown: ShownAccessKey[] = [];
  /** The toolbar controls on screen that show an access key, with their commands. */
  function startAccessKeys(): void {
    if (!shellEl) return;
    const views = new Map(registry.view.get().commands.map((view) => [view.id, view] as const));
    const shown: ShownAccessKey[] = [];
    const tips: AccessKeyTip[] = [];
    for (const element of shellEl.querySelectorAll<HTMLElement>('[data-command-id]')) {
      // Not the mini toolbar, the command search, a menu, the page or a pane: those are not the toolbars.
      if (element.closest('[data-mini-toolbar], [role="listbox"], [role="menu"], .de-page, .de-pane, .de-panel'))
        continue;
      const view = views.get(element.dataset['commandId'] ?? '');
      const key = view?.entry.accessKey;
      if (!view || key === undefined) continue;
      shown.push({ id: view.id, key: key.toLowerCase(), group: view.entry.group });
      tips.push({ element, key });
    }
    accessShown = shown;
    accessTips = tips;
    accessMode = true;
    void say(tr.t('access.mode'));
  }
  function endAccessKeys(restoreFocus: boolean): void {
    accessGesture.exit();
    accessMode = false;
    accessTips = [];
    accessShown = [];
    if (restoreFocus) core.focus();
  }
  function runAccessKey(key: string): void {
    const resolved = resolveShownKey(accessShown, key);
    // A key no shown command has, or one shown twice, runs nothing; the mode stays on.
    if (resolved.kind !== 'one') return;
    endAccessKeys(false);
    const result = pressAccessKey(registry, resolved.group, key);
    if (!result.ran && result.reasonKey) void say(tr.text(result.reasonKey));
    // A command that opened a dialog or a pane took focus; otherwise the text keeps it.
    void tick().then(() => {
      if (!activeElement()) core.focus();
    });
  }
  function onAccessKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    const action = accessGesture.keyDown(event.key);
    if (action.kind === 'leave') {
      event.preventDefault();
      event.stopPropagation();
      endAccessKeys(true);
    } else if (action.kind === 'press') {
      event.preventDefault();
      event.stopPropagation();
      runAccessKey(action.key);
    } else if (action.kind === 'consume') {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function onAccessKeyup(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (accessGesture.keyUp(event.key).kind !== 'enter') return;
    // Keeps the browser's menu bar from taking the Alt key where the browser allows it.
    event.preventDefault();
    startAccessKeys();
  }
  let commandSearchOpen = $state(false);
  function closeCommandSearch(restore: boolean): void {
    commandSearchOpen = false;
    if (restore) core.focus();
    else
      void tick().then(() => {
        if (!activeElement()) core.focus();
      });
  }

  // The context menu (UX-008): at the pointer, or at the caret from the keyboard.
  let menu = $state.raw<{
    point: { x: number; y: number };
    targets: ContextTarget[];
    /** The proofing finding at the caret when the menu opened (UX-042). */
    finding: ProofingFindingView | null;
  } | null>(null);
  let pageEl: HTMLElement | undefined = $state();

  // The mini toolbar (UX-010): near a selection the user may change; hidden by Escape, and again
  // once the selection collapses (the next selection shows it again).
  let miniDismissed = $state(false);
  const miniAnchor = $derived.by(() => {
    void selection.current;
    const r = core.caretRect?.() ?? pageEl?.getBoundingClientRect() ?? null;
    return r ? { x: r.x, y: r.y } : null;
  });
  const miniShown = $derived(
    !selection.current.empty && !miniDismissed && !commandSearchOpen && !menu,
  );
  $effect(() => {
    if (selection.current.empty) miniDismissed = false;
  });

  function menuFor(point: { x: number; y: number }): boolean {
    const targets = contextTargets(core.selection.get().contexts);
    const finding = core.proofing?.get().atCaret ?? null;
    if (finding === null && contextMenuGroups(registry.view.get().commands, targets).length === 0)
      return false;
    menu = { point, targets, finding };
    return true;
  }

  function caretPoint(): { x: number; y: number } {
    const rect = core.caretRect?.() ?? pageEl?.getBoundingClientRect() ?? null;
    return rect ? { x: rect.x, y: rect.y + rect.height } : { x: 0, y: 0 };
  }

  function closeMenu(restore: boolean): void {
    menu = null;
    if (restore) core.focus();
    else
      void tick().then(() => {
        // A command that opened a dialog or a pane took focus; otherwise back to the text.
        if (!activeElement()) core.focus();
      });
  }

  function onContextMenu(event: MouseEvent): void {
    // Shift with the context click leaves the browser's own menu (ADR 0052).
    if (event.shiftKey) return;
    const targets = contextTargets(core.selection.get().contexts);
    // A click on a proofing finding opens the menu even where no command is listed (UX-042).
    const onFinding = event
      .composedPath()
      .some((n) => n instanceof HTMLElement && n.dataset['deFinding'] !== undefined);
    if (!onFinding && contextMenuGroups(registry.view.get().commands, targets).length === 0) return;
    event.preventDefault();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const point = fromKeyboard ? caretPoint() : { x: event.clientX, y: event.clientY };
    // The caret moves with the click; the core publishes the new selection in the next frame.
    requestAnimationFrame(() => menuFor(point));
  }

  /** The page surface: clicks outside the text, the context menu, the painter's pointer gesture. */
  function pageEvents(node: HTMLElement) {
    const stops = [
      on(node, 'mousedown', (event: MouseEvent) => {
        // A click on the page surface outside the text puts the caret in the document (02 §3).
        if (event.target === event.currentTarget || event.target === node) {
          event.preventDefault();
          core.focus();
        }
      }),
      on(node, 'contextmenu', onContextMenu),
      on(node, 'pointerup', () => {
        if (!painterArmed) return;
        // The browser tells the editing surface of the selection the gesture made a little after
        // the pointer is released, so the view may still show the selection before the gesture (a
        // click on the target would then paint the source again). Wait for the view to change; if
        // it does not within a short time, the view is already current.
        const before = core.selection.get();
        let settled = false;
        let stopWatching = (): void => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = () => {
          if (settled) return;
          settled = true;
          stopWatching();
          clearTimeout(timer);
          requestAnimationFrame(() => {
            if (painterArmed && !core.selection.get().empty) paint();
          });
        };
        stopWatching = core.selection.subscribe(() => {
          if (core.selection.get() !== before) settle();
        });
        timer = setTimeout(settle, PAINTER_SETTLE_MS);
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  // Keys (UX-013, UX-023, UX-008, UX-009): the registry's, and the shell's own.
  onMount(() => {
    const root = rootOf();
    if (!root || !(root instanceof ShadowRoot || root instanceof Document)) return;
    const target = root instanceof Document ? (shellEl as HTMLElement) : root;
    const keys = landmarkKeys(registry.apple);
    const inPage = (event: Event) => (pageEl ? event.composedPath().includes(pageEl) : false);
    const cycle = (step: 1 | -1) => {
      if (!shellEl) return;
      const next = nextLandmark(landmarksIn(shellEl), activeElement(), step);
      if (!next) return;
      if (next.dataset['landmark'] === 'page') core.focus();
      else focusTarget(next).focus();
    };
    const stopKeys = bindShortcuts(target, registry, {
      shell: (key, event) => {
        if (keys.next.has(key)) {
          cycle(1);
          return true;
        }
        if (keys.previous.has(key)) {
          cycle(-1);
          return true;
        }
        if ((key === 'Shift-F10' || key === 'ContextMenu') && inPage(event))
          return menuFor(caretPoint());
        // FE-103: Escape leaves the editing surface. Focus is taken off it, so Tab goes on to the
        // next control in page order and Shift+Tab back to the previous one.
        // UX-010: Escape first hides the mini toolbar, and leaves the text on the next press.
        // A dialog is closed by Escape itself (the native cancel); the shell does not take the key (FE-070).
        if (key === 'Escape' && event.composedPath().some((n) => n instanceof HTMLDialogElement))
          return false;
        if (key === 'Escape' && miniShown) {
          miniDismissed = true;
          return true;
        }
        if (key === 'Escape' && inPage(event)) {
          // Focus moves to a place just after the surface, not to nothing: with no focus WebKit starts
          // the next Tab at the first control of the page. Tab then goes to the next control and
          // Shift+Tab to the surface's predecessor in page order.
          if (tabOriginEl) tabOriginEl.focus();
          else activeElement()?.blur();
          return true;
        }
        return false;
      },
      onUnavailable: (reasonKey) => void say(tr.text(reasonKey)),
    });
    // While the painter is on, Enter applies and Escape stops, before the core sees the key.
    const stopPainter = on(
      target,
      'keydown',
      (event: Event) => {
        if (!painterArmed || !(event instanceof KeyboardEvent) || !inPage(event)) return;
        if (event.key === 'Escape') {
          painterArmed = false;
          announce('announce.painter.off');
        } else if (event.key === 'Enter' && !core.selection.get().empty) paint();
        else return;
        event.preventDefault();
        event.stopPropagation();
      },
      { capture: true },
    );
    // Access keys (UX-012): the mode is entered and used on the shell's own keys, and ends when
    // the pointer or the focus leaves the shell.
    const stopAccess = [
      on(target, 'keydown', onAccessKeydown, { capture: true }),
      on(target, 'keyup', onAccessKeyup, { capture: true }),
      on(target, 'pointerdown', () => {
        if (accessGesture.active) endAccessKeys(false);
      }),
      on(target, 'focusout', (event: Event) => {
        const next = (event as FocusEvent).relatedTarget;
        if (accessGesture.active && !next) endAccessKeys(false);
      }),
    ];
    return () => {
      stopKeys();
      stopPainter();
      for (const stop of stopAccess) stop();
    };
  });

  // Fill mode (FRW-076): finishing with something left opens the summary instead (FRW-078).
  function finishFill(): void {
    const summary = core.fill?.get();
    if (summary && fillProgress(summary).left.length > 0) {
      void openPane('fill');
      return;
    }
    const done = core.runNamed?.('finishFill') ?? false;
    announce(done ? 'fill.finished' : 'fill.finishFailed');
  }

  const panelLabel = $derived(
    panel.current ? tr.t(panel.current.kind === 'footnote' ? 'panel.footnote' : 'panel.story') : '',
  );
  const paneLabel = $derived.by(() => {
    const d = pane ? paneRegistry.get(pane.id) : undefined;
    return d ? tr.text(d.label) : '';
  });
  const paneHeadingId = `de-pane-${Math.random().toString(36).slice(2, 8)}`;
</script>

<div
  bind:this={shellEl}
  class="de-shell"
  dir={tr.dir}
  data-theme={theme}
  data-page-theme={mode.pageTheme}
>
  {#if mode.header !== 'none'}
    <Header title={props.title} />
  {/if}
  {#if mode.toolbar === 'full'}
    <FullToolbar onEscape={() => core.focus()} />
  {:else if mode.toolbar !== 'none'}
    <Toolbar onEscape={() => core.focus()} />
  {/if}
  {#if core.fill}
    <FillBar fill={core.fill} onFinish={finishFill} />
  {/if}
  <div class="de-workspace">
    <div
      bind:this={pageEl}
      part="page"
      class="de-page"
      role="region"
      aria-label={tr.t('landmark.page')}
      data-landmark="page"
      dir={direction?.current ?? 'ltr'}
      {@attach pageEvents}
    >
      <div class="de-body-frame">
        <div
          class="de-body-host"
          style:zoom={zoom === DEFAULT_ZOOM ? undefined : String(zoom)}
          {@attach (node) => core.mountBody(node)}
        ></div>
        {#if core.carets}
          <Carets carets={core.carets} />
        {/if}
      </div>
      <!-- Where focus waits after Escape leaves the editing surface (FE-103): the next Tab goes on from here. -->
      <span class="de-tab-origin" tabindex="-1" bind:this={tabOriginEl}></span>
    </div>
    {#if panel.current}
      <aside
        part="sidebar"
        class="de-panel"
        aria-label={panelLabel}
        data-panel={panel.current.kind}
        data-landmark="pane"
        lang={tr.locale}
      >
        <div class="de-panel-head">
          <span>{panelLabel}</span>
          <button type="button" onclick={() => core.closePanel()}>{tr.t('panel.close')}</button>
        </div>
        {#key panel.current.id}
          <div class="de-panel-editor" {@attach (node) => core.mountPanel(node)}></div>
        {/key}
      </aside>
    {/if}
    {#if pane}
      {@const Pane = pane.component}
      <!-- Escape anywhere in the pane closes it; the pane's own widgets stop the keys they use. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <aside
        bind:this={paneEl}
        part="sidebar"
        class="de-pane"
        aria-labelledby={paneHeadingId}
        data-pane={pane.id}
        data-landmark="pane"
        lang={tr.locale}
        onkeydown={onPaneKeydown}
      >
        <div class="de-pane-head">
          <h2 class="de-pane-title" id={paneHeadingId} tabindex="-1">{paneLabel}</h2>
          <button
            type="button"
            class="de-pane-close"
            aria-label={tr.t('pane.close', { pane: paneLabel })}
            onclick={closePane}>{tr.t('dialog.close')}</button
          >
        </div>
        <div class="de-pane-content">
          <Pane {core} close={closePane} />
        </div>
      </aside>
    {/if}
  </div>
  <StatusBar
    {paneFailed}
    {notice}
    onDismiss={() => (notice = null)}
    {zoom}
    onAccessRequest={props.onAccessRequest ? requestAccess : undefined}
    {accessRequested}
    statusItems={props.statusItems}
  />
  {#if menu}
    <ContextMenu
      point={menu.point}
      targets={menu.targets}
      finding={menu.finding}
      onClose={closeMenu}
    />
  {/if}
  {#if commandSearchOpen}
    <CommandSearch onClose={closeCommandSearch} />
  {/if}
  {#if accessMode}
    <AccessKeyTips tips={accessTips} />
  {/if}
  {#if miniShown && miniAnchor}
    <MiniToolbar anchor={miniAnchor} />
  {/if}
  {#if dialogs}
    {@const { LanguageDialog, RegionDialog, CommentBox, ExportDialog, MathEditorDialog } = dialogs}
    {#if dialog === 'math' && core.mathEditor && equation}
      <MathEditorDialog
        editor={core.mathEditor}
        {equation}
        onApplied={() => {
          closeMath();
          announce('announce.equation.set');
        }}
        onRejected={() => announce('announce.equation.rejected')}
        onClose={closeMath}
      />
    {:else if dialog === 'language'}
      <LanguageDialog
        initial={selection.current.lang ?? null}
        onApply={applyLanguage}
        onClose={() => (dialog = null)}
      />
    {:else if dialog === 'region'}
      <RegionDialog onCreate={markRegion} onClose={() => (dialog = null)} />
    {:else if dialog === 'comment' && core.threads && commentAnchor}
      <CommentBox
        threads={core.threads}
        anchor={commentAnchor}
        onPosted={commentPosted}
        onClose={() => {
          dialog = null;
          commentAnchor = null;
        }}
      />
    {:else if dialog === 'export' && (core.exports || exportFilters())}
      <ExportDialog
        exports={core.exports}
        filters={props.filters}
        onClose={() => (dialog = null)}
      />
    {/if}
  {/if}
  <div class="de-visually-hidden" role="status" lang={tr.locale}>{announcement}</div>
</div>
