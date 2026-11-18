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
  bindParticipant,
  checkWorkflowBody,
  fieldOwnersOf,
  sendProblem,
  sendWorkflow,
  snapshotOf,
  workflowEvent,
  type SendProblem,
  type WorkflowEventName,
  type WorkflowParticipant,
} from '@docedit/authority';
import { createHash } from 'node:crypto';
import { canonicalize } from '@docedit/model';
import { recordCorrection, recordResume } from '../workflow/correction.ts';
import { recordDecline, recordVoid, type StopOutcome } from '../workflow/stop.ts';
import { recordRemind } from '../workflow/schedule-sweep.ts';
import {
  registerParticipantCode,
  verifyParticipantCode,
  type AccessCodeProblem,
} from '../workflow/access-code-service.ts';
import { acceptConsent, type ConsentProblem } from '../workflow/consent-service.ts';
import { recordOf } from '../workflow/record.ts';
import { signField, type SignProblem } from '../workflow/sign-service.ts';
import { completeMyPart, type CompleteProblem } from '../workflow/complete-service.ts';
import type { ProgressOutcome } from '../workflow/progress.ts';
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

  /** The webhooks of a transition carry the control commit's `seq` and the chain head (ADR 0382). */
  const raiseAll = async (
    ctx: Parameters<Handler>[0],
    doc: string,
    out: Extract<ProgressOutcome, { ok: true }>,
  ): Promise<void> => {
    const ref = k.refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const chain =
      (await d.logs.state?.(ref))?.chainHead ??
      out.resource.sentHash?.replace(/^sha256:/, '') ??
      '';
    const at = { seq: out.control?.seq ?? head.seq, chainHead: out.control?.chainHead ?? chain };
    for (const e of out.raised) {
      const event = workflowEvent(e.name, {
        workflow: out.resource.id,
        document: doc,
        ...at,
        ...(e.participant !== undefined ? { participant: e.participant } : {}),
      });
      k.emit(ctx, event.type, doc, { ...event.data });
    }
  };

  const problemOf = (
    doc: string,
    problem: Extract<ProgressOutcome | StopOutcome, { ok: false }>['problem'],
  ) => {
    switch (problem.code) {
      case 'reason_required':
        return new ApiError('validation_failed', 'a reason is required', {
          violations: [{ path: '/reason', rule: 'a reason is required' }],
        });
      case 'not_found':
        return new ApiError('not_found', `document ${doc} has no workflow`);
      case 'forbidden':
        return new ApiError('forbidden', 'the caller may not do this');
      case 'invalid_state':
        return new ApiError('conflict', `the workflow is ${problem.state}`);
      case 'conflict':
        return new ApiError('conflict', `the workflow is ${problem.state}`);
    }
  };

  const transitionDeps = () => ({
    workflows: store(),
    grants: d.grants,
    logs: d.logs,
    notifier: d.notifier,
    ...(d.audit ? { audit: d.audit } : {}),
    now: d.now,
    controlWaitMs: CONTROL_WAIT_MS,
  });

  /**
   * `POST /documents/{id}/workflow/correct` (12 §6.2 `correct`; FRW-032; method and path assumed,
   * G95). Needs `manage`. An `in_progress` workflow moves to `correcting`: the document is unlocked
   * for the owner, the participants are paused, a control commit records it and `corrected` is
   * raised. Any other state is `conflict`.
   */
  const correctWorkflowRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const out = await recordCorrection(transitionDeps(), {
      ref: k.refOf(ctx, doc),
      actor: ctx.caller.actor,
    });
    if (!out.ok) throw problemOf(doc, out.problem);
    await raiseAll(ctx, doc, out);
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /**
   * `POST /documents/{id}/workflow/resume` (12 §6.2 `resume`; FRW-032; method and path assumed,
   * G95). Needs `manage`. The document at the head is compared with the document at `sentSeq`
   * (the whole document, not the caller's projection); the participants the change concerns are
   * reset, the document is locked again and the workflow returns to `in_progress`.
   */
  const resumeWorkflowRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const workflows = store();
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const ref = k.refOf(ctx, doc);
    const current = await workflows.read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    if (current.state !== 'correcting' || current.sentSeq === null)
      throw new ApiError(
        'conflict',
        `the workflow is ${current.state}; only a corrected one is resumed`,
      );
    const head = await d.logs.head(ref);
    const [sent, now] = await Promise.all([
      d.content.rebuild(ref, head.incarnation, current.sentSeq),
      d.content.rebuild(ref, head.incarnation, head.seq),
    ]);
    const out = await recordResume(transitionDeps(), {
      ref,
      actor: ctx.caller.actor,
      sent: snapshotOf({ cdm: sent.cdm, requires: sent.requires, doc: sent.doc }),
      head: snapshotOf({ cdm: now.cdm, requires: now.requires, doc: now.doc }),
      owners: fieldOwnersOf(
        { cdm: now.cdm, requires: now.requires, doc: now.doc },
        current.participants,
      ),
    });
    if (!out.ok) throw problemOf(doc, out.problem);
    await raiseAll(ctx, doc, out);
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /**
   * `POST /documents/{id}/workflow/void` (12 §6.2 `void`; FRW-033; method and path assumed, G95).
   * Needs `manage` and a reason. A workflow that is `sent` or `in_progress` becomes `voided`; the
   * document stays locked and nobody fills it any more. Any other state is `conflict`; a blank
   * reason is `validation_failed` and nothing changes.
   */
  const voidWorkflowRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const body = (await ctx.body()) as { reason: string };
    const out = await recordVoid(transitionDeps(), {
      ref: k.refOf(ctx, doc),
      actor: ctx.caller.actor,
      reason: body.reason,
    });
    if (!out.ok) throw problemOf(doc, out.problem);
    await raiseAll(ctx, doc, out);
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /**
   * `POST /documents/{id}/workflow/participants/{pid}/decline` (12 §6.2 `decline`; FRW-033; method
   * and prefix assumed, G95). The caller is a user whose token binds to `pid` (`wfp` names the
   * participant and `sub` is the one recorded for them, `bindParticipant`, FRW-038), or the host's
   * service credential. Any other user is `forbidden`. A participant who is a `cc`,
   * or a workflow that is not `in_progress`, is refused; a blank reason is `validation_failed`.
   */
  const declineRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const pid = ctx.params['pid']!;
    const identity = ctx.caller.identity;
    await liveDocument(ctx, doc);
    const current = await store().read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    // The host's service credential acts for the participant it names (05 §6.1: it may act on every
    // route); a user acts only for the participant their token is bound to.
    if (ctx.caller.kind === 'user') {
      if (identity === null || identity.docs[doc] === undefined)
        throw new ApiError('forbidden', 'the token does not cover this document');
      const bound = bindParticipant(
        {
          sub: identity.sub,
          ...(identity.asserted?.wfp !== undefined ? { wfp: identity.asserted.wfp } : {}),
        },
        recordOf(current),
      );
      if (!bound.ok || bound.participant.id !== pid)
        throw new ApiError('forbidden', 'the token is not bound to this participant');
    }
    const body = (await ctx.body()) as { reason: string };
    const out = await recordDecline(transitionDeps(), {
      ref: k.refOf(ctx, doc),
      actor: ctx.caller.actor,
      participant: pid,
      reason: body.reason,
    });
    if (!out.ok) throw problemOf(doc, out.problem);
    await raiseAll(ctx, doc, out);
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /**
   * `POST /documents/{id}/workflow/remind` (12 §6.2 `remind`; FRW-034; method and path assumed,
   * G95). Needs `manage`. Raises `reminder_due` at once for each active participant who has not
   * completed; the workflow is not changed and the schedule's count of reminders is not touched. A
   * workflow that is not `sent` or `in_progress` is `conflict`.
   */
  const remindWorkflowRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const workflows = store();
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const out = await recordRemind({ workflows }, { ref: k.refOf(ctx, doc), manage: true });
    if (!out.ok) throw problemOf(doc, out.problem);
    await raiseAll(ctx, doc, {
      ok: true,
      changed: false,
      resource: out.resource,
      control: null,
      raised: out.raised,
    });
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /** The answer to a problem of the access code. */
  const codeProblem = (doc: string, p: AccessCodeProblem): ApiError => {
    switch (p.code) {
      case 'not_found':
        return new ApiError('not_found', `document ${doc} has no such participant`);
      case 'not_required':
        return new ApiError('conflict', 'the participant needs no access code');
      case 'invalid_state':
        return new ApiError('conflict', `the workflow is ${p.state}`);
      case 'conflict':
        return new ApiError('conflict', `the workflow is ${p.state}`);
      case 'not_registered':
        return new ApiError('conflict', 'no access code is registered for the participant');
      case 'wrong_code':
        return new ApiError('forbidden', 'the access code is wrong');
      case 'rate_limited':
        return new ApiError('rate_limited', 'too many wrong access codes', {
          retryAfterMs: p.retryAfterMs,
        });
    }
  };

  const accessDeps = () => {
    if (!d.accessCodes || !d.evidence)
      throw new ApiError('not_found', 'this server keeps no access codes');
    return { ...transitionDeps(), codes: d.accessCodes, evidence: d.evidence, events: d.events };
  };

  /** The code of a body: a string of 1 to 255 characters, else `validation_failed`. */
  const codeOf = async (ctx: Parameters<Handler>[0]): Promise<string> => {
    const body = (await ctx.body()) as { code?: unknown } | null;
    const code = body?.code;
    if (typeof code !== 'string' || code.length < 1 || code.length > 255)
      throw new ApiError('validation_failed', 'a code of 1 to 255 characters is required', {
        violations: [{ path: '/code', rule: 'a code of 1 to 255 characters is required' }],
      });
    return code;
  };

  /**
   * `POST /documents/{id}/workflow/participants/{pid}/access-code` (FRW-039; method and path
   * assumed, G95; ADR 0393, proposed). Needs `manage`. The host registers the code of a participant
   * whose `auth.require` lists `access_code`; only a salted hash is kept and nothing about the code
   * is returned. A participant who needs none is `conflict`.
   */
  const registerAccessCodeRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const pid = ctx.params['pid']!;
    const deps = accessDeps();
    guard(ctx.caller, 'manage', doc);
    await liveDocument(ctx, doc);
    const out = await registerParticipantCode(deps, {
      ref: k.refOf(ctx, doc),
      participant: pid,
      code: await codeOf(ctx),
    });
    if (!out.ok) throw codeProblem(doc, out.problem);
    return { status: 204 };
  };

  /**
   * `POST /documents/{id}/workflow/participants/{pid}/verify` (12 §7; FRW-039; method and prefix
   * assumed, G95). The caller is a user whose token binds to `pid` (`wfp` and `sub`, FRW-038): the
   * host's service credential does not prove the code for the person. A wrong code is `forbidden`
   * and raises `auth_failed`; repeated wrong codes are `rate_limited` with `retryAfterMs`. A correct
   * code lets the participant fill.
   */
  const verifyAccessCodeRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const pid = ctx.params['pid']!;
    const deps = accessDeps();
    const identity = ctx.caller.identity;
    await liveDocument(ctx, doc);
    const current = await store().read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    if (!current.participants.some((p) => p.id === pid))
      throw new ApiError('not_found', `document ${doc} has no such participant`);
    if (ctx.caller.kind !== 'user' || identity === null || identity.docs[doc] === undefined)
      throw new ApiError('forbidden', 'only the participant proves their own access code');
    const bound = bindParticipant(
      {
        sub: identity.sub,
        ...(identity.asserted?.wfp !== undefined ? { wfp: identity.asserted.wfp } : {}),
      },
      recordOf(current),
    );
    if (!bound.ok || bound.participant.id !== pid)
      throw new ApiError('forbidden', 'the token is not bound to this participant');
    const agent = ctx.req.headers['user-agent'];
    const out = await verifyParticipantCode(deps, {
      ref: k.refOf(ctx, doc),
      actor: ctx.caller.actor,
      participant: pid,
      code: await codeOf(ctx),
      // The facts of the request: the socket's address and the `User-Agent` header (FRW-040).
      facts: {
        address: ctx.req.socket.remoteAddress ?? null,
        userAgent: typeof agent === 'string' && agent.length > 0 ? agent.slice(0, 512) : null,
        amr: identity.asserted?.amr ?? null,
      },
    });
    if (!out.ok) throw codeProblem(doc, out.problem);
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-cache',
    });
  };

  /** The answer to a problem of the consent step. */
  const consentProblem = (doc: string, p: ConsentProblem): ApiError => {
    switch (p.code) {
      case 'not_found':
        return new ApiError('not_found', `document ${doc} has no such participant`);
      case 'invalid_state':
        return new ApiError('conflict', `the workflow is ${p.state}`);
      case 'no_consent':
        return new ApiError('conflict', 'the workflow names no consent text');
      case 'not_applicable':
        return new ApiError('conflict', `a participant of kind ${p.kind} accepts no consent text`);
      case 'awaiting_code':
        return new ApiError('conflict', 'the participant has not yet given their access code');
      case 'text_missing':
        return new ApiError(
          'conflict',
          'the service holds no text for the consent the workflow names',
        );
    }
  };

  /**
   * `POST /documents/{id}/workflow/participants/{pid}/consent` (12 §7, §8.1 step 1; FRW-044; method
   * and prefix assumed, G95; ADR 0395, proposed). The caller is the participant: a user whose token
   * binds to `pid`. The body is empty or `{}`: the text, its version and its hash are the service's,
   * so a body that carries any member, a hash included, is `validation_failed`. The answer is the
   * acceptance as recorded: the text identifier, the version, the hash the service computed and the
   * server time.
   */
  const consentRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const pid = ctx.params['pid']!;
    if (!d.consentTexts || !d.evidence || !d.workflows)
      throw new ApiError('not_found', 'this server keeps no consent texts');
    const body = (await ctx.body()) as Record<string, unknown> | null | undefined;
    if (body !== null && body !== undefined) {
      if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)
        throw new ApiError(
          'validation_failed',
          'the consent request has no body: the service holds the text',
          {
            violations: [{ path: '/', rule: 'an empty body' }],
          },
        );
    }
    const identity = ctx.caller.identity;
    await liveDocument(ctx, doc);
    const current = await store().read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    if (!current.participants.some((p) => p.id === pid))
      throw new ApiError('not_found', `document ${doc} has no such participant`);
    if (ctx.caller.kind !== 'user' || identity === null || identity.docs[doc] === undefined)
      throw new ApiError('forbidden', 'only the participant accepts the consent');
    const bound = bindParticipant(
      {
        sub: identity.sub,
        ...(identity.asserted?.wfp !== undefined ? { wfp: identity.asserted.wfp } : {}),
      },
      recordOf(current),
    );
    if (!bound.ok || bound.participant.id !== pid)
      throw new ApiError('forbidden', 'the token is not bound to this participant');
    const agent = ctx.req.headers['user-agent'];
    const out = await acceptConsent(
      { workflows: d.workflows, evidence: d.evidence, texts: d.consentTexts, now: d.now },
      {
        ref: k.refOf(ctx, doc),
        participant: pid,
        facts: {
          address: ctx.req.socket.remoteAddress ?? null,
          userAgent: typeof agent === 'string' && agent.length > 0 ? agent.slice(0, 512) : null,
          amr: identity.asserted?.amr ?? null,
        },
      },
    );
    if (!out.ok) throw consentProblem(doc, out.problem);
    return json(
      200,
      {
        textId: out.accepted.textId,
        version: out.accepted.version,
        hash: out.accepted.hash,
        acceptedAt: new Date(out.accepted.atMs).toISOString(),
      },
      { 'Cache-Control': 'private, no-store' },
    );
  };

  /** The answer to a problem of the signing. */
  const signProblem = (doc: string, p: SignProblem): ApiError => {
    switch (p.code) {
      case 'not_found':
        return new ApiError('not_found', `document ${doc} has no such ${p.what}`);
      case 'invalid_state':
        return new ApiError('conflict', `the workflow is ${p.state}`);
      case 'refused':
        return new ApiError('forbidden', p.reason);
      case 'consent':
        return new ApiError('forbidden', `the consent is not on record: ${p.reason}`);
      case 'already_signed':
        return new ApiError('conflict', 'the field is already signed');
      case 'not_stored':
        return new ApiError('conflict', `the signing was not stored (${p.reason})`);
      case 'adoption': {
        const a = p.problem;
        switch (a.code) {
          case 'validation_failed':
            return new ApiError('validation_failed', `${a.path} must be ${a.rule}`, {
              violations: [{ path: a.path, rule: a.rule }],
            });
          case 'not_found':
            return new ApiError('not_found', 'no such signature image for this document');
          case 'forbidden':
            return new ApiError('forbidden', 'the image was not adopted by the signer');
          case 'not_ready':
            return new ApiError('conflict', `the image is ${a.state}, not ready`);
          case 'failed':
            return new ApiError('conflict', `the image failed its checks: ${a.reason}`);
          case 'not_an_image':
            return new ApiError('conflict', 'the asset is not an image');
          case 'corrupt':
            return new ApiError('conflict', 'the stored image does not match its recorded hash');
        }
      }
    }
  };

  /**
   * `POST /documents/{id}/fields/{fid}/sign` (12 §8.1 step 3; FRW-046; ADR 0397, proposed). The
   * caller is the participant: a user token bound to a participant of the workflow. The body names
   * the adopted image, `{ asset, mode }`. The service checks the P7 conditions and the consent,
   * writes one commit with origin `sign` that sets the field and the `dateSigned` fields of its role,
   * records the evidence and raises `field_completed`. A repeat (same `Idempotency-Key`, or the same
   * request) writes one commit. A refusal writes nothing.
   */
  const signRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const fid = ctx.params['fid']!;
    if (!d.consentTexts || !d.evidence || !d.workflows || !d.assetRegistry || !d.outbox)
      throw new ApiError('not_found', 'this server does not offer signing');
    const body = (await ctx.body()) as { asset?: unknown; mode?: unknown } | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError('validation_failed', 'the body is { asset, mode }', {
        violations: [{ path: '/', rule: 'an object with asset and mode' }],
      });
    for (const key of Object.keys(body))
      if (key !== 'asset' && key !== 'mode')
        throw new ApiError('validation_failed', `the body has no member ${key}`, {
          violations: [{ path: `/${key}`, rule: 'asset and mode only' }],
        });
    const identity = ctx.caller.identity;
    await liveDocument(ctx, doc);
    const current = await store().read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    if (ctx.caller.kind !== 'user' || identity === null || identity.docs[doc] === undefined)
      throw new ApiError('forbidden', 'only a participant signs');
    const bound = bindParticipant(
      {
        sub: identity.sub,
        ...(identity.asserted?.wfp !== undefined ? { wfp: identity.asserted.wfp } : {}),
      },
      recordOf(current),
    );
    if (!bound.ok) throw new ApiError('forbidden', 'the token is not bound to a participant');
    const agent = ctx.req.headers['user-agent'];
    const out = await signField(
      {
        workflows: d.workflows,
        evidence: d.evidence,
        texts: d.consentTexts,
        assets: d.assetRegistry,
        finals: d.assets,
        logs: d.logs,
        content: d.content,
        grants: d.grants,
        outbox: d.outbox,
        events: d.events,
        now: d.now,
        ...(d.outboxWaitMs !== undefined ? { waitMs: d.outboxWaitMs } : {}),
      },
      {
        ref: k.refOf(ctx, doc),
        actor: ctx.caller.actor,
        participant: bound.participant.id,
        field: fid,
        body: { asset: body.asset, mode: body.mode },
        facts: {
          address: ctx.req.socket.remoteAddress ?? null,
          userAgent: typeof agent === 'string' && agent.length > 0 ? agent.slice(0, 512) : null,
          amr: identity.asserted?.amr ?? null,
        },
      },
    );
    if (!out.ok) throw signProblem(doc, out.problem);
    const { signed } = out;
    return json(
      200,
      {
        field: fid,
        value: signed.value,
        seq: signed.seq,
        chainHash: signed.chainHash,
        ...(signed.dateSigned !== null ? { dateSigned: signed.dateSigned } : {}),
      },
      { 'Cache-Control': 'private, no-store' },
    );
  };

  /** The answer to a problem of the completion. */
  const completeProblem = (doc: string, p: CompleteProblem): ApiError => {
    switch (p.code) {
      case 'not_found':
        return new ApiError('not_found', `document ${doc} has no such ${p.what}`);
      case 'invalid_state':
        return new ApiError('conflict', `the workflow is ${p.state}`);
      case 'forbidden':
        return new ApiError('forbidden', p.reason);
      case 'conflict':
        return new ApiError('conflict', `the workflow is ${p.state}`);
      case 'not_stored':
        return new ApiError('conflict', `the completion was not stored (${p.reason})`);
      case 'validation':
        return new ApiError(
          'validation_failed',
          'the fields do not pass: ' + p.problems.map((x) => x.key || x.code).join(', '),
          {
            violations: p.problems.map((x) => ({
              path: x.key === '' ? '/' : `/fields/${x.key}`,
              rule: x.rule !== undefined ? `${x.code} (${x.rule})` : x.code,
            })),
          },
        );
    }
  };

  /**
   * `POST /documents/{id}/workflow/participants/{pid}/complete` (12 §5.3, §6.2, §8.1 step 4; FRW-047;
   * method and prefix assumed, G95; ADR 0398, proposed). The caller is the participant: a user whose
   * token binds to `pid`. The body is empty or `{}`. The service checks the participant's fields,
   * writes the `rules` commit, marks the participant completed and answers the workflow resource. A
   * refusal because a field does not pass is `validation_failed` with one violation for each field
   * key and rule; the participant stays active. A second call answers the same and writes nothing.
   */
  const completeRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const pid = ctx.params['pid']!;
    if (!d.evidence || !d.workflows || !d.outbox)
      throw new ApiError('not_found', 'this server does not offer completion');
    const body = (await ctx.body()) as Record<string, unknown> | null | undefined;
    if (body !== null && body !== undefined) {
      if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)
        throw new ApiError('validation_failed', 'the completion request has no body', {
          violations: [{ path: '/', rule: 'an empty body' }],
        });
    }
    const identity = ctx.caller.identity;
    await liveDocument(ctx, doc);
    const current = await store().read(ctx.caller.tenant, doc);
    if (current === null) throw new ApiError('not_found', `document ${doc} has no workflow`);
    if (!current.participants.some((p) => p.id === pid))
      throw new ApiError('not_found', `document ${doc} has no such participant`);
    if (ctx.caller.kind !== 'user' || identity === null || identity.docs[doc] === undefined)
      throw new ApiError('forbidden', 'only the participant completes their part');
    const bound = bindParticipant(
      {
        sub: identity.sub,
        ...(identity.asserted?.wfp !== undefined ? { wfp: identity.asserted.wfp } : {}),
      },
      recordOf(current),
    );
    if (!bound.ok || bound.participant.id !== pid)
      throw new ApiError('forbidden', 'the token is not bound to this participant');
    const agent = ctx.req.headers['user-agent'];
    const out = await completeMyPart(
      {
        ...transitionDeps(),
        evidence: d.evidence,
        content: d.content,
        outbox: d.outbox,
        ...(d.outboxWaitMs !== undefined ? { waitMs: d.outboxWaitMs } : {}),
      },
      {
        ref: k.refOf(ctx, doc),
        actor: ctx.caller.actor,
        participant: pid,
        facts: {
          address: ctx.req.socket.remoteAddress ?? null,
          userAgent: typeof agent === 'string' && agent.length > 0 ? agent.slice(0, 512) : null,
        },
      },
    );
    if (!out.ok) throw completeProblem(doc, out.problem);
    if (out.changed)
      await raiseAll(ctx, doc, {
        ok: true,
        changed: true,
        resource: out.resource,
        control: out.control,
        raised: out.raised,
      });
    return json(200, toWire(out.resource), {
      ETag: out.resource.etag,
      'Cache-Control': 'private, no-store',
    });
  };

  return {
    getWorkflow,
    putWorkflow,
    sendWorkflow: sendWorkflowRoute,
    remindWorkflow: remindWorkflowRoute,
    participantVerify: verifyAccessCodeRoute,
    participantConsent: consentRoute,
    participantComplete: completeRoute,
    signField: signRoute,
    registerAccessCode: registerAccessCodeRoute,
    voidWorkflow: voidWorkflowRoute,
    participantDecline: declineRoute,
    correctWorkflow: correctWorkflowRoute,
    resumeWorkflow: resumeWorkflowRoute,
  };
}
