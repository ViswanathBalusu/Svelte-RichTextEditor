/**
 * The history routes of 05 §6.2 that the control plane serves in this lane: `POST
 * /documents/{id}/fork` (HIS-022; 08 §8). The other history routes (`history`, `versions`, `diff`,
 * `attribution`, `restore`, `read-marker`, `activity`) are not in this module.
 *
 * Fork is a service-credential operation (the component raises `de-fork-request` and the host
 * calls this route; 05 §8.1). The new document gets the content at `atSeq` as its checkpoint at
 * sequence number 0, so it starts its own log, incarnation and hash chain (06 §4; D67). The source
 * document is not written to.
 *
 * Decisions recorded in docs/adr/0153-control-plane-4-backlog-batch.md (proposed):
 * - the member "whether grants are copied" is named `copyGrants` (gap G69 leaves the name open);
 *   it defaults to false, so a fork has no grants unless the request says so (HIS-022 criterion 3);
 * - a copied grant set keeps its regions and grants only: approvals, leases and the workflow state
 *   of the source are not copied.
 */
import { formatTimestamp, uuid7, type JsonEnvelope } from '@docedit/model';
import { assetRefsIn } from '../data-plane/asset-attachments.ts';
import { actingConnection, refuseSeqBelowGate } from './gate.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { PermissionState } from '@docedit/authority';
import type { DocumentRecord } from '../storage/types.ts';

/** The body of `POST /documents/{id}/fork` as this module reads it (05 §6.2; 08 §8). */
interface ForkBody {
  atSeq: number;
  copyGrants?: boolean;
}

/** The body of `PUT /documents/{id}/read-marker` (05 §6.2; 08 §10). */
interface ReadMarkerBody {
  seq: number;
  /** How far the caller has read the comments: a comment sequence number (PRO-058; decision 73). */
  commentSeq?: number;
}

/**
 * The resource of a document as `handlers.ts` writes it (05 §6.2 DocumentResource). Duplicated
 * here because `handlers.ts` imports this module; both must change together.
 */
