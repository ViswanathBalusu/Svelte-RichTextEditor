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
import type { SyncPort } from '@docedit/protocol';
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
   * The `seq` of the checkpoint the comment ranges come from (HIS-010 criterion 4), when the host
   * has one. Between checkpoints the ranges are those of the nearest earlier one.
   */
  readonly checkpointSeq?: number | null;
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
  readonly checkpointSeq: number | null;
  /** Always true: no command changes this state. */
  readonly readOnly = true as const;
  protected readonly core: DocumentCore;
  #destroyed = false;

  constructor(input: VersionInput, core: DocumentCore) {
    this.seq = input.seq;
    this.time = input.time;
    this.name = input.name ?? null;
    this.checkpointSeq = input.checkpointSeq ?? null;
    this.core = core;
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

  /** Whether the comment ranges are those of an earlier checkpoint, not of this exact `seq` (criterion 4). */
  get approximateComments(): boolean {
    return this.checkpointSeq === null || this.checkpointSeq < this.seq;
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
    readonly checkpointSeq?: number | null;
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
    checkpointSeq: label.checkpointSeq ?? null,
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
