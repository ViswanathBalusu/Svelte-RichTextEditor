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
import { checkWorkflowBody } from '@docedit/authority';
import { checkIfMatch } from './http.ts';
import { json, notModified, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import {
  NO_WORKFLOW_ETAG,
  toWire,
  type WorkflowResourceStore,
} from '../workflow/workflow-resource.ts';

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

  return { getWorkflow, putWorkflow };
}
