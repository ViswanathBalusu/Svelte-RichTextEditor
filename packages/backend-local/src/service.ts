/**
 * The local backend (PRO-100; 05 §8.3): the mock service's authority and ports, with the log kept
 * in a store that outlives the page. There is no server and no synchronisation with one (A1): the
 * project's own authority package runs in the page and decides, as in `backend-mock`.
 *
 * Every tab runs its own rooms over one shared store. The store is the arbiter: a write is
 * conditional on the head it extends, so only one tab's commit takes each sequence number, and a
 * commit is acknowledged only once the store holds it. After a tab stores something it posts the
 * new head on a `BroadcastChannel`; the other tabs read the store, build the room again and let
 * each open channel resume where it was (04 §9), so the commit reaches their editors in order.
 */
import type { StoredCommit, WriteRequest, WriteResult } from '@docedit/authority';
import {
  MockDocument,
  MockService,
  packPerms,
  type DocumentHooks,
  type DocumentPersistence,
  type GrantSpec,
  type MockServiceOptions,
  type RestoredDocument,
  type SegmentRecord,
} from '@docedit/backend-mock';
import type { CdmEnvelope } from '@docedit/model';
import type { PermissionState } from '@docedit/authority';
import type { LocalStore } from './store.ts';

export interface LocalServiceOptions extends MockServiceOptions {
  /**
   * The channel that tells other tabs about stored commits. Default: a `BroadcastChannel` named
   * `docedit-local`, when the page has one. Without any, tabs do not follow each other.
   */
  channel?: BroadcastChannel | null;
  /** Used when `channel` is absent: the name of the default channel. */
  channelName?: string;
}

/** What one tab tells the others. */
interface HeadMessage {
  doc: string;
  head: number;
}

/** The calls of one document to the store, in the order they were made. */
class DocumentStore implements DocumentPersistence {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly service: LocalService;
  private readonly store: LocalStore;
  private readonly id: string;

  constructor(service: LocalService, store: LocalStore, id: string) {
    this.service = service;
    this.store = store;
    this.id = id;
  }

  /** Runs `f` after every earlier call, whether or not it succeeded. */
  enqueue<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Resolves when every call made so far has finished. */
  settled(): Promise<unknown> {
    return this.chain;
  }

  append(segment: number, offset: number, req: WriteRequest): Promise<WriteResult> {
    return this.enqueue(async () => {
      const result = await this.store.append(this.id, segment, offset, req);
      if (result.status === 'ok') this.service.announce(this.id, req.commits);
      return result;
    });
  }

  addSegment(segment: SegmentRecord, expectHead: number): Promise<boolean> {
    return this.enqueue(async () => {
      const ok = await this.store.addSegment(this.id, segment, expectHead);
      if (ok) this.service.announce(this.id, []);
      return ok;
    });
  }

  putPerms(perms: PermissionState): Promise<boolean> {
    return this.enqueue(async () => {
      const ok = await this.store.putPerms(this.id, packPerms(perms));
      if (ok) this.service.announce(this.id, []);
      return ok;
    });
  }

  stale(): void {
    this.service.follow(this.id);
  }
}

export class LocalService extends MockService {
  private readonly store: LocalStore;
  private readonly channel: BroadcastChannel | null;
  private readonly adapters = new Map<string, DocumentStore>();
  private readonly following = new Map<string, Promise<void>>();
  private closed = false;

  private constructor(store: LocalStore, opts: LocalServiceOptions) {
    super(opts);
    this.store = store;
    const channel =
      opts.channel !== undefined
        ? opts.channel
        : typeof BroadcastChannel === 'function'
          ? new BroadcastChannel(opts.channelName ?? 'docedit-local')
          : null;
    this.channel = channel;
    if (channel)
      channel.onmessage = (e: MessageEvent<HeadMessage>) => {
        if (e.data && typeof e.data.doc === 'string') this.follow(e.data.doc);
      };
  }

