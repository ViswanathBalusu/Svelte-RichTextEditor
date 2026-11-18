/**
 * A stand-in for the editing core that implements only `CoreApi` (FE-026 criterion 7: the
 * interface's tests run against a stub of the document API). Used by the Node.js tests and by the
 * Playwright harness. Views notify synchronously, or once per frame like the real core.
 */
import type {
  AccessObject,
  AccessSummary,
  ClassificationLabel,
  CommandName,
  CommentAnchor,
  CommentBodyPart,
  CoreApi,
  CoreLabels,
  DocumentStats,
  EditorMode,
  ExportJobView,
  ExportOptions,
  ExportService,
  ExportTarget,
  FillSummary,
  GrantsService,
  GrantsSnapshot,
  OutlineItem,
  PanelInfo,
  PeerCaret,
  PresencePeer,
  ReadView,
  RecoveredEdits,
  RecoveredItem,
  RefusalNotice,
  RegionGrant,
  RegionLabel,
  RegionSummary,
  SearchMatch,
  SearchOptions,
  SearchResults,
  SelectionSummary,
  ShellCounts,
  ShellRect,
  StatusSummary,
  StyleEditCheck,
  StyleEditOp,
  StyleEditReason,
  StyleSummary,
  ThreadDetail,
  ThreadOutcome,
  ThreadRequest,
  ThreadSummary,
  ThreadWrite,
  ThreadsService,
  ViewName,
  ProofingFindingView,
  ProofingStatus,
} from '../../src/core-api.ts';
import type { MarkupView } from '../../src/shell/markup-views.ts';

/** `shared`: every view of the core notifies in one frame pass, as the engine does. */
export type Notify = 'sync' | 'frame' | 'shared' | ((run: () => void) => void);

export class Value<T> implements ReadView<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();
  readonly #notify: (run: () => void) => void;
  #scheduled = false;

  constructor(value: T, notify: Notify = 'sync') {
    this.#value = value;
    this.#notify =
      notify === 'sync'
        ? (run) => run()
        : notify === 'frame' || notify === 'shared'
          ? (run) => void requestAnimationFrame(() => run())
          : notify;
  }

  get(): T {
    return this.#value;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  set(value: T): void {
    this.#value = value;
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#notify(() => {
      this.#scheduled = false;
      for (const listener of [...this.#listeners]) listener();
    });
  }
}

export interface FakeCoreOptions {
  notify?: Notify;
  access?: AccessSummary;
  status?: StatusSummary;
  presence?: readonly PresencePeer[];
  features?: readonly string[];
  counts?: ShellCounts;
  outline?: readonly OutlineItem[];
  /** Leave out the optional members, like the spike core. */
  minimal?: boolean;
  /** Offer the members of phase 1b (ADR 0052): named commands, modes, styles, regions, ports. */
  extended?: boolean;
  modes?: readonly EditorMode[];
  mode?: EditorMode;
  /** `settings.trackChanges` is `everyone` (UX-038); with `extended` only. */
  trackedForEveryone?: boolean;
  views?: readonly ViewName[];
  /** Offers the markup views of suggestions (UX-035); with xtended only. */
  markupViews?: boolean;
  permissions?: AccessObject | null;
  styles?: readonly StyleSummary[];
  /**
   * Offers `styleEdit` (UX-022): `reason` refuses every edit, `blocked` names the regions a user may
   * not edit that use a style, `uses` the regions that use it (the user may edit them), `builtIn`
   * the styles that cannot be renamed or deleted.
   */
  styleEdit?: {
    reason?: StyleEditReason;
    blocked?: Readonly<Record<string, readonly string[]>>;
    uses?: Readonly<Record<string, readonly string[]>>;
    builtIn?: readonly string[];
  };
  regions?: readonly RegionSummary[];
  stats?: DocumentStats;
  language?: string | null;
  /** Export targets the deployment announces; null: no exports port. */
  exportTargets?: readonly ExportTarget[] | null;
  /** Whether an export leaves out hidden parts (ADR 0019). */
  projected?: boolean;
  /** Region grants; null: no grants port. */
  grants?: readonly RegionGrant[] | null;
  fill?: FillSummary | null;
  carets?: readonly PeerCaret[];
  /** The document's base direction (`settings.dir`); absent: no `direction` view (UX-065). */
  direction?: 'ltr' | 'rtl';
  /** The document's classification label; absent: no `classification` view (UX-085). */
  classification?: ClassificationLabel | null;
  /** A proofing port is attached (UX-041): the `proofing` view and its actions; absent: none. */
  proofing?: ProofingStatus;
  /** Offer the comment threads port (UX-028); absent: no `threads`. */
  threads?: boolean;
}

