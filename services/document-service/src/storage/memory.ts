/**
 * The storage ports in process (BE-002; PRM-002): the same conditions and the same outcomes as
 * the PostgreSQL stores, without a database. The contract suites in test/contract run against
 * both, so a deployment can swap one for the other, or for a policy engine behind GrantStore,
 * without touching rooms.
 */
import type { LogCommit, PermissionState, WriteRequest, WriteResult } from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { chainHash, encodeCommit } from './codec.ts';
import { isUuid } from './ids.ts';
import {
  DocumentNotFoundError,
  DuplicateExternalIdError,
  RetiredRegionError,
  RevisionConflictError,
  type AppendOptions,
  type ChangeOptions,
  type DocRef,
  type DocumentChangeOptions,
  type DocumentPatch,
  type DocumentQuery,
  type DocumentRecord,
  type DocumentStore,
  type GrantStore,
  type HeadState,
  type LogHead,
  type LogStore,
  type NewDocument,
  type OwnershipStore,
  type PermissionChange,
} from './types.ts';

interface MemoryDocument {
  record: Omit<DocumentRecord, 'head' | 'state'>;
  log: LogCommit[];
  /** The content of each stored snapshot commit, by `seq` (packet A, phase 1b; BE-037). */
  snapshots?: Map<number, JsonEnvelope>;
  epoch: number;
  owner: string | null;
  perms: PermissionState;
  history: PermissionState[];
  retired: Map<string, number>;
}

const clone = <T>(v: T): T => structuredClone(v);

function withoutRegions(p: PermissionState, regions: ReadonlySet<string>): PermissionState {
  return {
    ...p,
    grants: p.grants.filter((g) => !regions.has(g.region)),
    regionStates: new Map([...p.regionStates].filter(([r]) => !regions.has(r))),
    ...(p.approvals
      ? { approvals: new Map([...p.approvals].filter(([r]) => !regions.has(r))) }
      : {}),
    leases: p.leases.filter((l) => !regions.has(l.region)),
  };
}

function applyChange(p: PermissionState, c: PermissionChange, revision: number): PermissionState {
  const key = (g: { region: string; principal: string }) => `${g.region}\u0000${g.principal}`;
  const grants = new Map(p.grants.map((g) => [key(g), g]));
  for (const g of c.removeGrants ?? []) grants.delete(key(g));
  for (const g of c.putGrants ?? []) grants.set(key(g), { ...g });
  const states = new Map(p.regionStates);
  const approvals = new Map(p.approvals ?? []);
  for (const r of c.clearRegionStates ?? []) {
    states.delete(r);
    approvals.delete(r);
  }
  // As in PostgreSQL: a state with no binding clears the approval of its region (PRM-046).
  for (const s of c.setRegionStates ?? []) {
    states.set(s.region, s.state);
    if (s.approval) approvals.set(s.region, { ...s.approval });
    else approvals.delete(s.region);
  }
  const leases = new Map(p.leases.map((l) => [l.region, l]));
  for (const r of c.removeLeases ?? []) leases.delete(r);
  // As in PostgreSQL (06 §4.1: lease_id and acquired_at are not null): a lease keeps the id and
  // acquisition time it is given, and one put without them gets a fresh id and the current time.
  for (const l of c.putLeases ?? [])
    leases.set(l.region, { ...l, id: l.id ?? uuid7(), acquiredAt: l.acquiredAt ?? Date.now() });
  const byRegion = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    revision,
    grants: [...grants.entries()].sort(byRegion).map(([, g]) => g),
    regionStates: new Map([...states.entries()].sort(byRegion)),
    ...(approvals.size ? { approvals: new Map([...approvals.entries()].sort(byRegion)) } : {}),
    leases: [...leases.entries()].sort(byRegion).map(([, l]) => l),
    documentState: c.documentState ?? p.documentState,
    workflowActive: c.workflowActive ?? p.workflowActive,
  };
}

export class MemoryStore implements LogStore, OwnershipStore, GrantStore, DocumentStore {
  readonly #docs = new Map<string, MemoryDocument>();

