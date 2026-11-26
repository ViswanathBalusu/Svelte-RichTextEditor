/**
 * The history, comments, leases and imports ports over REST (05 §6.2; PRO-097). Each port is a thin
 * set of control-plane calls, as in files.ts: the bearer token is added by the RestClient, never
 * placed in a URL (05 §3.1), `If-Match` goes where a route is conditional (05 §6.1) and
 * `Idempotency-Key` where a create call takes one (05 §6.1). Responses are validated against their
 * shapes by the RestClient.
 *
 * The thread and comment events that arrive on the channel are not applied here: that belongs to
 * the review pane's store (PRO-097 notes). A lease acquired through this module is kept alive by
 * heartbeats until it is released, when the host gives a clock (`LeaseClock`); see `armHeartbeat`.
 */
import type {
  Body,
  CommentsPort,
  HistoryPort,
  ImportsPort,
  LeasesPort,
  Response,
  Tagged,
} from '@docedit/protocol';
import type { RestClient, RestRequest } from './rest.ts';

/** The timers that keep a lease alive (07 §10). `now` is Unix milliseconds, as in `Platform`. */
export interface LeaseClock {
  set(fn: () => void, ms: number): number;
  clear(key: number | null | undefined): void;
  now(): number;
}

export interface ReviewPortsHost {
  /** The control-plane client, once discovery has been read. */
  rest(): Promise<RestClient>;
  /**
   * Sends the heartbeats of the leases this module acquires (PRO-097 criterion 3). Without it, a
   * lease is extended only by explicit `heartbeat` calls.
   */
  clock?: LeaseClock;
}

export interface ReviewPorts {
  readonly history: HistoryPort;
  readonly comments: CommentsPort;
  readonly leases: LeasesPort;
  readonly imports: Omit<ImportsPort, 'importFile'>;
}

const enc = (s: string): string => encodeURIComponent(s);

/** The value of a lease as the port returns it. */
type LeaseValue = Awaited<ReturnType<LeasesPort['acquire']>>['value'];

/** A lease a caller holds through this module, with what its next heartbeat needs. */
interface HeldLease {
  readonly docId: string;
  readonly regionId: string;
  readonly key: string;
  /** The entity tag of the lease's latest response: the `If-Match` of the next heartbeat. */
  etag: string;
  /** The expiry in Unix milliseconds, from the latest response. */
  expiresAt: number;
  /** When the lease was acquired, on the local clock. */
  readonly acquiredAt: number;
  timer: number | null;
}

/** A lease lasts at most eight hours in total, however often it is extended (07 §10). */
const LEASE_MAX_MS = 8 * 60 * 60 * 1000;

const leaseKey = (docId: string, regionId: string): string => JSON.stringify([docId, regionId]);

/* Request members, left out when the caller gave no value (exactOptionalPropertyTypes). */
const keyed = (idempotencyKey: string | undefined): Pick<RestRequest, 'idempotencyKey'> =>
  idempotencyKey === undefined ? {} : { idempotencyKey };

const conditional = (ifMatch: string | undefined): Pick<RestRequest, 'ifMatch'> =>
  ifMatch === undefined ? {} : { ifMatch };

/** A query object as the RestClient takes it; undefined members are left out by withQuery. */
const queried = (q: unknown): Pick<RestRequest, 'query'> =>
  q === undefined ? {} : { query: q as Readonly<Record<string, string | number | undefined>> };

