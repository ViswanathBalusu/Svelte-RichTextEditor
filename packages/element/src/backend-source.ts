/**
 * Where the element's backend comes from (05 §8.1, §8.3; PRO-074, PRO-090).
 *
 * - A `backend` property wins: the element uses that object for every port, ignores `endpoint`
 *   and makes no discovery request of its own.
 * - Otherwise `endpoint` and `getToken` make a DEP client (`@docedit/backend-dep`), which is loaded
 *   on demand, so that a host that passes its own backend never downloads it. The client announces
 *   the protocol features and the CDM features the editing core supports, in `hello` and in every
 *   `ch.open` (05 §1 rule 4; 03 §11.1).
 *
 * Tests and demos replace the endpoint factory through `src/testing.ts`; the published module does
 * not expose it.
 */
import type { Backend, TokenSource } from '@docedit/protocol';

export interface EndpointOptions {
  endpoint: string;
  /** The host's `getToken`, called with `{ docId }`. */
  getToken: TokenSource;
  docId: string;
}

export type EndpointBackendFactory = (options: EndpointOptions) => Backend | Promise<Backend>;

const depBackend: EndpointBackendFactory = async (options) => {
  const [{ createDepBackend, DEFAULT_FEATURES }, { capabilities }] = await Promise.all([
    import('@docedit/backend-dep'),
    import('@docedit/engine'),
  ]);
  return createDepBackend({
    endpoint: options.endpoint,
    getToken: options.getToken,
    docId: options.docId,
    // `exports`, `assets`, `leases`, `history` and `workflow` are asked for because the element uses
    // the ports (`requestExport`, pasted pictures, the check-out control of the permissions pane, the
    // history pane, the participant's fill mode); they are negotiated only where the server announces
    // them (SEC-007; PRM-043; UX-097; UX-106).
    features: [
      ...new Set([
        ...DEFAULT_FEATURES,
        'exports',
        'assets',
        'leases',
        'history',
        'workflow',
        ...capabilities().features,
      ]),
    ],
  });
};

let factory: EndpointBackendFactory = depBackend;

/** Replaces the endpoint factory; `null` restores the DEP client. For tests and demos only. */
export function setEndpointBackendFactory(next: EndpointBackendFactory | null): void {
  factory = next ?? depBackend;
}

/** Makes the backend for an endpoint. */
export async function endpointBackend(options: EndpointOptions): Promise<Backend> {
  return factory(options);
}
