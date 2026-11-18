// The DEP definition against the tables of 05 (and 12 §10): every message type, close code, error
// code, notification type, webhook event and route the prose names is defined, and nothing else
// (SPK-019; PRO-001 to PRO-003; a first step of PRO-117).
import { describe, expect, it } from 'vitest';
import { DEP1, checkDefinition, defineDep } from '../src/definition/index.ts';
import { generateAsyncApi } from '../src/generate/asyncapi.ts';
import { webhookType } from '../src/definition/events.ts';
import { GAPS } from '../src/definition/gaps.ts';
import { DECISIONS } from '../src/definition/decisions.ts';

// 05 §5.1 to §5.6 and 12 §10, with the direction of each table.
const PROSE_MESSAGES: Record<string, 'c2s' | 's2c' | 'both'> = {
  hello: 'c2s',
  welcome: 's2c',
  'auth.expiring': 's2c',
  'auth.refresh': 'c2s',
  'auth.ok': 's2c', // named in the notes of auth.refresh only (G19)
  'auth.revoked': 's2c',
  ping: 'both',
  pong: 'both',
  goaway: 's2c',
  error: 'both',
  chunk: 'both',
  'ch.open': 'c2s',
  'ch.opened': 's2c',
  'ch.rejected': 's2c',
  'ch.close': 'c2s',
  'ch.closed': 's2c',
  'sync.submit': 'c2s',
  'sync.ack': 's2c',
  'sync.reject': 's2c',
  'sync.commit': 's2c',
  'sync.caughtUp': 's2c',
  'sync.reset': 's2c',
  'sync.check': 's2c',
  'presence.update': 'c2s',
  'presence.state': 's2c',
  'perm.changed': 's2c',
  event: 's2c',
  'wf.changed': 's2c', // 12 §10
};

const PROSE_CLOSE_CODES = [4400, 4401, 4403, 4406, 4408, 4413, 4429, 4500, 4503];

const PROSE_ERROR_CODES = [
  'bad_message',
  'unknown_type',
  'unauthenticated',
  'token_expired',
  'revoked',
  'forbidden',
  'unsupported_version',
  'unsupported_engine',
  'unsupported_cdm',
  'unsupported_feature',
  'not_found',
  'already_open',
  'channel_limit',
  'stale_base',
  'rebase_failed',
  'permission_denied',
  'read_only',
  'invalid_op',
  'conflict',
  'field_invalid',
  'busy',
  'too_large',
  'rate_limited',
  'quota_exceeded',
  'slow_consumer',
  'precondition_failed',
  'validation_failed',
  'pending_suggestions',
  'workflow_active',
  'idempotency_mismatch',
  'unavailable',
  'internal',
];

const PROSE_NOTIFICATIONS = [
  'thread.created',
  'thread.updated',
  'thread.resolved',
  'thread.reopened',
  'thread.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'version.created',
  'version.restored',
  'export.progress',
  'export.completed',
  'export.failed',
  'export.cancelled',
  'import.completed',
  'import.failed',
  'asset.ready',
  'asset.failed',
  'document.updated',
];

// 05 §7 and 12 §10 (with decision D17 for the workflow names).
const PROSE_WEBHOOKS = [
  'dep.document.created',
  'dep.document.deleted',
  'dep.document.state_changed',
  'dep.document.changed',
  'dep.version.created',
  'dep.version.restored',
  'dep.grants.changed',
  'dep.region.state_changed',
  'dep.session.joined',
  'dep.session.left',
  'dep.thread.created',
  'dep.thread.resolved',
  'dep.thread.reopened',
  'dep.thread.deleted',
  'dep.comment.created',
  'dep.comment.mentioned',
  'dep.task.assigned',
  'dep.export.completed',
  'dep.export.failed',
  'dep.import.completed',
  'dep.import.failed',
  'dep.commit.rejected',
  ...[
    'sent',
    'participant_activated',
    'participant_viewed',
    'field_completed',
    'participant_completed',
    'participant_declined',
    'auth_failed',
    'reminder_due',
    'corrected',
    'voided',
    'expired',
    'completed',
    'finalised',
  ].map((n) => `dep.workflow.${n}`),
].map((n) => `${n}.v1`);

