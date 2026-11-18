/**
 * The shell's test harness: mounts `App` into the open shadow root of a host element, as the
 * element does (02 §2, §3), with a fake core that implements only `CoreApi` (FE-026 criterion 7).
 * Playwright drives it through `window.harness`.
 *
 * The first thing it does is record `securitypolicyviolation` events, which are composed, so
 * violations inside the shadow root reach the document (spike S2 method).
 */
import { flushSync, mount, unmount } from 'svelte';
import App from '../../src/App.svelte';
import { bindCommandStateEvent, createCommandRegistry } from '../../src/commands/index.ts';
import type { CommandEntry, ExecResult } from '../../src/commands/types.ts';
import type {
  AccessObject,
  AccessSummary,
  ClassificationLabel,
  CommentAnchor,
  DocumentStats,
  EditorMode,
  ExportJobView,
  ExportTarget,
  FillSummary,
  PeerCaret,
  ProofingFindingView,
  ProofingStatus,
  PresencePeer,
  PrincipalInfo,
  RecoveredItem,
  RegionGrant,
  RegionSummary,
  ResolveUsers,
  SearchPrincipals,
  SelectionSummary,
  ShellCounts,
  StatusSummary,
  StyleSummary,
  UserInfo,
  ViewName,
} from '../../src/core-api.ts';
import { FilterRegistry } from '../../src/extensions/filters.ts';
import type { DocumentChangedEvent, HookQueueStats } from '../../src/extensions/hooks.ts';
import { StatusItemRegistry, contributePanel } from '../../src/extensions/contributions.ts';
import { PaneRegistry, type PaneComponent } from '../../src/shell/panes.ts';

/** The identifier of the extension panel the harness contributes (UX-052). */
export const EXTENSION_PANE = 'ext-notes';
import { Strings } from '../../src/i18n/strings.ts';
import { Icons } from '../../src/icons/icons.ts';
import { PeopleDirectory } from '../../src/people/directory.ts';
import { SettingsStore, type ShellSettings } from '../../src/shell/settings.ts';
import shellCss from '../../src/styles/shell.css?inline';
import type { ReviewItem, ThreadDetail, ThreadSummary } from '../../src/core-api.ts';
import { FakeCore, type FakeCoreOptions, type Notify } from '../../test/support/fake-core.ts';
import { historyPort, type HistoryHarnessMode } from './his-009-history-port.ts';
import { catchUpPort, type CatchUpHarnessMode } from './his-028-catch-up-port.ts';

const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(
    `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${JSON.stringify(e.sample)}`,
  );
});
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

/** The host's directory for the tests (UX-025). */
const DIRECTORY: Readonly<Record<string, UserInfo>> = {
  u1: { id: 'u1', name: 'Ada Lovelace', avatarUrl: '/avatar.png' },
  u2: { id: 'u2', name: 'Grace Hopper' },
  u3: { id: 'u3', name: '<img src=x onerror="window.__pwned=1">' },
  u4: { id: 'u4', name: 'Katherine Johnson', avatarUrl: 'javascript:window.__pwned=1' },
  u5: { id: 'u5', name: 'Radia Perlman' },
  u6: { id: 'u6', name: 'Barbara Liskov' },
  u7: { id: 'u7', name: 'Frances Allen' },
  u8: { id: 'u8', name: 'Margaret Hamilton' },
  u9: { id: 'u9', name: 'Hedy Lamarr' },
};

/** Users and groups the host's `searchPrincipals` finds (PRM-035). */
const PRINCIPALS: readonly PrincipalInfo[] = [
  { principal: 'user:u1', name: 'Ada Lovelace', detail: 'Legal' },
  { principal: 'user:u2', name: 'Grace Hopper' },
  { principal: 'group:legal', name: 'Legal team' },
];