/**
 * The comment threads port (UX-028; 05 §6.2) the tests drive: the anchor of the selection, the
 * document's thread count, and the requests it received. `refuseNext` makes the next request answer
 * with that code, as the service would.
 */
export class FakeThreads implements ThreadsService {
  current: CommentAnchor | null = {
    selection: { kind: 'range', from: 3, to: 12, baseSeq: 41 },
    scopes: [['view', 'comment']],
  };
  threads = 0;
  refuseNext: string | null = null;
  readonly requests: ThreadRequest[] = [];
  /** The threads the comments pane lists (UX-030); set by the harness. */
  items: ThreadSummary[] = [];

  // --- UX-029: the thread view. The service's copy of each thread, its version and its requests.
  /** The signed-in user. */
  user = 'user:ada';
  readonly changes = new Value(0);
  readonly details = new Map<string, ThreadDetail>();
  /** What the thread view asked the service to do, as `{ op, ... }` records. */
  readonly writes: Array<Record<string, unknown>> = [];
  /** The next write answers `precondition_failed` with the latest thread (another client changed it). */
  staleNext: { readonly apply: (detail: ThreadDetail) => ThreadDetail } | null = null;
  #version = 1;

  self(): string {
    return this.user;
  }

  detail(id: string): ThreadDetail | null {
    return this.details.get(id) ?? null;
  }

  /** Puts a thread in the service's copy, with a new version, and tells the pane. */
  put(detail: Omit<ThreadDetail, 'etag'>): ThreadDetail {
    const next = { ...detail, etag: `v${this.#version++}` };
    this.details.set(next.id, next);
    const summary = this.items.find((t) => t.id === next.id);
    if (summary) {
      const index = this.items.indexOf(summary);
      this.items[index] = {
        ...summary,
        state: next.state,
        replyCount: Math.max(0, next.comments.length - 1),
        excerpt: next.detached ? null : summary.excerpt,
      };
    }
    this.changes.set(this.changes.get() + 1);
    return next;
  }

  /** Another client's reply: the copy changes and the pane is told, as `comment.created` would. */
  remoteReply(id: string, author: string, text: string): void {
    const d = this.details.get(id)!;
    this.put({
      ...d,
      comments: [
        ...d.comments,
        {
          id: `c${d.comments.length + 1}-${author}`,
          author,
          createdAt: '2026-11-02T10:00:00Z',
          body: [{ type: 'text', text }],
          edited: false,
        },
      ],
    });
  }

  #write(
    op: string,
    id: string,
    etag: string,
    detail: Record<string, unknown>,
    change: (d: ThreadDetail) => Omit<ThreadDetail, 'etag'> | null,
  ): ThreadWrite {
    this.writes.push({ op, id, etag, ...detail });
    const current = this.details.get(id);
    if (!current) return { ok: false, code: 'not_found' };
    if (this.staleNext) {
      const stale = this.staleNext;
      this.staleNext = null;
      const latest = this.put(stale.apply(current));
      return { ok: false, code: 'precondition_failed', latest };
    }
    if (etag !== current.etag) return { ok: false, code: 'precondition_failed', latest: current };
    const next = change(current);
    if (!next) return { ok: false, code: 'not_found' };
    return { ok: true, detail: this.put(next) };
  }

  async reply(id: string, body: readonly CommentBodyPart[], etag: string): Promise<ThreadWrite> {
    return this.#write('reply', id, etag, { body }, (d) => ({
      ...d,
      comments: [
        ...d.comments,
        {
          id: `c${d.comments.length + 1}`,
          author: this.user,
          createdAt: '2026-11-02T11:00:00Z',
          body,
          edited: false,
        },
      ],
    }));
  }

  async editComment(
    id: string,
    commentId: string,
    body: readonly CommentBodyPart[],
    etag: string,
  ): Promise<ThreadWrite> {
    return this.#write('edit', id, etag, { commentId, body }, (d) => ({
      ...d,
      comments: d.comments.map((c) => (c.id === commentId ? { ...c, body, edited: true } : c)),
    }));
  }

  async deleteComment(id: string, commentId: string, etag: string): Promise<ThreadWrite> {
    return this.#write('deleteComment', id, etag, { commentId }, (d) => ({
      ...d,
      comments: d.comments.filter((c) => c.id !== commentId),
    }));
  }

  async deleteThread(id: string, etag: string): Promise<{ ok: boolean; code?: string }> {
    this.writes.push({ op: 'deleteThread', id, etag });
    const current = this.details.get(id);
    if (!current) return { ok: false, code: 'not_found' };
    if (etag !== current.etag) return { ok: false, code: 'precondition_failed' };
    this.details.delete(id);
    this.items = this.items.filter((t) => t.id !== id);
    this.changes.set(this.changes.get() + 1);
    return { ok: true };
  }

  async setState(id: string, state: 'open' | 'resolved', etag: string): Promise<ThreadWrite> {
    return this.#write('state', id, etag, { state }, (d) => ({ ...d, state }));
  }
  anchor(): CommentAnchor | null {
    return this.current;
  }

  count(): number {
    return this.threads;
  }

  list(): readonly ThreadSummary[] {
    return this.items.map((t) => ({ ...t }));
  }

  async create(request: ThreadRequest): Promise<ThreadOutcome> {
    this.requests.push(request);
    if (this.refuseNext !== null) {
      const code = this.refuseNext;
      this.refuseNext = null;
      return { ok: false, code };
    }
    this.threads++;
    return { ok: true, id: `t${this.threads}` };
  }
}

