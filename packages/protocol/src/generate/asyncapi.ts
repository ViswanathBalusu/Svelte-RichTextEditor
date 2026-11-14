/**
 * Generates the AsyncAPI 3.0 document of the real-time plane (PRO-001): the subprotocol `dep.v1`,
 * the envelope, one message per message type with its direction, and an operation per direction.
 *
 * The document describes a DEP server: `receive` operations are what a client sends, `send`
 * operations what the server sends.
 */
import type { DepDefinition } from '../definition/extension.ts';
import type { MessageDef } from '../definition/messages.ts';
import { SAFE_MAX } from '../definition/shapes.ts';
import {
  type JsonSchema,
  type SchemaOptions,
  comment,
  namedSchema,
  toSchema,
} from './json-schema.ts';
import { reachable } from './reach.ts';
import { payloadTypeName } from './typescript.ts';

export const ASYNCAPI_REF = '#/components/schemas/';

export function asyncApiSchemaOptions(cdmPath: string): SchemaOptions {
  return {
    refBase: ASYNCAPI_REF,
    cdmRef: (t) => (t === 'cdm-doc' ? `${cdmPath}#/$defs/node.doc` : cdmPath),
  };
}

const DIRECTION = {
  c2s: 'client to server',
  s2c: 'server to client',
  both: 'either direction',
} as const;

/** The envelope schema of one message type (05 §4). */
export function messageEnvelopeSchema(m: MessageDef, refBase: string): JsonSchema {
  const required = ['t'];
  const properties: JsonSchema = { t: { const: m.t } };
  properties['id'] = {
    type: 'string',
    description:
      m.id === 'required'
        ? 'Required: the message expects a reply.'
        : 'Set when the sender expects a reply.',
  };
  if (m.id === 'required') required.push('id');
  if (m.re !== 'none') {
    properties['re'] = { type: 'string', description: 'The `id` of the message this one answers.' };
    if (m.re === 'required') required.push('re');
  }
  if (m.ch !== 'none') {
    properties['ch'] = {
      type: 'integer',
      minimum: 0,
      maximum: SAFE_MAX,
      description: 'Channel number.',
    };
    if (m.ch === 'required') required.push('ch');
  }
  const payload = payloadTypeName(m);
  if (payload) {
    properties['d'] = { $ref: `${refBase}${payload}` };
    required.push('d');
  } else {
    properties['d'] = { type: 'object', description: 'No payload members; may be omitted (D02).' };
  }
  const out: JsonSchema = {
    title: `${m.t} envelope`,
    description: `\`${m.t}\` (${DIRECTION[m.dir]}): ${m.summary}`,
    type: 'object',
    properties,
    required,
  };
  const note = comment(m);
  if (note) out['$comment'] = note;
  return out;
}

/** The generic envelope: what every frame has, whatever its type (05 §4). */
export function envelopeSchema(): JsonSchema {
  return {
    title: 'Envelope',
    description:
      'Every text frame is one JSON object. Receivers MUST ignore members they do not know, and ignore message types they do not know (05 §1 rule 3).',
    $comment: '05 §4',
    type: 'object',
    properties: {
      t: { type: 'string', minLength: 1, description: 'Message type.' },
      id: { type: 'string', description: 'Set by the sender on a message that expects a reply.' },
      re: {
        type: 'string',
        description: 'The `id` this message replies to. Required on every reply.',
      },
      ch: {
        type: 'integer',
        minimum: 0,
        maximum: SAFE_MAX,
        description: 'Channel number, on every channel-scoped message including `ch.open`.',
      },
      d: { type: 'object', description: 'Payload.' },
    },
    required: ['t'],
  };
}

const extensions = (m: MessageDef): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    'x-dep-direction': m.dir,
    'x-dep-spec': m.spec,
    'x-dep-owner': m.owner,
  };
  if (m.feature) out['x-dep-feature'] = m.feature;
  if (m.replies) out['x-dep-replies'] = [...m.replies];
  if (m.gaps?.length) out['x-dep-gaps'] = [...m.gaps];
  if (m.decisions?.length) out['x-dep-decisions'] = [...m.decisions];
  return out;
};