export interface MountOptions {
  locale?: string;
  toolbar?: ShellSettings['toolbar'];
  header?: ShellSettings['header'];
  theme?: ShellSettings['theme'];
  pageTheme?: ShellSettings['pageTheme'];
  /** The `title` property; with `slotTitle`, a light-DOM element in the title slot instead. */
  title?: string;
  slotTitle?: string;
  /** Inline size of the host element, in CSS pixels. */
  width?: number;
  access?: AccessSummary;
  status?: StatusSummary;
  presence?: PresencePeer[];
  features?: string[];
  counts?: ShellCounts;
  /** `host`: the directory above; `failing`: every call rejects; `none`: no resolveUsers. */
  people?: 'host' | 'failing' | 'none';
  /** The history port of HIS-009: full, a reader of named versions, or failing; absent: none. */
  history?: HistoryHarnessMode;
  /** The catch-up port of HIS-028: with activity, without, failing, or a user who has not viewed the head. */
  catchUp?: CatchUpHarnessMode;
  share?: boolean;
  /** The host can print (UX-040 criterion 3): the print command is offered and records its runs. */
  print?: boolean;
  headerPanes?: boolean;
  outline?: boolean;
  /** Like the spike core: no optional views and no query method. */
  minimal?: boolean;
  /** The members of phase 1b (ADR 0052). */
  extended?: boolean;
  /** Offers the markup views of suggestions (UX-035); with xtended only. */
  markupViews?: boolean;
  notify?: Notify;
  selection?: Partial<SelectionSummary>;
  mode?: EditorMode;
  modes?: EditorMode[];
  /** `settings.trackChanges` is `everyone` (UX-038). */
  trackedForEveryone?: boolean;
  views?: ViewName[];
  permissions?: AccessObject | null;
  styles?: StyleSummary[];
  /** Offers `styleEdit` (UX-022); see the fake core's option of the same name. */
  styleEdit?: FakeCoreOptions['styleEdit'];
  regions?: RegionSummary[];
  stats?: DocumentStats;
  language?: string | null;
  exportTargets?: ExportTarget[] | null;
  projected?: boolean;
  grants?: RegionGrant[] | null;
  fill?: FillSummary | null;
  carets?: PeerCaret[];
  /** The document's base direction (`settings.dir`), as the core's `direction` view (UX-065). */
  direction?: 'ltr' | 'rtl';
  /** A proofing port is attached (UX-041): the findings the harness steps through are `proofingFindings`. */
  proofing?: { status: ProofingStatus; findings: ProofingFindingView[] };
  /** The document's classification label, as the core's `classification` view (UX-085). */
  classification?: ClassificationLabel | null;
  /** The host's directory search: `host` (the list above) or `none`. */
  principals?: 'host' | 'none';
  /** The host handles requests for access to hidden content (UX-104). */
  accessRequests?: boolean;
  /** A toolbar of the host's own in the light DOM, from `state` and `exec` (UX-005). */
  hostToolbar?: boolean;
  /**
   * Client export filters of an extension (UX-055): a working Markdown filter and one that
   * tampers with what it receives and throws. The core then offers `getContent`.
   */
  exportFilters?: boolean;
  /**
   * The accessibility checker pane (UX-066, UX-067): the core gives a document with one issue of
   * each kind (the alternative text of one figure is set by `editChecker`), and records the blocks
   * the pane asks it to select.
   */
  checker?: boolean;
  /**
   * Extension hooks (UX-054): one that throws, one that never resolves and one that records.
   * Each input in the editing surface counts as a transaction (the revision goes up).
   */
  hooks?: boolean;
  /**
   * An extension's panel and status-bar items (UX-052): a panel registered through
   * `contributePanel`, and one item at each edge of the status bar.
   */
  extensionContributions?: boolean;
  /** Host string replacements by key (UX-063, criterion 2), passed to the string catalogue. */
  overrides?: Record<string, string>;
  /** Host icon replacements by command icon name (UX-063, criteria 1 and 3). */
  icons?: Record<string, unknown>;
  /** The comment threads port (UX-028), with the `comments` feature announced. */
  comments?: boolean;
  /** The core lists suggestions and steps and resolves them (UX-036, UX-037). */
  review?: boolean;
  /** The comments pane itself (UX-030): the real pane is the `comments` loader; threads come from `setThreads`. */
  commentsPane?: boolean;
  /** Milliseconds `searchPrincipals` holds its answer, by query text (UX-031 criterion 2). */
  principalDelays?: Record<string, number>;
}

interface Mounted {
  core: FakeCore;
  settings: SettingsStore;
  strings: Strings;
  icons: Icons;
  registry: ReturnType<typeof createCommandRegistry>;
  app: Record<string, unknown>;
  host: HTMLElement;
  root: ShadowRoot;
  stops: Array<() => void>;
}

let current: Mounted | null = null;
const resolveCalls: string[][] = [];
const shareRequests: number[] = [];
const printRequests: number[] = [];
const accessRequests: string[] = [];
const commandEvents: string[][] = [];
const hostEvents: string[][] = [];
const missing: Array<[string, readonly string[]]> = [];
/** The identifiers of the commands `tryRegister` registered, in the order they ran (UX-051). */
const commandRuns: string[] = [];
/** The problems the shell reported for host extensions (UX-050), in order. */
const extensionReports: Array<{
  extension: string;
  reason: string;
  message: string;
  fatal: boolean;
}> = [];

/**
 * The host extension lists the harness can set (UX-050). `valid` has one extension with a command;
 * `mixed` adds one with a bad manifest, one for an unsupported API version, and one whose activation
 * registers a command and then throws. The reports and the commands are what the tests read.
 */