/** Named commands of phase 1b the extended fake runs. */
export const FAKE_COMMANDS = [
  'copyFormat',
  'pasteFormat',
  'paragraphStyle',
  'characterStyle',
  'tableStyle',
  'createStyle',
  'changeStyle',
  'deleteStyle',
  'setLanguage',
  'markRegion',
  'setRegionPolicy',
  'renameRegion',
  'nextEditableRegion',
  'insertField',
  'insertRecovered',
  'discardRecovered',
  'finishFill',
  'showReferences',
];

export const FAKE_QUERIES = [
  'canEditSelection',
  'canUndo',
  'canRedo',
  'isBold',
  'isItalic',
  'canInsertFootnote',
  'hasHeader',
  'canCopyFormat',
  'canPasteFormat',
  'canMarkRegion',
  'hasNextEditableRegion',
  'canInsertField',
];

/** One frame pass for every view that changed, as the engine does (B1): one rAF callback. */
class FrameHub {
  readonly #pending = new Set<() => void>();
  #scheduled = false;

  schedule(run: () => void): void {
    this.#pending.add(run);
    if (this.#scheduled) return;
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      const due = [...this.#pending];
      this.#pending.clear();
      for (const f of due) f();
    });
  }
}

/** An export job the harness drives (UX-101). */
export class FakeExports implements ExportService {
  readonly targets: Value<readonly ExportTarget[]>;
  readonly projected: Value<boolean>;
  readonly jobs = new Map<string, Value<ExportJobView | null>>();
  readonly requests: Array<{ target: ExportTarget; options: ExportOptions }> = [];
  readonly cancelled: string[] = [];
  failNext = false;
  /** What `preflight` answers; a test sets it (EXP-003 criterion 3). */
  preflightWarnings: ExportJobView['diagnostics'] = [];
  readonly preflights: ExportTarget[] = [];

  preflight(target: ExportTarget): ExportJobView['diagnostics'] {
    this.preflights.push(target);
    return this.preflightWarnings;
  }

  constructor(targets: readonly ExportTarget[], projected: boolean, notify: Notify) {
    this.targets = new Value(targets, notify);
    this.projected = new Value(projected, notify);
    this.#notify = notify;
  }

  readonly #notify: Notify;

  async request(target: ExportTarget, options: ExportOptions): Promise<{ jobId: string }> {
    this.requests.push({ target, options });
    if (this.failNext) {
      this.failNext = false;
      throw Object.assign(new Error('refused'), { code: 'validation_failed' });
    }
    const jobId = `job${this.requests.length}`;
    this.jobs.set(
      jobId,
      new Value<ExportJobView | null>(
        {
          id: jobId,
          target,
          seq: 7,
          state: 'queued',
          progress: null,
          result: null,
          diagnostics: [],
        },
        this.#notify,
      ),
    );
    return { jobId };
  }

  job(jobId: string): Value<ExportJobView | null> {
    let view = this.jobs.get(jobId);
    if (!view) {
      view = new Value<ExportJobView | null>(null, this.#notify);
      this.jobs.set(jobId, view);
    }
    return view;
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
    const view = this.jobs.get(jobId);
    const job = view?.get();
    if (view && job) view.set({ ...job, state: 'cancelled' });
  }

  /** Moves a job on, as `export.progress` events would. */
  update(jobId: string, patch: Partial<ExportJobView>): void {
    const view = this.job(jobId);
    const job = view.get();
    if (job) view.set({ ...job, ...patch });
  }
}

/** The grants port (PRM-035) with an etag; `conflictNext` makes the next save fail first. */
export class FakeGrants implements GrantsService {
  #grants: readonly RegionGrant[];
  #rev = 1;
  conflictNext = false;
  readonly saves: Array<{ grants: readonly RegionGrant[]; etag: string }> = [];

