/**
 * The editor itself, loaded with the first document (02 §2, §4; FE-002, FE-004): the editing core
 * (`@docedit/engine`), the shell (`@docedit/ui`), Svelte and the component's styles. The element's
 * module stays small and imports none of this until a document loads, so importing it on a server
 * evaluates no editor code (FE-001).
 *
 * The shell is mounted with `mount(App, { target: shadowRoot, props })` and removed with `unmount`
 * (02 §4). The shell reaches the core only through `CoreApi`; this file is the one place where the
 * element meets the core's API and the shell's props, so a change in either is adapted here.
 */
import {
  type AssetImageLookup,
  EditorCore,
  type ConnectionState,
  type EditMode,
  type EquationDrawer,
} from '@docedit/engine';
import {
  PortError,
  type Access,
  type Content,
  type PermissionsPort,
  type PrincipalInfo,
  type SearchPrincipals,
  type SyncChannel,
} from '@docedit/protocol';
import {
  App,
  PeopleDirectory,
  SettingsStore,
  Strings,
  createCommandRegistry,
  headerMode,
  themeMode,
  toolbarMode,
  type CoreApi,
  type DocumentStats,
  type EditorMode,
  type ResolveUsers,
  type ShellSettings,
} from '@docedit/ui';
import { flushSync, mount, unmount } from 'svelte';
import type { NormalConfig } from './config.ts';
import type { Connection, StatusDetail } from './events.ts';
import { hostApi, type HostApi } from './host-api.ts';
import type { PdfSource } from './pdf/messages.ts';
import type { PdfViewerFrame } from './pdf/viewer-frame.ts';
import { grantsService, regionsView } from './permissions-shell.ts';
import type { AttachAt, EditorHandle, ReadView } from './session.ts';
import { attachShortcuts } from './shortcuts.ts';
import { sourcesService } from './sources.ts';
import { fillView } from './fill.ts';
import { rolesService } from './roles.ts';
import { fieldPropertiesService } from './field-properties.ts';
import { mathEditorService } from './math-editor.ts';
import { mayChange } from './status.ts';
import { attachStyles, type StylePath } from './styles.ts';

/** The modes the element's switcher offers (UX-015; the shell's `mode.*` commands). */
const SHELL_MODES: readonly EditorMode[] = ['edit', 'review', 'view'];

export interface MountOptions {
  root: ShadowRoot;
  content: Content;
  config: NormalConfig;
  /** The PDF viewer's page: `config.pdfViewerUrl`, else the one next to the module. */
  viewerUrl: string;
  /** The host's directory, read when the shell asks (the property may change later). */
  resolveUsers: () => ResolveUsers | null;
  /**
   * The host's directory search, read when the shell asks (PRO-080 criterion 2). With no callback
   * set, the shell gets an answer of no matches, so the grants pane still works.
   */
  searchPrincipals: () => SearchPrincipals | null;
  /** The document identifier the element was loaded with, for `searchPrincipals`. */
  docId: string;
  /**
   * The backend's permissions port, when the session has one (PRO-080 criterion 2). With its
   * `regions` read the shell offers the permissions pane; with its grants reads, the grant controls.
   */
  permissions?: PermissionsPort | null;
  /** The manifest's family-to-alias lookup (FE-062 criterion 1); absent when none was read. */
  fontAlias?: (family: string) => string | undefined;
  /** The signed URL of an asset, for the web view's pictures (FE-067 criterion 3); absent without assets. */
  assetImage?: AssetImageLookup;
  /** Draws equations in the web view (FE-069); absent, the LaTeX source is shown as text. */
  drawEquation?: EquationDrawer;
  /** The directory the math fonts are served from (`config.katexFontsUrl`), for the math editor (FE-070). */
  mathFontsUrl?: string | null;
  /** The shell's attribute-driven settings (`toolbar`, `locale`). */
  settings: SettingsStore;
  /** The `mode` the host asked for (05 §8.1); the core applies the most restrictive one allowed. */
  mode: EditMode;
  /**
   * Called when the owner activates the share command; the element raises `de-share-request` from
   * it (PRO-089, UX-039). The shell shows the command when this is given.
   */
  onShareRequest: () => void;
  /**
   * Called when the print command runs (UX-040 criterion 3); the element prints the typeset PDF
   * through `DocEditor.print()`. The shell shows the command only when this is given.
   */
  onPrintRequest?: () => void;
  /**
   * Called when a reader asks for access to a placeholder (UX-104, ADR 0019); the element raises
   * `de-access-request` from it. The shell shows the request control only when this is given.
   */
  onAccessRequest?: (detail: { scope: string }) => void;
  /** The host's replacement strings by key (UX-063), read when the shell mounts. */
  strings: () => StringOverrides | null;
  /** The host's extensions (05 §8.1 `extensions`), read when the shell mounts (UX-050). */
  extensions: () => readonly unknown[];
  /** Each problem with an extension, raised by the element as `de-error` (UX-050; never fatal). */
  onExtensionError: (report: { readonly extension: string; readonly message: string }) => void;
}