function extensionsFor(kind: 'none' | 'valid' | 'mixed'): unknown[] {
  const notes = {
    manifest: { id: 'ext.notes', name: 'Notes', apiVersion: '1' },
    activate: (api: { registerCommand(e: unknown): void }) =>
      api.registerCommand({
        id: 'ext.notes.insert',
        label: 'command.format.bold',
        group: 'ext',
        changesContent: false,
        capability: 'host-panels-and-commands',
        run: () => true,
      }),
  };
  if (kind === 'none') return [];
  if (kind === 'valid') return [notes];
  return [
    notes,
    { manifest: { id: 'Bad Id', name: 'Bad', apiVersion: '1' }, activate: () => {} },
    {
      manifest: { id: 'ext.old', name: 'Old', apiVersion: '0' },
      activate: (api: { registerCommand(e: unknown): void }) =>
        api.registerCommand({
          id: 'ext.old.cmd',
          label: 'command.format.bold',
          group: 'ext',
          changesContent: false,
          capability: 'host-panels-and-commands',
          run: () => true,
        }),
    },
    {
      manifest: { id: 'ext.boom', name: 'Boom', apiVersion: '1' },
      activate: (api: { registerCommand(e: unknown): void }) => {
        api.registerCommand({
          id: 'ext.boom.cmd',
          label: 'command.format.bold',
          group: 'ext',
          changesContent: false,
          capability: 'host-panels-and-commands',
          run: () => true,
        });
        throw new Error('the extension failed while starting');
      },
    },
  ];
}
/** Host override keys that no table knows (UX-063, criterion 2). */
const unknownKeys: string[] = [];
/** Host icon names whose drawing was not usable (UX-063, criterion 1). */
const iconsInvalid: string[] = [];
/** What the export filters received (UX-055). */
const filterContents: string[] = [];
/** Hook calls (UX-054): the revision, and whether an input event was being dispatched then. */
const hookCalls: Array<{
  revision: number;
  duringInput: boolean;
  inputFrame: number;
  frame: number;
}> = [];
/** Animation frames drawn so far, and the frame each input's revision was made in (UX-054). */
let frame = 0;
const inputFrames = new Map<number, number>();
const frameLoop = (): void => {
  frame++;
  requestAnimationFrame(frameLoop);
};
requestAnimationFrame(frameLoop);
const hookErrors: string[] = [];
let duringInput = false;

/** The checker's document (UX-066, UX-067): one issue of each kind, and one in region rLegal. */
let checkerAltFixed = false;
const checkerSelected: string[] = [];
/** How many times the checker read the document (UX-066 criterion 5). */
let checkerReads = 0;
function checkerContent(): unknown {
  checkerReads += 1;
  const text = (value: string, marks: unknown[] = []) =>
    marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };
  const para = (id: string, style: string | null, content: unknown[]) => ({
    type: 'paragraph',
    attrs: { id, style },
    content,
  });
  const figure = (id: string, alt: string | null) => ({
    type: 'figure',
    attrs: { id, asset: id, width: 4000, height: 3000, alt },
  });
  const def = (id: string, attrs: Record<string, unknown>) => ({
    type: 'style_def',
    attrs: { id, kind: 'paragraph', name: id, builtIn: true, ...attrs },
  });
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            def('Normal', {}),
            def('Heading1', { basedOn: 'Normal', outlineLevel: 1 }),
            def('Heading3', { basedOn: 'Normal', outlineLevel: 3 }),
            { type: 'page_setup', attrs: { id: 'ps1', width: 11906, height: 16838 } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para('hScope', 'Heading1', [text('Scope')]),
            para('hTooDeep', 'Heading3', [text('Too deep')]),
            para('pLink', null, [
              text('Read the '),
              text('click here', [{ type: 'link', attrs: { href: 'https://example.com/r' } }]),
            ]),
            figure('fNoAlt', checkerAltFixed ? 'A chart' : null),
            {
              type: 'table',
              attrs: { id: 'tNoHeader', style: null, grid: [2000], headerRows: 0 },
              content: [
                {
                  type: 'table_row',
                  attrs: { id: 'tNoHeader-row' },
                  content: [
                    {
                      type: 'table_cell',
                      attrs: { id: 'c1', colspan: 1, rowspan: 1, shading: null },
                      content: [para('pCell', null, [text('Cell')])],
                    },
                  ],
                },
              ],
            },
            para('pNavy', null, [
              text('Black on navy', [{ type: 'highlight', attrs: { value: 'darkBlue' } }]),
            ]),
            {
              type: 'region',
              attrs: { id: 'rLegal', title: 'Legal review', policy: 'restricted' },
              content: [figure('fLegal', '  ')],
            },
          ],
        },
      ],
    },
  };
}

/** The document the fake core holds for the export filters. */
const DOCUMENT_CONTENT = {
  cdm: 1,
  requires: [],
  doc: { type: 'doc', blocks: [{ type: 'paragraph', text: 'Body text of the test document.' }] },
};

