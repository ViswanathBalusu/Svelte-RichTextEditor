// The machine-readable definitions are well-formed and say what the definition says (SPK-019;
// PRO-001 to PRO-003): Ajv compiles every JSON Schema, generated examples get the same verdict from
// Ajv and from the codec's validator, unknown members are allowed (05 §1 rule 3), a missing
// required member fails, and the AsyncAPI and OpenAPI documents pass structural checks.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractDocument } from '../src/contract/fixtures.ts';
import { ShapeValidator } from '../src/codec/validate.ts';
import { DEP1 } from '../src/definition/index.ts';
import { webhookEnvelope, webhookType } from '../src/definition/events.ts';
import type { Shape } from '../src/definition/shapes.ts';
import { ExampleBuilder } from '../src/generate/examples.ts';
import { payloadTypeName } from '../src/generate/typescript.ts';
import {
  ajv2020,
  ajvDraft7,
  readJson,
  refsOf,
  resolvePointer,
  rewriteRefs,
  root,
} from './support.ts';

const standalone = readJson('spec/dep/dep-1.schema.json');
const asyncapi = readJson('spec/dep/dep-1.asyncapi.json');
const openapi = readJson('spec/dep/dep-1.openapi.json');
const examples = new ExampleBuilder(DEP1, contractDocument());
const validator = new ShapeValidator(DEP1);
const ajv = ajv2020();
ajv.addSchema(standalone);
const DEP_ID = standalone['$id'] as string;
const schemaFor = (name: string) => {
  const v = ajv.getSchema(`${DEP_ID}#/$defs/${name}`);
  if (!v) throw new Error(`no schema ${name}`);
  return v;
};

/** Shapes whose top level is an object, with their name in the standalone schema. */
function objectShapes(): Array<[string, Shape]> {
  const out: Array<[string, Shape]> = [];
  for (const s of DEP1.shapes) if (s.shape.kind === 'object') out.push([s.name, s.shape]);
  for (const m of DEP1.messages)
    if (m.payload?.kind === 'object') out.push([payloadTypeName(m)!, m.payload]);
  return out;
}