  constructor(grants: readonly RegionGrant[]) {
    this.#grants = grants;
  }

  async load(): Promise<GrantsSnapshot> {
    return { etag: `"g${this.#rev}"`, grants: this.#grants };
  }

  async save(grants: readonly RegionGrant[], etag: string): Promise<GrantsSnapshot> {
    this.saves.push({ grants, etag });
    if (this.conflictNext || etag !== `"g${this.#rev}"`) {
      this.conflictNext = false;
      // Someone else saved first: their grants are the current ones.
      this.#rev++;
      this.#grants = [...this.#grants, { region: 'r1', principal: 'user:u9', role: 'commenter' }];
      throw Object.assign(new Error('precondition failed'), { code: 'precondition_failed' });
    }
    this.#rev++;
    this.#grants = grants;
    return { etag: `"g${this.#rev}"`, grants };
  }
}

export const EDIT: AccessSummary = {
  scope: 'body',
  caps: ['view', 'comment', 'suggest', 'edit'],
  limit: null,
};
export const VIEW: AccessSummary = { scope: 'body', caps: ['view'], limit: 'role' };

export interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A fake core whose state tests set directly. */
export class FakeCore implements CoreApi {
  readonly selection: Value<SelectionSummary>;
  readonly panel: Value<PanelInfo | null>;
  readonly outline: Value<readonly OutlineItem[]>;
  readonly revision: Value<number>;
  readonly access?: Value<AccessSummary>;
  readonly status?: Value<StatusSummary>;
  readonly presence?: Value<readonly PresencePeer[]>;
  readonly features?: Value<readonly string[]>;
  readonly counts?: Value<ShellCounts>;
  readonly refusal?: Value<RefusalNotice | null>;
  readonly recovered?: Value<RecoveredEdits>;
  readonly direction?: Value<'ltr' | 'rtl'>;
  readonly classification?: Value<ClassificationLabel | null>;
  /** Spelling and grammar (UX-041, UX-042), with `proofing`; every action is recorded in `proofingCalls`. */
  readonly proofing?: Value<ProofingStatus>;
  readonly proofingCalls: string[] = [];
  // Phase 1b (ADR 0052), with `extended`.
  readonly commandNames?: readonly string[];
  readonly queryNames?: readonly string[];
  readonly mode?: Value<EditorMode>;
  readonly modes?: Value<readonly EditorMode[]>;
  readonly trackedForEveryone?: Value<boolean>;
  readonly view?: Value<ViewName>;
  readonly views?: Value<readonly ViewName[]>;
  readonly markupView?: Value<MarkupView>;
  /** The function the shell gave to name suggestions (UX-035 criterion 4); null when cleared. */
  suggestionLabel: ((kind: 'ins' | 'del' | 'fmt', user: string) => string) | null = null;
  readonly permissions?: Value<AccessObject | null>;
  readonly stats?: Value<DocumentStats>;
  readonly language?: Value<string | null>;
  readonly styles?: Value<readonly StyleSummary[]>;
  readonly regions?: Value<readonly RegionSummary[]>;
  readonly carets?: Value<readonly PeerCaret[]>;
  readonly fill?: Value<FillSummary | null>;
  readonly exports?: FakeExports;
  readonly grants?: FakeGrants;
  readonly threads?: FakeThreads;
  regionLabels: Readonly<Record<string, RegionLabel>> | null = null;
  copiedFormat: string[] | null = null;
  regionLimit = 500;
  fieldLimit = 2000;
  fields = 0;
  readonly calls: Call[] = [];
  /** How many times each query was asked. */
  readonly queryCounts = new Map<string, number>();
  labels: CoreLabels | null = null;
  undoDepth = 0;
  redoDepth = 0;
  hasHeader = true;
  surface: HTMLElement | null = null;
  #panelSurface: HTMLElement | null = null;

