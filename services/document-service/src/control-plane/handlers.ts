/**
 * The resources of 05 §6.2: discovery, tokens, documents, content, regions, grants and revocation
 * here; export jobs, assets, fields and the commit log in the `*-routes.ts` modules; the font
 * manifest at the end. Each handler runs after the pipeline has authenticated the caller and fixed
 * the tenant (pipeline.ts); every storage call names that tenant. Every read route projects for the
 * requester (ADR 0019; BE-098): content, commits, field values, region titles, previews, assets.
 */
import {
  controlAudit,
  type DocRole,
  type PermissionState,
  type RegionGrant,
  parsePrincipal,
} from '@docedit/authority';
import {
  canonicalize,
  formatTimestamp,
  nodeHash,
  parseTimestamp,
  uuid7,
  type JsonEnvelope,
  type JsonNode,
} from '@docedit/model';
import { readDocument } from '@docedit/model/validate';
import type {
  CreateDocumentRequest,
  DocumentResource,
  Grants,
  GrantsPatch,
  RegionInfo,
  RegionState,
  RegionStateRequest,
  RevokeRequest,
  TokenRequest,
  UpdateDocumentRequest,
} from '@docedit/protocol';
import { diffPermissions } from '../storage/permission-change.ts';
import type { DocumentRecord } from '../storage/types.ts';
import { assetReferences } from './assets.ts';
import { assetRoutes } from './asset-routes.ts';
import { auditRoutes } from './audit-routes.ts';
import { commitRoutes } from './commit-routes.ts';
import { emptyDocument, regionNodeOf, regionsOfJson } from './content.ts';
import { exportRoutes } from './export-routes.ts';
import { fieldRoutes } from './field-routes.ts';
import { workflowRoutes } from './workflow-routes.ts';
import { instantiateTemplate, templateRoutes } from './template-routes.ts';
import { bulkSendRoutes } from './bulk-send.ts';
import { historyListRoutes } from './history-list-route.ts';
import { historyReadRoutes } from './history-reads.ts';
import { historyRoutes } from './history-routes.ts';
import { importRoutes } from './imports.ts';
import { activityRoutes } from './activity-route.ts';
import { connectRoutes } from './connect-route.ts';
import { restoreRoutes } from './restore-route.ts';
import { threadRoutes } from './thread-routes.ts';
import { versionRoutes } from './versions-routes.ts';
import { leaseRoutes } from './lease-routes.ts';
import { emptyCatalogue, fontsEtag } from './fonts.ts';
import { readerConnectionOn, refuseSeqBelowGate } from './gate.ts';
import { checkIfMatch, ifMatchTags, pageLimit, seqParam } from './http.ts';
import { createKit, json, notModified, type HandlerDeps, type Kit } from './kit.ts';
import { guard, type Ctx, type Handler } from './pipeline.ts';
import { admitRestCommit } from './live-quota-rest.ts';
import { ApiError } from './problems.ts';
import { projectRegionTitle, readerView } from './visibility.ts';
import { quotaRoutes } from './quota-admin-routes.ts';
import { registryRoutes } from './registry-routes.ts';
import { auditSegmentRoutes } from './audit-segment-route.ts';
import { suggestionRoutes } from './suggestion-routes.ts';
import { historyVisibilityRoutes } from './history-visibility-routes.ts';
import { retentionRoutes } from './retention-routes.ts';
import { holdRoutes } from './hold-routes.ts';
import { eraseRoutes } from './erase-routes.ts';
import { tombstoneRoutes } from './tombstone-routes.ts';
import { searchRoutes } from './search-routes.ts';
import { webhookRoutes } from './webhook-routes.ts';

export type { HandlerDeps } from './kit.ts';

const docEtag = (r: DocumentRecord) => `"m${r.metaRevision}"`;

/** Whether a stored update changed a field a reader of the metadata sees (PRO-035 criterion 4). */
const metadataChanged = (before: DocumentRecord, after: DocumentRecord) =>
  before.title !== after.title ||
  before.label !== after.label ||
  before.state !== after.state ||
  canonicalize(before.properties) !== canonicalize(after.properties);

/**
 * A change of metadata (title, state, deletion) has no log position a replica reports, so it is
 * recorded beyond every `seq`: the writer's later reads of the tenant's lists and of that document
 * stay on the primary for as long as its session is kept (BE-064 criterion 3).
 */
