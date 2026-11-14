/**
 * The JSON Schema (2020-12) of the rules language (FRW-015: every attribute has a declared
 * grammar). It describes the shape of a `rule_def`'s attributes: the operands, the operators with
 * their arities, the effects, and the bounds JSON Schema can express. Types, references, conflicts
 * and cycles need the document's fields and are checked by `compileRules` (ADR 0030).
 */
import { DEFINITION_ID_PATTERN, FIELD_KEY_PATTERN } from './cdm.ts';
import {
  COMPARISON_OPERATORS,
  FIELD_EFFECTS,
  FORMULA_OPERATORS,
  LOGIC_OPERATORS,
  OPERATORS,
  type Operator,
} from './language.ts';
import { LIMITS } from './limits.ts';
import { RULES_STATUS, RULES_VERSION } from './version.ts';

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });

const single = (name: string, value: Schema): Schema => ({
  type: 'object',
  properties: { [name]: value },
  required: [name],
  additionalProperties: false,
});

const tuple = (items: Schema[]): Schema => ({
  type: 'array',
  prefixItems: items,
  minItems: items.length,
  items: false,
});

const list = (min: number, max?: number): Schema => ({
  type: 'array',
  items: ref('expression'),
  minItems: min,
  ...(max !== undefined ? { maxItems: max } : {}),
});

function operandsOf(op: Operator): Schema {
  switch (op) {
    case 'in':
      return tuple([ref('expression'), { type: 'array', items: { type: 'string' }, minItems: 1 }]);
    case 'matches':
      return tuple([ref('expression'), { type: 'string', maxLength: LIMITS.patternLength }]);
    case 'round':
      return tuple([
        ref('expression'),
        { type: 'integer', minimum: 0, maximum: LIMITS.roundPlaces },
      ]);
    case 'not':
    case 'empty':
      return list(1, 1);
    case 'if':
      return list(3, 3);
    case '-':
      return list(1, 2);
    case '/':
      return list(2, 2);
    case 'and':
    case 'or':
    case '+':
    case '*':
      return list(2);
    case 'sum':
    case 'min':
    case 'max':
    case 'concat':
      return list(1);
    default:
      return list(2, 2); // comparisons
  }
}

/** `$defs` names that need no escaping in a JSON Pointer or a URI fragment. */
const NAMES: Partial<Record<Operator, string>> = {
  '==': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
};
const defName = (op: Operator): string => `op_${NAMES[op] ?? op}`;

const keys: Schema = {
  type: 'array',
  items: ref('fieldKey'),
  minItems: 1,
  uniqueItems: true,
};

export function generateRulesSchema(): Schema {
  const defs: Record<string, Schema> = {
    fieldKey: { type: 'string', maxLength: 128, pattern: FIELD_KEY_PATTERN },
    ruleId: { type: 'string', pattern: DEFINITION_ID_PATTERN },
    literal: { anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'null' }] },
    field: single('field', ref('fieldKey')),
    role: single('role', { type: 'string', pattern: DEFINITION_ID_PATTERN }),
    now: single('now', { const: 'date' }),
  };
  for (const op of OPERATORS) defs[defName(op)] = single(op, operandsOf(op));
  defs['expression'] = {
    anyOf: [
      ref('literal'),
      ref('field'),
      ref('role'),
      ref('now'),
      ...OPERATORS.map((op) => ref(defName(op))),
    ],
  };
  for (const e of FIELD_EFFECTS) {
    if (e === 'validate')
      defs[`effect_${e}`] = single(e, {
        type: 'object',
        properties: {
          fields: keys,
          message: {
            type: 'string',
            minLength: 1,
            maxLength: LIMITS.messageLength,
            // No C0 controls other than tab and line feed, no DEL, no C1 controls (ADR 0018).
            pattern: '^[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]*$',
          },
        },
        required: ['fields', 'message'],
        additionalProperties: false,
      });
    else if (e === 'set')
      defs[`effect_${e}`] = single(e, {
        type: 'object',
        properties: { field: ref('fieldKey'), value: ref('expression') },
        required: ['field', 'value'],
        additionalProperties: false,
      });
    else defs[`effect_${e}`] = single(e, keys);
  }
  defs['effects'] = {
    type: 'array',
    items: { anyOf: FIELD_EFFECTS.map((e) => ref(`effect_${e}`)) },
  };
  defs['rule'] = {
    type: 'object',
    properties: {
      id: ref('ruleId'),
      when: ref('expression'),
      then: ref('effects'),
      else: { anyOf: [ref('effects'), { type: 'null' }] },
      ext: { type: 'object' },
    },
    required: ['id', 'when', 'then'],
    additionalProperties: false,
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:docedit:${RULES_VERSION.replace('/', ':')}:${RULES_STATUS}`,
    title: `Field rules ${RULES_VERSION} (${RULES_STATUS})`,
    description: [
      'The attributes of a rule_def (12 §3.5, §5; ADR 0012; ADR 0030). This schema checks shapes only.',
      'compileRules also checks, with the document at hand:',
      `- each of when, then and else is at most ${LIMITS.ruleAttributeBytes} bytes of canonical JSON and ${LIMITS.ruleDepth} levels deep (the CDM grammar of rule_def);`,
      '- static types: string literals are read as the decimal or date their position needs, and nothing is converted when a rule runs;',
      '- every field key exists (I14), set targets formula fields, choice literals are options of their field, role operands name a role_def;',
      '- one rule at most shows or hides, enables or disables, or sets each field; the graph of set effects has no cycle (I14);',
      `- at most ${LIMITS.rules} rules in a document (I15);`,
      `- patterns use the linear-time subset of ADR 0030 §5: repetition counts up to ${LIMITS.patternRepeat}, at most ${LIMITS.patternProgram} instructions.`,
      `Operator groups: comparison ${COMPARISON_OPERATORS.join(' ')}; logic ${LOGIC_OPERATORS.join(' ')}; in, empty, matches; formulas ${FORMULA_OPERATORS.join(' ')}.`,
      'The routing effects addParticipant and skipParticipant belong to the workflow resource, not to a rule_def.',
    ].join('\n'),
    $ref: '#/$defs/rule',
    $defs: defs,
  };
}
