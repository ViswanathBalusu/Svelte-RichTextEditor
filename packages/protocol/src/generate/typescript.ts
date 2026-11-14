/**
 * Generates the TypeScript types of DEP from the definition (SPK-019; PRO-004 groundwork): one
 * interface per named shape and message payload, the envelope of every message type, the REST
 * operation map and the webhook event map. The output imports only CDM types from `@docedit/model`,
 * never ProseMirror (PRO-091).
 */
import type { DepDefinition } from '../definition/extension.ts';
import { webhookData, webhookType, webhookTypeName } from '../definition/events.ts';
import type { MessageDef } from '../definition/messages.ts';
import { PATH_PARAMS, type OperationDef } from '../definition/resources.ts';
import type { Prop, Shape } from '../definition/shapes.ts';

const ident = /^[A-Za-z_$][\w$]*$/;
const key = (k: string): string => (ident.test(k) ? k : JSON.stringify(k));
const docLine = (text: string | undefined, indent = ''): string =>
  text ? `${indent}/** ${text.replace(/\*\//g, '* /').replace(/\n/g, ' ')} */\n` : '';

/** PascalCase of a message type: `sync.caughtUp` → `SyncCaughtUp`. */
export function pascal(t: string): string {
  return t
    .split(/[._-]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/** The generated name of a message's payload type. */
export function payloadTypeName(m: MessageDef): string | null {
  if (!m.payload) return null;
  if (m.payload.kind === 'ref') return m.payload.name;
  return m.payloadName ?? pascal(m.t);
}

export const messageTypeName = (m: MessageDef): string => `${pascal(m.t)}Message`;

function wrap(t: string): string {
  return /[|&]/.test(t) ? `(${t})` : t;
}

export function tsType(shape: Shape, indent = ''): string {
  switch (shape.kind) {
    case 'string':
      if (shape.enum) return shape.enum.map((v) => JSON.stringify(v)).join(' | ');
      if (shape.known)
        return `${shape.known.map((v) => JSON.stringify(v)).join(' | ')} | (string & {})`;
      return 'string';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'const':
      return JSON.stringify(shape.value);
    case 'array': {
      const inner = tsType(shape.items, indent);
      return /[|&{ ]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case 'object':
      return objectType(shape.props, indent, shape.openMembers === true);
    case 'map':
      return `{ [key: string]: ${tsType(shape.values, indent)} }`;
    case 'ref':
      return shape.name;
    case 'anyOf':
      return shape.of.map((s) => wrap(tsType(s, indent))).join(' | ');
    case 'nullable':
      return `${wrap(tsType(shape.of, indent))} | null`;
    case 'any':
      return 'unknown';
    case 'external':
      return shape.target === 'cdm-doc' ? 'ModelDocNode' : 'ModelCdmEnvelope';
  }
}

function member(name: string, p: Prop, indent: string): string {
  const conditional =
    typeof p.required === 'object'
      ? `Required when \`${p.required.if.prop}\` is ${JSON.stringify(p.required.if.equals)}.`
      : '';
  const text = [p.doc ?? p.shape.doc, conditional].filter(Boolean).join(' ');
  const optional = p.required === true ? '' : '?';
  return `${docLine(text, indent)}${indent}${key(name)}${optional}: ${tsType(p.shape, indent)};\n`;
}

function objectType(props: Readonly<Record<string, Prop>>, indent: string, open = false): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return '{ [key: string]: unknown }';
  const inner = `${indent}  `;
  const index = open ? `${inner}[member: string]: unknown;\n` : '';
  return `{\n${entries.map(([k, p]) => member(k, p, inner)).join('')}${index}${indent}}`;
}

function declare(name: string, shape: Shape, doc?: string): string {
  const head = docLine(doc ?? shape.doc);
  if (shape.kind === 'object' && Object.keys(shape.props).length > 0)
    return `${head}export interface ${name} ${objectType(shape.props, '', shape.openMembers === true)}\n`;
  return `${head}export type ${name} = ${tsType(shape)};\n`;
}

function envelope(m: MessageDef): string {
  const payload = payloadTypeName(m);
  const lines: string[] = [`  t: ${JSON.stringify(m.t)};`];
  lines.push(m.id === 'required' ? '  id: string;' : '  id?: string;');
  if (m.re === 'required') lines.push('  re: string;');
  else lines.push('  re?: string;');
  if (m.ch === 'required') lines.push('  ch: number;');
  else if (m.ch === 'optional') lines.push('  ch?: number;');
  if (payload === null) lines.push('  d?: { [key: string]: unknown };');
  else lines.push(`  d: ${payload};`);
  const dir = { c2s: 'client to server', s2c: 'server to client', both: 'either direction' }[m.dir];
  return `/** \`${m.t}\` (${dir}, ${m.spec}): ${m.summary.replace(/\*\//g, '* /')} */\nexport interface ${messageTypeName(m)} {\n${lines.join('\n')}\n}\n`;
}

function operationEntry(o: OperationDef): string {
  const params = [...o.path.matchAll(/\{(\w+)\}/g)].map((p) => p[1]!);
  const paramType = params.length
    ? `{ ${params.map((p) => `${p}: ${tsType((o.params?.[p] ?? PATH_PARAMS[p])!.shape)}`).join('; ')} }`
    : 'Record<string, never>';
  const queryEntries = Object.entries(o.query ?? {});
  if (o.success.list)
    queryEntries.push(
      ['cursor', { shape: { kind: 'string' }, required: false }],
      ['limit', { shape: { kind: 'integer' }, required: false }],
    );
  const query = queryEntries.length
    ? `{ ${queryEntries.map(([k, p]) => `${key(k)}${p.required === true ? '' : '?'}: ${tsType(p.shape)}`).join('; ')} }`
    : 'Record<string, never>';
  const body = o.body ? tsType(o.body) : 'never';
  const item = o.success.body ? tsType(o.success.body) : 'void';
  const response = o.success.list ? `List<${item}>` : item;
  return [
    `  /** ${o.method} ${o.path}: ${o.summary.replace(/\*\//g, '* /')} (${o.spec}) */`,
    `  ${o.operationId}: {`,
    `    method: ${JSON.stringify(o.method)};`,
    `    path: ${JSON.stringify(o.path)};`,
    `    params: ${paramType};`,
    `    query: ${query};`,
    `    body: ${body};`,
    `    response: ${response};`,
    `  };`,
  ].join('\n');
}

export function generateTypes(def: DepDefinition): string {
  const out: string[] = [];
  out.push(
    '// GENERATED by packages/protocol/scripts/generate.ts from src/definition. Do not edit by hand.',
    `// DEP ${def.version} (${def.status}). See docs/spec/05-protocol.md.`,
    '/* eslint-disable */',
    '',
    "import type { CdmEnvelope as ModelCdmEnvelope, DocNode as ModelDocNode } from '@docedit/model';",
    '',
    `export type ProtocolVersion = ${JSON.stringify(def.version)};`,
    `export type Subprotocol = ${JSON.stringify(def.subprotocol)};`,
    '',
    '/** A cursor list (05 §6.1). `nextCursor` is null on the last page (D14). */',
    'export interface List<T> {\n  items: T[];\n  nextCursor: string | null;\n}',
    '',
    '// --- Named shapes -------------------------------------------------------------------------',
    '',
  );
  for (const s of def.shapes) out.push(declare(s.name, s.shape));
  out.push(
    '// --- Message payloads ---------------------------------------------------------------------',
    '',
  );
  for (const m of def.messages)
    if (m.payload && m.payload.kind !== 'ref')
      out.push(declare(payloadTypeName(m)!, m.payload, `Payload of \`${m.t}\` (${m.spec}).`));
  out.push(
    '// --- Envelopes (05 §4) ---------------------------------------------------------------------',
    '',
  );
  for (const m of def.messages) out.push(envelope(m));
  const union = (ms: readonly MessageDef[]) =>
    ms.map((m) => `  | ${messageTypeName(m)}`).join('\n');
  out.push(
    `/** Every message a client may send. */\nexport type ClientMessage =\n${union(def.messages.filter((m) => m.dir !== 's2c'))};\n`,
    `/** Every message a server may send. */\nexport type ServerMessage =\n${union(def.messages.filter((m) => m.dir !== 'c2s'))};\n`,
    `/** Every message of DEP ${def.version}. */\nexport type DepMessage =\n${union(def.messages)};\n`,
    `export type MessageType = DepMessage['t'];\n`,
    `/** Message envelope by type. */\nexport interface MessageMap {\n${def.messages.map((m) => `  ${JSON.stringify(m.t)}: ${messageTypeName(m)};`).join('\n')}\n}\n`,
    `/** Payload by message type (\`never\` for a message without payload). */\nexport interface PayloadMap {\n${def.messages.map((m) => `  ${JSON.stringify(m.t)}: ${payloadTypeName(m) ?? 'never'};`).join('\n')}\n}\n`,
  );
  out.push(
    '// --- Control plane (05 §6) -----------------------------------------------------------------',
    '',
  );
  out.push(
    `/** Every REST operation: method, path, parameters, body and success response. */\nexport interface Operations {\n${def.operations.map(operationEntry).join('\n')}\n}\n`,
  );
  out.push(`export type OperationId = keyof Operations;\n`);
  out.push(
    '// --- Events plane (05 §7) ------------------------------------------------------------------',
    '',
  );
  for (const w of def.webhooks) out.push(declare(`${webhookTypeName(w)}Data`, webhookData(w)));
  out.push(
    `/** \`data\` by CloudEvents \`type\`. */\nexport interface WebhookEventMap {\n${def.webhooks.map((w) => `  ${JSON.stringify(webhookType(w))}: ${webhookTypeName(w)}Data;`).join('\n')}\n}\n`,
    [
      '/** A webhook body: a CloudEvents 1.0 event in structured JSON mode (05 §7). */',
      'export interface WebhookEvent<T extends keyof WebhookEventMap = keyof WebhookEventMap> {',
      "  specversion: '1.0';",
      '  id: string;',
      '  source: string;',
      '  type: T;',
      '  /** The document identifier. */',
      '  subject: string;',
      '  time?: string;',
      "  datacontenttype?: 'application/json';",
      '  data: WebhookEventMap[T];',
      '}',
      '',
    ].join('\n'),
  );
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
