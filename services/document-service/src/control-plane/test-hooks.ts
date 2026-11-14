/**
 * Fault injection for the conformance kit (05 §11 "an optional fault-injection profile"; 06 §8;
 * BE-079; ADR 0054). Only a service started in test mode has these routes, and the configuration
 * refuses test mode in a production environment (config.ts), so in production the routes do not
 * exist: every path under `/_test/` is `not_found`.
 *
 * The routes take a service credential of the tenant whose documents they touch, and every use is
 * written to the log (`test.hook`). What they do is the data plane's hooks (`DataPlane.hooks`,
 * packet A) and the control plane's own:
 *
 *   GET  /_test/timers                               the shortened timers in force
 *   POST /_test/database          { "down": true }   every write fails as if the database were down
 *   POST /_test/documents/{id}/fail-next-write { "at": "before-insert" | "after-insert" }
 *   POST /_test/documents/{id}/kill-room             the room stops as a crash would
 *   POST /_test/documents/{id}/drop-announcement     the next grant announcement is lost
 *   GET  /_test/documents/{id}/state                 head, epoch, owner, incarnation, chain head
 *   GET  /_test/documents/{id}/audit                 the document's audit events
 */
import type { IncomingMessage } from 'node:http';
import type { Logger } from '../log.ts';
import type { DataPlane } from '../seams.ts';
import { readJsonBody } from './http.ts';
import type { PlainHandler, Reply } from './pipeline.ts';
import { ApiError, isApiError, problemOf } from './problems.ts';
import type { TokenService } from './tokens.ts';

/** The timers test mode shortens (BE-079 criterion 2), all settings, in ms unless named. */
export interface TestTimers {
  /** Default lifetime of minted user tokens, seconds (05 §3.1 allows at most 900). */
  tokenLifetimeS: number;
  /** Job leases (BE-049). */
  jobLeaseMs: number;
  /** Rooms close this long after their last channel (06 §2.2: 60 seconds). */
  roomIdleMs: number;
  /** A connection must send `hello` within this (05 §5.1: 10 seconds). */
  helloTimeoutMs: number;
  /** Idempotency keys are remembered this long (05 §6.1: 24 hours; PRO-043 criterion 4). */
  idempotencyTtlMs: number;
  /** The preview window (06 §10: ten seconds). */
  previewWindowMs: number;
  /** The node lease (06 §2.1). */
  nodeLeaseMs: number;
}

export const TEST_TIMERS: TestTimers = {
  tokenLifetimeS: 60,
  jobLeaseMs: 2_000,
  roomIdleMs: 1_000,
  helloTimeoutMs: 2_000,
  idempotencyTtlMs: 5_000,
  previewWindowMs: 1_000,
  nodeLeaseMs: 3_000,
};

const reply = (status: number, body: unknown): Reply => ({
  status,
  body,
  headers: { 'Cache-Control': 'no-store' },
});

/** The handler of every path under `/_test/`. */
export function testHooks(opts: {
  tokens: TokenService;
  dataPlane: DataPlane;
  timers: TestTimers;
  logger: Logger;
}): PlainHandler {
  return async (req: IncomingMessage, url: URL): Promise<Reply> => {
    try {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer '))
        throw new ApiError('unauthenticated', 'a service credential is required', {
          challenge: 'Bearer',
        });
      const { tenant } = await opts.tokens.verifyService(header.slice(7));
      const path = url.pathname.slice('/_test'.length);
      const hooks = opts.dataPlane.hooks;
      const log = (hook: string, doc?: string) =>
        opts.logger.warn({ event: 'test.hook', message: hook, tenant, ...(doc ? { doc } : {}) });
      if (req.method === 'GET' && path === '/timers') return reply(200, opts.timers);
      if (!hooks) throw new ApiError('not_found', 'the data plane offers no test hooks');
      if (req.method === 'POST' && path === '/database') {
        const body = (await readJsonBody(req, 4096)) as { down?: unknown } | undefined;
        log(body?.down === false ? 'database.up' : 'database.down');
        hooks.dropDatabase(body?.down !== false);
        return reply(204, undefined);
      }
      const m = /^\/documents\/([0-9a-f-]{36})\/([a-z-]+)$/.exec(path);
      if (!m) throw new ApiError('not_found', 'no such test hook');
      const ref = { tenant, doc: m[1]! };
      switch (`${req.method} ${m[2]}`) {
        case 'POST fail-next-write': {
          const body = (await readJsonBody(req, 4096)) as { at?: unknown } | undefined;
          const at = body?.at === 'after-insert' ? 'after-insert' : 'before-insert';
          log(`fail-next-write.${at}`, ref.doc);
          hooks.failNextWrite(ref, at);
          return reply(204, undefined);
        }
        case 'POST kill-room':
          log('kill-room', ref.doc);
          return reply(200, { killed: await hooks.killRoom(ref) });
        case 'POST drop-announcement':
          log('drop-announcement', ref.doc);
          hooks.dropNextAnnouncement(ref);
          return reply(204, undefined);
        case 'GET state':
          log('state', ref.doc);
          return reply(200, await hooks.state(ref));
        case 'GET audit':
          log('audit', ref.doc);
          return reply(200, { items: await hooks.auditEvents(ref) });
        default:
          throw new ApiError('not_found', 'no such test hook');
      }
    } catch (e) {
      const err = isApiError(e)
        ? e
        : new ApiError('internal', 'the test hook failed', { cause: e });
      return {
        status: err.status,
        body: problemOf(err, ''),
        headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
      };
    }
  };
}