// 05 §6.2: every resource and method of the table.
const PROSE_ROUTES = [
  'POST /tokens',
  'GET /documents',
  'POST /documents',
  'GET /documents/{id}',
  'PATCH /documents/{id}',
  'DELETE /documents/{id}',
  'GET /documents/{id}/content',
  'PUT /documents/{id}/content',
  'GET /documents/{id}/commits',
  'GET /documents/{id}/regions',
  'PUT /documents/{id}/regions/{rid}/state',
  'POST /documents/{id}/regions/{rid}/lease',
  'PUT /documents/{id}/regions/{rid}/lease',
  'DELETE /documents/{id}/regions/{rid}/lease',
  'GET /documents/{id}/grants',
  'PATCH /documents/{id}/grants',
  'POST /sessions/revoke',
  'GET /documents/{id}/history',
  'GET /documents/{id}/versions',
  'POST /documents/{id}/versions',
  'GET /documents/{id}/diff',
  'GET /documents/{id}/attribution',
  'POST /documents/{id}/restore',
  'POST /documents/{id}/fork',
  'PUT /documents/{id}/read-marker',
  'GET /documents/{id}/activity',
  'GET /documents/{id}/connect',
  'GET /documents/{id}/threads',
  'POST /documents/{id}/threads',
  'GET /threads/{tid}',
  'PATCH /threads/{tid}',
  'DELETE /threads/{tid}',
  'POST /threads/{tid}/comments',
  'PATCH /comments/{cid}',
  'DELETE /comments/{cid}',
  'POST /documents/{id}/assets',
  'POST /assets/{aid}/complete',
  'POST /documents/{id}/assets/resolve',
  'POST /documents/{id}/exports',
  'GET /exports/{jid}',
  'DELETE /exports/{jid}',
  'POST /documents/{id}/imports',
  'GET /imports/{jid}',
  'GET /fonts',
  'GET /webhooks',
  'POST /webhooks',
  'GET /webhooks/{id}',
  'PATCH /webhooks/{id}',
  'DELETE /webhooks/{id}',
  'POST /webhooks/{id}/ping',
  'POST /webhooks/{id}/deliveries/{deliveryId}/replay',
  'GET /audit',
  'GET /search',
  'GET /retention',
  'PUT /retention',
  'GET /documents/{id}/retention',
  'PUT /documents/{id}/retention',
  'GET /quotas',
  'PUT /quotas',
  'GET /origins',
  'GET /keys',
  'POST /origins',
  'DELETE /origins/{origin}',
  'POST /keys',
  'DELETE /keys/{kid}',
];
// 05 §2 (discovery) and the routes of 12 §10 that have a path and a method.
const OTHER_ROUTES = [
  'GET /.well-known/dep',
  'GET /documents/{id}/fields',
  'GET /documents/{id}/field-values',
  'PATCH /documents/{id}/field-values',
  'GET /documents/{id}/workflow',
  'PUT /documents/{id}/workflow',
  'POST /documents/{id}/workflow/send',
  'POST /documents/{id}/workflow/correct',
  'POST /documents/{id}/workflow/resume',
  'POST /documents/{id}/workflow/remind',
  'POST /documents/{id}/workflow/void',
  'POST /documents/{id}/workflow/participants/{pid}/consent',
  'POST /documents/{id}/workflow/participants/{pid}/verify',
  'POST /documents/{id}/workflow/participants/{pid}/complete',
  'POST /documents/{id}/workflow/participants/{pid}/decline',
  'POST /documents/{id}/fields/{fid}/sign',
  'GET /documents/{id}/workflow/evidence',
  'GET /documents/{id}/workflow/final',
  // UX-080 (08 §11; 13 §10): legal holds through the administration API, service credential only.
  'POST /documents/{id}/holds',
  'GET /holds',
  // HIS-038 (08 §13): the erasure of a person, service credential only.
  'POST /users/erase',
  // HIS-040 (08 §13): the tombstone of one commit payload, service credential only.
  'POST /documents/{id}/commits/{seq}/tombstone',
];

