/**
 * The service's way back to the caller's storage (05 §10: it "can rebuild any of them from
 * storage"; ADR 0392, proposed). The caller serves one route:
 *
 *     GET {base}/states/{stateId}
 *
 * and answers `200` with the inputs of `open` for that state (`doc`, `checkpointRef`, `commits`,
 * `stateId`), `404` when it has no such state, and anything else when it cannot say. The service
 * checks what it gets exactly as it checks an `open` call: the chain, the head and the checkpoint.
 * It trusts nothing in the answer, so the route needs no more protection than any other read of the
 * caller's own log, and a bearer token may be sent.
 */
import type { OpenRequest, StateLoader } from './service.ts';

export interface HttpLoaderOptions {
  /** The caller's base URL, without a trailing slash. */
  baseUrl: string;
  token?: string;
  /** For tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** How long to wait for storage, in milliseconds. */
  timeoutMs?: number;
}

export const DEFAULT_STORAGE_TIMEOUT_MS = 10_000;

export function httpStateLoader(options: HttpLoaderOptions): StateLoader {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    async load(stateId: string): Promise<OpenRequest | undefined> {
      const res = await doFetch(`${base}/states/${encodeURIComponent(stateId)}`, {
        headers: {
          accept: 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`storage answered ${res.status}`);
      return (await res.json()) as OpenRequest;
    },
  };
}
