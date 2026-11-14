/**
 * Generates the JSON Schema (draft 2020-12) of the CDM from the definition (CDM-007).
 *
 * What JSON Schema cannot express is listed in the description and checked by model.validate():
 * the order of children, identity and references, table geometry, limits measured over the whole
 * document, the math gate, forbidden combinations that depend on attributes, and feature gating.
 */
import { DEFINITION_ID_PATTERN, NODE_MARK_HOSTS } from '../definition/cdm1.ts';
import type { CdmDefinition, Grammar, MarkDef, NodeDef } from '../definition/grammar.ts';
import { CLARK_NAME_PATTERN, refPattern } from '../validate/grammar-check.ts';
import { allowedChildren, minChildren } from './content-expr.ts';

type Schema = Record<string, unknown>;

const NO_CONTROL_PATTERN = '^[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]*$';
const SUGGESTION_MARKS = ['ins', 'del', 'fmt'];

export const NOT_EXPRESSIBLE = [
  'I1 in part: the order and cardinality of children (content expressions); exactly one paragraph in a footnote; node marks only on paragraph, table_row and table; node types, marks, attributes and attribute values (the `field` kind `formValue`) that belong to a feature missing from `requires`; the `hidden_region` placeholder and the redaction marker, which exist only in projections',
  'I2: identifiers present and unique; a non-null identifier never changes; a suggestion identifier belongs to one user',
  'I3: regions and section breaks are direct children of the body; a removed region identifier is never reused',
  'I4: every reference resolves, to a definition of the right kind, a numbering level that the definition has and a field target of the kind its field needs; cited sources exist; assets are attached to the document',
  'I5: basedOn chains have no cycles and are at most ten styles deep',
  'I6: column spans add up to the grid, taking row spans into account; header rows are at most the rows of the table',
  'I7 in part: canonical size at most 16 MiB, at most 500 regions, nesting depth at most 12',
  'I8: LaTeX passes the math gate (09)',
  'I10 in part: no footnote inside a footnote; no table in a story or a footnote; no floating figure in a table cell; no page or column break in cells, captions or footnotes; no form field in headers, footers or footnotes',
  'I11 in part: rules that relate two values: table properties only on table styles, `minLevel` at most `maxLevel`, a field target in the form of its kind and no target or sequence name where the kind takes none, unique option identifiers, the shape of `fmt.before`',
  'I12 in part: an extension node carries a fallback',
  'I13 to I15: field keys unique, assignees and `formValue` targets resolve, at most 2,000 fields and 500 rules, values of at most 4 KiB typed by kind',
  'Size and depth limits of `ext`, payloads and preserved element trees; a name in a registered namespace written with its prefix, never in Clark notation; references to shared trees resolve to a `preserved_def`',
];

function grammarSchema(g: Grammar): Schema {
  let s: Schema;
  switch (g.kind) {
    case 'string': {
      s = { type: 'string', maxLength: g.maxLength };
      if (g.minLength !== undefined) s['minLength'] = g.minLength;
      if (g.pattern && g.noControl !== false)
        s = { ...s, allOf: [{ pattern: g.pattern }, { pattern: NO_CONTROL_PATTERN }] };
      else if (g.pattern) s['pattern'] = g.pattern;
      else if (g.noControl !== false) s['pattern'] = NO_CONTROL_PATTERN;
      break;
    }
    case 'integer':
      s = { type: 'integer', minimum: g.min, maximum: g.max };
      break;
    case 'boolean':
      s = { type: 'boolean' };
      break;
    case 'enum':
      s = { enum: [...g.values] };
      break;
    case 'ref':
      s = { type: 'string', pattern: refPattern(g.to) };
      break;
    case 'object': {
      const properties: Schema = {};
      for (const [k, v] of Object.entries(g.properties)) properties[k] = grammarSchema(v);
      s = { type: 'object', properties, additionalProperties: false };
      if (g.required?.length) s['required'] = [...g.required];
      break;
    }
    case 'array':
      s = { type: 'array', items: grammarSchema(g.items), maxItems: g.maxItems };
      if (g.minItems !== undefined) s['minItems'] = g.minItems;
      break;
    case 'json':
      s = g.objectOnly
        ? {
            type: 'object',
            ...(g.keyPattern ? { propertyNames: { pattern: g.keyPattern } } : {}),
            additionalProperties: { $ref: '#/$defs/json' },
            description: `At most ${g.maxBytes} bytes of canonical JSON and ${g.maxDepth} levels deep.`,
          }
        : {
            $ref: '#/$defs/json',
            description: `At most ${g.maxBytes} bytes of canonical JSON and ${g.maxDepth} levels deep.`,
          };
      break;
    case 'elementTree':
      s = g.noRef
        ? {
            $ref: '#/$defs/elementBody',
            description: `At most ${g.maxBytes} bytes of canonical JSON and ${g.maxDepth} levels deep.`,
          }
        : {
            anyOf: [{ $ref: '#/$defs/elementBody' }, { $ref: '#/$defs/elementRef' }],
            description: `A tree of at most ${g.maxBytes} bytes of canonical JSON and ${g.maxDepth} levels deep, or a reference to a shared tree in a preserved_def.`,
          };
      break;
  }
  return g.nullable ? { anyOf: [s, { type: 'null' }] } : s;
}

function attrsSchema(def: NodeDef | MarkDef): Schema {
  const properties: Schema = {};
  const required: string[] = [];
  for (const [name, a] of Object.entries(def.attrs)) {
    // `default` is an annotation: the value the canonical form omits (03 §2). A required
    // attribute's default only lets ProseMirror create the node, so it is not published.
    properties[name] =
      a.presence === 'required'
        ? grammarSchema(a.grammar)
        : { ...grammarSchema(a.grammar), default: a.default };
    if (a.presence === 'required') required.push(name);
  }
  const s: Schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) s['required'] = required;
  return s;
}

