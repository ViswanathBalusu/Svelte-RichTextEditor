/**
 * Templates (12 §9, §10; FRW-062; docs/adr/0406-w4-FRW-062-templates.md, proposed).
 *
 * - `POST /templates` marks a document as a template; `GET /templates` lists the templates of the
 *   tenant, oldest first; `GET /templates/{tid}` reads one. All three need a service credential: a
 *   template is a tenant-wide resource, and the host decides which documents are templates.
 * - `POST /documents` with `template` instantiates one (`instantiateTemplate`): a fork of the
 *   template document at a pinned `seq`, with participants bound to its roles and values prefilled
 *   in the same call. Everything is checked before anything is created, so a refused call leaves
 *   no document behind. The workflow, the grants and the state of the template are never copied:
 *   the new document starts as an active document with, at most, a draft workflow made from the
 *   participants of the call.
 */
import { checkWorkflowBody, type WorkflowInput } from '@docedit/authority';
import {
  formatTimestamp,
  uuid7,
  type JsonEnvelope,
  type JsonNode,
  type JsonValue,
} from '@docedit/model';
import type { CreateDocumentRequest } from '@docedit/protocol';
import { derivedCommitId, stableJson } from '../data-plane/commit-id.ts';
import type { DocumentRecord } from '../storage/types.ts';
import type { TemplateRecord } from '../workflow/template-store.ts';
import { prefillSteps } from './fields.ts';
import { actingConnection, refuseSeqBelowGate } from './gate.ts';
import { json, type HandlerDeps, type Kit } from './kit.ts';
import { type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

const wire = (t: TemplateRecord) => ({
  id: t.id,
  document: t.doc,
  name: t.name,
  createdAt: formatTimestamp(t.createdAtMs),
});

/** The `role_def` identifiers of a document, by walking its tree. */
function rolesOf(node: JsonNode | JsonValue): Set<string> {
  const roles = new Set<string>();
  const walk = (n: unknown): void => {
    if (typeof n !== 'object' || n === null) return;
    const o = n as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
    if (o.type === 'role_def' && typeof o.attrs?.id === 'string') roles.add(o.attrs.id);
    if (Array.isArray(o.content)) o.content.forEach(walk);
  };
  walk(node);
  return roles;
}

export function templateRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const store = () => {
    if (!d.templates) throw new ApiError('not_found', 'this server keeps no templates');
    return d.templates;
  };
  const serviceOnly = (ctx: Ctx): void => {
    if (ctx.caller.kind !== 'service')
      throw new ApiError('forbidden', 'templates are a service-credential resource (12 §9)');
  };

  const createTemplate: Handler = async (ctx) => {
    serviceOnly(ctx);
    const templates = store();
    const body = (await ctx.body()) as { document: string; name: string };
    await k.liveDocument(ctx, body.document);
    const record: TemplateRecord = {
      id: uuid7(d.now()),
      doc: body.document,
      name: body.name,
      createdBy: ctx.caller.actor,
      createdAtMs: d.now(),
    };
    if ((await templates.create(ctx.caller.tenant, record)) === 'exists')
      throw new ApiError('conflict', 'the document is a template already');
    return json(201, wire(record), { Location: `${k.rest}/templates/${record.id}` });
  };

  const listTemplates: Handler = async (ctx) => {
    serviceOnly(ctx);
    const rows = await store().list(ctx.caller.tenant);
    return json(200, { items: rows.map(wire), nextCursor: null });
  };

  const getTemplate: Handler = async (ctx) => {
    serviceOnly(ctx);
    const found = await store().get(ctx.caller.tenant, ctx.params['tid']!);
    if (found === null) throw new ApiError('not_found', `no template ${ctx.params['tid']!}`);
    return json(200, wire(found));
  };

  return { createTemplate, listTemplates, getTemplate };
}

/** What a document made from a template takes from the caller's request (FRW-062; FRW-063 rows). */
export type FromTemplateBody = Pick<
  CreateDocumentRequest,
  'participants' | 'values' | 'externalId' | 'title' | 'properties' | 'classification'
>;

export interface FromTemplate {
  readonly tenant: string;
  /** The surrogate of the person or service the work is done for. */
  readonly actor: string;
  /** The identifier of the new document. */
  readonly id: string;
  readonly template: TemplateRecord;
  /** The pinned seq of the template document, already read through the history gate. */
  readonly atSeq: number;
  /** The content of the template document at `atSeq`. */
  readonly full: { readonly cdm: number; readonly requires: string[]; readonly doc: JsonNode };
  readonly body: FromTemplateBody;
}

/**
 * Makes one document from a template at a pinned seq (FRW-062 criteria 1, 2 and 4): the content as
 * a fork has it, the participants as the draft workflow, the values as a `prefill` commit. Everything
 * is checked before anything is created. It does not read the template, check the caller or the
 * history gate: its callers do, once for many rows in a bulk send. Storage errors are thrown as
 * they are; the route translates them (`Kit.translate`).
 */
