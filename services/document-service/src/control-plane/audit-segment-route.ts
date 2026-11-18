/**
 * `GET /documents/{id}/audit-segment?fromSeq=&toSeq=` (operation getAuditSegment; 08 §12; 13 §10;
 * HIS-037): a segment of the hash chain that a relying party checks without the service.
 *
 * The segment holds the hashed metadata of each record, its payload hash and its chain hashes, the
 * anchor records of the range and the verification instructions, and never a payload
 * (`auditSegment` of `@docedit/history`). Row 2 of 07 §12 applies: `view` and the history gate.
 *
 * - Records below the caller's gate are left out. Only the chain hash of the record just below it
 *   travels, as the first held record's link, because the chain check needs it (owner decision
 *   142: hidden commits are left out and one link hash is revealed).
 * - A range that ends below the gate is `forbidden`, one above the head `not_found`, one that
 *   starts after it ends `validation_failed`.
 * - A caller whose view hides content is refused with `forbidden`. A record that touched only
 *   hidden content cannot be left out of the middle of a range without breaking the chain, and its
 *   scopes name the hidden regions. Whether the names of hidden region scopes may show is still
 *   open (owner decisions, 2026-11-15, note under decision 142); until the owner says so, a reader
 *   with hidden regions gets no segment. A service credential reads the full chain.
 * - The anchors are those the store holds for the range; this store has none yet (HIS-036).
 */
import { auditSegment } from '@docedit/history';
import { actingConnection, minVisibleSeqOf, regionInfosOfJson, connectionOn } from './gate.ts';
import { seqParam } from './http.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { readerView } from './visibility.ts';

export function auditSegmentRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  const getAuditSegment: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.history', doc);
    const record = await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    if (!d.logs.chainRange) throw new ApiError('not_found', 'this server offers no audit export');
    const head = await d.logs.head(ref);
    const fromSeq = seqParam(ctx.url, 'fromSeq') ?? 1;
    const toSeq = seqParam(ctx.url, 'toSeq') ?? head.seq;
    if (fromSeq < 1)
      throw new ApiError('validation_failed', 'fromSeq is a sequence number from 1', {
        violations: [{ path: 'fromSeq', rule: 'at least 1' }],
      });

    // The caller's gate. A service credential reads the full chain unless it names a user.
    const named = ctx.req.headers['dep-actor'] !== undefined;
    const conn = named ? actingConnection(ctx.caller.actor) : connectionOn(ctx.caller, doc);
    let min = 0;
    if (conn) {
      const full = await d.content.rebuild(ref, head.incarnation, head.seq);
      const perms = await d.grants.current(ref);
      min = await minVisibleSeqOf({
        caller: ctx.caller,
        ...(named ? { as: conn } : {}),
        ref,
        record,
        head: head.seq,
        regions: regionInfosOfJson(full.doc),
        perms,
        logs: d.logs,
        now: d.now(),
      });
      if (!readerView(d.views, conn, full.doc, perms).full)
        throw new ApiError(
          'forbidden',
          'the audit export is not offered to a reader whose view hides content',
        );
    }

    // Only the records the segment holds, and the one below them, are read.
    const bundle = await d.logs.chainRange(ref, Math.max(fromSeq, min), toSeq);
    const made = auditSegment(bundle, { fromSeq, toSeq, minVisibleSeq: min });
    if (!made.ok) throw new ApiError(made.code, made.reason);
    return json(200, made.segment, { 'Cache-Control': 'private, no-cache' });
  };

  return { getAuditSegment };
}
