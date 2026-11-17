/**
 * What every route module of the control plane shares: its dependencies, and the helpers that
 * resolve a document of the caller's tenant, map surrogates to `sub` values, read the content at
 * the head as the caller may see it, and raise events. Each module of routes (handlers.ts and the
 * `*-routes.ts` files) builds its handlers from one kit.
 */
import { parsePrincipal, type PermissionState } from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import type { AuditStore, OutboxStore } from '../storage/types.ts';
import type { ReadMarkerStore } from '../storage/read-markers.ts';
import type { ThreadStore } from '../storage/thread-store.ts';
import type { VersionStorePort } from '../storage/versions-memory.ts';
import type { DataPlane, RoomNotifier } from '../seams.ts';
import {
  DocumentNotFoundError,
  DuplicateExternalIdError,
  RetiredRegionError,
  RevisionConflictError,
  type AssetStore,
  type CheckpointStore,
  type DocRef,
  type DocumentRecord,
  type DocumentStore,
  type GrantStore,
  type LogStore,
} from '../storage/types.ts';
import type { AssetRegistry, AssetUploads } from './assets.ts';
import type { ContentReader } from './content.ts';
import type { EventSink } from './events.ts';
import {
  CHANGE_WINDOW_MS,
  DOCUMENT_CHANGED,
  DebouncedEventSink,
  DocumentChangeDebounce,
} from './event-throttle.ts';
import type { ExportPolicy, NotifyFn } from './exports.ts';
import type { FontCatalogue } from './fonts.ts';
import type { Cursors } from './http.ts';
import type { WebhookSubscriptions } from './webhook-subscriptions.ts';
import type { RetentionService } from './retention.ts';
import type { HoldService } from './holds.ts';
import type { QuotaAdminService } from './quota-admin.ts';
import type { TenantRegistry } from './tenants.ts';
import type { SearchHit, SearchQuery } from './search-index.ts';
import type { CompileBudget } from './exp-009-compile-budget.ts';
import type { PolicyHookGate } from './policy-hook-client.ts';
import type { JobQueue } from './jobs/queue.ts';
import type { TenantMeter } from './metrics.ts';
import type { PinnedCache } from './pinned-cache.ts';
import type { Ctx, Reply } from './pipeline.ts';
import type { ReadRouter, ReadSession, ReadSessions, ReadStores } from './read-routing.ts';
import { ApiError } from './problems.ts';
import type { TokenService } from './tokens.ts';
import type { UserDirectory } from './users.ts';
import type { Views } from './visibility.ts';

