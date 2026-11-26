/**
 * Generates the OpenAPI 3.1 document of the control plane (PRO-002) and, under `webhooks`, the
 * events plane (05 §7). Success statuses follow decision D61; problem responses are `4XX` and
 * `5XX` ranges, and the status of each code is the `httpStatus` of the registry (D61).
 */
import type { DepDefinition } from '../definition/extension.ts';
import { webhookEnvelope, webhookType } from '../definition/events.ts';
import { PATH_PARAMS, type OperationDef } from '../definition/resources.ts';
import type { Prop } from '../definition/shapes.ts';
import {
  type JsonSchema,
  type SchemaOptions,
  namedSchema,
  propSchema,
  toSchema,
} from './json-schema.ts';
import { reachable } from './reach.ts';

export const OPENAPI_REF = '#/components/schemas/';

export function openApiSchemaOptions(cdmPath: string): SchemaOptions {
  return {
    refBase: OPENAPI_REF,
    cdmRef: (t) => (t === 'cdm-doc' ? `${cdmPath}#/$defs/node.doc` : cdmPath),
  };
}

const json = (schema: JsonSchema) => ({ 'application/json': { schema } });

function parameter(
  name: string,
  where: 'path' | 'query' | 'header',
  p: Prop,
  o: SchemaOptions,
): JsonSchema {
  const out: JsonSchema = {
    name,
    in: where,
    required: where === 'path' ? true : p.required === true,
    schema: propSchema(p, o),
  };
  const description = p.doc ?? p.shape.doc;
  if (description) out['description'] = description;
  return out;
}

function listSchema(item: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      items: { type: 'array', items: item },
      nextCursor: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Opaque cursor of the next page; null on the last page (D14).',
      },
    },
    required: ['items', 'nextCursor'],
    $comment: '05 §6.1; gaps: G55; decisions: D14',
  };
}

const SUCCESS: Record<OperationDef['success']['status'], string> = {
  '200': 'OK.',
  '201': 'Created.',
  '202': 'Accepted: a job was created.',
  '204': 'No content.',
  '2XX': 'Success. No status code is defined for this route yet.',
};