const hasRequired = (def: NodeDef | MarkDef): boolean =>
  Object.values(def.attrs).some((a) => a.presence === 'required');

export function generateJsonSchema(def: CdmDefinition): Schema {
  const defs: Schema = {};
  for (const n of def.nodes) {
    const properties: Schema = { type: { const: n.name } };
    const required = ['type'];
    if (n.name === 'text') {
      properties['text'] = { type: 'string', minLength: 1 };
      properties['marks'] = {
        type: 'array',
        items: { anyOf: def.marks.map((m) => ({ $ref: `#/$defs/mark.${m.name}` })) },
      };
      required.push('text');
    } else {
      if (Object.keys(n.attrs).length) properties['attrs'] = { $ref: `#/$defs/attrs.${n.name}` };
      if (hasRequired(n)) required.push('attrs');
      if (n.content) {
        const content: Schema = {
          type: 'array',
          items: {
            anyOf: allowedChildren(def, n.content).map((c) => ({ $ref: `#/$defs/node.${c}` })),
          },
        };
        const min = minChildren(n.content);
        if (min > 0) {
          content['minItems'] = min;
          required.push('content');
        }
        properties['content'] = content;
      }
      if (NODE_MARK_HOSTS.includes(n.name)) {
        properties['marks'] = {
          type: 'array',
          items: { anyOf: SUGGESTION_MARKS.map((m) => ({ $ref: `#/$defs/mark.${m}` })) },
        };
      } else if (n.inline) {
        // Inline atoms carry marks as text does (spike S11, change 1).
        properties['marks'] = {
          type: 'array',
          items: { anyOf: def.marks.map((m) => ({ $ref: `#/$defs/mark.${m.name}` })) },
        };
      }
    }
    defs[`node.${n.name}`] = {
      description: n.feature
        ? `${n.doc} Feature \`${n.feature}\`. (${n.spec})`
        : `${n.doc} (${n.spec})`,
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
    if (n.name !== 'text' && Object.keys(n.attrs).length) defs[`attrs.${n.name}`] = attrsSchema(n);
  }
  for (const m of def.marks) {
    const properties: Schema = { type: { const: m.name } };
    if (Object.keys(m.attrs).length) properties['attrs'] = { $ref: `#/$defs/attrs.mark.${m.name}` };
    defs[`mark.${m.name}`] = {
      description: m.feature
        ? `${m.doc} Feature \`${m.feature}\`. (${m.spec})`
        : `${m.doc} (${m.spec})`,
      type: 'object',
      properties,
      required: hasRequired(m) ? ['type', 'attrs'] : ['type'],
      additionalProperties: false,
    };
    defs[`attrs.mark.${m.name}`] = attrsSchema(m);
  }
  defs['json'] = {
    description: 'JSON without floating-point numbers (03 §1 principle 7): decimals are strings.',
    anyOf: [
      { type: 'null' },
      { type: 'boolean' },
      { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
      { type: 'string' },
      { type: 'array', items: { $ref: '#/$defs/json' } },
      { type: 'object', additionalProperties: { $ref: '#/$defs/json' } },
    ],
  };
  const attrsMap = {
    type: 'object',
    propertyNames: { pattern: CLARK_NAME_PATTERN },
    additionalProperties: { type: 'string' },
  };
  defs['elementBody'] = {
    description:
      'Preserved attributes and child elements of an original element, in Clark notation (ADR 0017).',
    type: 'object',
    properties: {
      attrs: attrsMap,
      children: {
        type: 'array',
        items: { anyOf: [{ $ref: '#/$defs/element' }, { $ref: '#/$defs/elementText' }] },
      },
    },
    additionalProperties: false,
  };
  defs['element'] = {
    type: 'object',
    properties: {
      name: { type: 'string', pattern: CLARK_NAME_PATTERN },
      attrs: attrsMap,
      children: {
        type: 'array',
        items: { anyOf: [{ $ref: '#/$defs/element' }, { $ref: '#/$defs/elementText' }] },
      },
    },
    required: ['name'],
    additionalProperties: false,
  };
  defs['elementText'] = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };
  defs['elementRef'] = {
    description: 'A reference to the shared tree of a preserved_def (spike S11).',
    type: 'object',
    properties: { ref: { type: 'string', pattern: DEFINITION_ID_PATTERN } },
    required: ['ref'],
    additionalProperties: false,
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:docedit:cdm:${def.cdm}${def.status === 'draft' ? ':draft' : ''}`,
    title: `CDM version ${def.cdm}${def.status === 'draft' ? ' (draft)' : ''}`,
    description: [
      `JSON Schema for documents of the Canonical Document Model, major version ${def.cdm}, generated from packages/model/src/definition (03; CDM-007).`,
      def.status === 'draft'
        ? 'Draft: published before the footnote model (CDM-001), the attribute grammars (CDM-002) and spike S11 are decided.'
        : '',
      'A document is valid only if it also passes model.validate(); this schema cannot express:',
      ...NOT_EXPRESSIBLE.map((s) => `- ${s}.`),
    ]
      .filter(Boolean)
      .join('\n'),
    type: 'object',
    properties: {
      cdm: { const: def.cdm },
      requires: {
        type: 'array',
        items: { enum: def.features.map((f) => f.name) },
        uniqueItems: true,
      },
      doc: { $ref: `#/$defs/node.${def.topNode}` },
    },
    required: ['cdm', 'requires', 'doc'],
    additionalProperties: false,
    $defs: defs,
  };
}