  #find(ref: DocRef): MemoryDocument | undefined {
    const d = this.#docs.get(ref.doc);
    // Another tenant's document is invisible, as row-level security makes it in PostgreSQL.
    return d && d.record.tenant === ref.tenant ? d : undefined;
  }

  #get(ref: DocRef): MemoryDocument {
    const d = this.#find(ref);
    if (!d) throw new DocumentNotFoundError(`no document ${ref.doc}`);
    return d;
  }

  async create(tenant: string, input: NewDocument): Promise<DocumentRecord> {
    const id = input.id ?? uuid7();
    if (!isUuid(id) || !isUuid(tenant)) throw new TypeError('document and tenant must be UUIDs');
    if (this.#docs.has(id)) throw new Error(`document ${id} exists`);
    // unique (tenant_id, external_id), as in PostgreSQL (packet A2, BE-035).
    if (
      input.externalId !== undefined &&
      [...this.#docs.values()].some(
        (x) => x.record.tenant === tenant && x.record.externalId === input.externalId,
      )
    )
      throw new DuplicateExternalIdError('another document of the tenant has this externalId');
    const p = input.permissions;
    const perms = applyChange(
      {
        revision: 0,
        grants: [],
        regionStates: new Map(),
        leases: [],
        documentState: 'active',
        workflowActive: false,
      },
      {
        putGrants: p?.grants ?? [],
        setRegionStates: [...(p?.regionStates ?? new Map())].map(([region, state]) => ({
          region,
          state,
        })),
        putLeases: p?.leases ?? [],
        documentState: p?.documentState ?? 'active',
        workflowActive: p?.workflowActive ?? false,
      },
      p?.revision ?? 1,
    );
    const doc: MemoryDocument = {
      record: {
        id,
        tenant,
        externalId: input.externalId ?? null,
        title: input.title ?? null,
        cdmVersion: input.cdmVersion,
        requires: [...(input.requires ?? [])],
        historyVisibility: 'editors',
        createdBy: input.createdBy,
        createdAt: Date.now(),
        incarnation: crypto.randomUUID(),
        properties: clone({ ...(input.properties ?? {}) }),
        label: input.label ?? null,
        deletedAt: null,
        metaRevision: 1,
        forkedFrom: input.fork?.from ?? null,
        forkedAtSeq: input.fork?.atSeq ?? null,
      },
      log: [],
      epoch: 0,
      owner: null,
      perms,
      history: [perms],
      retired: new Map(),
    };
    this.#docs.set(id, doc);
    return this.#record(doc);
  }

  #record(d: MemoryDocument): DocumentRecord {
    return clone({ ...d.record, state: d.perms.documentState, head: d.log.length });
  }

  async get(ref: DocRef): Promise<DocumentRecord | null> {
    const d = this.#find(ref);
    return d ? this.#record(d) : null;
  }

  // Document metadata (packet A2, BE-035): the same conditions as PgDocumentStore.

  async list(tenant: string, query: DocumentQuery): Promise<DocumentRecord[]> {
    return [...this.#docs.values()]
      .filter(
        (d) =>
          d.record.tenant === tenant &&
          d.record.deletedAt === null &&
          (query.externalId === undefined || d.record.externalId === query.externalId) &&
          (query.after === undefined || d.record.id > query.after),
      )
      .sort((a, b) => (a.record.id < b.record.id ? -1 : 1))
      .slice(0, query.limit)
      .map((d) => this.#record(d));
  }

  async update(
    ref: DocRef,
    patch: DocumentPatch,
    opts: DocumentChangeOptions,
  ): Promise<{ record: DocumentRecord; perms: PermissionState | null }> {
    const d = this.#live(ref, opts);
    if (patch.title !== undefined) d.record.title = patch.title;
    if (patch.properties !== undefined) d.record.properties = clone({ ...patch.properties });
    if (patch.label !== undefined) d.record.label = patch.label;
    d.record.metaRevision++;
    let perms: PermissionState | null = null;
    if (patch.state !== undefined && patch.state !== d.perms.documentState) {
      d.perms = applyChange(d.perms, { documentState: patch.state }, d.perms.revision + 1);
      d.history.push(d.perms);
      perms = clone(d.perms);
    }
    return { record: this.#record(d), perms };
  }

  async remove(ref: DocRef, opts: DocumentChangeOptions): Promise<DocumentRecord> {
    const d = this.#live(ref, opts);
    d.record.deletedAt = Date.now();
    d.record.metaRevision++;
    return this.#record(d);
  }

  /** A document that is not deleted, at the metadata revision the caller names. */
  #live(ref: DocRef, opts: DocumentChangeOptions): MemoryDocument {
    const d = this.#find(ref);
    if (!d || d.record.deletedAt !== null)
      throw new DocumentNotFoundError(`no document ${ref.doc}`);
    if (opts.ifMetaRevision !== undefined && opts.ifMetaRevision !== d.record.metaRevision)
      throw new RevisionConflictError(
        `the metadata revision is ${d.record.metaRevision}, not ${opts.ifMetaRevision}`,
        d.record.metaRevision,
      );
    return d;
  }

  async append(ref: DocRef, req: WriteRequest, options: AppendOptions = {}): Promise<WriteResult> {
    const d = this.#find(ref);
    if (!d || req.epoch !== d.epoch || req.fromSeq !== d.log.length + 1)
      return { status: 'fenced' };
    if (req.revision !== d.perms.revision)
      return { status: 'revision_moved', perms: clone(d.perms) };
    const snap = req.snapshot;
    if (
      snap &&
      (!options.snapshot || snap.snapshot.checkpoint !== `sha256:${options.snapshot.hash}`)
    )
      throw new TypeError('a snapshot commit needs its content');
    // A test fault (BE-079) at the points PgLogStore has: before anything is inserted, so that not
    // even a duplicate identifier is noticed, or after the inserts, which are then undone.
    if (options.fault === 'before-insert') return { status: 'failed' };
    const undo = {
      length: d.log.length,
      perms: d.perms,
      retired: new Map(d.retired),
      snapshot: snap?.seq,
    };
    const result = this.#insert(d, req, options);
    if (options.fault === 'after-insert' && result.status === 'ok') {
      d.log.length = undo.length;
      d.perms = undo.perms;
      d.retired = undo.retired;
      if (undo.snapshot !== undefined) d.snapshots?.delete(undo.snapshot);
      return { status: 'failed' };
    }
    return result;
  }

  /** The inserts of `append`, once the conditions held. */
  #insert(d: MemoryDocument, req: WriteRequest, options: AppendOptions): WriteResult {
    // A conflict on the commit identifier alone is a duplicate submission, never another writer
    // (06 §2.3; BE-025): nothing is stored and the stored commit is returned (as PgLogStore does).
    const stored = new Map(d.log.map((c) => [c.id, c]));
    // A snapshot commit is written alone, with its content (packet A, phase 1b; BE-037).
    const snap = req.snapshot;
    if (snap && options.snapshot) {
      const prior = stored.get(snap.id);
      if (prior) return { status: 'duplicate', stored: clone(prior) };
      d.log.push(clone({ ...snap, scopes: [...snap.scopes].sort() }));
      (d.snapshots ??= new Map()).set(snap.seq, clone(options.snapshot.envelope));
      const gone = new Set(snap.retired);
      for (const r of gone) if (!d.retired.has(r)) d.retired.set(r, snap.seq);
      if (gone.size) d.perms = withoutRegions(d.perms, gone);
      return { status: 'ok' };
    }
    const ids = new Set<string>();
    for (const c of req.commits) {
      const prior = stored.get(c.id);
      if (prior) return { status: 'duplicate', stored: clone(prior) };
      if (ids.has(c.id)) return { status: 'failed' };
      ids.add(c.id);
    }
    const retired = new Set<string>();
    for (const c of req.commits) {
      d.log.push(clone({ ...c, scopes: [...c.scopes].sort() }));
      for (const r of c.retired) {
        if (!d.retired.has(r)) d.retired.set(r, c.seq);
        retired.add(r);
      }
    }
    if (retired.size) d.perms = withoutRegions(d.perms, retired);
    return { status: 'ok' };
  }

  async read(ref: DocRef, fromSeq = 1, toSeq?: number): Promise<LogCommit[]> {
    const d = this.#find(ref);
    if (!d) return [];
    return clone(d.log.filter((c) => c.seq >= fromSeq && (toSeq === undefined || c.seq <= toSeq)));
  }

  /** The stored commit with this identifier, as PgLogStore.byId finds it (BE-039). */
  async byId(ref: DocRef, id: string): Promise<LogCommit | null> {
    const c = this.#find(ref)?.log.find((x) => x.id === id);
    return c ? clone(c) : null;
  }

  /** The content a stored snapshot commit brought (packet A, phase 1b; BE-037). */
  async snapshotContent(ref: DocRef, seq: number): Promise<JsonEnvelope | null> {
    const c = this.#find(ref)?.snapshots?.get(seq);
    return c ? clone(c) : null;
  }

  /** Gives the log a new incarnation, as PgLogStore.newIncarnation does (BE-078). */
  async newIncarnation(ref: DocRef, incarnation: string): Promise<{ before: string }> {
    const d = this.#get(ref);
    const before = d.record.incarnation;
    d.record.incarnation = incarnation;
    return { before };
  }

  /**
   * Rewinds the log to `head`, as a database restored to an earlier point would leave it (BE-078
   * tests only). Nothing else changes: the incarnation stays until the operator procedure runs.
   */
  rewindForTest(ref: DocRef, head: number): void {
    const d = this.#get(ref);
    d.log = d.log.filter((c) => c.seq <= head);
    for (const s of [...(d.snapshots?.keys() ?? [])]) if (s > head) d.snapshots!.delete(s);
  }

  async head(ref: DocRef): Promise<LogHead> {
    const d = this.#get(ref);
    return {
      seq: d.log.length,
      epoch: d.epoch,
      owner: d.owner,
      incarnation: d.record.incarnation,
    };
  }

  /**
   * The head with the chain head (BE-079 criterion 4), the hash PgLogStore stores with the head:
   * each commit encoded as it is written (codec.ts) and chained from the first. It is computed from
   * the log when asked, so it cannot drift from what the log holds.
   */
  async state(ref: DocRef): Promise<HeadState> {
    const head = await this.head(ref);
    let prev: Buffer | null = null;
    for (const c of this.#get(ref).log) {
      const e = encodeCommit(ref.doc, c);
      prev = chainHash(prev, e.metaBytes, e.payloadHash);
    }
    return { ...head, chainHead: prev ? prev.toString('hex') : null };
  }

  async claim(ref: DocRef, node: string): Promise<number> {
    const d = this.#get(ref);
    d.epoch++;
    d.owner = node;
    return d.epoch;
  }

  async release(ref: DocRef, node: string, epoch: number): Promise<boolean> {
    const d = this.#get(ref);
    if (d.owner !== node || d.epoch !== epoch) return false;
    d.owner = null;
    return true;
  }

  async current(ref: DocRef): Promise<PermissionState> {
    return clone(this.#get(ref).perms);
  }

  async at(ref: DocRef, revision: number): Promise<PermissionState | null> {
    const p = this.#get(ref).history.find((h) => h.revision === revision);
    return p ? clone(p) : null;
  }

  async history(ref: DocRef): Promise<PermissionState[]> {
    return clone(this.#get(ref).history);
  }

  async retired(ref: DocRef): Promise<string[]> {
    return [...this.#get(ref).retired.keys()].sort();
  }

  /** Each retired region with the `seq` of the commit that retired it (07 §3; PRM-003). */
  async retiredSeqs(ref: DocRef): Promise<Map<string, number>> {
    return new Map([...this.#get(ref).retired].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  async change(
    ref: DocRef,
    change: PermissionChange,
    opts: ChangeOptions,
  ): Promise<PermissionState> {
    const d = this.#get(ref);
    if (opts.ifRevision !== undefined && opts.ifRevision !== d.perms.revision)
      throw new RevisionConflictError(
        `the grants revision is ${d.perms.revision}, not ${opts.ifRevision}`,
        d.perms.revision,
      );
    const touched = [
      ...(change.putGrants ?? []).map((g) => g.region),
      ...(change.setRegionStates ?? []).map((s) => s.region),
      ...(change.putLeases ?? []).map((l) => l.region),
    ];
    const bad = touched.find((r) => d.retired.has(r));
    if (bad) throw new RetiredRegionError(`region ${bad} is retired`);
    d.perms = applyChange(d.perms, change, d.perms.revision + 1);
    d.history.push(d.perms);
    return clone(d.perms);
  }
}
