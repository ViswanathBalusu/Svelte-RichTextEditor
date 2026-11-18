/**
 * The workflow resource routes of 12 §6.1 and §10 (FRW-025): `GET` and `PUT /documents/{id}/workflow`.
 * The rules and the decisions taken where 12 is silent are in docs/adr/0371-w4-FRW-025-workflow-put.md
 * (proposed). Summary:
 *
 * - `GET` answers the resource with its `ETag` (the revision, quoted); a document without a workflow
 *   is `not_found`. Who may read it is not stated in 07 §12; the row of the head content is used,
 *   as for the fields (D145).
 * - `PUT` needs `manage` and `If-Match`. A document with no workflow has the ETag `"0"`: a `PUT`
 *   that carries it creates the workflow (state `draft`, revision 1), so a second creation, which
 *   carries `"0"` after the first, is refused as `precondition_failed`. Once the state is not
 *   `draft`, a `PUT` is refused as `workflow_active`.
 * - The body is checked by `checkWorkflowBody` (packages/authority): the members the server owns
 *   may be echoed and are ignored.
 */
import {
  activeParticipantIds,
  checkWorkflowBody,
  sendProblem,
  sendWorkflow,
  workflowEvent,
  type SendProblem,
  type WorkflowEventName,
  type WorkflowParticipant,
} from '@docedit/authority';
import { createHash } from 'node:crypto';
import { canonicalize } from '@docedit/model';
import { recordTransition } from '../workflow/transitions.ts';
import { checkIfMatch } from './http.ts';
import { json, notModified, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { BodyViolation } from './problems.ts';
import {
  NO_WORKFLOW_ETAG,
  toWire,
  type WorkflowResourceStore,
} from '../workflow/workflow-resource.ts';

/** How long the send waits for the room to record its control commit, ms (ADR 0382, point 5). */
const CONTROL_WAIT_MS = 500;

export function workflowRoutes(k: Kit): Record<string, Handler> {
  const { d, liveDocument } = k;

  const store = (): WorkflowResourceStore => {
    if (!d.workflows) throw new ApiError('not_found', 'this server keeps no workflows');
    return d.workflows;
  };

  const getWorkflow: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const workflows = store();
    // 07 §12 has no row for the workflow; the head content's row, as for the fields (D145).
    guard(ctx.caller, 'read.head', doc);
    await liveDocument(ctx, doc);
    const found = await workflows.read(ctx.caller.tenant, doc);
    if (found === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    const headers = { ETag: found.etag, 'Cache-Control': 'private, no-cache' };
    if (notModified(ctx, found.etag)) return { status: 304, headers };
    return json(200, toWire(found), headers);
  };

  const putWorkflow: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const workflows = store();
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const tenant = ctx.caller.tenant;
    const current = await workflows.read(tenant, doc);
    if (current !== null && current.state !== 'draft')
      throw new ApiError(
        'workflow_active',
        `the workflow is ${current.state}; only a draft is replaced (12 §10)`,
      );
    checkIfMatch(ctx.req, current?.etag ?? NO_WORKFLOW_ETAG);
    const checked = checkWorkflowBody(await ctx.body(), doc);
    if (!checked.ok)
      throw new ApiError('validation_failed', 'the workflow is not valid', {
        violations: checked.problems,
      });
    const result = await workflows.put(tenant, doc, current?.rev ?? 0, checked.input);
    if (!result.ok) {
      if (result.problem.code === 'workflow_active')
        throw new ApiError(
          'workflow_active',
          `the workflow is ${result.problem.state}; only a draft is replaced (12 §10)`,
        );
      throw new ApiError('precondition_failed', 'the resource changed since the ETag was read');
    }
    return json(result.created ? 201 : 200, toWire(result.resource), {
      ETag: result.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /** What the failures of the send list say, one violation each, with the identifier that failed. */
  const violationsOf = (failures: readonly SendProblem[]): BodyViolation[] =>
    failures.flatMap((f): BodyViolation[] => {
      switch (f.code) {
        case 'required_field_unassigned':
          return f.keys.map((key) => ({
            path: `/fields/${key}`,
            rule: 'a required field has an assignee',
          }));
        case 'role_without_participant':
          return f.roles.map((role) => ({
            path: `/roles/${role}`,
            rule: 'a role has a participant who holds it',
          }));
        case 'rules_invalid':
          return f.problems.map((p) => ({
            path: p.path,
            rule: `the rules validate (${p.code})`,
          }));
        case 'pending_suggestions':
          return f.suggestionIds.map((id) => ({
            path: `/suggestions/${id ?? ''}`,
            rule: 'no suggestion is unresolved',
          }));
      }
    });

  /**
   * `POST /documents/{id}/workflow/send` (12 §6.2 `send`; FRW-027; method and path assumed, G95).
   * Needs `manage`. Runs the send list over the whole document as it stands (not the caller's
   * projection), refuses with every failure and leaves the draft unchanged, or records the
   * transition (`recordTransition`, FRW-030): the lock, the control commit, `sentSeq` and the chain
   * hash, the first participants active. Then it stores the `sent` version at `sentSeq` and raises
   * `dep.workflow.sent` and one `dep.workflow.participant_activated` for each participant it
   * activated. A repeat with the same `Idempotency-Key` is answered from the stored response by the
   * pipeline; docs/adr/0383-w4-FRW-027-send-route.md (proposed) has the decisions.
   */
  const sendWorkflowRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const workflows = store();
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const ref = k.refOf(ctx, doc);
    const current = await workflows.read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);

    // The document as it stands, whole: a checklist over a projection would miss what the caller
    // may not read (ADR 0019).
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    // A document with no commit yet has no chain head: the hash of its canonical content stands for
    // it (docs/adr/0383-w4-FRW-027-send-route.md, point 3).
    const chain =
      (await d.logs.state?.(ref))?.chainHead ??
      createHash('sha256')
        .update(canonicalize({ cdm: full.cdm, requires: full.requires, doc: full.doc }))
        .digest('hex');
    const participants: WorkflowParticipant[] = current.participants.map((p) => ({
      id: p.id,
      roles: p.roles,
      kind: p.kind,
      order: p.order,
      completed: false,
      ...(p.sub !== undefined ? { sub: p.sub } : {}),
    }));
    const sent = sendWorkflow(
      {
        state: current.state as 'draft',
        participants,
        sentSeq: current.sentSeq,
        sentHash: current.sentHash,
        end: null,
      },
      { manage: true },
      { cdm: full.cdm, requires: full.requires, doc: full.doc },
      { seq: head.seq, hash: `sha256:${chain}` },
    );
    if (!sent.ok) {
      const problem = sendProblem(sent);
      throw new ApiError(problem.code, problem.detail, {
        violations: violationsOf(problem.failures),
      });
    }

    const active = new Set(activeParticipantIds(sent.record.participants));
    const out = await recordTransition(
      {
        workflows,
        grants: d.grants,
        logs: d.logs,
        notifier: d.notifier,
        ...(d.audit ? { audit: d.audit } : {}),
        now: d.now,
        controlWaitMs: CONTROL_WAIT_MS,
      },
      {
        ref,
        actor: ctx.caller.actor,
        from: current,
        write: {
          to: 'sent',
          sentSeq: sent.record.sentSeq!,
          sentHash: sent.record.sentHash!,
          participants: current.participants.map((p) => ({
            ...p,
            state: active.has(p.id) ? 'active' : 'pending',
          })),
        },
      },
    );
    if (!out.ok) {
      if (out.problem.code === 'not_found')
        throw new ApiError('not_found', `document ${doc} has no workflow`);
      throw new ApiError('conflict', `the workflow is ${out.problem.state}; only a draft is sent`);
    }

    // The `sent` version at `sentSeq` (08 §4). A second creation for the same seq and kind returns
    // the stored one, so a repeated send adds none.
    await d.versions?.create(ref, {
      seq: sent.record.sentSeq!,
      kind: 'sent',
      createdBy: ctx.caller.actor,
      createdAt: d.now(),
    });

    // The webhooks carry the control commit's `seq` and the chain head when the room wrote it in
    // time, else `sentSeq` and the chain head at the send (docs/adr/0382, point 5).
    const at = {
      seq: out.control?.seq ?? sent.record.sentSeq!,
      chainHead: out.control?.chainHead ?? chain,
    };
    const raise = (name: WorkflowEventName, participant?: string): void => {
      const event = workflowEvent(name, {
        workflow: out.resource.id,
        document: doc,
        ...at,
        ...(participant !== undefined ? { participant } : {}),
      });
      k.emit(ctx, event.type, doc, { ...event.data });
    };
    raise('sent');
    for (const p of current.participants)
      if (active.has(p.id)) raise('participant_activated', p.id);

    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  return { getWorkflow, putWorkflow, sendWorkflow: sendWorkflowRoute };
}