const METADATA_WRITE = Number.MAX_SAFE_INTEGER;

/**
 * The visibility class of a cached pinned read. Only documents read without restrictions are cached
 * (every reader then has the full view), so one class names them all (ADR 0019; SR-C4).
 */
const FULL_VIEW_CLASS = 'full';

/** The ETag of a content body: `"<incarnation>.<seq>.<view>"` (D70), read back from the bytes. */
function etagOfBody(bytes: Uint8Array): string {
  const b = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    seq: number;
    incarnation: string;
    view: string;
  };
  return `"${b.incarnation}.${b.seq}.${b.view}"`;
}
const grantsEtag = (rev: number) => `"g${rev}"`;

function documentResource(r: DocumentRecord): DocumentResource {
  return {
    id: r.id,
    externalId: r.externalId,
    title: r.title,
    properties: r.properties,
    classification: r.label,
    state: r.state,
    cdm: r.cdmVersion,
    requires: r.requires,
    createdAt: formatTimestamp(r.createdAt),
  };
}

/** A refusal of `readDocument` as a problem: `too_large` for the size limits, else the rules. */
function contentRefusal(
  read: { code: string; violations?: ReadonlyArray<{ path: string; invariant: string }> },
  at: string,
): ApiError {
  if (read.code === 'too_large')
    return new ApiError('too_large', 'the content is larger than the limits of 03 (16 MiB)');
  return new ApiError('validation_failed', 'the content is not valid CDM', {
    violations:
      read.code === 'validation_failed' && read.violations
        ? read.violations.map((v) => ({ path: `${at}${v.path}`, rule: v.invariant }))
        : [{ path: at, rule: read.code }],
  });
}

