/**
 * The assets, exports and fonts ports over REST (05 §6.2; PRO-096). Each port is a thin set of
 * control-plane calls: the bearer token goes only to the control plane (05 §3.1), and the bytes of
 * an upload go to the pre-signed address without it. The asset outcome (`asset.ready` or
 * `asset.failed`) arrives as a session event, so `upload` waits for it on the notices of the
 * session (05 §5.6; 05 §6.2).
 */
import {
  PortError,
  isPortError,
  type AssetsPort,
  type Body,
  type CancelSignal,
  type ExportJob,
  type ExportsPort,
  type FontManifest,
  type FontsPort,
  type Notification,
  type Response,
  type Tagged,
  type Unsubscribe,
  type UploadSource,
} from '@docedit/protocol';
import type { FetchLike } from './platform.ts';
import type { RestClient, RestRequest } from './rest.ts';

export interface FilePortsHost {
  /** The control-plane client, once discovery has been read. */
  rest(): Promise<RestClient>;
  /** The platform `fetch`, used for the upload to the pre-signed address only. */
  fetch: FetchLike;
  /** The `event` messages of the session, after the backend has read them. */
  notices: { add(cb: (n: Notification) => void): Unsubscribe };
  /** The backend's timers, so that close() cancels a poll (PRO-096; the same timers as the rest). */
  clock: { set(fn: () => void, ms: number): number; clear(key: number | null | undefined): void };
  /** The `exportTargets` of the discovery document, or null before it is read or when absent. */
  exportTargets(): readonly string[] | null;
}

/**
 * How often an export job is read while the caller follows it (PRO-096, PRO-086). A choice of this
 * lane, not of the spec: docs/adr/0314-lane-U-PRO-086-102.md.
 */
export const EXPORT_POLL_MS = 1000;

/** The states after which a job does not change again (ExportJob.state). */
export const EXPORT_TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface FilePorts {
  readonly assets: AssetsPort;
  readonly exports: ExportsPort;
  readonly fonts: FontsPort;
  /** Rejects every upload that still waits for its outcome (called by close()). */
  abort(reason: string): void;
}

const enc = (s: string): string => encodeURIComponent(s);

/** The idempotency header of a create call, only when the caller gave a key (exactOptionalPropertyTypes). */
const keyed = (idempotencyKey: string | undefined): Pick<RestRequest, 'idempotencyKey'> =>
  idempotencyKey === undefined ? {} : { idempotencyKey };

interface Waiter {
  reject(e: PortError): void;
  settle(): void;
}