  /** Opens the service on a store and loads the documents it holds. */
  static async open(store: LocalStore, opts: LocalServiceOptions = {}): Promise<LocalService> {
    const service = new LocalService(store, opts);
    for (const id of await store.list()) await service.load(id);
    return service;
  }

  protected override hooks(docId: string): DocumentHooks {
    let adapter = this.adapters.get(docId);
    if (!adapter) {
      adapter = new DocumentStore(this, this.store, docId);
      this.adapters.set(docId, adapter);
    }
    return { ...super.hooks(docId), persist: adapter };
  }

  /** Creates a document and stores it; the call returns once the store holds it. */
  async create(
    content: CdmEnvelope,
    opts: { grants?: readonly GrantSpec[]; id?: string } = {},
  ): Promise<string> {
    const id = this.createDocument(content, opts);
    await this.flush();
    return id;
  }

  override createDocument(
    content: CdmEnvelope,
    opts: { grants?: readonly GrantSpec[]; id?: string } = {},
  ): string {
    const id = super.createDocument(content, opts);
    const doc = this.docs.get(id)!;
    const record = doc.toRecord();
    void this.adapters.get(id)!.enqueue(async () => {
      if (await this.store.create(record)) this.announce(id, []);
    });
    return id;
  }

  /** `PUT /documents/{id}/content` for a store: waits for the writes in flight, then replaces. */
  async replace(docId: string, content: CdmEnvelope): Promise<void> {
    await this.document(docId)?.drain();
    this.replaceContent(docId, content);
    await this.flush();
  }

  /** Resolves when everything this service has asked of the store is stored. */
  async flush(): Promise<void> {
    for (;;) {
      for (const [id, doc] of this.docs) {
        await doc.drain();
        await this.adapters.get(id)?.settled();
      }
      const quiet = [...this.docs.values()].every((d) => d.quiet);
      if (quiet) return;
    }
  }

  /** Reads a document from the store into this service, when it is not loaded yet. */
  private async load(id: string): Promise<void> {
    if (this.docs.has(id)) return;
    const restored = await this.store.read(id);
    if (!restored) return;
    const first = restored.record.segments[0]!;
    const content = {
      cdm: 1,
      requires: first.requires,
      doc: first.initial,
    } as unknown as CdmEnvelope;
    this.docs.set(id, new MockDocument(id, content, [], this.hooks(id), restored));
  }

  /** Tells the other tabs that the store moved. */
  announce(docId: string, commits: readonly StoredCommit[]): void {
    if (!this.channel || this.closed) return;
    const last = commits[commits.length - 1];
    this.channel.postMessage({ doc: docId, head: last?.seq ?? 0 } satisfies HeadMessage);
  }

  /**
   * Brings a document up to what the store holds: after another tab stored something, or after
   * this tab's own write found the store ahead. One run at a time per document.
   */
  follow(docId: string): Promise<void> {
    const prev = this.following.get(docId) ?? Promise.resolve();
    const next = prev.then(() => this.catchUp(docId)).catch(() => undefined);
    this.following.set(docId, next);
    return next;
  }

  /** Resolves when every `follow` asked for so far has run. */
  async settle(): Promise<void> {
    await Promise.all([...this.following.values()]);
  }

  private async catchUp(docId: string): Promise<void> {
    if (this.closed) return;
    const doc = this.docs.get(docId);
    if (!doc) return void (await this.load(docId));
    for (let attempt = 0; attempt < 5; attempt++) {
      await doc.drain();
      const restored: RestoredDocument | undefined = await this.store.read(docId);
      if (!restored) return;
      if (!doc.quiet) continue;
      const now = doc.toRecord();
      if (
        restored.record.head === now.head &&
        restored.record.perms.revision === now.perms.revision &&
        restored.record.segments.length === now.segments.length
      )
        return;
      doc.adopt(restored);
      return;
    }
  }

  override async dispose(): Promise<void> {
    await this.flush();
    await this.settle();
    this.closed = true;
    await super.dispose();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.store.close();
  }
}
