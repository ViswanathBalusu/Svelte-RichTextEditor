/**
 * The import flow of the `imports` port (PRO-097 criterion 4; 05 §6.2; 09 §12): upload the Word file
 * as an asset, wait for `asset.ready`, request the import with the asset, and read the job every
 * `IMPORT_POLL_MS` until it ends. The job's states are those of the reference service (`queued`,
 * `running`, `completed`, `failed`, `cancelled`; docs/adr/0373-w2-EXP-098-import-job.md): the
 * protocol's `ImportJob` names only `id` and `warnings` (gap G74). The upload answers with the
 * asset identifier (owner decision 189).
 */
import {
  PortError,
  type AssetsPort,
  type CancelSignal,
  type ImportJob,
  type ImportsPort,
} from '@docedit/protocol';

/** How often a running import job is read. A choice of this lane, as `EXPORT_POLL_MS` is. */
export const IMPORT_POLL_MS = 1000;

/** The states after which an import job does not change again. */
export const IMPORT_TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface ImportFlowHost {
  /** The routes of the import: `request` and `get`. */
  readonly imports: Pick<ImportsPort, 'request' | 'get'>;
  /** Uploads the file and resolves its asset identifier once the asset is ready. */
  readonly assets: Pick<AssetsPort, 'upload'>;
  /** The backend's timers, so that close() cancels a poll. */
  readonly clock: {
    set(fn: () => void, ms: number): number;
    clear(key: number | null | undefined): void;
  };
}

export interface ImportFlow {
  readonly importFile: ImportsPort['importFile'];
  /** Rejects every import that still follows a job (called by close()). */
  abort(reason: string): void;
}

/** The state of a job as the service reports it; `ImportJob` does not name it (G74). */
export function importState(job: ImportJob): string | undefined {
  const s = (job as { state?: unknown }).state;
  return typeof s === 'string' ? s : undefined;
}

export function createImportFlow(host: ImportFlowHost): ImportFlow {
  const running = new Set<(e: PortError) => void>();

  const importFile: ImportsPort['importFile'] = async (docId, file, opts) => {
    const signal: CancelSignal | undefined = opts?.signal;
    const { asset } = await host.assets.upload(docId, file, signal ? { signal } : undefined);
    const first = await host.imports.request(
      docId,
      { asset, format: 'docx' },
      {
        ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
      },
    );
    return follow(first, opts?.onProgress);
  };

  const follow = (first: ImportJob, onProgress?: (job: ImportJob) => void): Promise<ImportJob> =>
    new Promise<ImportJob>((resolve, reject) => {
      let timer: number | null = null;
      let last: string | undefined;
      const end = (): void => {
        host.clock.clear(timer);
        timer = null;
        running.delete(fail);
      };
      const fail = (e: PortError): void => {
        end();
        reject(e);
      };
      const report = (job: ImportJob): void => {
        const state = importState(job);
        if (state === last) return;
        last = state;
        try {
          onProgress?.(job);
        } catch {
          // The listener's own error belongs to the listener.
        }
      };
      const settle = (job: ImportJob): boolean => {
        report(job);
        const state = importState(job);
        if (state !== undefined && IMPORT_TERMINAL.has(state)) {
          end();
          resolve(job);
          return true;
        }
        return false;
      };
      const later = (): void => {
        timer = host.clock.set(() => void read(), IMPORT_POLL_MS);
      };
      const read = async (): Promise<void> => {
        timer = null;
        try {
          const { value } = await host.imports.get(first.id);
          if (!running.has(fail)) return;
          if (!settle(value)) later();
        } catch (e) {
          if (!running.has(fail)) return;
          if (e instanceof PortError && e.code === 'not_found') fail(e);
          else later();
        }
      };
      running.add(fail);
      if (!settle(first)) later();
    });

  return {
    importFile,
    abort: (reason) => {
      for (const fail of [...running]) fail(new PortError('unavailable', reason));
    },
  };
}
