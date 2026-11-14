/**
 * The routes `GET /webhooks`, `POST /webhooks`, `GET|PATCH|DELETE /webhooks/{id}` (operations
 * listWebhooks, createWebhook, getWebhook, updateWebhook, deleteWebhook; 05 section 6.2 and 7;
 * 13 section 10; UX-079). The operations themselves are in `WebhookSubscriptions`
 * (webhook-subscriptions.ts). This module only maps their answers to replies and reads the
 * request's `If-Match`.
 *
 * The pipeline has already verified the credential and fixed the tenant. The service-credential
 * rule of each route refuses a user token with `forbidden` before this handler runs, and the
 * operations check it again.
 *
 * A server composed without a subscription store does not offer the routes (`not_found`), as for
 * the other optional parts of `HandlerDeps`.
 */
import { uuid7 } from '@docedit/model';
import { ifMatchTags } from './http.ts';
import { json, type Kit } from './kit.ts';
import type { Ctx, Handler, Reply } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { Answer, WebhookSubscriptions } from './webhook-subscriptions.ts';

/**
 * Records a successful change of a webhook subscription on the audit trail (UX-079 criterion 3;
 * kind `webhook.changed`, a proposed name in docs/adr/0330-lane-V-UX-076-090.md). The record holds
 * the subscription's identifier and the operation only: never the secret. Recorded after the
 * operation returns, so a refused change is not audited.
 */
async function auditWebhookChange(
  k: Kit,
  ctx: Ctx,
  operation: 'created' | 'updated' | 'deleted',
  subscription: string,
): Promise<void> {
  await k.d.audit?.record([
    {
      id: uuid7(),
      tenant: ctx.caller.tenant,
      doc: null,
      actor: ctx.caller.actor,
      kind: 'webhook.changed',
      data: { subscription, operation },
      at: k.d.now(),
    },
  ]);
}

/**
 * An operation's answer as a reply: the ETag and Location headers, and no body for 204. The
 * operations give a Location relative to the REST base (`/webhooks/{id}`); the reply makes it the
 * full URL under the REST base (`k.rest`, for example `https://host/v1`), as the other routes do.
 */
function replyOf(answer: Answer, rest: string): Reply {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (answer.etag !== undefined) headers['ETag'] = answer.etag;
  if (answer.location !== undefined) headers['Location'] = `${rest}${answer.location}`;
  if (answer.status === 204) return { status: 204, headers };
  return json(answer.status, answer.body, headers);
}

export function webhookRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const subs = (): WebhookSubscriptions => {
    if (!d.webhooks) throw new ApiError('not_found', 'this server keeps no webhook subscriptions');
    return d.webhooks;
  };

  const listWebhooks: Handler = async (ctx) => replyOf(await subs().list(ctx.caller), k.rest);

  const createWebhook: Handler = async (ctx) => {
    const answer = await subs().create(ctx.caller, await ctx.body());
    const id = (answer.body as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string') await auditWebhookChange(k, ctx, 'created', id);
    return replyOf(answer, k.rest);
  };

  const getWebhook: Handler = async (ctx) =>
    replyOf(await subs().get(ctx.caller, ctx.params['id'] ?? ''), k.rest);

  const updateWebhook: Handler = async (ctx) => {
    const id = ctx.params['id'] ?? '';
    const answer = await subs().update(ctx.caller, id, await ctx.body(), ifMatchTags(ctx.req));
    await auditWebhookChange(k, ctx, 'updated', id);
    return replyOf(answer, k.rest);
  };

  const deleteWebhook: Handler = async (ctx) => {
    const id = ctx.params['id'] ?? '';
    const answer = await subs().remove(ctx.caller, id, ifMatchTags(ctx.req));
    await auditWebhookChange(k, ctx, 'deleted', id);
    return replyOf(answer, k.rest);
  };

  return { listWebhooks, createWebhook, getWebhook, updateWebhook, deleteWebhook };
}
