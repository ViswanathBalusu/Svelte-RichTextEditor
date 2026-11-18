/**
 * The workflow port over REST (12 §6, §7, §10; FRW-028, FRW-035). Each method is one control-plane
 * call, as in review.ts: the bearer token is added by the RestClient, `If-Match` goes on the
 * conditional `PUT`, and the response of the workflow routes is checked against the `Workflow`
 * shape. The port's `onChange` is not here: it follows the channel (`ch.opened.workflow` and
 * `wf.changed`), so the backend adds it.
 */
import type { Tagged, WorkflowPort } from '@docedit/protocol';
import type { RestClient } from './rest.ts';

export interface WorkflowRestHost {
  /** The control-plane client, once discovery has been read. */
  rest(): Promise<RestClient>;
}

type Value = Awaited<ReturnType<WorkflowPort['get']>>['value'];

const enc = (s: string): string => encodeURIComponent(s);

/** The workflow port without `onChange`. */
export function createWorkflowRest(host: WorkflowRestHost): Omit<WorkflowPort, 'onChange'> {
  const path = (docId: string, rest = ''): string => `/documents/${enc(docId)}/workflow${rest}`;
  const tagged = async (
    method: string,
    url: string,
    req: { body?: unknown; ifMatch?: string } = {},
  ): Promise<Tagged<Value>> => {
    const r = await (await host.rest()).call<Value>(method, url, { ...req, shape: 'Workflow' });
    return { value: r.value, etag: r.etag ?? '' };
  };
  const plain = async <T>(method: string, url: string, body?: unknown): Promise<T> =>
    (await (await host.rest()).call<T>(method, url, body === undefined ? {} : { body })).value;

  return {
    get: (docId) => tagged('GET', path(docId)),
    put: (docId, workflow, opts) =>
      tagged('PUT', path(docId), { body: workflow, ifMatch: opts.ifMatch }),
    act: (docId, action, body) =>
      tagged('POST', path(docId, `/${action}`), body === undefined ? {} : { body }),
    participant: (docId, participantId, action, body) =>
      plain('POST', path(docId, `/participants/${enc(participantId)}/${action}`), body),
    evidence: (docId) => plain('GET', path(docId, '/evidence')),
    final: (docId) => plain('GET', path(docId, '/final')),
  };
}