function exportFilterRegistry(): FilterRegistry {
  const filters = new FilterRegistry();
  filters.add({
    kind: 'export',
    id: 'ext.markdown-out',
    label: 'Markdown (extension)',
    mimeType: 'text/markdown',
    extension: 'md',
    run: (content) => {
      filterContents.push(JSON.stringify(content));
      return new TextEncoder().encode('Body text of the test document.\n');
    },
  });
  filters.add({
    kind: 'export',
    id: 'ext.broken-out',
    label: 'Broken format (extension)',
    mimeType: 'text/plain',
    extension: 'txt',
    run: (content) => {
      filterContents.push(JSON.stringify(content));
      (content as { doc: unknown }).doc = null;
      throw new Error('the broken filter failed');
    },
  });
  return filters;
}

const host = document.getElementById('host')!;
const root = host.attachShadow({ mode: 'open' });
const base = new CSSStyleSheet();
base.replaceSync(':host { display: block; contain: content; }');
const shell = new CSSStyleSheet();
shell.replaceSync(shellCss);
root.adoptedStyleSheets = [base, shell];

function resolver(kind: MountOptions['people']): ResolveUsers | undefined {
  if (kind === 'none') return undefined;
  if (kind === 'failing')
    return async (ids) => {
      resolveCalls.push([...ids]);
      throw new Error('directory unavailable');
    };
  return async (ids) => {
    resolveCalls.push([...ids]);
    return ids.map((id) => DIRECTORY[id] ?? null);
  };
}

/** The queries `searchPrincipals` received, and how long to hold the answer to some (UX-031). */
const principalQueries: Array<{ text: string; purpose: string; docId: string }> = [];
let principalDelays: Record<string, number> = {};

const searchPrincipals: SearchPrincipals = async (query) => {
  principalQueries.push({ text: query.text, purpose: query.purpose, docId: query.docId });
  const delay = principalDelays[query.text];
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  return PRINCIPALS.filter((p) => p.name.toLowerCase().includes(query.text.toLowerCase()));
};

/** The host's own share dialog, in the light DOM (UX-039). */
function hostShareDialog(): void {
  shareRequests.push(Date.now());
  const dialog = document.createElement('dialog');
  dialog.id = 'share-dialog';
  const heading = document.createElement('h2');
  heading.textContent = 'Share with people';
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    // As the element's focus() does when the host gives focus back to it.
    (current?.app['restoreFocus'] as (() => boolean) | undefined)?.();
  });
  dialog.append(heading, done);
  document.body.append(dialog);
  dialog.showModal();
}

/** A host-built toolbar (UX-005): buttons from `state`, updated from `de-command-state`. */
function hostToolbar(registry: Mounted['registry']): () => void {
  const bar = document.createElement('div');
  bar.id = 'host-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Host toolbar');
  const ids = ['format.bold', 'format.italic', 'edit.undo', 'insert.footnote'];
  const buttons = ids.map((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset['command'] = id;
    b.textContent = id;
    b.addEventListener('click', () => {
      hostEvents.push(['exec', id, JSON.stringify(registry.exec(id))]);
    });
    bar.append(b);
    return b;
  });
  const render = () => {
    for (const b of buttons) {
      const s = registry.state(b.dataset['command']!);
      b.setAttribute('aria-disabled', String(!s.enabled));
      if (s.active === null) b.removeAttribute('aria-pressed');
      else b.setAttribute('aria-pressed', String(s.active));
    }
  };
  const onState = (e: Event) => {
    hostEvents.push((e as CustomEvent<{ commands: string[] }>).detail.commands);
    render();
  };
  host.addEventListener('de-command-state', onState);
  document.getElementById('after')!.before(bar);
  render();
  return () => {
    host.removeEventListener('de-command-state', onState);
    bar.remove();
  };
}