  constructor(options: FakeCoreOptions = {}) {
    let notify = options.notify ?? 'sync';
    if (notify === 'shared') {
      const hub = new FrameHub();
      notify = (run) => hub.schedule(run);
    }
    this.selection = new Value<SelectionSummary>(
      { empty: true, scope: 'body', region: null, style: 'Normal', marks: [] },
      notify,
    );
    this.panel = new Value<PanelInfo | null>(null, notify);
    this.outline = new Value<readonly OutlineItem[]>(options.outline ?? [], notify);
    this.revision = new Value(0, notify);
    if (options.minimal) {
      // Like the spike core: no optional view, no query method, no labels.
      Object.assign(this, { query: undefined, setLabels: undefined });
      return;
    }
    this.access = new Value(options.access ?? EDIT, notify);
    this.status = new Value<StatusSummary>(
      options.status ?? { connection: 'online', sync: 'saved' },
      notify,
    );
    this.presence = new Value(options.presence ?? [], notify);
    this.features = new Value(options.features ?? [], notify);
    this.counts = new Value(options.counts ?? {}, notify);
    this.refusal = new Value<RefusalNotice | null>(null, notify);
    this.recovered = new Value<RecoveredEdits>({ count: 0, items: [] }, notify);
    if (options.direction) this.direction = new Value(options.direction, notify);
    if (options.classification !== undefined)
      this.classification = new Value(options.classification, notify);
    if (options.proofing) this.proofing = new Value(options.proofing, notify);
    if (options.threads) this.threads = new FakeThreads();
    if (!options.extended) {
      // Like the core of phase 1a: none of the members of phase 1b.
      Object.assign(this, {
        runNamed: undefined,
        queryReason: undefined,
        setMode: undefined,
        setView: undefined,
        setRegionLabels: undefined,
        setMarkupView: undefined,
        setSuggestionLabel: undefined,
        selectBlock: undefined,
        blockChangedSince: undefined,
        search: undefined,
        selectMatch: undefined,
        caretRect: undefined,
        focusField: undefined,
      });
      return;
    }
    Object.assign(this, { commandNames: FAKE_COMMANDS, queryNames: FAKE_QUERIES });
    this.mode = new Value<EditorMode>(options.mode ?? 'edit', notify);
    this.modes = new Value<readonly EditorMode[]>(options.modes ?? ['edit', 'view'], notify);
    this.trackedForEveryone = new Value<boolean>(options.trackedForEveryone === true, notify);
    this.view = new Value<ViewName>('web', notify);
    this.views = new Value<readonly ViewName[]>(options.views ?? ['web'], notify);
    if (options.markupViews) this.markupView = new Value<MarkupView>('all', notify);
    else Object.assign(this, { setMarkupView: undefined, setSuggestionLabel: undefined });
    this.permissions = new Value<AccessObject | null>(
      options.permissions === undefined
        ? {
            rev: 1,
            docRole: 'owner',
            caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
            scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
          }
        : options.permissions,
      notify,
    );
    this.stats = new Value<DocumentStats>(options.stats ?? { words: 6, pages: null }, notify);
    this.language = new Value<string | null>(
      options.language === undefined ? 'en-GB' : options.language,
      notify,
    );
    this.styles = new Value<readonly StyleSummary[]>(options.styles ?? [], notify);
    if (options.styleEdit) {
      const cfg = options.styleEdit;
      Object.assign(this, {
        styleEdit: (op: StyleEditOp, id?: string): StyleEditCheck => {
          this.#record('styleEdit', op, id);
          if (cfg.reason) return { ok: false, reason: cfg.reason, regions: [] };
          if (op === 'create' || id === undefined) return { ok: true, regions: [] };
          const blocked = cfg.blocked?.[id];
          if (blocked) return { ok: false, reason: 'region', regions: blocked };
          if (cfg.builtIn?.includes(id)) return { ok: false, reason: 'built-in', regions: [] };
          return { ok: true, regions: cfg.uses?.[id] ?? [] };
        },
      });
    }
    this.regions = new Value<readonly RegionSummary[]>(options.regions ?? [], notify);
    this.carets = new Value<readonly PeerCaret[]>(options.carets ?? [], notify);
    this.fill = new Value<FillSummary | null>(options.fill ?? null, notify);
    if (options.exportTargets !== null)
      Object.assign(this, {
        exports: new FakeExports(
          options.exportTargets ?? ['pdf', 'tex'],
          options.projected ?? false,
          notify,
        ),
      });
    if (options.grants !== null && options.grants !== undefined)
      Object.assign(this, { grants: new FakeGrants(options.grants) });
    if (options.fill === undefined) Object.assign(this, { fill: undefined });
  }

  // --- Phase 1b (ADR 0052) --------------------------------------------------------------

  queryReason(name: string): string | null {
    const s = this.selection.get();
    switch (name) {
      case 'canMarkRegion':
        if (s.scope === 'region') return 'nested';
        if (s.empty) return 'blocks';
        if ((this.regions?.get().length ?? 0) >= this.regionLimit) return 'regionLimit';
        return null;
      case 'canInsertField':
        if (this.panel.get() !== null) return 'subeditor';
        if (this.fields >= this.fieldLimit) return 'fieldLimit';
        return null;
      case 'hasNextEditableRegion':
        return 'none';
      case 'canCopyFormat':
        return 'noFormat';
      default:
        return null;
    }
  }

