/**
 * Notifications on the socket (05 §5.6) and webhooks of the events plane (05 §7), as data
 * (PRO-003). Webhook bodies are CloudEvents 1.0 in structured JSON mode; `type` is the event name
 * with a version suffix and `subject` is the document identifier.
 */
import {
  type Annotated,
  type NamedShape,
  type Prop,
  type Shape,
  lit,
  obj,
  opt,
  req,
  seq,
  str,
} from './shapes.ts';
import { NOTIFICATION_TYPE_SHAPE } from './notifications.ts';

export { NOTIFICATIONS, NOTIFICATION_TYPE_SHAPE, type NotificationDef } from './notifications.ts';

export interface WebhookDef extends Annotated {
  /** The event name without the version suffix, for example `dep.export.completed`. */
  name: string;
  version: number;
  when: string;
  spec: string;
  /** Members of `data` beyond `seq`. */
  data: Record<string, Prop>;
  owner: string;
}

// Marked pure, so that a build that never reads `WEBHOOKS` (the client does not) drops them (FND-008).
/* @__NO_SIDE_EFFECTS__ */
const w = (
  name: string,
  when: string,
  data: WebhookDef['data'] = {},
  extra: Annotated = {},
): WebhookDef => ({
  name,
  version: 1,
  when,
  spec: '05 §7',
  data,
  owner: 'PRO',
  ...extra,
});

export const WEBHOOKS: readonly WebhookDef[] = [
  w('dep.document.created', 'A document was created.'),
  w('dep.document.deleted', 'A document was deleted (soft delete).'),
  w('dep.document.state_changed', 'The document state changed (`active`, `locked`, `archived`).'),
  w(
    'dep.document.changed',
    'Content changed. Debounced to at most once per 10 seconds per document.',
    {
      chainHead: req(
        str({ format: 'sha256' }),
        'The hash-chain head, so that a host can anchor it independently (08 §12). Placeholder name.',
        {
          gaps: ['G83'],
        },
      ),
    },
  ),
  w('dep.version.created', 'A named version was created.'),
  w('dep.version.restored', 'A version was restored.'),
  w('dep.grants.changed', 'Region grants changed.'),
  w('dep.region.state_changed', 'A region state changed (07 §11).'),
  w('dep.session.joined', 'A session joined the document.'),
  w('dep.session.left', 'A session left the document.'),
  w('dep.thread.created', 'A thread was created.'),
  w('dep.thread.resolved', 'A thread was resolved.'),
  w('dep.thread.reopened', 'A thread was reopened.'),
  w('dep.thread.deleted', 'A thread was deleted.'),
  w('dep.comment.created', 'A comment was created.'),
  w(
    'dep.comment.mentioned',
    'A comment mentions someone; the host sends the notification (13 §5).',
  ),
  w('dep.task.assigned', 'A thread was assigned as a task.'),
  w('dep.export.completed', 'An export job completed.'),
  w('dep.export.failed', 'An export job failed.'),
  w('dep.import.completed', 'An import job completed.'),
  w('dep.import.failed', 'An import job failed.'),
  w(
    'dep.commit.rejected',
    'A commit was rejected with `permission_denied` or `invalid_op`. Throttled. Useful for security monitoring.',
    {},
    { gaps: ['G84'] },
  ),
];

/** The full CloudEvents `type` of a webhook, for example `dep.export.completed.v1`. */
export const webhookType = (def: WebhookDef): string => `${def.name}.v${def.version}`;

/** PascalCase base name for the generated types of a webhook, for example `ExportCompleted`. */
export const webhookTypeName = (def: WebhookDef): string =>
  def.name
    .replace(/^dep\./, '')
    .split(/[._]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

/** The `data` shape of a webhook: `seq` plus its own members (05 §7: "`data` is small and includes `seq`"). */
export function webhookData(def: WebhookDef): Shape {
  return obj(
    { seq: req(seq(), 'The document head the event refers to.'), ...def.data },
    {
      doc: `Data of \`${webhookType(def)}\`: ${def.when}`,
      spec: def.spec,
      gaps: ['G83', ...(def.gaps ?? [])],
    },
  );
}

/** The CloudEvents members of a webhook body (05 §7), with `type` and `data` given. */
function cloudEvent(type: Shape, data: Shape, doc: string): Shape {
  return obj(
    {
      specversion: req(str({ enum: ['1.0'] })),
      id: req(str({ minLength: 1 }), 'Event identifier.', { gaps: ['G82'] }),
      source: req(str({ format: 'uri-reference', minLength: 1 }), undefined, { gaps: ['G82'] }),
      type: req(
        type,
        'The event name with its version suffix, for example `dep.export.completed.v1`.',
      ),
      subject: req(str({ format: 'uuid7' }), 'The document identifier.'),
      time: opt(str({ format: 'timestamp' }), undefined, { gaps: ['G82'] }),
      datacontenttype: opt(str({ enum: ['application/json'] })),
      data: req(data),
    },
    {
      doc: `${doc} Requests are signed as described by Standard Webhooks: headers \`webhook-id\`, \`webhook-timestamp\`, \`webhook-signature\`, HMAC-SHA256, five-minute tolerance.`,
      spec: '05 §7',
      gaps: ['G82'],
    },
  );
}

/** The whole body of one webhook. */
export function webhookEnvelope(def: WebhookDef): Shape {
  return cloudEvent(
    lit(webhookType(def)),
    webhookData(def),
    `The body of \`${webhookType(def)}\`: a CloudEvents 1.0 event in structured JSON mode.`,
  );
}

/** The shape of any webhook body (05 §7), which a client never receives. */
export const WEBHOOK_DELIVERY_SHAPE: NamedShape = {
  name: 'WebhookDelivery',
  owner: 'PRO',
  shape: cloudEvent(
    str({ minLength: 1 }),
    obj({ seq: req(seq()) }),
    'Any webhook body: a CloudEvents 1.0 event in structured JSON mode.',
  ),
};

/** Shapes for the notification names and the CloudEvents envelope (05 §5.6, §7). */
export const EVENT_SHAPES: readonly NamedShape[] = [
  NOTIFICATION_TYPE_SHAPE,
  WEBHOOK_DELIVERY_SHAPE,
];