function documentResource(r: DocumentRecord) {
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

export function historyRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  /**
   * Copies the content at `atSeq` of a document into a new one (HIS-022). Refused for a user
   * credential (`forbidden`), for a `atSeq` above the head (`not_found`) and for a `atSeq` that is
   * not a sequence number (`validation_failed`, by the body shape).
   */
  const forkDocument: Handler = async (ctx) => {
    if (ctx.caller.kind !== 'service')
      throw new ApiError('forbidden', 'fork is a service-credential operation (05 §6.2; 08 §8)');
    const source = ctx.params['id']!;
    const sourceRecord = await liveDocument(ctx, source);
    const body = (await ctx.body()) as ForkBody;
    if (body.copyGrants !== undefined && typeof body.copyGrants !== 'boolean')
      throw new ApiError('validation_failed', 'copyGrants is a boolean', {
        violations: [{ path: '/copyGrants', rule: 'a boolean' }],
      });
    const ref = refOf(ctx, source);
    const head = await d.logs.head(ref);
    if (body.atSeq > head.seq)
      throw new ApiError('not_found', `no content at seq ${body.atSeq}; the head is ${head.seq}`);
    // A fork reveals the state at `atSeq`: the same gate as every other seq (HIS-024). A service
    // credential reads full history, unless it names the user it acts for in `DEP-Actor`: then
    // `atSeq` must be visible to that user (PRM-042 criterion 4; ADR 0379, proposed).
    // The actor is the user's surrogate, which is what stored grants name.
    const named = ctx.req.headers['dep-actor'] !== undefined;
    await refuseSeqBelowGate(d, ctx.caller, ref, sourceRecord, head.seq, body.atSeq, {
      what: 'atSeq',
      ...(named ? { as: actingConnection(ctx.caller.actor) } : {}),
    });
    // The content as it was at `atSeq`, read from the source's own log (the same read as a pinned
    // content read, without the caller's projection: a service credential sees full history).
    const full = await d.content.rebuild(ref, head.incarnation, body.atSeq);
    const id = uuid7(d.now());
    const envelope = { cdm: full.cdm, requires: full.requires, doc: full.doc } as JsonEnvelope;
    // The content first: a document never exists without its content at seq 0 (D67; as create).
    await d.checkpoints.put(refOf(ctx, id), 0, envelope);
    let permissions: Omit<PermissionState, 'revision'> | undefined;
    if (body.copyGrants === true) {
      const perms = await d.grants.current(ref);
      permissions = {
        grants: perms.grants,
        regionStates: new Map(),
        leases: [],
        documentState: 'active',
        workflowActive: false,
      };
    }
    let record: DocumentRecord;
    try {
      record = await d.documents.create(ctx.caller.tenant, {
        id,
        cdmVersion: full.cdm,
        requires: full.requires,
        createdBy: ctx.caller.actor,
        fork: { from: source, atSeq: body.atSeq },
        ...(permissions !== undefined ? { permissions } : {}),
      });
    } catch (e) {
      k.translate(e);
    }
    // The assets the copied content references are attached to the copy, from seq 0, so that its
    // references resolve (invariant I4; HIS-022). Only those the source has attached: an asset
    // the source never held is left out. The objects are shared by hash, not copied.
    if (d.logs.attachAssets && d.logs.attachedAssets) {
      const held = await d.logs.attachedAssets(ref);
      const wanted = [...assetRefsIn(full.doc)].filter((a) => held.has(a));
      if (wanted.length > 0)
        await d.logs.attachAssets(
          refOf(ctx, id),
          wanted.map((asset) => ({ asset, seq: 0 })),
        );
    }
    k.emit(ctx, 'dep.document.created', id, { seq: 0 });
    return json(201, documentResource(record!), {
      ETag: `"m${record!.metaRevision}"`,
      Location: `${k.rest}/documents/${id}`,
    });
  };

  /**
   * Records how far the caller has read the document (HIS-027 criterion 1; 08 §10). One marker per
   * user and document; a lower or equal `seq` does not move it (criterion 2, in the store). A read
   * marker belongs to a user, so a service credential is refused. The `seq` must be a sequence
   * number the document has reached (`not_found` above the head).
   */
  const setReadMarker: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.head', doc);
    if (ctx.caller.kind !== 'user')
      throw new ApiError('forbidden', 'a read marker belongs to a user (08 §10)');
    const store = d.readMarkers;
    if (!store) throw new ApiError('not_found', 'read markers are not offered by this service');
    await liveDocument(ctx, doc);
    const body = (await ctx.body()) as ReadMarkerBody;
    if (typeof body?.seq !== 'number' || !Number.isSafeInteger(body.seq) || body.seq < 0)
      throw new ApiError('validation_failed', 'seq is a whole number of 0 or more', {
        violations: [{ path: '/seq', rule: 'a whole number, 0 or more' }],
      });
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    if (body.seq > head.seq)
      throw new ApiError('not_found', `no content at seq ${body.seq}; the head is ${head.seq}`);
    // The comment marker moves on its own, and only when the body names it (decision 73).
    let commentSeq: number | undefined;
    if (body.commentSeq !== undefined) {
      if (!Number.isSafeInteger(body.commentSeq) || body.commentSeq < 0)
        throw new ApiError('validation_failed', 'commentSeq is a whole number of 0 or more', {
          violations: [{ path: '/commentSeq', rule: 'a whole number, 0 or more' }],
        });
      const commentHead = (await d.threads?.commentHead(ref)) ?? 0;
      if (body.commentSeq > commentHead)
        throw new ApiError(
          'not_found',
          `no comment at seq ${body.commentSeq}; the last is ${commentHead}`,
        );
      commentSeq = await store.advanceComments(ref, ctx.caller.actor, body.commentSeq, d.now());
    }
    const seq = await store.advance(ref, ctx.caller.actor, body.seq, d.now());
    return json(200, commentSeq === undefined ? { seq } : { seq, commentSeq }, {
      ETag: commentSeq === undefined ? `"r${seq}"` : `"r${seq}c${commentSeq}"`,
    });
  };

  return { forkDocument, setReadMarker };
}