export function createReviewPorts(host: ReviewPortsHost): ReviewPorts {
  const call = async <T>(method: string, path: string, req: RestRequest = {}) =>
    (await host.rest()).call<T>(method, path, req);

  const tagged = async <T>(
    method: string,
    path: string,
    req: RestRequest = {},
  ): Promise<Tagged<T>> => {
    const r = await call<T>(method, path, req);
    return { value: r.value, etag: r.etag ?? '' };
  };

  const docPath = (docId: string, rest = ''): string => `/documents/${enc(docId)}${rest}`;

  const history: HistoryPort = {
    history: async (docId, query) =>
      (
        await call<Response<'listHistory'>>('GET', docPath(docId, '/history'), {
          ...queried(query),
          shape: 'HistoryGroup',
          list: true,
        })
      ).value,

    versions: async (docId, query) =>
      (
        await call<Response<'listVersions'>>('GET', docPath(docId, '/versions'), {
          ...queried(query),
          shape: 'Version',
          list: true,
        })
      ).value,

    createVersion: async (docId, body, opts) =>
      (
        await call<Response<'createVersion'>>('POST', docPath(docId, '/versions'), {
          body,
          shape: 'Version',
          ...keyed(opts?.idempotencyKey),
        })
      ).value,

    diff: async (docId, query) =>
      (
        await call<Response<'getDiff'>>('GET', docPath(docId, '/diff'), {
          ...queried(query),
          shape: 'Diff',
        })
      ).value,

    attribution: async (docId, query) =>
      (
        await call<Response<'getAttribution'>>('GET', docPath(docId, '/attribution'), {
          ...queried(query),
          shape: 'Attribution',
        })
      ).value,

    restore: async (docId, body) =>
      (
        await call<Response<'restore'>>('POST', docPath(docId, '/restore'), {
          body: body as Body<'restore'>,
          shape: 'RestoreResult',
        })
      ).value,

    setReadMarker: (docId, seq, opts) =>
      tagged<Response<'setReadMarker'>>('PUT', docPath(docId, '/read-marker'), {
        body: { seq },
        ifMatch: opts.ifMatch,
        shape: 'ReadMarker',
      }),

    activity: async (docId) =>
      (
        await call<Response<'getActivity'>>('GET', docPath(docId, '/activity'), {
          shape: 'Activity',
        })
      ).value,

    suggestionIntroduction: async (docId, suggestionId) =>
      (
        await call<Response<'getSuggestionIntroduction'>>(
          'GET',
          docPath(docId, `/suggestions/${enc(suggestionId)}/introduction`),
          { shape: 'SuggestionIntroduction' },
        )
      ).value,
  };

  const threadPath = (threadId: string, rest = ''): string => `/threads/${enc(threadId)}${rest}`;
  const commentPath = (commentId: string): string => `/comments/${enc(commentId)}`;

  const comments: CommentsPort = {
    threads: async (docId, query) =>
      (
        await call<Response<'listThreads'>>('GET', docPath(docId, '/threads'), {
          ...queried(query),
          shape: 'Thread',
          list: true,
        })
      ).value,

    createThread: (docId, body, opts) =>
      tagged<Response<'createThread'>>('POST', docPath(docId, '/threads'), {
        body,
        shape: 'Thread',
        ...keyed(opts?.idempotencyKey),
      }),

    thread: (threadId) => tagged('GET', threadPath(threadId), { shape: 'Thread' }),

    updateThread: (threadId, patch, opts) =>
      tagged('PATCH', threadPath(threadId), {
        body: patch,
        ifMatch: opts.ifMatch,
        shape: 'Thread',
      }),

    deleteThread: async (threadId, opts) => {
      await call('DELETE', threadPath(threadId), conditional(opts?.ifMatch));
    },

    reply: (threadId, body, opts) =>
      tagged('POST', threadPath(threadId, '/comments'), {
        body,
        shape: 'Comment',
        ...keyed(opts?.idempotencyKey),
      }),

    updateComment: (commentId, body, opts) =>
      tagged('PATCH', commentPath(commentId), {
        body,
        ifMatch: opts.ifMatch,
        shape: 'Comment',
      }),

    deleteComment: async (commentId, opts) => {
      await call('DELETE', commentPath(commentId), conditional(opts?.ifMatch));
    },

    addReaction: (commentId, reaction) =>
      tagged('POST', `${commentPath(commentId)}/reactions/${enc(reaction)}`, {
        shape: 'Comment',
      }),

    removeReaction: (commentId, reaction) =>
      tagged('DELETE', `${commentPath(commentId)}/reactions/${enc(reaction)}`, {
        shape: 'Comment',
      }),
  };

  const leasePath = (docId: string, regionId: string): string =>
    docPath(docId, `/regions/${enc(regionId)}/lease`);

  /* The leases held through this module, kept alive until released (PRO-097 criterion 3). */
  const clock = host.clock;
  const held = new Map<string, HeldLease>();

  /*
   * Arms the next heartbeat at half of the time left before the lease expires (the cadence is this
   * module's choice; 07 §10 gives the expiry and the eight-hour maximum, not the interval). The
   * timer stops when the lease has no entity tag, has expired, or has reached eight hours.
   */
  const armHeartbeat = (h: HeldLease): void => {
    if (!clock) return;
    clock.clear(h.timer);
    h.timer = null;
    const now = clock.now();
    const remaining = h.expiresAt - now;
    if (h.etag === '' || !(remaining > 0) || now - h.acquiredAt >= LEASE_MAX_MS) {
      if (held.get(h.key) === h) held.delete(h.key);
      return;
    }
    h.timer = clock.set(() => void beat(h), remaining / 2);
  };

  const beat = async (h: HeldLease): Promise<void> => {
    h.timer = null;
    if (held.get(h.key) !== h) return;
    if (!clock || clock.now() - h.acquiredAt >= LEASE_MAX_MS) {
      held.delete(h.key); // at its eight-hour maximum the lease is no longer extended (07 §10)
      return;
    }
    try {
      const t = await tagged<LeaseValue>('PUT', leasePath(h.docId, h.regionId), {
        ifMatch: h.etag,
        shape: 'Lease',
      });
      if (held.get(h.key) !== h) return; // released while the heartbeat was in flight
      h.etag = t.etag;
      h.expiresAt = Date.parse(t.value.expiresAt);
      armHeartbeat(h);
    } catch {
      // A refused heartbeat ends the keeping; the lease runs to its expiry and the caller sees the
      // refusal on its next call.
      if (held.get(h.key) === h) held.delete(h.key);
    }
  };

  const leases: LeasesPort = {
    acquire: async (docId, regionId) => {
      const t = await tagged<LeaseValue>('POST', leasePath(docId, regionId), { shape: 'Lease' });
      if (clock) {
        const key = leaseKey(docId, regionId);
        const previous = held.get(key);
        if (previous) clock.clear(previous.timer);
        const h: HeldLease = {
          docId,
          regionId,
          key,
          etag: t.etag,
          expiresAt: Date.parse(t.value.expiresAt),
          acquiredAt: clock.now(),
          timer: null,
        };
        held.set(key, h);
        armHeartbeat(h);
      }
      return t;
    },

    heartbeat: async (docId, regionId, opts) => {
      const t = await tagged<LeaseValue>('PUT', leasePath(docId, regionId), {
        ifMatch: opts.ifMatch,
        shape: 'Lease',
      });
      const h = held.get(leaseKey(docId, regionId));
      if (h) {
        h.etag = t.etag;
        h.expiresAt = Date.parse(t.value.expiresAt);
        armHeartbeat(h);
      }
      return t;
    },

    release: async (docId, regionId, opts) => {
      const key = leaseKey(docId, regionId);
      const h = held.get(key);
      if (h) {
        clock?.clear(h.timer);
        h.timer = null;
        held.delete(key);
      }
      try {
        await call('DELETE', leasePath(docId, regionId), conditional(opts?.ifMatch));
      } catch (e) {
        // The lease still exists: keep it alive again, as before the release was attempted.
        if (h) {
          held.set(key, h);
          armHeartbeat(h);
        }
        throw e;
      }
    },
  };

  const imports: Omit<ImportsPort, 'importFile'> = {
    request: async (docId, body, opts) =>
      (
        await call<Response<'createImport'>>('POST', docPath(docId, '/imports'), {
          body,
          shape: 'ImportJob',
          ...keyed(opts?.idempotencyKey),
        })
      ).value,

    get: (jobId) => tagged('GET', `/imports/${enc(jobId)}`, { shape: 'ImportJob' }),
  };

  return { history, comments, leases, imports };
}
