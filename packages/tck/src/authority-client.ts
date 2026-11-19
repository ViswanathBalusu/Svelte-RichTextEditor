/**
 * The kit's client for the authority service (05 §10; PRO-125). The binding is the one of ADR 0314
 * (owner decision 193): one request and one response per call, the state identifier in the path,
 * bodies as JSON, a failed call as `application/problem+json` with the service's `code`.
 *
 * | Call | Route |
 * |---|---|
 * | `open` | `POST /v1/authority/documents/{doc}/open` |
 * | `materialise` | `GET /v1/authority/states/{stateId}/content?seq=N` |
 * | `applyCommit` | `POST /v1/authority/states/{stateId}/commits` |
 * | `restoreSteps` | `POST /v1/authority/states/{stateId}/restore-steps` |
 * | `diff` | `POST /v1/authority/states/{stateId}/diff` |
 * | `attribution` | `POST /v1/authority/states/{stateId}/attribution` |
 * | `migrate` | `POST /v1/authority/documents/{doc}/migrate` |
 * | `evaluateRules` | `POST /v1/authority/states/{stateId}/evaluate-rules` |
 * | `mapRanges` | `POST /v1/authority/states/{stateId}/map-ranges` |
 * | what it supports | `GET /v1/authority/capabilities` |
 */
import type { CdmEnvelope } from '@docedit/model';
import { documentHash } from '@docedit/model';
import { KitFailure, isObject, show } from './assert.ts';
import { Http, type HttpResponse } from './rest.ts';

export const AUTHORITY_API = '/v1/authority';

/** The calls of 05 §10, by the names the capabilities answer uses. */
export const AUTHORITY_CALLS = [
  'open',
  'applyCommit',
  'materialise',
  'mapRanges',
  'restoreSteps',
  'diff',
  'attribution',
  'migrate',
  'evaluateRules',
] as const;
export type AuthorityCall = (typeof AUTHORITY_CALLS)[number];

export class AuthorityClient {
  /** The service's base URL; a restart may move it. */
  url: string;
  private readonly token: string | undefined;
  private readonly http = new Http();

  constructor(url: string, token?: string) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
  }

  /** One request. The path starts with `/v1/authority`. */
  call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<HttpResponse> {
    return this.http.request(method, `${this.url}${path}`, {
      ...(this.token !== undefined ? { token: this.token } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }

  capabilities() {
    return this.call('GET', `${AUTHORITY_API}/capabilities`);
  }

  /** `open` for a document with no log: the checkpoint is the document as created. */
  async openContent(doc: string, content: CdmEnvelope) {
    const contentHash = await documentHash(content as never);
    return this.open(doc, {
      checkpointRef: { seq: 0, chainHead: null, contentHash, content },
      commits: [],
      stateId: contentHash,
    });
  }

  open(doc: string, body: unknown) {
    return this.call('POST', `${AUTHORITY_API}/documents/${encodeURIComponent(doc)}/open`, body);
  }

  materialise(stateId: string, seq?: number) {
    return this.call(
      'GET',
      `${AUTHORITY_API}/states/${stateId}/content`,
      undefined,
      seq === undefined ? undefined : { seq },
    );
  }

  /** A call on a state: `commits`, `restore-steps`, `diff`, `attribution`, `evaluate-rules` or `map-ranges`. */
  onState(
    stateId: string,
    call: 'commits' | 'restore-steps' | 'diff' | 'attribution' | 'evaluate-rules' | 'map-ranges',
    body: unknown,
  ) {
    return this.call('POST', `${AUTHORITY_API}/states/${stateId}/${call}`, body);
  }

  migrate(doc: string, body: unknown) {
    return this.call('POST', `${AUTHORITY_API}/documents/${encodeURIComponent(doc)}/migrate`, body);
  }
}

/** The `code` of a problem document (`application/problem+json`), or undefined. */
export function problemCode(res: HttpResponse): string | undefined {
  return isObject(res.json) && typeof res.json['code'] === 'string' ? res.json['code'] : undefined;
}

/** A response that must be a success of this status. */
export function expectOk(res: HttpResponse, status: number, what: string): HttpResponse {
  if (res.status !== status)
    throw new KitFailure(
      `${what}: ${res.method} ${new URL(res.url).pathname} answered ${res.status}`,
      `HTTP ${status}`,
      `HTTP ${res.status} ${show(res.json ?? res.text)}`,
    );
  return res;
}

/** A response that must be a problem of this status and code (05 §10; RFC 9457). */
export function expectProblem(
  res: HttpResponse,
  status: number,
  code: string,
  what: string,
): HttpResponse {
  const type = res.headers.get('content-type') ?? '';
  if (
    res.status !== status ||
    problemCode(res) !== code ||
    !type.startsWith('application/problem+json')
  )
    throw new KitFailure(
      `${what}: ${res.method} ${new URL(res.url).pathname}`,
      `HTTP ${status} application/problem+json with code ${code}`,
      `HTTP ${res.status} ${type} ${show(res.json ?? res.text)}`,
    );
  return res;
}