describe('the DEP definition', () => {
  it('is consistent: names unique, references resolve, every gap and decision exists', () => {
    expect(checkDefinition(DEP1)).toEqual([]);
  });

  it('defines every message type of 05 §5.1 to §5.6 and 12 §10 with its direction, and nothing else', () => {
    const defined = Object.fromEntries(DEP1.messages.map((m) => [m.t, m.dir]));
    expect(defined).toEqual(PROSE_MESSAGES);
  });

  it('marks channel-scoped messages, requests and replies as the envelope rules say (05 §4)', () => {
    const byType = new Map(DEP1.messages.map((m) => [m.t, m]));
    for (const t of [
      'ch.open',
      'ch.opened',
      'ch.rejected',
      'ch.close',
      'ch.closed',
      'sync.submit',
      'sync.ack',
      'sync.reject',
      'sync.commit',
      'perm.changed',
    ])
      expect(byType.get(t)!.ch, t).toBe('required');
    for (const t of ['hello', 'welcome', 'goaway', 'chunk', 'auth.revoked'])
      expect(byType.get(t)!.ch, t).toBe('none');
    for (const t of ['hello', 'ch.open', 'sync.submit', 'auth.refresh'])
      expect(byType.get(t)!.id, t).toBe('required');
    for (const t of ['welcome', 'ch.opened', 'ch.rejected', 'sync.ack', 'sync.reject', 'auth.ok'])
      expect(byType.get(t)!.re, t).toBe('required');
  });

  it('has the close codes of 05 §5.7 and the error registry of 05 §5.8', () => {
    expect(DEP1.closeCodes.map((c) => c.code)).toEqual(PROSE_CLOSE_CODES);
    expect(DEP1.errors.map((e) => e.code).sort()).toEqual([...PROSE_ERROR_CODES].sort());
    for (const e of DEP1.errors) {
      expect(e.surfaces.length, e.code).toBeGreaterThan(0);
      expect(e.clientAction.length, e.code).toBeGreaterThan(0);
    }
  });

  it('has the notification types of 05 §5.6 and the webhook events of 05 §7 and 12 §10, with a version suffix', () => {
    expect(DEP1.notifications.map((n) => n.type).sort()).toEqual([...PROSE_NOTIFICATIONS].sort());
    expect(DEP1.webhooks.map(webhookType).sort()).toEqual([...PROSE_WEBHOOKS].sort());
  });

  it('has every resource and method of 05 §6.2, and the routes of discovery and 12 §10', () => {
    const routes = DEP1.operations.map((o) => `${o.method} ${o.path}`).sort();
    expect(routes).toEqual([...PROSE_ROUTES, ...OTHER_ROUTES].sort());
  });

  it('marks service-credential routes as 05 §6.2 and 07 §12 do', () => {
    const service = DEP1.operations
      .filter((o) => o.security.length === 1 && o.security[0] === 'service')
      .map((o) => `${o.method} ${o.path}`);
    expect(service.sort()).toEqual(
      [
        'POST /tokens',
        'GET /documents',
        'POST /documents',
        'PUT /documents/{id}/content',
        'POST /sessions/revoke',
        'POST /documents/{id}/fork',
        'POST /documents/{id}/imports',
        'GET /webhooks',
        'POST /webhooks',
        'GET /webhooks/{id}',
        'PATCH /webhooks/{id}',
        'DELETE /webhooks/{id}',
        'POST /webhooks/{id}/ping',
        'POST /webhooks/{id}/deliveries/{deliveryId}/replay',
        'GET /audit',
        'GET /search',
        'GET /retention',
        'PUT /retention',
        'GET /documents/{id}/retention',
        'PUT /documents/{id}/retention',
        'POST /documents/{id}/holds',
        'GET /holds',
        'POST /users/erase',
        'POST /documents/{id}/commits/{seq}/tombstone',
        'GET /quotas',
        'PUT /quotas',
        'GET /origins',
        'GET /keys',
        'POST /origins',
        'DELETE /origins/{origin}',
        'POST /keys',
        'DELETE /keys/{kid}',
      ].sort(),
    );
  });

  it('lets another epic register a message without changing the envelope (PRO-001)', () => {
    const core = defineDep([]);
    const extended = defineDep([
      {
        owner: 'TEST',
        shapes: [],
        features: [],
        messages: [
          {
            t: 'x-test.ping',
            dir: 's2c',
            summary: 'A test message.',
            spec: 'test',
            ch: 'optional',
            id: 'optional',
            re: 'none',
            payload: null,
            owner: 'TEST',
          },
        ],
        operations: [],
        notifications: [],
        webhooks: [],
      },
    ]);
    expect(checkDefinition(extended)).toEqual([]);
    expect(extended.messages.map((m) => m.t)).toEqual([
      ...core.messages.map((m) => m.t),
      'x-test.ping',
    ]);
    const a = generateAsyncApi(core);
    const b = generateAsyncApi(extended);
    const schemas = (x: Record<string, unknown>) =>
      (x['components'] as { schemas: Record<string, unknown> }).schemas;
    expect(schemas(b)['Envelope']).toEqual(schemas(a)['Envelope']);
    expect(Object.keys((b['channels'] as { dep: { messages: object } }).dep.messages)).toContain(
      'x-test.ping',
    );
    // The fields and workflow additions of 12 §10 are registered the same way.
    expect(DEP1.messages.find((m) => m.t === 'wf.changed')?.owner).toBe('FRW');
  });

  it('carries protocol version 1.0 and the CDM version range of the model', () => {
    expect(DEP1.version).toBe('1.0');
    expect(DEP1.subprotocol).toBe('dep.v1');
    expect(DEP1.cdm).toEqual({ min: 1, max: 1 });
  });

  it('references every contradiction from the element it affects or from a decision', () => {
    const referenced = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const g of (v as { gaps?: unknown }).gaps instanceof Array
          ? (v as { gaps: string[] }).gaps
          : [])
          referenced.add(g);
        Object.values(v).forEach(walk);
      }
    };
    walk({ ...DEP1, gaps: [], decisions: [] });
    for (const d of DECISIONS) d.gaps.forEach((g) => referenced.add(g));
    const open = GAPS.filter((g) => g.kind === 'contradiction' && !g.resolved).map((g) => g.id);
    expect(open.filter((id) => !referenced.has(id))).toEqual([]);
    expect(new Set(GAPS.map((g) => g.id)).size).toBe(GAPS.length);
    // Resolved gaps are kept for traceability, and nothing in the definitions points at them.
    // G03 to G97 were settled by decisions taken to build the control plane (packet A2, D60 to D74),
    // G11 by one taken to build the data plane (packet A1, D42).
    expect(GAPS.filter((g) => g.resolved).map((g) => g.id)).toEqual([
      'G03',
      'G04',
      'G05',
      'G07',
      'G09',
      'G11',
      'G19',
      'G37',
      'G39',
      'G40',
      'G50',
      'G54',
      'G56',
      'G60',
      'G61',
      'G64',
      'G65',
      'G73',
      'G78',
      'G97',
    ]);
  });
});