export function createHandlers(d: HandlerDeps): Record<string, Handler> {
  // Typed, so that `k.translate(e)`, which never returns, ends the flow (TS assertion rules).
  const k: Kit = createKit(d);
  const { rest, refOf, liveDocument, emit } = k;

  // --- Discovery and tokens (05 §2, §3.1; PRO-008, PRO-011) ------------------------------------

  const getDiscovery: Handler = async () => {
    const ws = new URL(d.wsPath, d.publicUrl);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    return json(200, {
      versions: ['1.0'],
      ws: ws.toString(),
      rest,
      engines: ['pm-steps/1'],
      cdm: { min: 1, max: 1 },
      features: [...d.features],
      // The targets a client may ask for, with the `exports` feature (05 §2; UX-101).
      ...(d.features.includes('exports') ? { exportTargets: [...d.exportTargets] } : {}),
      mode: 'authority',
      jwks_uri: `${d.publicUrl}/.well-known/jwks.json`,
    });
  };

  const createToken: Handler = async (ctx) => {
    const body = (await ctx.body()) as TokenRequest;
    const minted = await d.tokens.mint(ctx.caller.tenant, body);
    return json(200, minted, { 'Cache-Control': 'no-store' });
  };

  const revokeSessions: Handler = async (ctx) => {
    const body = (await ctx.body()) as RevokeRequest;
    // A watermark to the second: `iat` has seconds, and a token issued in the same second after
    // the revocation must still work (05 §3.3; D73).
    const at = Math.floor(d.now() / 1000) * 1000;
    const user = await d.users.revoke(ctx.caller.tenant, body.sub, body.doc ?? null, at);
    d.dataPlane?.sessionsRevoked?.(ctx.caller.tenant, user.surrogate, body.doc ?? null);
    // PRM-052 criterion 3: the revocation is on record, with the actor, the user revoked, the
    // document if given and the server time. Identifiers only (control-audit.ts).
    if (d.audit) {
      const entry = controlAudit({
        kind: 'session.revoke',
        actor: ctx.caller.actor,
        ...(body.doc ? { document: body.doc } : {}),
        scopes: [],
        subject: user.surrogate,
        time: d.now(),
      });
      await d.audit.record([
        {
          id: uuid7(),
          tenant: ctx.caller.tenant,
          doc: entry.document ?? null,
          actor: entry.actor,
          kind: entry.kind,
          data: { subject: user.surrogate, scopes: entry.scopes },
          at: entry.time,
        },
      ]);
    }
    return { status: 204 };
  };

  // --- Documents (05 §6.2; BE-035, PRO-046, PRO-047) -------------------------------------------

  const listDocuments: Handler = async (ctx) => {
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');
    const after = cursor === null ? undefined : d.cursors.open('documents', cursor);
    const externalId = ctx.url.searchParams.get('externalId') ?? undefined;
    const query = {
      ...(externalId !== undefined ? { externalId } : {}),
      ...(after !== undefined ? { after } : {}),
      limit: limit + 1,
    };
    // A list may come from a read replica, unless the caller wrote what it lacks (BE-064).
    const session = k.session(ctx);
    const rows = d.reads
      ? (await d.reads.read(
          { kind: 'list', tenant: ctx.caller.tenant, ...(session ? { session } : {}) },
          (s) => s.documents.list(ctx.caller.tenant, query),
        ))!.value
      : await d.documents.list(ctx.caller.tenant, query);
    const page = rows.slice(0, limit);
    return json(200, {
      items: page.map(documentResource),
      nextCursor:
        rows.length > limit ? d.cursors.issue('documents', page[page.length - 1]!.id) : null,
    });
  };

  const createDocument: Handler = async (ctx) => {
    const body = (await ctx.body()) as CreateDocumentRequest;
    const sources = (['content', 'template', 'import'] as const).filter(
      (s) => body[s] !== undefined,
    );
    if (sources.length > 1)
      throw new ApiError('validation_failed', 'at most one of content, template and import', {
        violations: sources.map((s) => ({ path: `/${s}`, rule: 'at most one source' })),
      });
    if (body.template !== undefined) {
      // FRW-062: a fork of the template document at a pinned seq, with participants and values.
      const made = await instantiateTemplate(k, ctx, body);
      k.wrote(ctx, made.record.id, 0);
      emit(ctx, 'dep.document.created', made.record.id, { seq: 0 });
      return json(
        201,
        { ...documentResource(made.record), template: made.template },
        { ETag: docEtag(made.record), Location: `${rest}/documents/${made.record.id}` },
      );
    }
    if (body.import !== undefined)
      throw new ApiError('validation_failed', 'imports are not offered yet (D62)', {
        violations: [{ path: '/import', rule: 'not supported by this server' }],
      });
    let envelope: JsonEnvelope = emptyDocument();
    if (body.content !== undefined) {
      // A new document has no attached assets and no retired regions (I3, I4).
      const read = readDocument(body.content, {
        attachedAssets: new Set(),
        retiredRegionIds: new Set(),
      });
      if (!read.ok) throw contentRefusal(read, '/content');
      envelope = { cdm: read.cdm, requires: read.requires, doc: read.doc.toJSON() } as JsonEnvelope;
    }
    const id = uuid7();
    const ref = refOf(ctx, id);
    // The content first: a document never exists without its content at seq 0 (D67).
    await d.checkpoints.put(ref, 0, envelope);
    let record: DocumentRecord;
    try {
      record = await d.documents.create(ctx.caller.tenant, {
        id,
        cdmVersion: envelope.cdm,
        requires: envelope.requires,
        createdBy: ctx.caller.actor,
        ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.properties !== undefined ? { properties: body.properties } : {}),
        ...(body.classification !== undefined ? { label: body.classification } : {}),
      });
    } catch (e) {
      k.translate(e);
    }
    k.wrote(ctx, id, 0);
    emit(ctx, 'dep.document.created', id, { seq: 0 });
    return json(201, documentResource(record), {
      ETag: docEtag(record),
      Location: `${rest}/documents/${id}`,
    });
  };

  const getDocument: Handler = async (ctx) => {
    // 07 §12 has no row for metadata: read like the content at the head (D65).
    guard(ctx.caller, 'read.head', ctx.params['id']!);
    const r = await liveDocument(ctx, ctx.params['id']!);
    // HIS-031 criterion 4: the resource says whether a legal hold is in force (a boolean only).
    const legalHold = d.holds ? await d.holds.inForce(ctx.caller.tenant, r.id) : false;
    return json(200, { ...documentResource(r), legalHold }, { ETag: docEtag(r) });
  };

  const updateDocument: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // 07 §12 lists no row for it; `manage` or a service credential, as for deleting (D65).
    guard(ctx.caller, 'manage', doc);
    const current = await liveDocument(ctx, doc);
    checkIfMatch(ctx.req, docEtag(current));
    const body = (await ctx.body()) as UpdateDocumentRequest;
    let result;
    try {
      result = await d.documents.update(
        refOf(ctx, doc),
        {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.properties !== undefined ? { properties: body.properties } : {}),
          ...(body.classification !== undefined ? { label: body.classification } : {}),
          ...(body.state !== undefined ? { state: body.state } : {}),
        },
        { actor: ctx.caller.actor, ifMetaRevision: current.metaRevision },
      );
    } catch (e) {
      k.translate(e);
    }
    if (result.perms) {
      // The state is permission data: the room records it as a control commit (07 §9; BE-026).
      d.notifier.permissionsChanged(refOf(ctx, doc), result.perms);
      emit(ctx, 'dep.document.state_changed', doc, {
        state: result.record.state,
        previous: current.state,
        rev: result.perms.revision,
        // The content head at the change: every webhook carries `seq` (05 §7; PRO-069 criterion 1).
        seq: (await d.logs.head(refOf(ctx, doc))).seq,
      });
    }
    // A stored change to the metadata (title, properties, classification or state) raises
    // `document.updated` for the open channels (05 §5.6; PRO-035 criterion 4). The stores raise
    // `metaRevision` on every update, so the fields themselves are compared: a PATCH that leaves
    // every field as it was changes nothing and tells nobody (PRO-035 Notes).
    if (metadataChanged(current, result.record)) d.notifier.documentChanged(refOf(ctx, doc));
    // A change of the classification label is audited with its previous value (UX-085 criterion
    // 4). The kind `classification.changed` is a proposed name (docs/adr/0330-lane-U-UX-076-090.md).
    // Recorded after the update commits, so the audit is not atomic with the change yet.
    if (body.classification !== undefined && result.record.label !== current.label)
      await d.audit?.record([
        {
          id: uuid7(),
          tenant: ctx.caller.tenant,
          doc,
          actor: ctx.caller.actor,
          kind: 'classification.changed',
          data: { previous: current.label, label: result.record.label },
          at: d.now(),
        },
      ]);
    k.wrote(ctx, doc, METADATA_WRITE);
    return json(200, documentResource(result.record), { ETag: docEtag(result.record) });
  };

  const deleteDocument: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'manage', doc);
    const current = await liveDocument(ctx, doc);
    checkIfMatch(ctx.req, docEtag(current), false);
    try {
      await d.documents.remove(refOf(ctx, doc), {
        actor: ctx.caller.actor,
        ...(ifMatchTags(ctx.req) !== null ? { ifMetaRevision: current.metaRevision } : {}),
      });
    } catch (e) {
      k.translate(e);
    }
    d.notifier.documentChanged(refOf(ctx, doc));
    k.wrote(ctx, doc, METADATA_WRITE);
    // The data stays after a soft delete, so the head is still readable (PRO-069 criterion 1).
    emit(ctx, 'dep.document.deleted', doc, { seq: (await d.logs.head(refOf(ctx, doc))).seq });
    return { status: 204 };
  };

  // --- Content (05 §6.2, §5.2; BE-036, PRO-049; 07 §8) -----------------------------------------

  /**
   * The caller's history gate (07 §8; PRM-041) for a `seq` below the head. A role with `edit`
   * sees full history under the default setting without reading regions.
   */
  async function gateFor(ctx: Ctx, record: DocumentRecord, head: number, seq: number) {
    await refuseSeqBelowGate(d, ctx.caller, refOf(ctx, record.id), record, head, seq);
  }

  const getContent: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const seq = seqParam(ctx.url, 'seq');
    /** The permission check and the history gate; the log incarnation of a pinned read. */
    const check = async (): Promise<string | undefined> => {
      guard(ctx.caller, seq === undefined ? 'read.head' : 'read.history', doc);
      const record = await liveDocument(ctx, doc);
      if (seq === undefined) return undefined;
      const head = await d.logs.head(refOf(ctx, doc));
      if (seq > head.seq)
        throw new ApiError('not_found', `no content at seq ${seq}; the head is ${head.seq}`);
      await gateFor(ctx, record, head.seq, seq);
      return head.incarnation;
    };
    const read = async (): Promise<{ etag: string; bytes: Uint8Array }> => {
      const c = await k.readAs(ctx, doc, seq);
      const body = {
        seq: c.seq,
        incarnation: c.incarnation,
        cdm: c.cdm,
        requires: c.requires,
        doc: c.doc,
        view: c.view,
      };
      return { etag: c.etag, bytes: Buffer.from(canonicalize(body), 'utf8') };
    };
    let out: { etag: string; bytes: Uint8Array };
    if (seq !== undefined && d.pinnedCache) {
      // A pinned read may be served from the cache (BE-075). The check runs inside `serve`, before
      // any copy is served; a document under read restrictions is never cached (SR-C4).
      const ref = refOf(ctx, doc);
      const served = await d.pinnedCache.serve(
        {
          resource: { kind: 'content', doc: ref, seq },
          visibilityClass: FULL_VIEW_CLASS,
          restricted: d.views.visibility !== undefined,
          reader: ctx.caller.actor,
        },
        {
          // The key names the incarnation the check found, so a rewound log never meets an old copy.
          authorise: async (req) => {
            const incarnation = (await check())!;
            return { ...req, resource: { kind: 'content', doc: ref, seq, incarnation } };
          },
          fromHome: async () => (await read()).bytes,
        },
      );
      if (served.status !== 'served') throw new ApiError('not_found', `no content at seq ${seq}`);
      out = { etag: etagOfBody(served.body), bytes: served.body };
    } else {
      await check();
      out = await read();
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ETag: out.etag,
      // Private: a read differs by visibility class (SR-C4; D70). Pinned reads never change.
      'Cache-Control':
        seq !== undefined ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    };
    if (notModified(ctx, out.etag)) return { status: 304, headers };
    return { status: 200, bytes: Buffer.from(out.bytes), headers };
  };

  // --- Regions and grants (05 §6.2; 07 §3, §9; PRO-051, PRO-052, PRM-018) ---------------------

  const listRegions: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // No row in 07 §12: reading the region list needs `view` (D65).
    guard(ctx.caller, 'read.head', doc);
    await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const perms = await d.grants.current(ref);
    const view = readerView(d.views, await readerConnectionOn(d, ctx.caller, doc), full.doc, perms);
    const now = d.now();
    const names = await k.principalNames(ctx.caller.tenant, [
      ...perms.grants.map((g) => g.principal),
      ...perms.leases.map((l) => `user:${l.holder}`),
    ]);
    const all = regionsOfJson(full.doc).map((r, order): RegionInfo => {
      const state = perms.regionStates.get(r.id) ?? 'draft';
      const frozen = state === 'approved' || perms.documentState !== 'active';
      const lease = perms.leases.find((l) => l.region === r.id && l.expiresAt > now);
      const roles: DocRole[] = frozen
        ? []
        : r.policy === 'inherit'
          ? ['editor', 'owner']
          : ['owner'];
      const principals = frozen
        ? []
        : perms.grants
            .filter(
              (g) =>
                g.region === r.id &&
                g.role === 'editor' &&
                (g.expiresAt === null || g.expiresAt > now),
            )
            .map((g) => names(g.principal));
      return {
        id: r.id,
        title: projectRegionTitle(view, r.id, r.title) ?? '',
        policy: (['inherit', 'restricted', 'confidential'].includes(r.policy)
          ? r.policy
          : 'inherit') as RegionInfo['policy'],
        order,
        state,
        editors: {
          roles,
          principals: [...new Set(principals)].sort(),
          ...(lease && !frozen ? { leasedTo: names(`user:${lease.holder}`).slice(5) } : {}),
        },
      };
    });
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');
    const start = cursor === null ? 0 : Number(d.cursors.open(`regions/${doc}`, cursor));
    const page = all.slice(start, start + limit);
    // PRM-032 criterion 3: the list changes when the head moves (a region added or retired) or the
    // grants and region states change (the grants revision), and each reader's view is in the tag.
    const etag = `"${head.incarnation}.${head.seq}.${view.token}.g${perms.revision}"`;
    const headers = { ETag: etag };
    if (notModified(ctx, etag)) return { status: 304, headers };
    return json(
      200,
      {
        items: page,
        nextCursor:
          start + limit < all.length
            ? d.cursors.issue(`regions/${doc}`, String(start + limit))
            : null,
      },
      headers,
    );
  };

  async function grantsResource(tenant: string, perms: PermissionState): Promise<Grants> {
    const names = await k.principalNames(
      tenant,
      perms.grants.map((g) => g.principal),
    );
    return {
      rev: perms.revision,
      grants: perms.grants.map((g) => ({
        region: g.region,
        principal: names(g.principal),
        role: g.role,
        expiresAt: g.expiresAt === null ? null : formatTimestamp(g.expiresAt),
      })),
    };
  }

  const getGrants: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // 07 §12 has no row for reading grants: `manage` or a service credential (D65).
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const perms = await d.grants.current(refOf(ctx, doc));
    return json(200, await grantsResource(ctx.caller.tenant, perms), {
      ETag: grantsEtag(perms.revision),
    });
  };

  const updateGrants: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const current = await d.grants.current(ref);
    checkIfMatch(ctx.req, grantsEtag(current.revision));
    const body = (await ctx.body()) as GrantsPatch;
    if (body.grants === undefined)
      return json(200, await grantsResource(ctx.caller.tenant, current), {
        ETag: grantsEtag(current.revision),
      });
    // The regions of the content at the head; a grant on any other region is refused (PRM-018).
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const regionList = regionsOfJson(full.doc);
    const regions = new Set(regionList.map((r) => r.id));
    const restricted = new Set(
      regionList.filter((r) => r.policy === 'restricted').map((r) => r.id),
    );
    const seen = new Set<string>();
    const wanted: RegionGrant[] = [];
    for (const [i, g] of body.grants.entries()) {
      const at = `/grants/${i}`;
      if (!parsePrincipal(g.principal))
        throw new ApiError('validation_failed', 'a principal is user:, group:, everyone or role:', {
          violations: [
            { path: `${at}/principal`, rule: 'one of the four principal forms (07 §1)' },
          ],
        });
      if (!regions.has(g.region))
        throw new ApiError('validation_failed', `no region ${g.region} at the head`, {
          violations: [{ path: `${at}/region`, rule: 'a region of the document (07 §3)' }],
        });
      // `everyone` on a restricted region is forbidden (07 §17; owner decision 12 of 2026-11-15;
      // PRM-061). It would make the region behave like an `inherit` one for that role.
      if (g.principal === 'everyone' && restricted.has(g.region))
        throw new ApiError(
          'validation_failed',
          'everyone cannot hold a role on a restricted region',
          {
            violations: [
              {
                path: `${at}/principal`,
                rule: 'a restricted region is granted to users and groups, not to everyone (07 §1)',
              },
            ],
          },
        );
      const key = `${g.region}\u0000${g.principal}`;
      if (seen.has(key))
        throw new ApiError('validation_failed', 'two grants for one region and principal', {
          violations: [{ path: at, rule: 'one grant per region and principal (07 §1)' }],
        });
      seen.add(key);
      wanted.push({
        region: g.region,
        principal: await k.storedPrincipal(ctx.caller.tenant, g.principal),
        role: g.role,
        expiresAt:
          g.expiresAt === undefined || g.expiresAt === null ? null : parseTimestamp(g.expiresAt),
      });
    }
    const change = diffPermissions(current, { ...current, grants: wanted });
    let perms: PermissionState;
    try {
      perms = await d.grants.change(ref, change, {
        actor: ctx.caller.actor,
        ifRevision: current.revision,
      });
    } catch (e) {
      k.translate(e);
    }
    // Stored under the new revision first; then the room records a control commit (07 §9).
    d.notifier.permissionsChanged(ref, perms);
    // The event carries the head `seq` (05 §7; the envelope refuses an event without it, PRM-053).
    const grantHead = await d.logs.head(ref);
    emit(ctx, 'dep.grants.changed', doc, { rev: perms.revision, seq: grantHead.seq });
    return json(200, await grantsResource(ctx.caller.tenant, perms), {
      ETag: grantsEtag(perms.revision),
    });
  };

  /**
   * `PUT /documents/{id}/regions/{rid}/state` (05 §6.2; 07 §11): row 10 of 07 §12. No route reads a
   * region state (G99), so the precondition is the grants revision the state belongs to: the
   * ETag of the grants, or `*`. An approval answers with the `seq` and the hash of the region's
   * canonical content at the head (07 §11); storing them with the state is PRM's (phase 2).
   */
  const setRegionState: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const rid = ctx.params['rid']!;
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const current = await d.grants.current(ref);
    checkIfMatch(ctx.req, grantsEtag(current.revision));
    const body = (await ctx.body()) as RegionStateRequest;
    // PRO-053 criterion 1: only the three states of 07 §11 are accepted; any other value is refused.
    if (body?.state !== 'draft' && body?.state !== 'in_review' && body?.state !== 'approved')
      throw new ApiError('validation_failed', 'state must be draft, in_review or approved');
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const node = regionNodeOf(full.doc, rid);
    if (!node) throw new ApiError('not_found', `no region ${rid} at the head`);
    // An approval is bound to what the room computes at the head (PRM-046; 07 §11): the seq and the
    // hash of the region's canonical content. The client never supplies either.
    const approval =
      body.state === 'approved' ? { seq: head.seq, hash: await nodeHash(node) } : undefined;
    let perms: PermissionState;
    try {
      perms = await d.grants.change(
        ref,
        {
          setRegionStates: [{ region: rid, state: body.state, ...(approval ? { approval } : {}) }],
        },
        { actor: ctx.caller.actor, ifRevision: current.revision },
      );
    } catch (e) {
      k.translate(e);
    }
    d.notifier.permissionsChanged(ref, perms);
    emit(ctx, 'dep.region.state_changed', doc, {
      region: rid,
      state: body.state,
      rev: perms.revision,
      seq: head.seq,
    });
    const out: RegionState = approval
      ? { state: body.state, seq: approval.seq, hash: approval.hash }
      : { state: body.state };
    return json(200, out, { ETag: grantsEtag(perms.revision) });
  };

  /**
   * `PUT /documents/{id}/content` (05 §6.2; 04 §3.2; BE-037, PRO-050): a snapshot commit with
   * origin `import`. Row 13 of 07 §12 (a service credential) is the route's credential. The control
   * plane checks If-Match against the content at the head, the content itself (`model.validate`,
   * with the assets attached to the document and its retired regions), the active workflow
   * (`workflow_active`) and every approved region (unchanged, or `conflict`: 07 §11, PRM-047); the
   * data plane, which owns the log and the rooms, stores it and resets the channels.
   */
  const replaceContent: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    await liveDocument(ctx, doc);
    const apply = d.dataPlane?.replaceContent?.bind(d.dataPlane);
    if (!apply)
      throw new ApiError('not_found', 'this server does not replace content yet (BE-037)');
    // BE-091: the replacement is a commit, so it counts against the tenant's live-use quotas.
    await admitRestCommit(d.liveQuotas, ctx.caller.tenant);
    const ref = refOf(ctx, doc);
    const current = await d.content.read(ref, { conn: null });
    checkIfMatch(ctx.req, current.etag);
    const body = await ctx.body();
    const perms = await d.grants.current(ref);
    if (perms.workflowActive)
      throw new ApiError('workflow_active', 'a workflow is active; its content cannot be replaced');
    // Assets the new content may reference: those already referenced and those uploaded for it.
    const attached = new Set(assetReferences(current.doc).display);
    for (const f of assetReferences(current.doc).fragments) attached.add(f);
    for (const a of (await d.assetRegistry?.readyFor(ctx.caller.tenant, doc)) ?? [])
      attached.add(a.id);
    const read = readDocument(body, {
      attachedAssets: attached,
      retiredRegionIds: new Set(await d.grants.retired(ref)),
    });
    if (!read.ok) throw contentRefusal(read, '');
    const envelope = {
      cdm: read.cdm,
      requires: read.requires,
      doc: read.doc.toJSON(),
    } as JsonEnvelope;
    // An approved region must stay exactly as approved, even for a snapshot (07 §11; PRM-047).
    for (const [rid, state] of perms.regionStates) {
      if (state !== 'approved') continue;
      const before = regionNodeOf(current.doc, rid);
      const after = regionNodeOf(envelope.doc as JsonNode, rid);
      if (before && (!after || canonicalize(before) !== canonicalize(after)))
        throw new ApiError(
          'conflict',
          `region ${rid} is approved; change its state first (07 §11)`,
        );
    }
    // The ETag the caller matched is the head it replaces: the same PUT again is the same commit.
    const { seq } = await apply(ref, envelope, ctx.caller.actor, { head: current.etag });
    k.wrote(ctx, doc, seq);
    // The audit trail names the person the change is attributed to and the credential that made it
    // (owner decision 174; UX-097 criterion 1; 07 §14). Identifiers, the origin and the seq only.
    if (d.audit)
      await d.audit.record([
        {
          id: uuid7(),
          tenant: ref.tenant,
          doc: ref.doc,
          actor: ctx.caller.actor,
          kind: 'commit.service',
          data: { origin: 'replace', credential: ctx.caller.credential, seq, scopes: [] },
          at: d.now(),
        },
      ]);
    // The hash-chain head of the commit, for an independent anchor (05 §7; PRO-069 criterion 3).
    const chainHead = (await d.logs.state?.(ref))?.chainHead ?? null;
    emit(ctx, 'dep.document.changed', doc, { seq, ...(chainHead !== null ? { chainHead } : {}) });
    return { status: 204 };
  };

  // --- Fonts (05 §6.2; PRO-067, BE-047) --------------------------------------------------------

  const getFonts: Handler = async (ctx) => {
    const catalogue = d.fonts?.() ?? emptyCatalogue();
    const etag = fontsEtag(catalogue.manifest);
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' };
    if (notModified(ctx, etag)) return { status: 304, headers };
    return json(200, catalogue.manifest, headers);
  };

  // History reads (lists, diffs, attribution) are served from the read replica when one is
  // configured and it can answer them correctly (BE-064 criterion 1): the same handlers run on a
  // second kit over the replica's stores, and the router decides which one answers. A replica that
  // lacks the document, fails, or has not applied the caller's own writes sends the read to the
  // primary, whose answer (or refusal) is the one the caller gets.
  const primaryHistory = { ...historyReadRoutes(k), ...historyListRoutes(k) };
  const historyReads: Record<string, Handler> = primaryHistory;
  if (d.reads && d.replicaDeps) {
    const reads = d.reads;
    const { reads: _reads, replicaDeps, ...own } = d;
    const replicaKit = createKit({ ...own, ...replicaDeps });
    const onReplica = { ...historyReadRoutes(replicaKit), ...historyListRoutes(replicaKit) };
    for (const [id, primary] of Object.entries(primaryHistory)) {
      historyReads[id] = async (ctx) => {
        const session = k.session(ctx);
        const routed = await reads.read<Awaited<ReturnType<Handler>>>(
          {
            kind: 'history',
            tenant: ctx.caller.tenant,
            doc: ctx.params['id']!,
            ...(session ? { session } : {}),
          },
          async (store) => (store === reads.primary ? primary(ctx) : onReplica[id]!(ctx)),
        );
        return routed!.value;
      };
    }
  }

  return {
    getDiscovery,
    createToken,
    revokeSessions,
    listDocuments,
    createDocument,
    getDocument,
    updateDocument,
    deleteDocument,
    getContent,
    listRegions,
    getGrants,
    updateGrants,
    setRegionState,
    replaceContent,
    ...exportRoutes(k),
    ...importRoutes(k),
    ...assetRoutes(k),
    ...fieldRoutes(k),
    ...commitRoutes(k),
    ...historyRoutes(k),
    ...historyReads,
    ...restoreRoutes(k),
    ...activityRoutes(k),
    ...connectRoutes(k),
    ...threadRoutes(k),
    ...versionRoutes(k),
    ...leaseRoutes(k),
    ...auditRoutes(k),
    ...webhookRoutes(k),
    ...retentionRoutes(k),
    ...historyVisibilityRoutes(k),
    ...auditSegmentRoutes(k),
    ...suggestionRoutes(k),
    ...quotaRoutes(k),
    ...registryRoutes(k),
    ...holdRoutes(k),
    ...eraseRoutes(k),
    ...tombstoneRoutes(k),
    ...searchRoutes(k),
    ...workflowRoutes(k),
    ...templateRoutes(k),
    ...bulkSendRoutes(k),
    getFonts,
  };
}

export type { ExportOutputs } from './exports.ts';