function mountShell(options: MountOptions = {}): void {
  if (current) unmountShell();
  for (const child of [...host.children]) child.remove();
  if (options.width) host.style.setProperty('inline-size', `${options.width}px`);
  else host.style.removeProperty('inline-size');
  if (options.slotTitle) {
    const title = document.createElement('span');
    title.slot = 'title';
    title.textContent = options.slotTitle;
    host.append(title);
  }
  const core = new FakeCore({
    notify: options.notify ?? 'frame',
    ...(options.minimal ? { minimal: true } : {}),
    ...(options.extended ? { extended: true } : {}),
    ...(options.markupViews ? { markupViews: true } : {}),
    ...(options.access ? { access: options.access } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.presence ? { presence: options.presence } : {}),
    ...(options.features || options.comments
      ? { features: [...(options.features ?? []), ...(options.comments ? ['comments'] : [])] }
      : {}),
    ...(options.comments ? { threads: true } : {}),
    ...(options.review ? { review: true } : {}),
    ...(options.counts ? { counts: options.counts } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.modes ? { modes: options.modes } : {}),
    ...(options.trackedForEveryone !== undefined
      ? { trackedForEveryone: options.trackedForEveryone }
      : {}),
    ...(options.views ? { views: options.views } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    ...(options.styles ? { styles: options.styles } : {}),
    ...(options.styleEdit ? { styleEdit: options.styleEdit } : {}),
    ...(options.regions ? { regions: options.regions } : {}),
    ...(options.stats ? { stats: options.stats } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.exportTargets !== undefined ? { exportTargets: options.exportTargets } : {}),
    ...(options.projected ? { projected: true } : {}),
    ...(options.grants !== undefined ? { grants: options.grants } : {}),
    ...(options.fill !== undefined ? { fill: options.fill } : {}),
    ...(options.carets ? { carets: options.carets } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.classification !== undefined ? { classification: options.classification } : {}),
    ...(options.proofing ? { proofing: options.proofing.status } : {}),
    outline: [
      { id: 'h1', level: 1, text: 'Scope' },
      { id: 'h2', level: 2, text: 'Terms' },
      { id: 'h3', level: 2, text: 'Payment' },
      { id: 'h4', level: 1, text: 'Annex' },
    ],
  });
  if (options.proofing) core.proofingFindings = options.proofing.findings;
  if (options.selection) core.selection.set({ ...core.selection.get(), ...options.selection });
  if (options.history)
    Object.assign(core, {
      history: historyPort(
        options.history,
        resolver(options.people ?? 'host') ?? (async (ids) => ids.map(() => null)),
      ),
    });
  if (options.catchUp)
    Object.assign(core, {
      catchUp: catchUpPort(
        options.catchUp,
        resolver(options.people ?? 'host') ?? (async (ids) => ids.map(() => null)),
      ),
    });
  iconsInvalid.length = 0;
  const icons = new Icons({
    overrides: options.icons ?? null,
    onInvalid: (names) => iconsInvalid.push(...names),
  });
  const strings = new Strings({
    overrides: options.overrides ?? {},
    onMissing: (tag, keys) => missing.push([tag, keys]),
    onUnknown: (keys) => unknownKeys.push(...keys),
  });
  const settings = new SettingsStore({
    toolbar: options.toolbar ?? 'compact',
    header: options.header ?? 'default',
    locale: options.locale ?? 'en-GB',
    theme: options.theme ?? 'light',
    pageTheme: options.pageTheme ?? 'light',
  });
  const registry = createCommandRegistry(core, { hasString: (k) => strings.has(k) });
  const stops = [
    registry.onStateChange((ids) => commandEvents.push([...ids])),
    bindCommandStateEvent(registry, host),
  ];
  principalQueries.length = 0;
  principalDelays = options.principalDelays ?? {};
  const resolveUsers = resolver(options.people ?? 'host');
  const people = new PeopleDirectory(resolveUsers ? { resolveUsers, retryDelaysMs: [200] } : {});
  const props: Record<string, unknown> = {
    core,
    registry,
    strings,
    icons,
    people,
    settings,
    docId: 'd1',
  };
  if (options.title !== undefined) props['title'] = options.title;
  if (options.outline !== false)
    props['loadPane'] = async () => (await import('../../src/panes/OutlinePane.svelte')).default;
  if (options.headerPanes)
    props['panes'] = {
      comments: async () => (await import('./StubPane.svelte')).default,
      // With a catch-up port the pane is the shell's own (HIS-028); without, a stand-in.
      ...(options.catchUp
        ? {}
        : { 'catch-up': async () => (await import('./StubPane.svelte')).default }),
    };
  else if (options.commentsPane)
    props['panes'] = {
      comments: async () => (await import('../../src/panes/CommentsPane.svelte')).default,
    };
  if (options.share) props['onShareRequest'] = hostShareDialog;
  if (options.print) props['onPrintRequest'] = () => printRequests.push(Date.now());
  if (options.principals !== 'none' && options.extended)
    props['searchPrincipals'] = searchPrincipals;
  if (options.accessRequests)
    props['onAccessRequest'] = (detail: { scope: string }) => accessRequests.push(detail.scope);
  if (options.checker) {
    Object.assign(core, {
      getContent: checkerContent,
      selectBlock: (id: string) => {
        checkerSelected.push(id);
        return true;
      },
    });
  }
  if (options.exportFilters) {
    Object.assign(core, { getContent: () => DOCUMENT_CONTENT });
    props['filters'] = exportFilterRegistry();
  }
  if (options.hooks) {
    // Test bounds of the harness, not product values (ADR 0136: the host sets them).
    props['hooks'] = {
      capacity: 8,
      maxInFlight: 2,
      onError: (e: unknown) => void hookErrors.push(String((e as Error).message)),
      handlers: [
        () => {
          throw new Error('hook throws');
        },
        () => new Promise(() => {}),
        (e: DocumentChangedEvent) =>
          void hookCalls.push({
            revision: e.revision,
            duringInput,
            inputFrame: inputFrames.get(e.revision) ?? -1,
            frame,
          }),
      ],
    };
    // Each input is a transaction of the fake core: the revision goes up while it is dispatched.
    const onInput = () => {
      duringInput = true;
      const revision = core.revision.get() + 1;
      inputFrames.set(revision, frame);
      core.revision.set(revision);
      duringInput = false;
    };
    root.addEventListener('input', onInput);
    stops.push(() => root.removeEventListener('input', onInput));
  }
  if (options.extensionContributions) {
    const paneRegistry = new PaneRegistry();
    contributePanel(paneRegistry, {
      id: EXTENSION_PANE,
      label: 'Extension notes',
      load: async () =>
        (await import('./ExtensionPane.svelte')).default as unknown as PaneComponent,
    });
    props['paneRegistry'] = paneRegistry;
    const statusItems = new StatusItemRegistry();
    statusItems.add({
      id: 'ext.start-status',
      position: 'start',
      text: 'Extension start',
      label: 'Extension start status',
    });
    statusItems.add({
      id: 'ext.end-status',
      position: 'end',
      text: 'Extension end',
      label: 'Extension end status',
    });
    props['statusItems'] = statusItems;
  }
  props['onExtensionError'] = (report: (typeof extensionReports)[number]) =>
    void extensionReports.push({ ...report });
  const app = mount(App, { target: root, props: props as never }) as Record<string, unknown>;
  flushSync();
  if (options.hostToolbar) stops.push(hostToolbar(registry));
  current = { core, settings, strings, icons, registry, app, host, root, stops };
}

function unmountShell(): void {
  if (!current) return;
  for (const stop of current.stops) stop();
  void unmount(current.app);
  current.registry.destroy();
  current = null;
}

function need(): Mounted {
  if (!current) throw new Error('mount the shell first');
  return current;
}

const harness = {
  violations,
  errors,
  resolveCalls,
  shareRequests,
  printRequests,
  accessRequests,
  commandEvents,
  hostEvents,
  missing,
  unknownKeys,
  iconsInvalid,
  filterContents,
  hookCalls,
  hookErrors,
  /** The document the fake core holds, as the export filters would receive it. */
  documentContent: () => JSON.stringify(DOCUMENT_CONTENT),
  /** The blocks the checker pane asked the core to select, in order (UX-067 criterion 1). */
  checkerSelected: () => checkerSelected.slice(),
  /** How many times the checker has read the document since the page loaded (UX-066 criterion 5). */
  checkerReads: () => checkerReads,
  /** Changes the document count times in one task, as a burst of keystrokes would (UX-066 criterion 5). */
  burstChecker: (count: number) => {
    for (let i = 0; i < count; i++) need().core.revision.set(need().core.revision.get() + 1);
  },
  /** Changes the checker's document: `altFixed` gives the figure its alternative text (UX-067). */
  editChecker: (altFixed: boolean) => {
    checkerAltFixed = altFixed;
    need().core.revision.set(need().core.revision.get() + 1);
  },
  hookStats: () => (need().app['hookStats'] as () => HookQueueStats[])(),
  /** Opens the extension's panel by its identifier, as an extension command would (UX-052). */
  openExtensionPane: () =>
    (need().app['openPaneById'] as (id: string) => Promise<boolean>)(EXTENSION_PANE),
  /** Follows a link to a comment (UX-034): the shell's entry, as the host's call would reach it. */
  openLinkedComment: (id: string) =>
    (need().app['openLinkedComment'] as (id: string) => Promise<string>)(id),
  revision: () => need().core.revision.get(),
  mount: (options?: MountOptions) => mountShell(options),
  unmount: () => unmountShell(),
  setAccess: (access: AccessSummary) => need().core.access?.set(access),
  moveTo: (access: AccessSummary, selection: Partial<SelectionSummary>) =>
    need().core.moveTo(access, selection),
  setSelection: (selection: Partial<SelectionSummary>) =>
    need().core.selection.set({ ...need().core.selection.get(), ...selection }),
  setStatus: (status: StatusSummary) => need().core.status?.set(status),
  setPresence: (peers: PresencePeer[]) => need().core.presence?.set(peers),
  setFeatures: (features: string[]) => need().core.features?.set(features),
  setCounts: (counts: ShellCounts) => need().core.counts?.set(counts),
  setSettings: (patch: Partial<ShellSettings>) => need().settings.set(patch),
  /** Sets a public `--de-` property on the element that holds the shadow root, as a host page does. */
  setHostProperty: (name: string, value: string) => host.style.setProperty(name, value),
  setLocale: (locale: string) => need().strings.setLocale(locale),
  /** Replaces the host's icons while the shell is mounted (UX-063). */
  setIcons: (overrides: Record<string, unknown> | null) => need().icons.setOverrides(overrides),
  refuse: (reason: string, scopes: string[] = [], count?: number) =>
    need().core.refuse(reason, scopes, count),
  setAside: (items: RecoveredItem[]) => need().core.setAside(items),
  setMode: (mode: EditorMode) => need().core.mode?.set(mode),
  /** As the document does when `settings.trackChanges` changes (UX-038). */
  setTrackedForEveryone: (on: boolean) => need().core.trackedForEveryone?.set(on),
  setPermissions: (access: AccessObject | null) => need().core.permissions?.set(access),
  setStyles: (styles: StyleSummary[]) => need().core.styles?.set(styles),
  setRegions: (regions: RegionSummary[]) => need().core.regions?.set(regions),
  setStats: (stats: DocumentStats) => need().core.stats?.set(stats),
  setFill: (fill: FillSummary | null) => need().core.fill?.set(fill),
  setCarets: (carets: PeerCaret[]) => need().core.carets?.set(carets),
  setDirection: (dir: 'ltr' | 'rtl') => need().core.direction?.set(dir),
  /** As the core does when `document.updated` brings a new label (UX-085). */
  setClassification: (label: ClassificationLabel | null) => need().core.classification?.set(label),
  /** As the core does when its proofing state changes (UX-041). */
  setProofing: (status: ProofingStatus) => need().core.proofing?.set(status),
  /** What the shell asked the proofing port to do, in order (UX-041, UX-042). */
  proofingCalls: (): string[] => [...need().core.proofingCalls],
  setOutline: (items: Array<{ id: string; level: number; text: string }>) =>
    need().core.outline.set(items),
  setPanel: (kind: 'footnote' | 'story' | null) =>
    need().core.panel.set(kind ? { kind, id: `${kind}1`, label: kind } : null),
  setRegionLimit: (n: number) => void (need().core.regionLimit = n),
  setFieldLimit: (n: number) => {
    need().core.fieldLimit = n;
    need().core.revision.set(need().core.revision.get() + 1);
  },
  regionLabels: () => need().core.regionLabels,
  exportRequests: () => need().core.exports?.requests ?? [],
  exportCancelled: () => need().core.exports?.cancelled ?? [],
  failNextExport: () => void (need().core.exports!.failNext = true),
  /** What the core's preflight reports before a job is created (EXP-003 criterion 3). */
  setExportPreflight: (warnings: ExportJobView['diagnostics']) =>
    void (need().core.exports!.preflightWarnings = warnings),
  exportPreflights: () => need().core.exports?.preflights ?? [],
  updateExport: (jobId: string, patch: Partial<ExportJobView>) =>
    need().core.exports?.update(jobId, patch),
  grantSaves: () => need().core.grants?.saves ?? [],
  /** The comment threads port (UX-028, UX-031): what was asked for, and what the core reports. */
  principalQueries: () => [...principalQueries],
  threadRequests: () =>
    JSON.parse(JSON.stringify(need().core.threads?.requests ?? [])) as unknown[],
  setThreadAnchor: (anchor: CommentAnchor | null) => {
    const core = need().core;
    core.threads!.current = anchor;
    // The selection moved: the core publishes it, and the shell re-reads the anchor.
    core.selection.set({ ...core.selection.get() });
  },
  setThreadCount: (n: number) => void (need().core.threads!.threads = n),
  /** The suggestions the core lists, and where the selection is (UX-036). */
  setReviewItems: (
    items: ReviewItem[],
    selection: { from: number; to: number } = { from: 0, to: 0 },
  ) => {
    const core = need().core;
    core.reviewItems = items;
    core.reviewSelection = selection;
    // The shell reads whether the selection is empty from the core's selection summary.
    core.selection.set({ ...core.selection.get(), empty: selection.from === selection.to });
    core.revision.set(core.revision.get() + 1);
  },
  /** What the review commands asked of the core, and the selection now. */
  reviewCalls: () => JSON.parse(JSON.stringify(need().core.reviewCalls)) as unknown[],
  reviewSelection: () => ({ ...need().core.reviewSelection }),
  reviewIds: () => need().core.reviewItems.map((s) => s.id),
  /** Another person resolves a suggestion first: it leaves the list and the revision moves. */
  removeReviewItem: (id: string) => {
    const core = need().core;
    core.reviewItems = core.reviewItems.filter((s) => s.id !== id);
    core.revision.set(core.revision.get() + 1);
  },
  /** The threads the comments pane lists (UX-030). */
  setThreads: (items: ThreadSummary[]) => void (need().core.threads!.items = items),
  /** The service reports a changed list: the pane and the header count read it again (UX-030). */
  replaceThreads: (items: ThreadSummary[]) => need().core.threads!.replaceItems(items),
  /** The threads the pane asked the document to show (UX-030 criterion 2). */
  revealedThreads: () => [...(need().core.threads?.revealed ?? [])],
  /** The reader chooses a thread's highlight in the page (UX-030 criterion 2). */
  pickThread: (id: string) => need().core.threads!.pick(id),
  refuseNextThread: (code: string) => void (need().core.threads!.refuseNext = code),
  /** The service's copy of each thread, for the thread view (UX-029); each gets a new version. */
  putThreads: (details: Array<Omit<ThreadDetail, 'etag'>>) =>
    void details.forEach((d) => need().core.threads!.put(d)),
  /** Signs in as another user for the thread view (UX-029). */
  setThreadUser: (principal: string) => void (need().core.threads!.user = principal),
  /** Another client replies (comment.created): the pane is told and shows it without a reload. */
  remoteReply: (id: string, author: string, text: string) =>
    need().core.threads!.remoteReply(id, author, text),
  /** Another client assigns the thread, or clears it with null (thread.updated; UX-032 criterion 2). */
  remoteAssign: (id: string, assignee: string | null) =>
    need().core.threads!.remoteAssign(id, assignee),
  /** The next write finds the thread changed: another client replied first (If-Match fails). */
  staleNextThread: (author: string, text: string) => {
    need().core.threads!.staleNext = {
      apply: (d) => ({
        ...d,
        comments: [
          ...d.comments,
          {
            id: `c-stale`,
            author,
            createdAt: '2026-11-02T10:30:00Z',
            body: [{ type: 'text', text }],
            edited: false,
          },
        ],
      }),
    };
  },
  /** What the thread view asked the service to do. */
  threadWrites: () => JSON.parse(JSON.stringify(need().core.threads?.writes ?? [])) as unknown[],
  conflictNextGrantSave: () => void (need().core.grants!.conflictNext = true),
  restoreFocus: () => (need().app['restoreFocus'] as () => boolean)(),
  setUndo: (undo: number, redo: number) => {
    const core = need().core;
    core.undoDepth = undo;
    core.redoDepth = redo;
    core.revision.set(core.revision.get() + 1);
  },
  register: (
    id: string,
    label = 'command.format.bold',
    changesContent = false,
    extra: Partial<CommandEntry> = {},
  ) =>
    void need().registry.register({
      id,
      label,
      group: 'ext',
      changesContent,
      enabled: 'canEditSelection',
      capability: 'host-panels-and-commands',
      run: () => true,
      ...extra,
    } as CommandEntry),
  /** Registers a command and returns the error message, if registration is refused. */
  tryRegister: (entry: Partial<CommandEntry> & { id: string }) => {
    try {
      need().registry.register({
        label: 'command.format.bold',
        group: 'ext',
        changesContent: false,
        capability: 'host-panels-and-commands',
        run: () => {
          commandRuns.push(entry.id);
          return true;
        },
        ...entry,
      } as CommandEntry);
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  },
  unregister: (id: string) => need().registry.unregister(id),
  exec: (id: string, args?: unknown): ExecResult => need().registry.exec(id, args),
  state: (id: string) => {
    const s = need().registry.state(id);
    return {
      offered: s.offered,
      enabled: s.enabled,
      active: s.active,
      reason: s.reason,
      reasonKey: s.reasonKey,
    };
  },
  commandIds: () =>
    need()
      .registry.list()
      .map((e) => e.id),
  commandRuns: () => [...commandRuns],
  /** Sets the host's extension list on the mounted shell, as the element does (UX-050). */
  setExtensions: (kind: 'none' | 'valid' | 'mixed') =>
    (need().app['setExtensions'] as (list: unknown[]) => void)(extensionsFor(kind)),
  extensionReports: () => extensionReports.map((r) => ({ ...r })),
  runs: () =>
    need()
      .core.callsOf('run')
      .map((c) => String(c.args[0])),
  named: () =>
    need()
      .core.callsOf('runNamed')
      .map((c) => [String(c.args[0]), c.args[1] ?? null] as const),
  callsOf: (method: string) =>
    need()
      .core.callsOf(method)
      .map((c) => c.args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a))),
  calls: () => need().core.calls.map((c) => c.method),
  /** The markup view the core holds, and the words the shell gave it for a suggestion (UX-035). */
  markupView: () => need().core.markupView?.get() ?? null,
  suggestionLabel: (kind: 'ins' | 'del' | 'fmt', user: string) =>
    need().core.suggestionLabel?.(kind, user) ?? null,
  labels: () => need().core.labels,
  selection: () => need().core.selection.get(),
  fields: () => need().core.fields,
  /** Waits for `n` animation frames. */
  frames: (n = 1) =>
    new Promise<void>((resolve) => {
      const step = (left: number) =>
        left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
      step(n);
    }),
};

Object.assign(window, { harness });

export type Harness = typeof harness;