export async function createFromTemplate(
  d: HandlerDeps,
  input: FromTemplate,
): Promise<DocumentRecord> {
  const { tenant, actor, id, template, atSeq, full, body } = input;
  let workflow: WorkflowInput | null = null;
  if (body.participants !== undefined) {
    const checked = checkWorkflowBody({ participants: body.participants }, id);
    if (!checked.ok)
      throw new ApiError('validation_failed', 'the participants are not valid', {
        violations: checked.problems.map((p) => ({ path: p.path, rule: p.rule })),
      });
    const roles = rolesOf(full.doc);
    const unknown = checked.input.participants.flatMap((p, i) =>
      p.roles.filter((r) => !roles.has(r)).map((r) => ({ path: `/participants/${i}/roles`, r })),
    );
    if (unknown.length > 0)
      throw new ApiError('validation_failed', 'a participant holds a role the template lacks', {
        violations: unknown.map((u) => ({
          path: u.path,
          rule: `a role of the template (${u.r} is not)`,
        })),
      });
    workflow = checked.input;
  }
  const values = body.values ?? {};
  const steps = Object.keys(values).length > 0 ? prefillSteps(full.doc, values) : [];
  if (steps.length > 0 && !d.outbox)
    throw new ApiError('unavailable', 'server-authored commits are not delivered here');

  // The new document: the content first (D67), as a fork does it. Nothing of the template's
  // workflow, grants or state is copied: the document is active and has no workflow.
  const ref = { tenant, doc: id };
  const envelope = { cdm: full.cdm, requires: full.requires, doc: full.doc } as JsonEnvelope;
  await d.checkpoints.put(ref, 0, envelope);
  const record = await d.documents.create(tenant, {
    id,
    cdmVersion: full.cdm,
    requires: full.requires,
    createdBy: actor,
    fork: { from: template.doc, atSeq },
    ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.properties !== undefined ? { properties: body.properties } : {}),
    ...(body.classification !== undefined ? { label: body.classification } : {}),
  });

  // The participants are bound to the roles: the draft workflow of the new document.
  if (workflow !== null && d.workflows) {
    const put = await d.workflows.put(tenant, id, 0, workflow);
    if (!put.ok) throw new ApiError('conflict', 'the workflow could not be stored');
  }

  // The values are prefilled in a server-authored commit with origin `prefill`, as `PATCH
  // field-values` does it. The commit is awaited, so the call answers with the values in place.
  if (steps.length > 0 && d.outbox) {
    const perms = await d.grants.current(ref);
    const newHead = await d.logs.head(ref);
    const item = await d.outbox.enqueue({
      tenant,
      doc: id,
      commitId: derivedCommitId(
        'prefill',
        tenant,
        id,
        actor,
        String(newHead.seq),
        stableJson(steps),
      ),
      kind: 'author',
      request: {
        origin: 'prefill',
        actor,
        base: newHead.seq,
        steps,
        preconditions: {
          revision: perms.revision,
          head: newHead.seq,
          documentState: perms.documentState,
          workflowActive: perms.workflowActive,
        },
      },
    });
    const deadline = d.now() + (d.outboxWaitMs ?? 10_000);
    let settled = item;
    while (settled.state === 'pending' && d.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = (await d.outbox.get(tenant, item.id)) ?? settled;
    }
    if (settled.state !== 'done')
      throw new ApiError(
        settled.state === 'failed' ? 'conflict' : 'unavailable',
        'the values of the new document could not be prefilled',
      );
  }
  return record;
}

export interface Instantiated {
  readonly record: DocumentRecord;
  readonly template: { readonly id: string; readonly seq: number };
}

/**
 * Looks up a template for a request and pins the seq (FRW-062): the template must exist, its
 * document must be live, and the seq, the one asked for or the head, is read through the same
 * history gate as a fork (HIS-024). Returns the template, the pinned seq and the content at it.
 */
export async function pinTemplate(
  k: Kit,
  ctx: Ctx,
  templateId: string,
  templateSeq: number | undefined,
): Promise<{
  template: TemplateRecord;
  atSeq: number;
  full: FromTemplate['full'];
}> {
  const { d } = k;
  if (!d.templates) throw new ApiError('not_found', 'this server keeps no templates');
  const template = await d.templates.get(ctx.caller.tenant, templateId);
  if (template === null) throw new ApiError('not_found', `no template ${templateId}`);
  const sourceRecord = await k.liveDocument(ctx, template.doc);
  const source = k.refOf(ctx, template.doc);
  const head = await d.logs.head(source);
  const atSeq = templateSeq ?? head.seq;
  if (atSeq > head.seq)
    throw new ApiError('not_found', `no content at seq ${atSeq}; the head is ${head.seq}`);
  const named = ctx.req.headers['dep-actor'] !== undefined;
  await refuseSeqBelowGate(d, ctx.caller, source, sourceRecord, head.seq, atSeq, {
    what: 'templateSeq',
    ...(named ? { as: actingConnection(ctx.caller.actor) } : {}),
  });
  const full = await d.content.rebuild(source, head.incarnation, atSeq);
  return { template, atSeq, full: { cdm: full.cdm, requires: full.requires, doc: full.doc } };
}

/**
 * `POST /documents` with a `template` (FRW-062 criteria 1, 2, 4 and 6). The caller has a service
 * credential (`createDocument` is a service operation, as `forkDocument` is).
 */
export async function instantiateTemplate(
  k: Kit,
  ctx: Ctx,
  body: CreateDocumentRequest,
): Promise<Instantiated> {
  const pinned = await pinTemplate(k, ctx, body.template!, body.templateSeq);
  let record: DocumentRecord;
  try {
    record = await createFromTemplate(k.d, {
      tenant: ctx.caller.tenant,
      actor: ctx.caller.actor,
      id: uuid7(k.d.now()),
      ...pinned,
      body,
    });
  } catch (e) {
    k.translate(e);
  }
  return { record: record!, template: { id: pinned.template.id, seq: pinned.atSeq } };
}