export function createFilePorts(host: FilePortsHost): FilePorts {
  const waiters = new Set<Waiter>();

  const call = async <T>(method: string, path: string, req: RestRequest = {}) =>
    (await host.rest()).call<T>(method, path, req);

  const tagged = async <T>(method: string, path: string, shape: string): Promise<Tagged<T>> => {
    const r = await call<T>(method, path, { shape });
    return { value: r.value, etag: r.etag ?? '' };
  };

  /**
   * Registers for the outcome of one asset. Registration happens before the upload starts, so an
   * outcome that arrives early is not lost.
   */
  const outcome = (assetId: string, signal: CancelSignal | undefined) => {
    const resource = `/assets/${enc(assetId)}`;
    let resolveDone: () => void = () => {};
    let rejectDone: (e: PortError) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Nobody may see an unhandled rejection when the outcome arrives before the caller awaits.
    done.catch(() => {});
    let offNotices: Unsubscribe = () => {};
    let offSignal: Unsubscribe = () => {};
    const waiter: Waiter = {
      reject: (e) => {
        end();
        rejectDone(e);
      },
      settle: () => {
        end();
        resolveDone();
      },
    };
    const end = (): void => {
      offNotices();
      offSignal();
      waiters.delete(waiter);
    };
    offNotices = host.notices.add((n) => {
      if (n.resource !== resource) return;
      if (n.type === 'asset.ready') waiter.settle();
      else if (n.type === 'asset.failed')
        waiter.reject(new PortError('validation_failed', `asset ${assetId} failed`));
    });
    waiters.add(waiter);
    if (signal)
      offSignal = signal.onCancel(() =>
        waiter.reject(new PortError('unavailable', 'the upload was cancelled')),
      );
    return { done, cancel: (e: PortError) => waiter.reject(e) };
  };

  const assets: AssetsPort = {
    create: async (docId, body, opts) =>
      (
        await call<Response<'createAsset'>>('POST', `/documents/${enc(docId)}/assets`, {
          body,
          shape: 'AssetUpload',
          ...keyed(opts?.idempotencyKey),
        })
      ).value,

    complete: async (assetId) => {
      await call('POST', `/assets/${enc(assetId)}/complete`);
    },

    resolve: async (docId, assetIds) =>
      (
        await call<Response<'resolveAssets'>>('POST', `/documents/${enc(docId)}/assets/resolve`, {
          body: { assets: [...assetIds] },
          shape: 'ResolvedAssets',
        })
      ).value,

    upload: async (docId, file, opts) => {
      if (opts?.signal?.cancelled) throw new PortError('unavailable', 'the upload was cancelled');
      const source: UploadSource = file.source;
      const made = await assets.create(docId, {
        filename: file.filename,
        mime: source.type,
        size: source.size,
      } as Body<'createAsset'>);
      const assetId = made.asset;
      const pending = outcome(assetId, opts?.signal);
      try {
        const bytes = new Uint8Array(await source.arrayBuffer());
        // The pre-signed address carries its own authority: no bearer token goes there (05 §3.1).
        const res = await host.fetch(made.upload.url, {
          method: 'PUT',
          headers: { 'content-type': source.type },
          body: bytes,
        });
        if (res.status < 200 || res.status >= 300)
          throw new PortError('unavailable', `the upload answered ${res.status}`);
        await assets.complete(assetId);
      } catch (e) {
        const err = e instanceof PortError ? e : new PortError('unavailable', String(e));
        pending.cancel(err);
        throw err;
      }
      await pending.done;
      return { asset: assetId };
    },
  };

  /** The polls of the jobs still followed; abort() (called by close()) stops them all. */
  const polls = new Set<() => void>();

  /** A listener's failure must not stop the port, so it is not rethrown (PRO-096). */
  const report = (cb: (job: ExportJob) => void, job: ExportJob): void => {
    try {
      cb(job);
    } catch {
      // The listener's own error belongs to the listener.
    }
  };

  const exports: ExportsPort = {
    targets: () => host.exportTargets(),
    request: async (docId, body, opts) => {
      const job = (
        await call<ExportJob>('POST', `/documents/${enc(docId)}/exports`, {
          body,
          shape: 'ExportJob',
          ...keyed(opts?.idempotencyKey),
        })
      ).value;
      const onProgress = opts?.onProgress;
      if (onProgress) {
        report(onProgress, job);
        if (!EXPORT_TERMINAL.has(job.state)) follow(job.id, job, onProgress);
      }
      return job;
    },

    get: (jobId) => tagged<ExportJob>('GET', `/exports/${enc(jobId)}`, 'ExportJob'),

    cancel: async (jobId) => {
      await call('DELETE', `/exports/${enc(jobId)}`);
    },
  };

  /**
   * Reports the job's state and progress at each change, by reading it every EXPORT_POLL_MS, until
   * it reaches a terminal state, the job is not found, or the backend closes (PRO-096 criterion 2).
   * A read that fails for another reason is tried again at the next tick.
   */
  const follow = (jobId: string, first: ExportJob, onProgress: (job: ExportJob) => void): void => {
    let last = first.state;
    let lastProgress = first.progress;
    let timer: number | null = null;
    let stopped = false;
    let reading = false;
    const stop = (): void => {
      stopped = true;
      host.clock.clear(timer);
      timer = null;
      polls.delete(stop);
    };
    const later = (): void => {
      if (!stopped) timer = host.clock.set(() => void read(), EXPORT_POLL_MS);
    };
    const read = async (): Promise<void> => {
      timer = null;
      if (stopped || reading) return;
      reading = true;
      let job: ExportJob;
      try {
        job = (await exports.get(jobId)).value;
      } catch (e) {
        reading = false;
        if (isPortError(e) && e.code === 'not_found') stop();
        else later();
        return;
      }
      reading = false;
      if (stopped) return;
      if (job.state !== last || job.progress !== lastProgress) {
        last = job.state;
        lastProgress = job.progress;
        report(onProgress, job);
      }
      if (EXPORT_TERMINAL.has(job.state)) stop();
      else later();
    };
    polls.add(stop);
    later();
  };

  const fonts: FontsPort = {
    manifest: async () =>
      (await call<FontManifest>('GET', '/fonts', { shape: 'FontManifest' })).value,
  };

  return {
    assets,
    exports,
    fonts,
    abort: (reason) => {
      for (const w of [...waiters]) w.reject(new PortError('unavailable', reason));
      for (const stop of [...polls]) stop();
    },
  };
}
