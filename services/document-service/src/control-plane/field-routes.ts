/**
 * The field routes of 12 §10 (FRW-060, FRW-061; D145). See fields.ts for the rules.
 */
import { uuid7 } from '@docedit/model';
import { derivedCommitId, stableJson } from '../data-plane/commit-id.ts';
import { fieldValuesCsv, valueText } from './field-csv.ts';
import { prefillSteps, projectedFields, valuesByKey } from './fields.ts';
import { checkIfMatch, pageLimit, seqParam } from './http.ts';
import { json, notModified, type Kit, type ReadAs } from './kit.ts';
import { guard, type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { refuseSeqBelowGate } from './gate.ts';

const valuesEtag = (c: ReadAs) => `"v.${c.incarnation}.${c.seq}.${c.view}"`;

export function fieldRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  /** The history gate for a pinned read (07 §8; FRW-060 criterion 4). */
  async function gate(ctx: Ctx, doc: string, seq: number): Promise<void> {
    const ref = refOf(ctx, doc);
    const record = await liveDocument(ctx, doc);
    const head = await d.logs.head(ref);
    if (seq > head.seq)
      throw new ApiError('not_found', `no content at seq ${seq}; the head is ${head.seq}`);
    // The head, a named version and what the caller's gate allows (ADR 0034); a service credential
    // reads full history.
    await refuseSeqBelowGate(d, ctx.caller, ref, record, head.seq, seq);
  }

  const listFields: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // 07 §12 has no row for fields; `view`, as FRW-060 assumes (D145).
    guard(ctx.caller, 'read.head', doc);
    await liveDocument(ctx, doc);
    const c = await k.readAs(ctx, doc);
    // Fields inside a region hidden from the caller are not in the projection (ADR 0019).
    const all = projectedFields(c.doc).map((f) => f.info);
    const etag = `"f.${c.incarnation}.${c.seq}.${c.view}"`;
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');
    const start = cursor === null ? 0 : Number(d.cursors.open(`fields/${doc}/${c.seq}`, cursor));
    const page = all.slice(start, start + limit);
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' };
    if (cursor === null && notModified(ctx, etag)) return { status: 304, headers };
    return json(
      200,
      {
        items: page,
        nextCursor:
          start + limit < all.length
            ? d.cursors.issue(`fields/${doc}/${c.seq}`, String(start + limit))
            : null,
      },
      headers,
    );
  };

  const getFieldValues: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const seq = seqParam(ctx.url, 'seq');
    guard(ctx.caller, seq === undefined ? 'read.head' : 'read.history', doc);
    if (seq !== undefined) await gate(ctx, doc, seq);
    else await liveDocument(ctx, doc);
    const c = await k.readAs(ctx, doc, seq);
    const keys = ctx.url.searchParams.getAll('key');
    // Values the caller may not read are the projection's redaction marker (ADR 0019).
    const values = valuesByKey(projectedFields(c.doc), keys);
    // `?format=csv` is the spreadsheet output (FRW-064; ADR 0410, proposed): the same values and the
    // same projection, one row each, with a leading formula character neutralised. The JSON a
    // client reads is unchanged.
    const format = ctx.url.searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'csv')
      throw new ApiError('validation_failed', 'format is json or csv', {
        violations: [{ path: 'format', rule: 'json or csv' }],
      });
    const etag = format === 'csv' ? valuesEtag(c).replace(/"$/, ':csv"') : valuesEtag(c);
    const headers = {
      ETag: etag,
      // As for content (D70): pinned reads are immutable, and every read is private.
      'Cache-Control':
        seq !== undefined ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    };
    if (notModified(ctx, etag)) return { status: 304, headers };
    if (format === 'csv')
      return {
        status: 200,
        bytes: Buffer.from(
          fieldValuesCsv(Object.entries(values).map(([key, v]) => ({ key, value: valueText(v) }))),
          'utf8',
        ),
        headers: {
          ...headers,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="field-values.csv"',
        },
      };
    return json(200, { values, seq: c.seq, view: c.view }, headers);
  };

  /**
   * Prefill by key (12 §9; FRW-061): a service credential, or `manage` (D145, the owner's question
   * of FRW-061 with the default of the matrix's row 10). Atomic; refused while a workflow is active
   * (`workflow_active`).
   */
  const prefillFieldValues: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const current = await k.readAs(ctx, doc);
    checkIfMatch(ctx.req, valuesEtag(current));
    const body = (await ctx.body()) as { values?: Record<string, unknown> };
    const values = body.values ?? {};
    if (Object.keys(values).length === 0)
      throw new ApiError('validation_failed', 'a prefill names at least one key', {
        violations: [{ path: '/values', rule: 'at least one key' }],
      });
    const perms = await d.grants.current(ref);
    if (perms.workflowActive)
      throw new ApiError(
        'workflow_active',
        'a workflow is active; fields are filled by participants',
      );
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    // Every key and value first; nothing is applied when one is refused (FRW-061 criterion 3).
    const steps = prefillSteps(full.doc, values);
    const outbox = d.outbox;
    if (!outbox)
      throw new ApiError('unavailable', 'server-authored commits are not delivered here');
    const item = await outbox.enqueue({
      tenant: ref.tenant,
      doc: ref.doc,
      // Deterministic (SYN-030 criterion 3): the same prefill by the same caller against the same
      // head is the same request, so a retry stores one item and one commit (ADR 0377, proposed).
      commitId: derivedCommitId(
        'prefill',
        ref.tenant,
        ref.doc,
        ctx.caller.actor,
        String(head.seq),
        stableJson(steps),
      ),
      kind: 'author',
      // The preconditions the authorisation relied on (SYN-030 criterion 3): the room re-checks
      // them when it applies the commit and answers `conflict` if any has moved.
      request: {
        origin: 'prefill',
        actor: ctx.caller.actor,
        base: head.seq,
        steps,
        preconditions: {
          revision: perms.revision,
          head: head.seq,
          documentState: perms.documentState,
          workflowActive: perms.workflowActive,
        },
      },
    });
    // Wait for the room (or a transient authority) to store the commit (06 §2.2, §3).
    const deadline = d.now() + (d.outboxWaitMs ?? 10_000);
    let settled = item;
    while (settled.state === 'pending' && d.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = (await outbox.get(ref.tenant, item.id)) ?? settled;
    }
    if (settled.state === 'failed') {
      const r = settled.result as { code?: string; message?: string } | null;
      const code = r?.code === 'conflict' || r?.code === 'field_invalid' ? r.code : 'conflict';
      throw new ApiError(code, `the prefill was refused (${r?.code ?? 'refused'})`);
    }
    // Only a commit the room accepted or still holds is audited: a refused prefill changed nothing
    // (UX-097 criterion 4).
    // The audit trail names the person the change is attributed to and the credential that made it
    // (owner decision 174; UX-097 criterion 1; 07 §14). Identifiers and the origin only, never a value.
    if (d.audit)
      await d.audit.record([
        {
          id: uuid7(),
          tenant: ref.tenant,
          doc: ref.doc,
          actor: ctx.caller.actor,
          kind: 'commit.service',
          data: {
            origin: 'prefill',
            credential: ctx.caller.credential,
            commit: item.id,
            scopes: [],
          },
          at: d.now(),
        },
      ]);
    if (settled.state === 'pending')
      // Accepted: the outbox delivers it; the values are read back later (D145).
      return json(202, { values, seq: null, view: current.view });
    const after = await k.readAs(ctx, doc);
    const read = valuesByKey(projectedFields(after.doc), Object.keys(values));
    return json(
      200,
      { values: read, seq: after.seq, view: after.view },
      { ETag: valuesEtag(after) },
    );
  };

  return { listFields, getFieldValues, prefillFieldValues };
}