export interface HandlerDeps {
  documents: DocumentStore;
  grants: GrantStore;
  logs: LogStore;
  checkpoints: CheckpointStore;
  assets: AssetStore;
  users: UserDirectory;
  tokens: TokenService;
  queue: JobQueue;
  content: ContentReader;
  views: Views;
  events: EventSink;
  notifier: RoomNotifier;
  /** The data plane's hooks and reads, when it offers them (seams.ts). */
  dataPlane?: Pick<
    DataPlane,
    'sessionsRevoked' | 'readContent' | 'replaceContent' | 'readCommits' | 'notify'
  >;
  /** The public base URL of the endpoint, for example `https://docs.example.com`. */
  publicUrl: string;
  restPath: string;
  wsPath: string;
  features: readonly string[];
  /** Export targets the worker supports (PRO-063 criterion 3). */
  exportTargets: readonly string[];
  /** Lifetime of signed URLs, ms (10 §3.7 "short-lived"; a setting). */
  signedUrlMs: number;
  cursors: Cursors;
  now: () => number;
  /** Called after a job is queued, so that an in-process runner starts at once. */
  onJobQueued?: () => void;
  // --- Phase 1b (packet C). ----------------------------------------------------------------------
  /** The `assets` rows (PRO-061, PRO-062). */
  assetRegistry?: AssetRegistry;
  /** The asset worker's upload checks, pre-signed uploads and signed URLs; absent: no assets. */
  uploads?: AssetUploads | null;
  /** Lifetime of a pre-signed upload, seconds (a setting). */
  uploadSeconds?: number;
  /** The font set (PRO-067, BE-047). */
  fonts?: () => FontCatalogue;
  /** Previews, caches and tenant caps (BE-050, BE-051, EXP-006, EXP-007). */
  exportPolicy?: ExportPolicy;
  /** The outbox through which server-authored commits reach the room (BE-039; FRW-061). */
  outbox?: OutboxStore;
  /** How long a prefill waits for its commit, ms (a setting). */
  outboxWaitMs?: number;
  /** Per-tenant cost counters (BE-085). */
  meter?: TenantMeter;
  // --- Scaling (BE-064, BE-075). ----------------------------------------------------------------
  /** Read-only routes through a read replica (BE-064): lists and pinned content. Absent: primary. */
  reads?: ReadRouter<ReadStores>;
  /** The callers' writes, so that their reads wait for the replica (BE-064 criterion 3). */
  readSessions?: ReadSessions;
  /** Version-pinned content cached in the process (BE-075). Absent: no cache. */
  pinnedCache?: PinnedCache;
  /** The audit trail that `GET /audit` reads (BE-014; UX-081). Absent: the route is not offered. */
  audit?: AuditStore;
  /** The read markers of `PUT /documents/{id}/read-marker` (HIS-027). Absent: the route is not offered. */
  readMarkers?: ReadMarkerStore;
  /** The comment threads of `/threads` and `POST /documents/{id}/threads` (PRO-059). Absent: not offered. */
  threads?: ThreadStore;
  /** The named versions of `/versions` (HIS-006; PRO-054). Absent: the routes are not offered. */
  versions?: VersionStorePort;
  /** The webhook subscriptions the `/webhooks` routes use (UX-079). Absent: the routes are not offered. */
  webhooks?: WebhookSubscriptions;
  /** The retention policies of `/retention` and `/documents/{id}/retention` (UX-080). Absent: not offered. */
  retention?: RetentionService;
  /** The legal holds of `/holds` and `/documents/{id}/holds` (UX-080 criteria 2 and 3). Absent: not offered. */
  holds?: HoldService;
  /** The tenant quota values of `/quotas` (UX-078 criterion 1). Absent: not offered. */
  quotaAdmin?: QuotaAdminService;
  /** The tenant's allowed origins and public keys, listed by `/origins` and `/keys` (UX-077). */
  tenantRegistry?: TenantRegistry;
  /** The index of `GET /search` (BE-054 criterion 2). Absent: the route is not offered. */
  /** The index the search route queries; the shape `SearchService` in search-routes.ts names. */
  search?: { search(tenant: string, q: string, query: SearchQuery): Promise<SearchHit[]> };
  /** The monthly compile-minute budget of tenants (EXP-009). Absent: no budget is checked. */
  compileBudget?: CompileBudget;
  /** The tenant's data-loss prevention hook, asked before an export (UX-086). Absent: no hook is asked. */
  policyHook?: PolicyHookGate;
}

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Reply => ({
  status,
  body,
  headers,
});

/** Whether `If-None-Match` names `etag` (RFC 9110 §13.1.2, weak comparison of strong tags). */
export function notModified(ctx: Ctx, etag: string): boolean {
  const inm = ctx.req.headers['if-none-match'];
  return (
    typeof inm === 'string' &&
    inm
      .split(',')
      .map((t) => t.trim())
      .includes(etag)
  );
}