function operation(op: OperationDef, o: SchemaOptions): JsonSchema {
  const parameters: JsonSchema[] = [];
  for (const m of op.path.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    parameters.push(parameter(name, 'path', (op.params?.[name] ?? PATH_PARAMS[name])!, o));
  }
  for (const [name, p] of Object.entries(op.query ?? {}))
    parameters.push(parameter(name, 'query', p, o));
  if (op.success.list)
    parameters.push(
      { $ref: '#/components/parameters/Cursor' },
      { $ref: '#/components/parameters/Limit' },
    );
  if (op.ifMatch === 'required') parameters.push({ $ref: '#/components/parameters/IfMatch' });
  if (op.ifMatch === 'optional')
    parameters.push({ $ref: '#/components/parameters/IfMatchOptional' });
  if (op.idempotencyKey) parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
  if (op.security.includes('service'))
    parameters.push({ $ref: '#/components/parameters/DepActor' });
  if (op.security.length) parameters.push({ $ref: '#/components/parameters/Traceparent' });

  const successBody = op.success.body ? toSchema(op.success.body, o) : undefined;
  const success: JsonSchema = { description: SUCCESS[op.success.status] };
  const headers: JsonSchema = { 'DEP-Request-Id': { $ref: '#/components/headers/RequestId' } };
  if (op.success.etag) headers['ETag'] = { $ref: '#/components/headers/ETag' };
  if (op.security.length) headers['Deprecation'] = { $ref: '#/components/headers/Deprecation' };
  if (op.security.length) headers['Sunset'] = { $ref: '#/components/headers/Sunset' };
  if (Object.keys(headers).length) success['headers'] = headers;
  if (successBody)
    success['content'] = json(op.success.list ? listSchema(successBody) : successBody);

  const description = [
    op.summary,
    op.requires ? `Requires: ${op.requires} (07 §12).` : '',
    op.feature ? `Only when the server announces the feature \`${op.feature}\`.` : '',
    `Specified in ${op.spec}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const out: JsonSchema = {
    operationId: op.operationId,
    summary: op.summary,
    description,
    tags: [tagOf(op)],
    security: op.security.map((c) => ({
      [c === 'user' ? 'userToken' : c === 'operator' ? 'operatorCredential' : 'serviceCredential']:
        [],
    })),
    parameters,
  };
  if (op.body) out['requestBody'] = { required: true, content: json(toSchema(op.body, o)) };
  out['responses'] = {
    [op.success.status]: success,
    '4XX': { $ref: '#/components/responses/Problem4XX' },
    '5XX': { $ref: '#/components/responses/Problem5XX' },
  };
  out['x-dep-spec'] = op.spec;
  out['x-dep-owner'] = op.owner;
  if (op.requires) out['x-dep-requires'] = op.requires;
  if (op.feature) out['x-dep-feature'] = op.feature;
  if (op.codes?.length) out['x-dep-codes'] = [...op.codes];
  if (op.gaps?.length) out['x-dep-gaps'] = [...op.gaps];
  if (op.decisions?.length) out['x-dep-decisions'] = [...op.decisions];
  return out;
}

function tagOf(op: OperationDef): string {
  const seg = op.path.split('/').filter(Boolean);
  if (seg[0] === '.well-known') return 'discovery';
  if (seg[0] === 'documents' && seg.length > 2) return seg[2]!.replace(/-.*/, '');
  return seg[0]!;
}

export function generateOpenApi(
  def: DepDefinition,
  cdmPath = '../cdm/cdm-1.schema.json',
): JsonSchema {
  const o = openApiSchemaOptions(cdmPath);
  const schemas: JsonSchema = {};
  const roots = [
    ...def.operations.flatMap((op) => [
      ...(op.body ? [op.body] : []),
      ...(op.success.body ? [op.success.body] : []),
      ...Object.values(op.query ?? {}).map((p) => p.shape),
      ...Object.values(op.params ?? {}).map((p) => p.shape),
    ]),
    ...def.webhooks.map((w) => webhookEnvelope(w)),
    { kind: 'ref', name: 'ProblemDetails' } as const,
  ];
  for (const s of reachable(def, roots)) schemas[s.name] = namedSchema(s, o);
  for (const w of def.webhooks) {
    const type = webhookType(w);
    schemas[`webhook.${type}`] = { title: type, ...toSchema(webhookEnvelope(w), o) };
  }

  const paths: Record<string, JsonSchema> = {};
  for (const op of def.operations) {
    const item = (paths[op.path] ??= {});
    if (op.base === 'endpoint')
      item['servers'] = [
        {
          url: '{endpoint}',
          description: 'The endpoint given to the component (05 §8.1).',
          variables: { endpoint: { default: 'https://docs.example.com' } },
        },
      ];
    item[op.method.toLowerCase()] = operation(op, o);
  }

  const webhooks: JsonSchema = {};
  for (const w of def.webhooks) {
    const type = webhookType(w);
    webhooks[type] = {
      post: {
        operationId: `webhook.${type}`,
        summary: w.when,
        description: `${w.when} Delivered at least once, with exponential retry for up to 24 hours; receivers deduplicate on \`webhook-id\`; order is not guaranteed (05 §7).`,
        parameters: [
          {
            name: 'webhook-id',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'Standard Webhooks message identifier; receivers deduplicate on it.',
          },
          {
            name: 'webhook-timestamp',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: '^[0-9]+$' },
            description: 'Seconds since the epoch; five-minute tolerance.',
          },
          {
            name: 'webhook-signature',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'HMAC-SHA256 signatures; two secrets are active during rotation.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/cloudevents+json': { schema: { $ref: `${OPENAPI_REF}webhook.${type}` } },
          },
        },
        responses: { '2XX': { description: 'Received.' } },
        'x-dep-spec': w.spec,
        'x-dep-owner': w.owner,
        ...(w.gaps?.length ? { 'x-dep-gaps': [...w.gaps] } : {}),
        ...(w.decisions?.length ? { 'x-dep-decisions': [...w.decisions] } : {}),
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'DEP control plane',
      version: def.version,
      description: [
        `The control plane and the events plane of the Document Editing Protocol ${def.version} (${def.status}), generated from packages/protocol/src/definition (05 §6, §7; SPK-019, PRO-002, PRO-003).`,
        'Conventions (05 §6.1): JSON bodies; errors are RFC 9457 problem details with a `code` from the registry; every mutable resource has an `ETag` and updates require `If-Match`; POST requests that create something accept an `Idempotency-Key` (scoped to the tenant, the caller, the route and a hash of the body, remembered for 24 hours); lists are `{ items, nextCursor }` with an opaque `cursor` and a `limit` of at most 200; requests may carry `traceparent`.',
        "Browsers: the service answers CORS preflights for the tenant's allowed origins, allows the headers Authorization, Content-Type, If-Match, Idempotency-Key, DEP-Actor and traceparent, and exposes ETag, Retry-After, Deprecation and Sunset.",
        "A resource addressed by a bare identifier (`/threads/{tid}`, `/exports/{jid}`, `/assets/{aid}`) is resolved to its document, and the caller's token must cover that document.",
        'Success statuses follow decision D61 (200 with a body, 201 when a resource is created, 202 when a job is started, 204 without a body). Problem responses are declared as `4XX` and `5XX` ranges; the status of each code is its `httpStatus` in the registry (spec/dep/dep-1.registry.json), and a missing `If-Match` is 428 with `precondition_failed`. Every response carries `DEP-Request-Id` (D71). Placeholders for bodies the prose does not define are marked with their gap (decision D26).',
      ].join('\n\n'),
      'x-dep-status': def.status,
      'x-dep-cors': {
        allowHeaders: [
          'Authorization',
          'Content-Type',
          'If-Match',
          'Idempotency-Key',
          'DEP-Actor',
          'traceparent',
        ],
        exposeHeaders: ['ETag', 'Retry-After', 'Deprecation', 'Sunset', 'DEP-Request-Id'],
      },
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [
      {
        url: '{rest}',
        description:
          'The complete `rest` base URL announced in discovery (05 §2); resource paths are relative to it.',
        variables: { rest: { default: 'https://docs.example.com/v1' } },
      },
    ],
    paths,
    webhooks,
    components: {
      schemas,
      parameters: {
        Cursor: {
          name: 'cursor',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Opaque cursor from `nextCursor`.',
        },
        Limit: {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200 },
          description:
            'At most 200; 50 when absent. A value outside 1 to 200 is `validation_failed` (D72). `/commits` pages with `after` (G55).',
        },
        IfMatch: {
          name: 'If-Match',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: 'The `ETag` the update is based on (05 §6.1).',
        },
        IfMatchOptional: {
          name: 'If-Match',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Optional on DELETE (D15; G57).',
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', minLength: 1 },
          description: 'The same key with a different body is `idempotency_mismatch` (05 §6.1).',
        },
        DepActor: {
          name: 'DEP-Actor',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description:
            'With a service credential: the user the call acts for; history attributes the change to them (05 §3.2).',
        },
        Traceparent: {
          name: 'traceparent',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'W3C trace context (05 §6.1).',
        },
      },
      headers: {
        ETag: { description: 'Entity tag of the resource (05 §6.1).', schema: { type: 'string' } },
        RequestId: {
          description:
            'The request identifier (05 §6.1 "responses carry a request identifier"; D71).',
          schema: { type: 'string' },
        },
        RetryAfter: {
          description: 'With `rate_limited` and `quota_exceeded` (05 §5.8).',
          schema: { type: 'string' },
        },
        Deprecation: {
          description: 'On deprecated resources (05 §1 rule 6).',
          schema: { type: 'string' },
        },
        Sunset: {
          description: 'On deprecated resources (05 §1 rule 6).',
          schema: { type: 'string' },
        },
      },
      responses: {
        Problem4XX: {
          description:
            'A client error as RFC 9457 problem details; the status of each code is its `httpStatus` in the registry (D61).',
          headers: {
            'Retry-After': { $ref: '#/components/headers/RetryAfter' },
            'DEP-Request-Id': { $ref: '#/components/headers/RequestId' },
          },
          content: {
            'application/problem+json': { schema: { $ref: `${OPENAPI_REF}ProblemDetails` } },
          },
        },
        Problem5XX: {
          description:
            'A server error as RFC 9457 problem details; the status of each code is its `httpStatus` in the registry (D61).',
          headers: {
            'Retry-After': { $ref: '#/components/headers/RetryAfter' },
            'DEP-Request-Id': { $ref: '#/components/headers/RequestId' },
          },
          content: {
            'application/problem+json': { schema: { $ref: `${OPENAPI_REF}ProblemDetails` } },
          },
        },
      },
      securitySchemes: {
        userToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'A user token (05 §3.1): host-signed or minted through POST /tokens; `exp` at most 15 minutes after `iat`; never placed in URLs.',
        },
        serviceCredential: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A service credential (05 §3.2): an API key, or a JWT with the type header `dep-svc+jwt`. How an API key is presented is not stated (G08); both are assumed to be bearer credentials (D18). It is the tenant administrator credential: bound to one tenant, never valid for another (UX-076; decision 68).',
        },
        operatorCredential: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An operator credential (UX-076; decision 68): for every tenant of the service, issued to the people and tools that run it. It manages tenants and is not a tenant administrator credential; a user token and a service credential are refused on its routes, and it is refused on theirs.',
        },
      },
    },
  };
}
