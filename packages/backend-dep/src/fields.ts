/**
 * The fields port over REST (12 §3, §9, §10; FRW-046). Each method is one control-plane call, as in
 * workflow.ts: the bearer token is added by the RestClient, `If-Match` goes on the conditional
 * `PATCH`, and the answers are checked against their shapes. The port is present while the `fields`
 * feature is negotiated. `sign` is `POST /documents/{id}/fields/{fid}/sign`: the body names the
 * adopted image, `{ asset, mode }`, and the server writes the field in a commit of its own, so the
 * answer carries no document change (FRW-046 criteria 2 and 3).
 */
import type { FieldsPort, Response, Tagged } from '@docedit/protocol';
import type { RestClient } from './rest.ts';

export interface FieldsRestHost {
  /** The control-plane client, once discovery has been read. */
  rest(): Promise<RestClient>;
}

const enc = (s: string): string => encodeURIComponent(s);

export function createFieldsRest(host: FieldsRestHost): FieldsPort {
  const path = (docId: string, rest = ''): string => `/documents/${enc(docId)}${rest}`;
  const call = async <T>(
    method: string,
    url: string,
    req: Parameters<RestClient['call']>[2] = {},
  ) => (await host.rest()).call<T>(method, url, req);

  return {
    fields: async (docId, query) =>
      (
        await call<Awaited<ReturnType<FieldsPort['fields']>>>('GET', path(docId, '/fields'), {
          ...(query === undefined
            ? {}
            : { query: query as Readonly<Record<string, string | number | undefined>> }),
          shape: 'FieldInfo',
          list: true,
        })
      ).value,
    values: async (docId, seq) => {
      const r = await call<Tagged<unknown>['value']>('GET', path(docId, '/field-values'), {
        ...(seq === undefined ? {} : { query: { seq } }),
        shape: 'FieldValues',
      });
      return { value: r.value, etag: r.etag ?? '' } as Awaited<ReturnType<FieldsPort['values']>>;
    },
    prefill: async (docId, values, opts) => {
      const r = await call<Tagged<unknown>['value']>('PATCH', path(docId, '/field-values'), {
        body: values,
        ifMatch: opts.ifMatch,
        shape: 'FieldValues',
      });
      return { value: r.value, etag: r.etag ?? '' } as Awaited<ReturnType<FieldsPort['prefill']>>;
    },
    sign: async (docId, fieldId, body) =>
      (
        await call<Response<'signField'>>('POST', path(docId, `/fields/${enc(fieldId)}/sign`), {
          body,
        })
      ).value,
  };
}
