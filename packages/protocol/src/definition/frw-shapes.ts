/**
 * The named shapes of the fields, rules and workflow additions (12 §10), in a module of their own so that
 * the client's first load does not carry them: they load with the first control-plane call that names one
 * (`wire-more.ts`; FND-008). `frw.ts` assembles the whole extension from them.
 */
import { WORKFLOW_STATES } from './common.ts';
import type { NamedShape } from './shapes.ts';
import {
  any,
  arr,
  bool,
  count,
  enm,
  map,
  nodeId,
  nullable,
  obj,
  opt,
  ref,
  req,
  seq,
  text,
  timestamp,
  uuid7,
} from './shapes.ts';

const FRW = 'FRW';
const FIELD_KINDS = [
  'text',
  'number',
  'date',
  'checkbox',
  'choice',
  'signature',
  'initials',
  'dateSigned',
  'formula',
];

export const FRW_SHAPES: readonly NamedShape[] = [
  {
    name: 'FieldInfo',
    owner: FRW,
    shape: obj(
      {
        id: req(nodeId()),
        key: req(text({ minLength: 1 })),
        kind: req(enm(FIELD_KINDS)),
        label: req(text()),
        assignee: req(
          nullable(text()),
          'A `role_def` identifier, or null for a field only authors set.',
        ),
        required: req(bool()),
        readOnly: req(bool()),
      },
      {
        doc: 'A field in the derived list (12 §3.2; FRW-060).',
        spec: '12 §3.2, §10',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'FieldValues',
    owner: FRW,
    shape: obj(
      {
        values: req(
          map(any(), { keys: text() }),
          'Values by key, as stored (decimal strings stay strings, 12 §3.3). Placeholder name.',
        ),
      },
      { spec: '12 §9, §10', gaps: ['G96'], decisions: ['D26'] },
    ),
  },
  {
    name: 'Workflow',
    owner: FRW,
    shape: obj(
      {
        id: req(uuid7()),
        doc: req(uuid7()),
        state: req(enm(WORKFLOW_STATES)),
        rev: req(count()),
        sentSeq: opt(seq()),
        sentHash: opt(text(), undefined, { gaps: ['G98'] }),
        timeZone: opt(text()),
        participants: req(
          arr(
            obj({
              id: req(text({ minLength: 1 }), undefined, { gaps: ['G59'] }),
              roles: req(arr(text())),
              kind: req(enm(['filler', 'signer', 'approver', 'cc'])),
              order: req(count()),
              sub: opt(text()),
              name: opt(text()),
              auth: opt(obj({ require: opt(arr(text())) })),
              state: opt(text()),
              completedSeq: opt(seq()),
              firstViewedAt: opt(
                timestamp(),
                'When the participant first opened the document (12 §6.3; FRW-031).',
              ),
              activatedAt: opt(
                timestamp(),
                'When the participant last became active: the anchor of the reminders (FRW-034).',
              ),
              verifiedAt: opt(
                timestamp(),
                'When a correct access code was submitted for the participant (FRW-039).',
              ),
            }),
          ),
        ),
        routing: opt(arr(obj({}))),
        deadline: opt(timestamp(), undefined, { gaps: ['G98'] }),
        reminders: opt(obj({ firstAfterDays: opt(count()), everyDays: opt(count()) })),
        consent: opt(obj({ textId: opt(text()), version: opt(count()) })),
        finalisation: opt(obj({ seal: opt(text()), certificate: opt(bool()) })),
      },
      {
        doc: 'The workflow resource, from the example of 12 §6.1; which members are required is not stated.',
        spec: '12 §6.1',
        gaps: ['G95'],
      },
    ),
  },
  {
    name: 'BulkSendRow',
    owner: FRW,
    shape: obj(
      {
        participants: opt(
          arr(
            obj({
              id: req(text({ minLength: 1 })),
              roles: req(arr(text())),
              kind: req(enm(['filler', 'signer', 'approver', 'cc'])),
              order: req(count()),
              sub: opt(text()),
              name: opt(text()),
              auth: opt(obj({ require: opt(arr(text())) })),
            }),
          ),
          "The recipient's participants, bound to the roles of the template.",
        ),
        values: opt(map(any(), { keys: text() }), "The recipient's values, prefilled by key."),
        title: opt(text({ maxLength: 1000 })),
        externalId: opt(text({ minLength: 1, maxLength: 255 })),
        properties: opt(obj({})),
        classification: opt(text({ minLength: 1, maxLength: 200 })),
      },
      {
        doc: 'One recipient row of a bulk send: what a document made from the template takes (FRW-063).',
        spec: '12 §9',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'BulkSendCreate',
    owner: FRW,
    shape: obj(
      {
        template: req(uuid7(), 'The template (`POST /templates`).'),
        templateSeq: opt(seq(), 'The seq of the template document to fork at. Default: the head.'),
        rows: req(arr(ref('BulkSendRow')), 'One document is made for each row, in order.'),
      },
      {
        doc: 'The body of `POST /bulk-sends` (12 §9; FRW-063).',
        spec: '12 §9, §10',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'BulkSendRowResult',
    owner: FRW,
    shape: obj(
      {
        index: req(count(), 'The position of the row in the request, from 0.'),
        document: req(nullable(uuid7()), 'The document made for the row; null when it failed.'),
        error: opt(
          obj({
            code: req(ref('ErrorCode')),
            message: req(text()),
            violations: opt(arr(obj({ path: req(text()), rule: req(text()) }))),
          }),
          'Why the row failed: the code and the violations the single call would have answered.',
        ),
      },
      {
        doc: 'The outcome of one row of a bulk send (FRW-063).',
        spec: '12 §9',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'BulkSend',
    owner: FRW,
    shape: obj(
      {
        id: req(uuid7()),
        template: req(uuid7()),
        seq: req(
          seq(),
          'The seq of the template the documents are forked at: pinned and recorded.',
        ),
        state: req(enm(['queued', 'running', 'completed', 'failed', 'cancelled'])),
        total: req(count(), 'The number of rows.'),
        done: req(count(), 'The rows handled so far.'),
        rows: opt(
          arr(ref('BulkSendRowResult')),
          'Each row with the new document or the failure; set when `state` is `completed`.',
        ),
        error: opt(obj({ code: req(ref('ErrorCode')), message: req(text()) })),
        createdAt: req(timestamp()),
        finishedAt: opt(timestamp()),
      },
      {
        doc: 'A bulk send: a job that makes one fork of a template for each recipient row (12 §9; FRW-063).',
        spec: '12 §9, §10',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'Template',
    owner: FRW,
    shape: obj(
      {
        id: req(uuid7()),
        document: req(uuid7(), 'The document that is the template.'),
        name: req(text({ minLength: 1, maxLength: 255 })),
        createdAt: req(timestamp()),
      },
      {
        doc: "A template: a document with role placeholders, fields and rules, and no participants (12 §9; FRW-062). The members are the lane's proposal (docs/adr/0406-w4-FRW-062-templates.md).",
        spec: '12 §9, §10',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'TemplateCreate',
    owner: FRW,
    shape: obj(
      {
        document: req(uuid7(), 'The document to mark as a template.'),
        name: req(text({ minLength: 1, maxLength: 255 })),
      },
      {
        doc: 'The body of `POST /templates` (12 §9; FRW-062).',
        spec: '12 §9, §10',
        gaps: ['G96'],
      },
    ),
  },
  {
    name: 'WorkflowReason',
    owner: FRW,
    shape: obj(
      {
        reason: req(
          text({ minLength: 1, maxLength: 2000 }),
          'Why the workflow is stopped: the participant who declines, or the owner who voids, says. A reason that is blank after trimming is refused.',
        ),
      },
      {
        doc: 'The body of `decline` and `void` (12 §6.2).',
        spec: '12 §6.2, §10',
        gaps: ['G95'],
      },
    ),
  },
  {
    name: 'WorkflowAccessCode',
    owner: FRW,
    shape: obj(
      {
        code: req(
          text({ minLength: 1, maxLength: 255 }),
          'The access code: registered by the host for a participant, and submitted by the participant to verify. It is never stored or returned in the clear.',
        ),
      },
      {
        doc: 'The body of `verify` and of the registration of an access code (12 §6.1, §7; FRW-039).',
        spec: '12 §6.1, §7, §10',
        gaps: ['G95'],
      },
    ),
  },
  {
    name: 'WorkflowConsentText',
    owner: FRW,
    shape: obj(
      {
        textId: req(text({ minLength: 1 }), 'The identifier of the consent text the workflow names.'),
        version: req(count(), 'The version of the text.'),
        text: req(
          text({ minLength: 1 }),
          'The text the service holds for that identifier and version, to be shown in full before any signing action.',
        ),
        acceptedAt: req(
          nullable(text()),
          'The server time of the acceptance on record for this very text (ISO 8601), or null when the participant has not accepted it.',
        ),
      },
      {
        doc: 'The consent text and the participant’s acceptance of it (12 §6.1, §8.1 step 1; FRW-044).',
        spec: '12 §6.1, §8.1, §10',
        gaps: ['G95'],
      },
    ),
  },
  {
    name: 'WorkflowCaptureSettings',
    owner: FRW,
    shape: obj(
      {
        captureNetworkIdentity: req(
          bool(),
          'Whether the IP address and the user agent of a participant are recorded in their evidence. On by default; off keeps neither (12 §7). A change applies to events after it; evidence already stored is not rewritten.',
        ),
      },
      {
        doc: 'The tenant setting for network identity capture in workflow evidence (12 §7; FRW-042).',
        spec: '12 §7, §10; 13 §10',
        gaps: ['G95'],
      },
    ),
  },
  {
    name: 'WorkflowPlaceholder',
    owner: FRW,
    shape: obj(
      {},
      {
        doc: 'A workflow request or response the prose does not define. Placeholder.',
        spec: '12 §10',
        gaps: ['G95'],
        decisions: ['D26'],
      },
    ),
  },
];
