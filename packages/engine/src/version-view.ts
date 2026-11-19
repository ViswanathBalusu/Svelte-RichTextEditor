/**
 * An old version as a second, read-only editor state (HIS-010; 08 §1, §5; 02 §7).
 *
 * The state is made from a pinned read of the content (`GET /content?seq=N`, which is immutable and
 * content-addressed, 05 §6.2) and is never attached to a channel: it holds no sync client, so no
 * commit can leave it. Its mode is `view`, which refuses every change (FE-029), and the object
 * shows no way to attach a channel or to reach the live document. The live document is another
 * `DocumentCore`; the two share nothing, so commits that arrive for the live one do not touch this
 * state and the reverse (criterion 2).
 *
 * `openVersion` is the one place that reads the content. It uses `loadContent(docId, seq)` of the
 * sync port. A version below the caller's visibility gate is refused by the service with
 * `forbidden` (HIS-024); the refusal comes back as a value and nothing is opened (criterion 5).
 *
 * Universal code: no Node.js or browser API. The web view adds `mount` in `view/version-web.ts`.
 */
import type { CommentsPort, SyncPort } from '@docedit/protocol';
import type {
  CdmEnvelope,
  CommandArgs,
  CommandName,
  ConnectionState,
  OutlineItem,
  StatusSummary,
} from './api.ts';
import { DocumentCore, type CoreConfig } from './core.ts';

/** What a version needs to be opened: the pinned content and what names it. */
export interface VersionInput {
  /** The sequence number the content was read at. */
  readonly seq: number;
  /** The document as a pinned read returned it. */
  readonly content: CdmEnvelope;
  /** When the version was made (ISO 8601, from the version or the commit); the view names it. */
  readonly time: string;
  /** The version's name, when it is a named version. */
  readonly name?: string | null;
  /**
   * The comment ranges at this `seq` (HIS-010 criterion 4; owner decision 81): the service maps each
   * thread's range through the commits up to the `seq` (`GET /threads?seq=`), so they are in the
   * positions of that time. A thread made after the `seq` is not in the list. Absent when the host
   * has no comments port or the read failed; the version then shows no comment ranges.
   */
  readonly comments?: readonly VersionThreadRange[] | null;
}

/** A thread's range in the document of a version. `from` equals `to` when its text was deleted by then. */
export interface VersionThreadRange {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

/** The core options a version view may take from the live editor (never `doc`, `mode` or `access`). */
export type VersionCoreOptions = Pick<
  CoreConfig,
  'schedule' | 'fontAlias' | 'assetImage' | 'drawEquation' | 'generateId'
>;

/** The reasons a version cannot be opened, as the service gives them (05 §5.8). */
export type VersionRefusal = 'forbidden' | 'not_found' | 'failed';

export type VersionOpen =
  | { readonly ok: true; readonly version: VersionDocument }
  | { readonly ok: false; readonly reason: VersionRefusal };

/** The core configuration of a version: view mode, no access object, no user, no channel. */
export function versionCoreConfig(
  input: VersionInput,
  options: VersionCoreOptions = {},
): CoreConfig {
  return { ...options, doc: input.content, mode: 'view', access: null };
}

/** A version held as a read-only state (headless; the web view extends it). */
export class VersionDocument {
  readonly seq: number;
  readonly time: string;
  readonly name: string | null;
  /** Whether the comment ranges of this `seq` were read and are drawn (criterion 4). */
  readonly commentsShown: boolean;
  /** Always true: no command changes this state. */
  readonly readOnly = true as const;
  protected readonly core: DocumentCore;
  #destroyed = false;

  constructor(input: VersionInput, core: DocumentCore) {
    this.seq = input.seq;
    this.time = input.time;
    this.name = input.name ?? null;
    this.commentsShown = input.comments !== undefined && input.comments !== null;
    this.core = core;
    // The ranges are those of this `seq`, so they are set as they stand: no mapping is needed.
    for (const t of input.comments ?? [])
      core.setThreadRange(t.id, { from: t.from, to: t.to }, input.seq);
  }

  /** Opens a version in a core of its own, without a view. */
  static create(input: VersionInput, options: VersionCoreOptions = {}): VersionDocument {
    return new VersionDocument(input, new DocumentCore(versionCoreConfig(input, options)));
  }

  /**
   * The state of the channel: always `detached`. A version is never connected to the live channel
   * and the object has no `attach`.
   */
  connection(): ConnectionState {
    return this.core.connection.get();
  }