export interface Kit {
  d: HandlerDeps;
  /** The opaque list cursors of the kit's list routes (the same instance as `d.cursors`). */
  cursors: Cursors;
  /** The public base of REST, for example `https://docs.example.com/v1`. */
  rest: string;
  refOf(ctx: Ctx, doc: string): DocRef;
  /** The document of the caller's tenant, or `not_found` (also for a deleted one). */
  liveDocument(ctx: Ctx, doc: string): Promise<DocumentRecord>;
  /** `user:<sub>` as storage holds it: `user:<surrogate>` (BE-013; D63). */
  storedPrincipal(tenant: string, principal: string): Promise<string>;
  /** The principals of stored grants and leases as hosts know them (`user:<sub>`). */
  principalNames(tenant: string, stored: readonly string[]): Promise<(p: string) => string>;
  /** The `sub` of each surrogate, for the wire (G11); erased users show as the surrogate. */
  subsOf(tenant: string, surrogates: readonly string[]): Promise<(s: string) => string>;
  emit(ctx: Ctx, type: string, doc: string, data: Record<string, string | number | null>): void;
  /** Storage errors as problems. */
  translate(e: unknown): never;
  /** The data plane's notifications, when it has them (05 §5.6). */
  notify(): NotifyFn | undefined;
  /** The permission state in storage now (S12 change 3). */
  perms(ref: DocRef): Promise<PermissionState>;
  /**
   * The content at `seq` (default the head) as the caller may see it, with its view token and
   * ETag: through the data plane for a user when it offers `readContent`, so that the view token
   * is the one its channels use (G101), and from storage otherwise (BE-098).
   */
  readAs(ctx: Ctx, doc: string, seq?: number): Promise<ReadAs>;
  /** Records that the caller stored `doc` at `seq`, so that its own reads wait for it (BE-064). */
  wrote(ctx: Ctx, doc: string, seq: number): void;
  /** The caller's read-your-writes session, when it has writes the replica may lack. */
  session(ctx: Ctx): ReadSession | undefined;
}

/** The session key of a caller: one credential acting for one actor (read-routing.ts). */
const sessionKey = (ctx: Ctx): string =>
  JSON.stringify([ctx.caller.tenant, ctx.caller.kind, ctx.caller.credential, ctx.caller.actor]);

export interface ReadAs {
  seq: number;
  incarnation: string;
  cdm: number;
  requires: string[];
  doc: JsonNode;
  view: string;
  /** `"<incarnation>.<seq>.<view>"` (D70). */
  etag: string;
}