  #query1b(name: string): boolean | undefined {
    const s = this.selection.get();
    switch (name) {
      case 'canCopyFormat':
        return !s.empty;
      case 'canPasteFormat':
        return this.copiedFormat !== null && this.#canChange();
      case 'canMarkRegion':
        return this.#canChange() && this.queryReason('canMarkRegion') === null;
      case 'hasNextEditableRegion':
        return this.#nextEditable() !== undefined;
      case 'canInsertField':
        return this.#canChange() && this.queryReason('canInsertField') === null;
      default:
        return undefined;
    }
  }

  #nextEditable(): RegionSummary | undefined {
    const access = this.permissions?.get();
    const here = this.access?.get().scope ?? 'body';
    const regions = [...(this.regions?.get() ?? [])].sort((a, b) => a.order - b.order);
    const current = regions.findIndex((r) => `region:${r.id}` === here);
    return regions
      .slice(current + 1)
      .find((r) => access?.scopes[`region:${r.id}`]?.includes('edit') ?? false);
  }

  #bump(): void {
    this.undoDepth++;
    this.revision.set(this.revision.get() + 1);
  }

  runNamed(name: string, args?: unknown): boolean {
    this.#record('runNamed', name, args);
    const a = (args ?? {}) as Record<string, unknown>;
    const s = this.selection.get();
    switch (name) {
      case 'copyFormat':
        if (s.empty) return false;
        this.copiedFormat = [...s.marks];
        this.revision.set(this.revision.get() + 1);
        return true;
      case 'pasteFormat':
        if (!this.copiedFormat || !this.#canChange()) return false;
        this.selection.set({ ...s, marks: [...this.copiedFormat] });
        this.copiedFormat = null;
        this.#bump();
        return true;
      case 'paragraphStyle': {
        const style = this.styles?.get().find((x) => x.id === a['style']);
        if (!style || !this.#canChange()) return false;
        this.selection.set({ ...s, style: style.name, styleId: style.id });
        this.#bump();
        return true;
      }
      case 'characterStyle':
        if (!this.#canChange()) return false;
        this.selection.set({ ...s, charStyleId: String(a['style']) });
        this.#bump();
        return true;
      case 'tableStyle':
        if (!this.#canChange()) return false;
        this.selection.set({ ...s, tableStyleId: String(a['style']) });
        this.#bump();
        return true;
      case 'createStyle': {
        const list = this.styles?.get() ?? [];
        this.styles?.set([
          ...list,
          {
            id: `s${list.length + 1}`,
            name: String(a['name']),
            kind: a['kind'] as StyleSummary['kind'],
            basedOn: typeof a['basedOn'] === 'string' ? a['basedOn'] : null,
          },
        ]);
        return true;
      }
      case 'changeStyle':
        this.styles?.set(
          (this.styles.get() ?? []).map((x) =>
            x.id === a['id']
              ? {
                  ...x,
                  name: typeof a['name'] === 'string' ? a['name'] : x.name,
                  basedOn: 'basedOn' in a ? (a['basedOn'] as string | null) : (x.basedOn ?? null),
                }
              : x,
          ),
        );
        return true;
      case 'deleteStyle':
        this.styles?.set((this.styles.get() ?? []).filter((x) => x.id !== a['id']));
        return true;
      case 'setLanguage':
        if (!this.#canChange()) return false;
        this.selection.set({ ...s, lang: (a['lang'] as string | null) ?? null });
        this.#bump();
        return true;
      case 'markRegion': {
        if (!this.#query1b('canMarkRegion')) return false;
        const regions = this.regions?.get() ?? [];
        const id = `r${regions.length + 1}`;
        this.regions?.set([
          ...regions,
          {
            id,
            title: String(a['title']),
            policy: 'inherit',
            order: regions.length,
            state: 'draft',
            editors: { roles: ['editor', 'owner'], principals: [] },
          },
        ]);
        this.#bump();
        return true;
      }
      case 'setRegionPolicy': {
        if (!this.permissions?.get()?.caps.includes('manage')) return false;
        this.regions?.set(
          (this.regions.get() ?? []).map((r) =>
            r.id === a['region'] ? { ...r, policy: a['policy'] as RegionSummary['policy'] } : r,
          ),
        );
        this.#bump();
        return true;
      }
      case 'renameRegion': {
        const caps = this.permissions?.get()?.caps ?? [];
        const title = typeof a['title'] === 'string' ? a['title'].trim() : '';
        if (!caps.includes('structure') || title === '') return false;
        this.regions?.set(
          (this.regions.get() ?? []).map((r) => (r.id === a['region'] ? { ...r, title } : r)),
        );
        this.#bump();
        return true;
      }
      case 'nextEditableRegion': {
        const next = this.#nextEditable();
        if (!next) return false;
        this.moveTo(
          { scope: `region:${next.id}`, caps: ['view', 'comment', 'suggest', 'edit'], limit: null },
          { scope: 'region', region: next.title },
        );
        return true;
      }
      case 'insertField':
        if (!this.#query1b('canInsertField')) return false;
        this.fields++;
        this.#bump();
        return true;
      case 'insertRecovered':
      case 'discardRecovered': {
        if (name === 'insertRecovered' && !this.#canChange()) return false;
        const items = this.recovered?.get().items ?? [];
        const rest = items.filter((item, i) => (item.id ?? String(i)) !== a['id']);
        if (rest.length === items.length) return false;
        this.recovered?.set({ count: rest.length, items: rest });
        if (name === 'insertRecovered') this.#bump();
        return true;
      }
      case 'finishFill':
        return true;
      default:
        return false;
    }
  }

  setMode(mode: EditorMode): boolean {
    this.#record('setMode', mode);
    if (!this.modes?.get().includes(mode)) return false;
    this.mode?.set(mode);
    this.revision.set(this.revision.get() + 1);
    return true;
  }

  setView(view: ViewName): boolean {
    this.#record('setView', view);
    if (!this.views?.get().includes(view)) return false;
    this.view?.set(view);
    return true;
  }

  setMarkupView(view: MarkupView): void {
    this.#record('setMarkupView', view);
    this.markupView?.set(view);
  }

  setSuggestionLabel(label: ((kind: 'ins' | 'del' | 'fmt', user: string) => string) | null): void {
    this.suggestionLabel = label;
  }

  setRegionLabels(labels: Readonly<Record<string, RegionLabel>>): void {
    this.regionLabels = labels;
  }

  selectBlock(id: string): boolean {
    this.#record('selectBlock', id);
    return id !== 'gone';
  }

  /** The block `changed` has changed after any `seq`; a block that is gone is unknown. */
  blockChangedSince(id: string, seq: number): boolean | null {
    this.#record('blockChangedSince', id, seq);
    return id === 'gone' ? null : id === 'changed';
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResults> {
    this.#record('search', query, options);
    const blocks = [
      ...this.outline.get().map((o) => ({ id: o.id, text: o.text })),
      { id: 'p1', text: 'Body text of the test document.' },
    ];
    const matches: SearchMatch[] = [];
    const needle = options.matchCase ? query : query.toLowerCase();
    for (const block of blocks) {
      const hay = options.matchCase ? block.text : block.text.toLowerCase();
      for (let i = hay.indexOf(needle); i >= 0 && needle; i = hay.indexOf(needle, i + 1))
        matches.push({
          index: matches.length,
          blockId: block.id,
          before: block.text.slice(Math.max(0, i - 12), i),
          text: block.text.slice(i, i + query.length),
          after: block.text.slice(i + query.length, i + query.length + 12),
        });
    }
    return { query, total: matches.length, matches };
  }

  selectMatch(match: SearchMatch): boolean {
    this.#record('selectMatch', match.index);
    return match.blockId !== 'gone';
  }

  caretRect(): ShellRect | null {
    const r = this.surface?.getBoundingClientRect();
    return r ? { x: r.x + 24, y: r.y + 8, width: 1, height: 18 } : null;
  }

  focusField(id: string): boolean {
    this.#record('focusField', id);
    return true;
  }

  /** The region guard refused a local change (the core's `refusal` view). */
  /** The findings `proofingStep` moves between, in document order (UX-041). */
  proofingFindings: ProofingFindingView[] = [];

  proofingStep(direction: 1 | -1 = 1): boolean {
    this.proofingCalls.push(`step:${String(direction)}`);
    const n = this.proofingFindings.length;
    if (!this.proofing || n === 0) return false;
    const at = this.proofingFindings.findIndex((f) => f.id === this.proofing?.get().current?.id);
    const next =
      this.proofingFindings[at < 0 ? (direction === 1 ? 0 : n - 1) : (at + direction + n) % n] ??
      null;
    this.proofing.set({ ...this.proofing.get(), current: next, atCaret: next });
    return true;
  }

  applyFinding(id: string, suggestion = 0): boolean {
    this.proofingCalls.push(`apply:${id}:${String(suggestion)}`);
    return true;
  }

  ignoreFinding(id: string, everywhere = false): boolean {
    this.proofingCalls.push(`${everywhere ? 'ignore-all' : 'ignore-once'}:${id}`);
    return true;
  }

  addFindingToDictionary(id: string): Promise<boolean> {
    this.proofingCalls.push(`add-word:${id}`);
    return Promise.resolve(true);
  }

  refuse(reason: string, scopes: readonly string[] = [], count?: number): void {
    const n = (this.refusal?.get()?.n ?? 0) + 1;
    this.refusal?.set({
      n,
      reason,
      scopes: [...scopes],
      ...(count === undefined ? {} : { count }),
    });
  }

  /** Work was set aside: a rejected commit or unsent work (the core's `recovered` view). */
  setAside(items: readonly RecoveredItem[]): void {
    const all = [...(this.recovered?.get().items ?? []), ...items];
    this.recovered?.set({ count: all.length, items: all });
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Whether content may be changed at the selection, as the region guard decides. */
  #canChange(): boolean {
    const access = this.access?.get();
    return !access || access.caps.includes('edit') || access.caps.includes('suggest');
  }

  query(name: string): boolean | undefined {
    this.queryCounts.set(name, (this.queryCounts.get(name) ?? 0) + 1);
    const marks = this.selection.get().marks;
    if (this.commandNames) {
      const answer = this.#query1b(name);
      if (answer !== undefined) return answer;
    }
    switch (name) {
      case 'canEditSelection':
        return this.#canChange();
      case 'canUndo':
        return this.undoDepth > 0;
      case 'canRedo':
        return this.redoDepth > 0;
      case 'isBold':
        return marks.includes('bold');
      case 'isItalic':
        return marks.includes('italic');
      case 'canInsertFootnote':
        return this.#canChange() && this.panel.get() === null;
      case 'hasHeader':
        return this.hasHeader;
      default:
        return undefined;
    }
  }

  setLabels(labels: CoreLabels): void {
    this.labels = labels;
    this.surface?.setAttribute('aria-label', labels.body);
  }

  #toggleMark(mark: string): boolean {
    if (!this.#canChange()) return false;
    const current = this.selection.get();
    const marks = current.marks.includes(mark)
      ? current.marks.filter((m) => m !== mark)
      : [...current.marks, mark].sort();
    this.selection.set({ ...current, marks });
    this.undoDepth++;
    this.revision.set(this.revision.get() + 1);
    return true;
  }

  run(command: CommandName): boolean {
    this.#record('run', command);
    switch (command) {
      case 'bold':
        return this.#toggleMark('bold');
      case 'italic':
        return this.#toggleMark('italic');
      case 'selectAll':
        return true;
      case 'undo':
        if (this.undoDepth === 0) return false;
        this.undoDepth--;
        this.redoDepth++;
        this.revision.set(this.revision.get() + 1);
        return true;
      case 'redo':
        if (this.redoDepth === 0) return false;
        this.redoDepth--;
        this.undoDepth++;
        this.revision.set(this.revision.get() + 1);
        return true;
      case 'insertFootnote':
        if (!this.#canChange()) return false;
        this.panel.set({ kind: 'footnote', id: 'fn1', label: 'Footnote' });
        return true;
      case 'editHeader':
        if (!this.hasHeader) return false;
        this.panel.set({ kind: 'story', id: 'header1', label: 'Header' });
        return true;
    }
  }

  closePanel(): void {
    this.#record('closePanel');
    this.panel.set(null);
    this.focus();
  }

  focus(): void {
    this.#record('focus');
    this.surface?.focus();
  }

  mountBody(target: HTMLElement): () => void {
    this.#record('mountBody');
    const surface = target.ownerDocument.createElement('div');
    surface.className = 'de-editing-surface';
    surface.contentEditable = 'true';
    surface.setAttribute('role', 'textbox');
    surface.setAttribute('aria-multiline', 'true');
    surface.setAttribute('aria-label', this.labels?.body ?? 'Document');
    // No `dir` of its own: like the engine's surface, it inherits the page's (`direction`, UX-065).
    const p = target.ownerDocument.createElement('p');
    p.textContent = 'Body text of the test document.';
    surface.append(p);
    target.append(surface);
    this.surface = surface;
    return () => {
      surface.remove();
      if (this.surface === surface) this.surface = null;
    };
  }

  mountPanel(target: HTMLElement): () => void {
    this.#record('mountPanel');
    const surface = target.ownerDocument.createElement('div');
    surface.className = 'de-sub-editor';
    surface.contentEditable = 'true';
    surface.setAttribute('role', 'textbox');
    surface.setAttribute('aria-label', this.labels?.footnote ?? 'Footnote text');
    target.append(surface);
    this.#panelSurface = surface;
    return () => {
      surface.remove();
      if (this.#panelSurface === surface) this.#panelSurface = null;
    };
  }

  /** Moves the caret into a scope with the given access (the core would publish both views). */
  moveTo(access: AccessSummary, selection: Partial<SelectionSummary> = {}): void {
    this.selection.set({ ...this.selection.get(), ...selection });
    this.access?.set(access);
  }
}