  /**
   * The comment ranges of the version, in its positions (criterion 4). A range whose text was
   * deleted by this `seq` is `detached`. Empty when `commentsShown` is false.
   */
  commentRanges(): readonly {
    readonly id: string;
    readonly from: number;
    readonly to: number;
    readonly detached: boolean;
  }[] {
    return this.core.threadRanges.get().map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      detached: r.detached,
    }));
  }

  /**
   * Runs a command; every one is refused (false) because the mode is `view`. Commands that only
   * move the selection or find text are not offered here; the shell asks `queryCommand` first.
   */
  run(name: CommandName, args?: CommandArgs): boolean {
    if (this.#destroyed) return false;
    return this.core.run(name, args);
  }

  /** The document of the version, as the envelope of a read. */
  content(): CdmEnvelope {
    return this.core.getContent();
  }

  /** The headings, for a reader who moves around the version. */
  outline(): readonly OutlineItem[] {
    return this.core.outline.get();
  }

  status(): StatusSummary {
    return this.core.status.get();
  }

  /** Steps and commits this state holds that were not confirmed: always none, because it never submits. */
  unsent(): number {
    const s = this.core.syncSnapshot();
    return s.queue.length + (s.inflight === null ? 0 : 1);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.core.destroy();
  }
}

/** What the host passes to open versions: the read, and what the live editor shares. */
export interface VersionOpener {
  /** The sync port of the document; only `loadContent` is used, with a `seq` (a pinned read). */
  readonly sync: Pick<SyncPort, 'loadContent'>;
  readonly docId: string;
  readonly options?: VersionCoreOptions;
  /**
   * The comments port; only `threads` is used, with a `seq`, so that the version shows the comment
   * ranges of that time (HIS-010 criterion 4). Without it, or when the read fails, none are shown.
   */
  readonly comments?: Pick<CommentsPort, 'threads'>;
  /** Builds the state; the web view passes its own constructor so the version can be mounted. */
  readonly make?: (input: VersionInput, options: VersionCoreOptions) => VersionDocument;
}

/**
 * The refusal code of a failed read: a `PortError` carries `code`; anything else is `failed`.
 * `forbidden` means the version is below the gate (07 §8); `not_found` that it does not exist.
 */
export function refusalOf(error: unknown): VersionRefusal {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'forbidden') return 'forbidden';
  if (code === 'not_found') return 'not_found';
  return 'failed';
}

/**
 * Opens the document at `seq` as a read-only state (HIS-010 criterion 1). The content is a pinned
 * read; the version is never attached to a channel. `time` and `name` come from the pane's item.
 */
export async function openVersion(
  opener: VersionOpener,
  seq: number,
  label: {
    readonly time: string;
    readonly name?: string | null;
  },
): Promise<VersionOpen> {
  let read;
  try {
    read = await opener.sync.loadContent(opener.docId, seq);
  } catch (error) {
    return { ok: false, reason: refusalOf(error) };
  }
  // A pinned read answers for the `seq` asked: another one is a fault, not a version.
  if (read.seq !== seq) return { ok: false, reason: 'failed' };
  const input: VersionInput = {
    seq,
    content: { cdm: read.cdm, requires: [...read.requires], doc: read.doc },
    time: label.time,
    name: label.name ?? null,
    comments: opener.comments ? await threadRangesAt(opener.comments, opener.docId, seq) : null,
  };
  const options = opener.options ?? {};
  try {
    const version = opener.make
      ? opener.make(input, options)
      : VersionDocument.create(input, options);
    return { ok: true, version };
  } catch {
    // A document this build cannot open (03 §2) is not a version it can show.
    return { ok: false, reason: 'failed' };
  }
}

/** The most pages of threads one version reads; a document with more shows the ranges of these. */
const THREAD_PAGES_MAX = 20;

/**
 * The comment ranges at `seq` (`GET /threads?seq=`, ranges mapped to that seq by the service),
 * or null when the read failed: a version without its comments is still a version (HIS-010
 * criterion 4). Block threads have no range and are left out; a service that has no comments
 * (`not_found`) or refuses them leaves the version without ranges.
 */
async function threadRangesAt(
  comments: Pick<CommentsPort, 'threads'>,
  docId: string,
  seq: number,
): Promise<readonly VersionThreadRange[] | null> {
  const out: VersionThreadRange[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < THREAD_PAGES_MAX; page++) {
      const r = await comments.threads(docId, cursor === undefined ? { seq } : { seq, cursor });
      for (const t of r.items) {
        const target = t.target;
        if (target && 'range' in target)
          out.push({ id: t.id, from: target.range.from, to: target.range.to });
      }
      if (r.nextCursor === null) return out;
      cursor = r.nextCursor;
    }
    return out;
  } catch {
    return null;
  }
}