describe('the standalone JSON Schema (spec/dep/dep-1.schema.json)', () => {
  it('compiles with Ajv (2020-12, strict, formats), resolving the CDM schema by its $id', () => {
    expect(standalone['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    for (const name of Object.keys(standalone['$defs'] as object))
      expect(() => schemaFor(name), name).not.toThrow();
  });

  it('accepts minimal and maximal examples of every shape, as the codec validator does', () => {
    for (const s of DEP1.shapes)
      for (const mode of ['min', 'max'] as const) {
        const value = examples.build(s.shape, mode);
        const v = schemaFor(s.name);
        expect(v(value), `${s.name} ${mode}: ${JSON.stringify(v.errors)}`).toBe(true);
        expect(validator.check(s.shape, value), `${s.name} ${mode}`).toEqual([]);
      }
  });

  it('allows unknown members everywhere (05 §1 rule 3) and fails when a required member is missing', () => {
    for (const [name, shape] of objectShapes()) {
      if (shape.kind !== 'object') continue;
      const v = schemaFor(name);
      const max = examples.build(shape, 'max') as Record<string, unknown>;
      const extended = { ...max, x_unknown_member: { nested: [1, 'two'] } };
      expect(v(extended), `${name} with an unknown member`).toBe(true);
      expect(validator.check(shape, extended), `${name} with an unknown member`).toEqual([]);
      for (const [k, p] of Object.entries(shape.props)) {
        if (p.required !== true) continue;
        const missing = Object.fromEntries(Object.entries(max).filter(([m]) => m !== k));
        expect(v(missing), `${name} without ${k}`).toBe(false);
        expect(validator.check(shape, missing).length, `${name} without ${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('validates every message as a frame, and accepts a frame of an unknown type', () => {
    const frame = schemaFor('Frame');
    for (const m of DEP1.messages)
      for (const mode of ['min', 'max'] as const) {
        const env = examples.message(m, mode);
        expect(frame(env), `${m.t} ${mode}: ${JSON.stringify(frame.errors)}`).toBe(true);
        if (m.payload)
          expect(frame({ ...env, d: 'not an object' }), `${m.t} with a bad payload`).toBe(false);
        if (m.id === 'required') {
          const { id: _id, ...noId } = env;
          expect(frame(noId), `${m.t} without id`).toBe(false);
        }
      }
    expect(frame({ t: 'x-future.message', d: { anything: true } })).toBe(true);
    expect(frame({ d: {} })).toBe(false);
  });

  it('checks conditional members: sync.ack carries steps when rebased', () => {
    const ack = schemaFor('Ack');
    const base = {
      id: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
      seq: 5,
      serverTime: '2026-09-18T10:42:00.000Z',
    };
    expect(ack({ ...base, rebased: false })).toBe(true);
    expect(ack({ ...base, rebased: true })).toBe(false);
    expect(ack({ ...base, rebased: true, steps: [{ stepType: 'replace', from: 1, to: 1 }] })).toBe(
      true,
    );
  });

  it('refuses scope identifiers outside the grammar of 05 §5.3', () => {
    const reject = schemaFor('SyncReject');
    const base = { id: 'x', code: 'permission_denied', message: 'no', action: 'drop', head: 3 };
    expect(reject({ ...base, scopes: ['body', 'region:rG7mK2pQ9xYt4HcD', 'defs', 'doc'] })).toBe(
      true,
    );
    expect(reject({ ...base, scopes: ['defs:style_def/Normal'] })).toBe(false);
    expect(reject({ ...base, scopes: ['region:short'] })).toBe(false);
  });
});

describe('the webhook schemas (spec/dep/webhooks)', () => {
  it('exist for every event of 05 §7 and 12 §10, compile, accept their examples and refuse a missing member', () => {
    for (const w of DEP1.webhooks) {
      const type = webhookType(w);
      const path = `spec/dep/webhooks/${type}.schema.json`;
      expect(existsSync(resolve(root, path)), path).toBe(true);
      const schema = readJson(path);
      const fresh = ajv2020();
      const v = fresh.compile(schema);
      const shape = webhookEnvelope(w);
      const body = examples.build(shape, 'max') as Record<string, unknown>;
      expect(body['type']).toBe(type);
      expect(v(body), `${type}: ${JSON.stringify(v.errors)}`).toBe(true);
      expect(
        v({ ...body, data: { ...(body['data'] as object), x_extra: 1 } }),
        `${type} with an unknown data member`,
      ).toBe(true);
      const { data: _d, ...noData } = body;
      expect(v(noData), `${type} without data`).toBe(false);
      const { seq: _s, ...noSeq } = body['data'] as Record<string, unknown>;
      expect(v({ ...body, data: noSeq }), `${type} without data.seq`).toBe(false);
      expect(v({ ...body, type: 'dep.other.v1' }), `${type} with another type`).toBe(false);
    }
  });
});

describe('the AsyncAPI document (spec/dep/dep-1.asyncapi.json)', () => {
  const components = asyncapi['components'] as {
    schemas: Record<string, unknown>;
    messages: Record<string, Record<string, unknown>>;
  };
  const channel = (asyncapi['channels'] as Record<string, Record<string, unknown>>)['dep']!;
  const operations = asyncapi['operations'] as Record<
    string,
    {
      action: string;
      channel: { $ref: string };
      messages: Array<{ $ref: string }>;
      reply?: { messages: Array<{ $ref: string }> };
    }
  >;

  it('is AsyncAPI 3.0 with the subprotocol dep.v1 and protocol version 1.0', () => {
    expect(asyncapi['asyncapi']).toBe('3.0.0');
    expect(asyncapi['info']).toMatchObject({
      title: expect.any(String),
      version: '1.0',
      'x-dep-subprotocol': 'dep.v1',
    });
    const headers = (
      channel['bindings'] as { ws: { headers: { properties: Record<string, { const: string }> } } }
    ).ws.headers;
    expect(headers.properties['Sec-WebSocket-Protocol']!.const).toBe('dep.v1');
    expect((channel['x-dep-close-codes'] as Array<{ code: number }>).map((c) => c.code)).toEqual(
      DEP1.closeCodes.map((c) => c.code),
    );
  });

  it('resolves every reference', () => {
    for (const ref of refsOf(asyncapi)) {
      if (ref.startsWith('#')) expect(resolvePointer(asyncapi, ref), ref).toBeDefined();
      else {
        const [file, fragment] = ref.split('#') as [string, string];
        const target = readJson(
          resolve(root, 'spec/dep', file)
            .slice(root.length + 1)
            .replace(/\\/g, '/'),
        );
        expect(resolvePointer(target, `#${fragment}`), ref).toBeDefined();
      }
    }
  });

  it('defines one message per message type, with the envelope members and the direction', () => {
    expect(Object.keys(components.messages).sort()).toEqual(DEP1.messages.map((m) => m.t).sort());
    expect(Object.keys(channel['messages'] as object).sort()).toEqual(
      DEP1.messages.map((m) => m.t).sort(),
    );
    for (const m of DEP1.messages) {
      const msg = components.messages[m.t]!;
      expect(msg['name']).toBe(m.t);
      expect(msg['x-dep-direction']).toBe(m.dir);
      const env = components.schemas[`message.${m.t}`] as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(env.properties['t']).toEqual({ const: m.t });
      for (const k of ['id', 'd']) expect(env.properties, `${m.t}.${k}`).toHaveProperty(k);
      if (m.ch !== 'none') expect(env.properties).toHaveProperty('ch');
      if (m.re !== 'none') expect(env.properties).toHaveProperty('re');
      expect(env.required.includes('id')).toBe(m.id === 'required');
      expect(env.required.includes('re')).toBe(m.re === 'required');
      expect(env.required.includes('ch')).toBe(m.ch === 'required');
    }
  });

  it('has operations whose messages belong to the channel, in the direction of each message', () => {
    for (const m of DEP1.messages) {
      const actions =
        m.dir === 'c2s' ? ['receive'] : m.dir === 's2c' ? ['send'] : ['receive', 'send'];
      for (const a of actions) expect(operations, `${a}.${m.t}`).toHaveProperty(`${a}.${m.t}`);
    }
    for (const [id, op] of Object.entries(operations)) {
      expect(['send', 'receive'], id).toContain(op.action);
      expect(op.channel.$ref).toBe('#/channels/dep');
      for (const r of [...op.messages, ...(op.reply?.messages ?? [])])
        expect(r.$ref.startsWith('#/channels/dep/messages/'), id).toBe(true);
      const t = op.messages[0]!.$ref.split('/').pop()!;
      const dir = DEP1.messages.find((m) => m.t === t)!.dir;
      expect(dir === 'both' || (op.action === 'receive') === (dir === 'c2s'), id).toBe(true);
    }
    expect(Object.keys(components.schemas).every((k) => /^[a-zA-Z0-9.\-_]+$/.test(k))).toBe(true);
  });

  it('has schemas that compile as draft-07 (the AsyncAPI schema format)', () => {
    const local = rewriteRefs(
      { $id: 'urn:test:asyncapi', definitions: components.schemas },
      '#/components/schemas/',
      '#/definitions/',
    ) as Record<string, unknown>;
    const noCdm = JSON.parse(
      JSON.stringify(local).replace(
        /"\$ref":"\.\.\/cdm\/cdm-1\.schema\.json(#[^"]*)?"/g,
        '"type":"object"',
      ),
    ) as Record<string, unknown>;
    const draft7 = ajvDraft7();
    draft7.addSchema(noCdm);
    for (const name of Object.keys(components.schemas)) {
      const v = draft7.getSchema(`urn:test:asyncapi#/definitions/${name}`);
      expect(v, name).toBeDefined();
    }
    const frame = draft7.getSchema('urn:test:asyncapi#/definitions/message.sync.submit')!;
    expect(
      frame(
        examples.message(
          DEP1.messages.find((m) => m.t === 'sync.submit')!,
          'max',
        ),
      ),
    ).toBe(true);
  });
});

describe('the OpenAPI document (spec/dep/dep-1.openapi.json)', () => {
  const paths = openapi['paths'] as Record<string, Record<string, Record<string, unknown>>>;
  const components = openapi['components'] as Record<string, Record<string, unknown>>;
  const ops = Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([k]) => ['get', 'post', 'put', 'patch', 'delete'].includes(k))
      .map(([method, op]) => ({ path, method: method.toUpperCase(), op })),
  );

  it('is OpenAPI 3.1 with protocol version 1.0 and the JSON Schema 2020-12 dialect', () => {
    expect(openapi['openapi']).toBe('3.1.0');
    expect(openapi['info']).toMatchObject({ version: '1.0' });
    expect(openapi['jsonSchemaDialect']).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('resolves every reference', () => {
    for (const ref of refsOf(openapi)) {
      if (ref.startsWith('#')) expect(resolvePointer(openapi, ref), ref).toBeDefined();
      else {
        const [file, fragment] = ref.split('#') as [string, string];
        const target = readJson(
          resolve(root, 'spec/dep', file)
            .slice(root.length + 1)
            .replace(/\\/g, '/'),
        );
        expect(resolvePointer(target, `#${fragment ?? ''}`), ref).toBeDefined();
      }
    }
  });

  it('gives every operation a unique id, its path parameters, a success and problem responses', () => {
    const ids = ops.map((o) => o.op['operationId']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ops.length).toBe(DEP1.operations.length);
    for (const { path, method, op } of ops) {
      const where = `${method} ${path}`;
      const params = (op['parameters'] as Array<Record<string, unknown>>).map((p) =>
        '$ref' in p ? (resolvePointer(openapi, p['$ref'] as string) as Record<string, unknown>) : p,
      );
      for (const m of path.matchAll(/\{(\w+)\}/g))
        expect(
          params.some((p) => p['in'] === 'path' && p['name'] === m[1] && p['required'] === true),
          `${where} {${m[1]}}`,
        ).toBe(true);
      const responses = op['responses'] as Record<string, unknown>;
      for (const k of Object.keys(responses))
        expect(/^([1-5]XX|[1-5][0-9]{2}|default)$/.test(k), `${where} response ${k}`).toBe(true);
      expect(responses['4XX'], where).toEqual({ $ref: '#/components/responses/Problem4XX' });
      expect(responses['5XX'], where).toEqual({ $ref: '#/components/responses/Problem5XX' });
      expect(
        Object.keys(responses).some((k) => k.startsWith('2')),
        where,
      ).toBe(true);
      const def = DEP1.operations.find((o) => o.method === method && o.path === path)!;
      if (def.ifMatch === 'required')
        expect(
          params.some((p) => p['name'] === 'If-Match' && p['required'] === true),
          `${where} If-Match`,
        ).toBe(true);
      if (def.idempotencyKey)
        expect(
          params.some((p) => p['name'] === 'Idempotency-Key'),
          `${where} Idempotency-Key`,
        ).toBe(true);
      if (def.success.etag)
        expect(
          (responses[def.success.status] as { headers: object }).headers,
          `${where} ETag`,
        ).toHaveProperty('ETag');
      for (const s of op['security'] as Array<Record<string, unknown>>)
        for (const scheme of Object.keys(s))
          expect(components['securitySchemes'], where).toHaveProperty(scheme);
      const service =
        def.security.length === 1 &&
        (def.security[0] === 'service' || def.security[0] === 'operator');
      expect(
        (op['security'] as Array<Record<string, unknown>>).some((s) => 'userToken' in s),
        `${where} user token`,
      ).toBe(!service && def.security.length > 0);
    }
  });

  it('uses problem details whose code is the registry of 05 §5.8, and cursor lists', () => {
    const problem = components['schemas']!['ProblemDetails'] as {
      properties: { code: { enum: string[] } };
    };
    for (const c of problem.properties.code.enum)
      expect(DEP1.errors.map((e) => e.code)).toContain(c);
    const list = ops.find((o) => o.op['operationId'] === 'listDocuments')!.op;
    const schema = (
      list['responses'] as Record<
        string,
        { content: Record<string, { schema: { properties: object; required: string[] } }> }
      >
    )['200']!.content['application/json']!.schema;
    expect(schema.required).toEqual(['items', 'nextCursor']);
    expect(
      (resolvePointer(openapi, '#/components/parameters/Limit') as { schema: { maximum: number } })
        .schema.maximum,
    ).toBe(200);
  });

  it('describes every webhook with the Standard Webhooks headers and a CloudEvents body', () => {
    const webhooks = openapi['webhooks'] as Record<
      string,
      { post: { parameters: Array<{ name: string }> } }
    >;
    expect(Object.keys(webhooks).sort()).toEqual(DEP1.webhooks.map(webhookType).sort());
    for (const [type, w] of Object.entries(webhooks))
      expect(
        w.post.parameters.map((p) => p.name),
        type,
      ).toEqual(['webhook-id', 'webhook-timestamp', 'webhook-signature']);
  });

  it('has component schemas that compile as JSON Schema 2020-12', () => {
    const local = rewriteRefs(
      { $id: 'urn:test:openapi', $defs: components['schemas'] },
      '#/components/schemas/',
      '#/$defs/',
    );
    const withCdm = rewriteRefs(
      local,
      '../cdm/cdm-1.schema.json',
      readJson('spec/cdm/cdm-1.schema.json')['$id'] as string,
    ) as Record<string, unknown>;
    const v2020 = ajv2020();
    v2020.addSchema(withCdm);
    for (const name of Object.keys(components['schemas']!))
      expect(v2020.getSchema(`urn:test:openapi#/$defs/${name}`), name).toBeDefined();
    const content = v2020.getSchema('urn:test:openapi#/$defs/Content')!;
    expect(
      content(examples.build({ kind: 'ref', name: 'Content' }, 'max')),
      JSON.stringify(content.errors),
    ).toBe(true);
    expect(
      content({ seq: 1, incarnation: 'x', cdm: 1, requires: [], doc: { type: 'not-a-cdm-node' } }),
    ).toBe(false);
  });
});