/** Host replacement strings by key (UX-063); a value that is not a message is ignored. */
export type StringOverrides = Readonly<Record<string, string>>;

/** The PDF viewer for the shell's PDF pane (FE-071; the pane is UX-019). Loaded when first used. */
export interface PdfService {
  /** Puts a viewer frame into `container` and opens the PDF in it; resolves once page 1 is drawn. */
  open(
    container: Element,
    source: PdfSource,
  ): Promise<{ viewer: PdfViewerFrame; pages: number; worker: boolean }>;
}

/** The shell's view of the core (ui's `CoreApi`) and the PDF viewer. */
export type ShellCore = CoreApi & { readonly pdf: PdfService };

export interface MountedEditor extends EditorHandle {
  /** Required here: the element's flush, getContent, exec and queryCommand reach the core by it. */
  readonly api: HostApi;
  readonly core: EditorCore;
  readonly shell: ShellCore;
  readonly stylePath: StylePath;
  /** A new `mode` attribute: the same core and shell, so unconfirmed work stays (FE-029). */
  setMode(mode: EditMode): void;
  /**
   * Gives focus back to the share button when the host's share dialog has closed (UX-039
   * criterion 2). True when focus was given back; false when no share request is waiting.
   */
  restoreShareFocus(): boolean;
  /**
   * Opens a shell pane by identifier, as the pane's command does (test hook for PRO-080 criterion 2;
   * the published element does not expose it). Resolves false when the pane is not offered.
   */
  openPane(id: string): Promise<boolean>;
  /** Replaces the host's string replacements while the shell is mounted (UX-063, UX-064). */
  setStrings(overrides: StringOverrides): void;
  /**
   * A message of the shell's catalogue in the locale in use, with the host's replacements applied
   * (UX-064); null for a key the catalogue does not have. The announcer reads its sentences here
   * (FE-107 criterion 6).
   */
  text(key: string, params: Readonly<Record<string, string | number>>): string | null;
  /** Brings the host's extensions in line with the list the element holds (UX-050). */
  setExtensions(list: readonly unknown[]): void;
}

export { SettingsStore };

/**
 * The states `de-command-state` watches (05 §8.1; FE-028; UX-005): the core's commands by their
 * names, and the registry's commands by their identifiers (`format.bold`), which the host's
 * `exec` and `queryCommand` take. A command that is not offered is left out.
 */
function commandStates(
  core: EditorCore,
  registry: ReturnType<typeof createCommandRegistry>,
): Record<string, { enabled: boolean; active: boolean }> {
  const out: Record<string, { enabled: boolean; active: boolean }> = {};
  for (const [name, state] of Object.entries(core.commands.get()))
    if (state) out[name] = { enabled: state.enabled, active: state.active };
  for (const entry of registry.list()) {
    const state = registry.state(entry.id);
    if (state.offered) out[entry.id] = { enabled: state.enabled, active: state.active === true };
  }
  return out;
}

/**
 * The shell settings the attributes give (05 §8.1 `toolbar`, `locale`, `theme`); unknown values
 * keep the shell's own reading of them (ui's `toolbarMode` and `themeMode`, PRO-079).
 */