export function createKit(d: HandlerDeps): Kit {
  const rest = `${d.publicUrl}${d.restPath}`;
  const changes = new DocumentChangeDebounce(d.events);
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  // Raises the waiting changes once their windows have ended. The timer is unreferenced, so it never
  // keeps the process alive; a change that waits is raised by the next timer or the next change.
  const armChangeFlush = (): void => {
    if (changeTimer !== null || changes.waiting === 0) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      changes.flush(d.now());
      armChangeFlush();
    }, CHANGE_WINDOW_MS);
    changeTimer.unref?.();
  };
  const refOf = (ctx: Ctx, doc: string): DocRef => ({ tenant: ctx.caller.tenant, doc });
  const subsOf = async (tenant: string, surrogates: readonly string[]) => {
    const unique = [...new Set(surrogates.filter((s) => s !== 'system'))];
    const subs = unique.length ? await d.users.subsOf(tenant, unique) : new Map<string, string>();
    return (s: string) => subs.get(s) ?? s;
  };
  const kit: Kit = {
    d,
    cursors: d.cursors,
    rest,
    refOf,
    async liveDocument(ctx, doc) {
      const r = await d.documents.get(refOf(ctx, doc));
      // Another tenant's document is invisible to this tenant (row-level security, BE-011).
      if (!r || r.deletedAt !== null) throw new ApiError('not_found', `no document ${doc}`);
      return r;
    },
    async storedPrincipal(tenant, principal) {
      const p = parsePrincipal(principal);
      if (p?.kind !== 'user') return principal;
      return `user:${(await d.users.resolve(tenant, p.sub)).surrogate}`;
    },
    async principalNames(tenant, stored) {
      const name = await subsOf(
        tenant,
        stored.filter((p) => p.startsWith('user:')).map((p) => p.slice(5)),
      );
      return (p: string) => (p.startsWith('user:') ? `user:${name(p.slice(5))}` : p);
    },
    subsOf,
    emit(ctx, type, doc, data) {
      const event = {
        type: `${type}.v1`,
        tenant: ctx.caller.tenant,
        subject: doc,
        data,
        time: d.now(),
      };
      // PRO-072 criterion 2: at most one dep.document.changed per document per window; the last of a
      // burst is raised when its window ends (armChangeFlush).
      // A sink that already debounces (the running service shares one with the rooms) takes it as it is.
      if (event.type === DOCUMENT_CHANGED && !(d.events instanceof DebouncedEventSink)) {
        changes.offer(event, d.now());
        armChangeFlush();
        return;
      }
      d.events.emit(event);
    },
    translate(e: unknown): never {
      if (e instanceof DocumentNotFoundError) throw new ApiError('not_found', 'no such document');
      if (e instanceof RevisionConflictError)
        throw new ApiError('precondition_failed', 'the resource changed since the ETag was read');
      if (e instanceof DuplicateExternalIdError)
        throw new ApiError('conflict', 'a document of the tenant has this externalId (D62)');
      if (e instanceof RetiredRegionError)
        throw new ApiError('validation_failed', 'a grant names a retired region', {
          violations: [{ path: '/grants', rule: 'regions that are not retired (07 §3)' }],
        });
      throw e;
    },
    notify() {
      const n = d.dataPlane?.notify;
      return n
        ? (ref, notification, opts) => n.call(d.dataPlane, ref, notification, opts)
        : undefined;
    },
    perms: (ref) => d.grants.current(ref),
    wrote(ctx, doc, seq) {
      if (!d.reads || !d.readSessions) return;
      d.readSessions.of(sessionKey(ctx)).wrote(ctx.caller.tenant, doc, seq);
    },
    session: (ctx) => d.readSessions?.find(sessionKey(ctx)),
    async readAs(ctx, doc, seq) {
      const reads = d.reads;
      // A pinned read may come from a replica that holds the `seq` (BE-064 criterion 2); the head
      // always comes from the primary.
      if (!reads || seq === undefined) return primaryRead(ctx, doc, seq);
      const session = d.readSessions?.find(sessionKey(ctx));
      const identity = ctx.caller.identity;
      const conn = identity ? { ...identity.connection, role: identity.docs[doc]! } : null;
      const routed = await reads.read<ReadAs>(
        { kind: 'pinned', tenant: ctx.caller.tenant, doc, seq, ...(session ? { session } : {}) },
        async (s) => {
          if (s === reads.primary) return primaryRead(ctx, doc, seq);
          const r = await s.content.read(refOf(ctx, doc), { seq, conn });
          return {
            seq: r.seq,
            incarnation: r.incarnation,
            cdm: r.cdm,
            requires: r.requires,
            doc: r.doc,
            view: r.view,
            etag: r.etag,
          };
        },
      );
      // The primary answers or throws; it never returns nothing for content.
      if (!routed) throw new ApiError('not_found', `no content at seq ${seq}`);
      return routed.value;
    },
  };
  return kit;

  /** The content from the primary: the data plane for a user when it offers reads, else storage. */
  async function primaryRead(ctx: Ctx, doc: string, seq: number | undefined): Promise<ReadAs> {
    const identity = ctx.caller.identity;
    if (identity && d.dataPlane?.readContent) {
      const c = await d.dataPlane.readContent(identity, doc, seq);
      return {
        seq: c.seq,
        incarnation: c.incarnation,
        cdm: c.cdm,
        requires: [...c.requires],
        doc: c.doc as JsonNode,
        view: c.view,
        etag: `"${c.incarnation}.${c.seq}.${c.view}"`,
      };
    }
    const conn = identity ? { ...identity.connection, role: identity.docs[doc]! } : null;
    const r = await d.content.read(refOf(ctx, doc), {
      ...(seq !== undefined ? { seq } : {}),
      conn,
    });
    return {
      seq: r.seq,
      incarnation: r.incarnation,
      cdm: r.cdm,
      requires: r.requires,
      doc: r.doc,
      view: r.view,
      etag: r.etag,
    };
  }
}