export function generateAsyncApi(
  def: DepDefinition,
  cdmPath = '../cdm/cdm-1.schema.json',
): JsonSchema {
  const o = asyncApiSchemaOptions(cdmPath);
  const schemas: JsonSchema = { Envelope: envelopeSchema() };
  const roots = def.messages.flatMap((m) => (m.payload ? [m.payload] : []));
  for (const s of reachable(def, roots)) schemas[s.name] = namedSchema(s, o);
  for (const m of def.messages) {
    const name = payloadTypeName(m);
    if (m.payload && m.payload.kind !== 'ref' && name)
      schemas[name] = { title: name, ...toSchema(m.payload, o) };
  }
  for (const m of def.messages) schemas[`message.${m.t}`] = messageEnvelopeSchema(m, ASYNCAPI_REF);

  const messages: JsonSchema = {};
  for (const m of def.messages) {
    const correlation =
      m.re === 'required'
        ? '$message.payload#/re'
        : m.id === 'required'
          ? '$message.payload#/id'
          : undefined;
    messages[m.t] = {
      name: m.t,
      title: m.t,
      summary: m.summary,
      contentType: 'application/json',
      payload: { $ref: `${ASYNCAPI_REF}message.${m.t}` },
      ...(correlation ? { correlationId: { location: correlation } } : {}),
      ...extensions(m),
    };
  }

  const channelMessages: JsonSchema = {};
  for (const m of def.messages) channelMessages[m.t] = { $ref: `#/components/messages/${m.t}` };

  const operations: JsonSchema = {};
  const msgRef = (t: string) => ({ $ref: `#/channels/dep/messages/${t}` });
  for (const m of def.messages) {
    const actions: Array<'receive' | 'send'> =
      m.dir === 'c2s' ? ['receive'] : m.dir === 's2c' ? ['send'] : ['receive', 'send'];
    for (const action of actions) {
      const replies = (m.replies ?? []).filter((r) => {
        const rm = def.messages.find((x) => x.t === r);
        return rm && (action === 'receive' ? rm.dir !== 'c2s' : rm.dir !== 's2c');
      });
      operations[`${action}.${m.t}`] = {
        action,
        channel: { $ref: '#/channels/dep' },
        title: `${action === 'receive' ? 'Receive' : 'Send'} ${m.t}`,
        summary: m.summary,
        messages: [msgRef(m.t)],
        ...(replies.length
          ? { reply: { channel: { $ref: '#/channels/dep' }, messages: replies.map(msgRef) } }
          : {}),
        'x-dep-spec': m.spec,
      };
    }
  }

  return {
    asyncapi: '3.0.0',
    id: `urn:docedit:dep:${def.major}:${def.status}:realtime`,
    info: {
      title: 'DEP real-time plane',
      version: def.version,
      description: [
        `The real-time plane of the Document Editing Protocol ${def.version} (${def.status}), generated from packages/protocol/src/definition (05 §4, §5; SPK-019, PRO-001).`,
        'This document describes a DEP server: `receive` operations are messages a client sends, `send` operations are messages the server sends; `both` messages have one of each.',
        `One multiplexed WebSocket with the subprotocol \`${def.subprotocol}\`. Each text frame is one JSON object, the envelope \`{ t, id, re, ch, d }\`. Binary frames are reserved for engines with opaque payloads (three unsigned LEB128 integers \`ch\`, \`kind\`, \`id\`, then the payload); \`pm-steps/1\` does not use them.`,
        'Receivers MUST ignore fields and message types they do not know; a message of an unknown type that carries an `id` is answered with `error` `unknown_type`, `fatal: false` (05 §1 rule 3).',
        'Gaps and decisions are referenced by identifier (`x-dep-gaps`, `x-dep-decisions`, `$comment`); spec/dep/dep-1.gaps.json lists them.',
      ].join('\n\n'),
      'x-dep-status': def.status,
      'x-dep-subprotocol': def.subprotocol,
      'x-dep-engines': [...def.engines],
      'x-dep-cdm': def.cdm,
    },
    defaultContentType: 'application/json',
    servers: {
      dep: {
        host: '{host}',
        pathname: '/{path}',
        protocol: 'wss',
        title: 'DEP WebSocket',
        description:
          "The `ws` address announced in discovery (05 §2). The `Origin` header is checked against the tenant's allowed origins when `hello` arrives.",
        variables: {
          host: {
            default: 'docs.example.com',
            description: 'Host of the `ws` address from discovery.',
          },
          path: { default: 'dep', description: 'Path of the `ws` address from discovery.' },
        },
      },
    },
    channels: {
      dep: {
        address: null,
        title: 'DEP connection',
        description:
          'The whole connection: session messages and every channel multiplexed by `ch`. Messages on one channel are delivered in order; there is no ordering between channels. At most one channel per document may be open on a connection.',
        servers: [{ $ref: '#/servers/dep' }],
        messages: channelMessages,
        bindings: {
          ws: {
            bindingVersion: '0.1.0',
            headers: {
              type: 'object',
              properties: {
                'Sec-WebSocket-Protocol': {
                  const: def.subprotocol,
                  description: 'The subprotocol carries the major version (05 §1 rule 1, §4).',
                },
              },
              required: ['Sec-WebSocket-Protocol'],
            },
          },
        },
        'x-dep-close-codes': def.closeCodes.map((c) => ({ code: c.code, meaning: c.meaning })),
      },
    },
    operations,
    components: { schemas, messages },
  };
}