export function settingsFrom(attrs: {
  toolbar: string | null;
  locale: string | null;
  theme: string | null;
  /** The proposed `header` attribute (UX-014; ADR 0041, ADR 0361): `none` hides the built-in header. */
  header?: string | null;
}): Partial<ShellSettings> {
  const out: {
    toolbar?: ShellSettings['toolbar'];
    header?: ShellSettings['header'];
    locale?: string;
    theme?: ShellSettings['theme'];
  } = {};
  if (attrs.toolbar !== null) out.toolbar = toolbarMode(attrs.toolbar);
  // Always set, so that removing the attribute brings the header back.
  if (attrs.header !== undefined) out.header = headerMode(attrs.header);
  if (attrs.locale) out.locale = attrs.locale;
  if (attrs.theme !== null) out.theme = themeMode(attrs.theme);
  return out;
}

/** A read view derived from others, notifying when any of them does. */
function derived<T>(sources: ReadonlyArray<ReadView<unknown>>, compute: () => T): ReadView<T> {
  return {
    get: compute,
    subscribe(listener) {
      const stops = sources.map((s) => s.subscribe(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

const CONNECTION: Readonly<Record<ConnectionState, Connection>> = {
  detached: 'offline',
  online: 'online',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

export function mountEditor(options: MountOptions): MountedEditor {
  const { root, content, config, viewerUrl } = options;
  // The core refuses a document this build cannot read (03 §2): UnsupportedDocumentError carries
  // `unsupported_cdm`, `unsupported_feature` or `validation_failed`, which the session reports.
  const core = new EditorCore({
    doc: { cdm: content.cdm, requires: [...content.requires], doc: content.doc },
    footnoteModel: config.footnoteModel,
    selectionShim: config.selectionShim,
    deferRemoteWhileComposing: config.deferRemoteWhileComposing,
    mode: options.mode,
    ...(options.fontAlias ? { fontAlias: options.fontAlias } : {}),
    ...(options.assetImage ? { assetImage: options.assetImage } : {}),
    ...(options.drawEquation ? { drawEquation: options.drawEquation } : {}),
  });
  const stylePath = attachStyles(root, {
    nonce: config.styleNonce,
    forceFallback: config.forceStyleFallback,
  });

  // `de-status` and the shell's save indicator show the same thing (FE-007): the core's
  // connection and save state, and `readonly` when the access allows no change.
  const status = derived<StatusDetail>([core.connection, core.saveState, core.permissions], () => {
    const access = core.permissions.get();
    return {
      connection: CONNECTION[core.connection.get()],
      sync: access && !mayChange(access) ? 'readonly' : core.saveState.get(),
    };
  });

  const fill = fillView(core);
  const port = options.permissions ?? null;
  const viewers = new Set<PdfViewerFrame>();
  let destroyed = false;
  const pdf: PdfService = {
    async open(container, source) {
      const { PdfViewerFrame } = await import('./pdf/viewer-frame.ts');
      if (destroyed) throw new PortError('unavailable', 'the editor was destroyed');
      const viewer = new PdfViewerFrame(container, { url: viewerUrl });
      viewers.add(viewer);
      try {
        const { pages, worker } = await viewer.open(source);
        return { viewer, pages, worker };
      } catch (e) {
        viewers.delete(viewer);
        viewer.destroy();
        throw e;
      }
    },
  };

  // The core's members of ui's CoreApi (ADR 0041), bound, plus the status and the PDF viewer. The
  // core fills `presence` and `features` from what attach() hands it (the backend's presence port
  // and features); `counts` has no source yet.
  const shell: ShellCore = {
    selection: core.selection,
    panel: core.panel,
    outline: core.outline,
    run: (command) => core.run(command),
    closePanel: () => core.closePanel(),
    // The variants of the header and footer panel (FE-057): the core lists and opens them.
    storyVariants: () => core.storyVariants(),
    editStory: (part, variant) => core.editStory(part, variant),
    focus: () => core.focus(),
    // The checker, the outline and the export diagnostics move to a block through this (UX-067 criterion 1).
    selectBlock: (id) => core.selectBlock(id),
    // The navigation pane's search (UX-020 criterion 3): the core's find over the body this reader
    // holds, with the text around each match; choosing a result selects that match and scrolls to it.
    // The pane's "match case" is the find's option (the engine's own default stays case-sensitive).
    search: (query, options) => {
      const state = core.findText(query, { matchCase: options?.matchCase === true });
      return Promise.resolve({
        query,
        total: state.count,
        matches: core.findResults().map((r) => ({
          index: r.index,
          blockId: r.blockId ?? '',
          before: r.before,
          text: r.text,
          after: r.after,
        })),
      });
    },
    selectMatch: (match) =>
      core.selectFindMatch(match.index, { blockId: match.blockId || null, text: match.text }),
    // Where a menu asked for from the keyboard opens (UX-008 criterion 1).
    caretRect: () => core.caretRect(),
    mountBody: (target) => core.mountBody(target),
    mountPanel: (target) => core.mountPanel(target),
    access: core.access,
    revision: core.revision,
    direction: core.direction,
    // The mode the switcher shows: the effective one, which the core enforces (the most restrictive
    // the access allows). The modes the switcher offers are the three this element supports (UX-015;
    // `fill` is FRW's, offered by its own participant view). `setMode` answers whether the mode asked
    // for is the one now in effect (FE-041 criterion 1; ui ShellCore.setMode).
    mode: {
      get: (): EditorMode => core.mode.get().effective,
      subscribe: (listener) => core.mode.subscribe(listener),
    },
    modes: { get: (): readonly EditorMode[] => SHELL_MODES, subscribe: () => () => {} },
    setMode: (mode: EditorMode): boolean => {
      if (!SHELL_MODES.includes(mode)) return false;
      core.setMode(mode);
      return core.mode.get().effective === mode;
    },
    queryNames: core.queryNames,
    // Named commands of phase 1b that the shell runs (ui CoreCommandName). `insertField` takes the
    // palette's `{ kind }` and inserts that form field kind at the caret (FRW-072).
    // `setRegionPolicy` takes `{ region, policy }` (PRM-036); the engine refuses it without `manage`.
    // `copyFormat` and `pasteFormat` are the format painter's (UX-009); `insertRecovered` and
    // `discardRecovered` take `{ id }` and are the recovered edits pane's (UX-017); `setLanguage`
    // takes `{ lang }` (UX-018).
    // `renameRegion` takes the permissions pane's `{ region, title }` (PRM-034); the engine refuses it
    // without `structure` and `edit` in the region.
    // `markRegion` takes the region dialog's `{ title }` (PRM-033); in suggestion mode the engine
    // refuses it and `canMarkRegion` says why (FE-044 criterion 5).
    // `nextEditableRegion` takes no arguments and moves the caret (PRM-027).
    // `showReferences` takes no arguments and selects a cross-reference that blocked the last
    // refused deletion (FE-133 criterion 5).
    commandNames: [
      'insertField',
      'setRegionPolicy',
      'renameRegion',
      'markRegion',
      'nextEditableRegion',
      'showReferences',
      'copyFormat',
      'pasteFormat',
      'insertRecovered',
      'discardRecovered',
      'setLanguage',
    ],
    runNamed: (name, args) => {
      if (name === 'showReferences') return core.showReferences();
      if (name === 'nextEditableRegion') return core.run('nextEditableRegion', undefined);
      // The format painter (UX-009): `copyFormat` takes the formatting at the selection, `pasteFormat`
      // puts it on the selection through the guards; neither takes an argument.
      if (name === 'copyFormat' || name === 'pasteFormat') return core.run(name);
      // The language dialog (UX-018): the `lang` mark of a BCP 47 tag on the selection, or none (the
      // document's default) for null; the core checks the tag and the user's right to change it.
      if (name === 'setLanguage') {
        const lang = (args as { lang?: unknown } | undefined)?.lang;
        if (lang !== null && typeof lang !== 'string') return false;
        return core.run('lang', { lang });
      }
      // The recovered edits pane (UX-017): `{ id }` names an item of the core's recovered view.
      if (name === 'insertRecovered' || name === 'discardRecovered') {
        const id = (args as { id?: unknown } | undefined)?.id;
        if (typeof id !== 'string') return false;
        return name === 'insertRecovered' ? core.insertRecovered(id) : core.discardRecovered(id);
      }
      if (name === 'markRegion') {
        const title = (args as { title?: unknown } | undefined)?.title;
        if (typeof title !== 'string') return false;
        return core.run('markRegion', { title });
      }
      if (name === 'renameRegion') {
        const a = args as { region?: unknown; title?: unknown } | undefined;
        if (typeof a?.region !== 'string' || typeof a.title !== 'string') return false;
        return core.run('renameRegion', { region: a.region, title: a.title });
      }
      if (name === 'setRegionPolicy') {
        const a = args as { region?: unknown; policy?: unknown } | undefined;
        if (typeof a?.region !== 'string') return false;
        if (a.policy !== 'inherit' && a.policy !== 'restricted') return false;
        return core.run('setRegionPolicy', { region: a.region, policy: a.policy });
      }
      if (name !== 'insertField') return false;
      const kind = (args as { kind?: unknown } | undefined)?.kind;
      if (typeof kind !== 'string') return false;
      // The palette inserts form fields: `date` is the form kind here, not the page date (ADR 0367).
      return core.run('insertField', { field: { kind: kind as 'text', form: true } });
    },
    query: (name) => core.query(name),
    // Why a query answered false; the shell shows it as `reason.query.<code>` (FE-044 criterion 5).
    queryReason: (name) => core.queryReason(name),
    setLabels: (labels) => core.setLabels(labels),
    presence: core.presence,
    // The peers' carets, measured by the core's body view (SYN-036 criterion 5; UX-027).
    carets: core.carets,
    features: core.features,
    counts: core.counts,
    // The status bar's word count, made off the typing path, and the document's default language
    // (UX-018). There is no typeset result here, so no page count: the web view shows none (02 §7).
    stats: derived<DocumentStats>([core.words], () => ({ words: core.words.get(), pages: null })),
    language: core.language,
    // Spelling and grammar through the backend's proofing port (UX-041, UX-042; 13 §6.1). Without a
    // port `proofing.get().available` is false and the shell shows no proofing control.
    proofing: core.proofing,
    proofingStep: (direction) => core.proofingStep(direction),
    applyFinding: (id, suggestion) => core.applyFinding(id, suggestion),
    ignoreFinding: (id, everywhere) => core.ignoreFinding(id, everywhere),
    addFindingToDictionary: (id) => core.addFindingToDictionary(id),
    // The shell's notices for a refused local change and for work set aside (UX; 07 §9), and for a
    // deletion the core trimmed to the parts the user may change (FE-037 criterion 2).
    refusal: core.refusal,
    recovered: core.recovered,
    trimmed: core.trimmed,
    // The sources pane (UX-103): the core's sources and the changes to them, as commits.
    sources: sourcesService(core),
    // The roles manager (FRW-074): the core's roles and the changes to them, as commits.
    roles: rolesService(core),
    // The field properties pane (FRW-073): a field's authored attributes and the change of them.
    fieldProperties: fieldPropertiesService(core),
    // The math editor (FE-070): the selected equation, its limits and its confirmation; MathLive loads on first use.
    mathEditor: mathEditorService(core, { fontsUrl: options.mathFontsUrl }),
    // Fill mode (FRW-076, FRW-078): the fields without their values, for the guided bar and the
    // fill pane, and the move of focus to a field's control.
    fill,
    focusField: (id) => core.focusField(id),
    status,
    pdf,
    // The permissions pane (PRO-080 criterion 2): the access in force, the backend's region list
    // and its grants. Without the backend's reads the pane, or its grant controls, are not offered.
    permissions: core.permissions,
    ...(port?.regions
      ? {
          regions: regionsView(port.regions.bind(port), options.docId, [
            core.permissions,
            core.regionTitles,
          ]),
        }
      : {}),
    ...(port?.grants && port.updateGrants
      ? {
          grants: grantsService(
            { grants: port.grants.bind(port), updateGrants: port.updateGrants.bind(port) },
            options.docId,
          ),
        }
      : {}),
  };

  // The property as it is when the shell asks (PRO-080 criterion 2): the shell reads its props once,
  // so the wrapper, not the value at mount, is passed. Absent, the answer is no matches.
  const searchPrincipals: SearchPrincipals = (query): Promise<PrincipalInfo[]> => {
    const search = options.searchPrincipals();
    return search ? search(query) : Promise.resolve([]);
  };

  const people = new PeopleDirectory({
    // The property as it is when the shell asks: a host may set it after the element loaded.
    resolveUsers: (ids) => options.resolveUsers()?.(ids) ?? Promise.resolve(ids.map(() => null)),
  });
  // The host's replacements by key (UX-063). A missing key falls back to the source table; an
  // unknown key is reported to the console, in every build. The shell reads this catalogue.
  const strings = new Strings({
    overrides: options.strings() ?? {},
    onUnknown: (keys) =>
      console.warn(`doc-editor: unknown string keys ignored: ${keys.join(', ')}`),
  });
  // The one command registry (13 §4; UX-005): the shell's toolbars and menus read it, and so do the
  // host's `exec` and `queryCommand`, so the host's buttons agree with the built-in ones.
  const registry = createCommandRegistry(shell, { hasString: (key) => strings.has(key) });
  const app = mount(App, {
    target: root,
    props: {
      core: shell,
      strings,
      registry,
      people,
      searchPrincipals,
      docId: options.docId,
      settings: options.settings,
      loadPane: async () => (await import('@docedit/ui/panes/OutlinePane.svelte')).default,
      onShareRequest: options.onShareRequest,
      ...(options.onPrintRequest ? { onPrintRequest: options.onPrintRequest } : {}),
      ...(options.onAccessRequest ? { onAccessRequest: options.onAccessRequest } : {}),
      onExtensionError: options.onExtensionError,
    },
  });
  // Run the mount effects now, so the body view exists when `de-ready` is seen.
  flushSync();
  // The host's extensions are activated once the shell exists; a later change comes through setExtensions.
  app.setExtensions(options.extensions());
  const stopShortcuts = attachShortcuts(root, (command) => core.run(command));

  const api = hostApi(core, registry);

  return {
    core,
    shell,
    stylePath,
    saveState: core.saveState,
    confirmedSeq: core.confirmedSeq,
    access: core.permissions,
    status,
    recovered: core.recovered,
    problem: core.problem,
    // The other sessions this reader may see (FE-107 criterion 3).
    presence: core.presence,
    // What a host-drawn header reads (UX-014 criterion 5): identifiers, a status and counts only.
    header: { mode: core.mode, presence: core.presence, counts: core.counts },
    // What `de-field-change` and `de-fill-progress` watch (FRW-070): no value is read.
    fill: { onFieldChange: (listener) => core.onFieldChange(listener), fill },
    // What `de-selection` and `de-command-state` watch (FE-028); read-only, no content.
    watch: {
      // A change of the registry's states is a reason to look again, as a new revision is (UX-005).
      revision: {
        subscribe: (listener) => {
          const offCore = core.revision.subscribe(listener);
          const offRegistry = registry.onStateChange(() => listener());
          return () => {
            offCore();
            offRegistry();
          };
        },
      },
      selectionScope: () => core.selectionScope(),
      commandStates: () => commandStates(core, registry),
    },
    attach(channel: SyncChannel, at: AttachAt) {
      return core.attach(channel, at);
    },
    flushJournal() {
      return core.flushJournal();
    },
    // FE-005: the shell stops its observers and its colour-scheme listener; the core closes its
    // channel. A PDF viewer's frame, and the PDF.js worker in it, is unloaded by the browser when the
    // element leaves the document.
    suspend() {
      if (destroyed) return;
      app.setSuspended(true);
      core.suspendSync();
    },
    resume() {
      if (destroyed) return;
      app.setSuspended(false);
      core.resumeSync();
    },
    setAccess(access: Access) {
      core.setAccess(access);
    },
    setMode(mode: EditMode) {
      core.setMode(mode);
    },
    setStrings(overrides: StringOverrides) {
      strings.setOverrides(overrides);
    },
    text(key, params) {
      return strings.current.has(key) ? strings.current.text(key, params) : null;
    },
    setExtensions(list: readonly unknown[]) {
      app.setExtensions(list);
    },
    restoreShareFocus() {
      return app.restoreFocus();
    },
    openPane(id: string) {
      return app.openPaneById(id);
    },
    focus() {
      core.focus();
    },
    api,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // Removing a viewer's frame ends its document and its PDF.js worker (FE-071).
      for (const viewer of viewers) viewer.destroy();
      viewers.clear();
      stopShortcuts();
      void unmount(app);
      registry.destroy();
      core.destroy();
    },
  };
}
