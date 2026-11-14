/**
 * What the rules read from the CDM definition (packages/model, cdm1.ts), so that the two never
 * disagree: the grammar of field keys and the bounds of the `rule_def` attributes.
 */
import { CDM1, DEFINITION_ID_PATTERN, type Grammar } from '@docedit/model/definition';

function grammarOf(node: string, attr: string): Grammar {
  const g = CDM1.nodes.find((n) => n.name === node)?.attrs[attr]?.grammar;
  if (!g) throw new Error(`the CDM definition has no ${node}.${attr}`);
  return g;
}

function patternOf(node: string, attr: string): string {
  const g = grammarOf(node, attr);
  if (g.kind !== 'string' || !g.pattern) throw new Error(`${node}.${attr} has no pattern`);
  return g.pattern;
}

/** Field keys such as `tenant.income` (the grammar of `form_field.key`). */
export const FIELD_KEY_PATTERN = patternOf('form_field', 'key');
/** Rule and role identifiers (the grammar of definition identifiers). */
export { DEFINITION_ID_PATTERN };

/** The CDM's bounds on `when`, `then` and `else`, for the test that keeps LIMITS equal to them. */
export function ruleAttributeBounds(): Record<
  'when' | 'then' | 'else',
  { maxBytes: number; maxDepth: number }
> {
  const read = (attr: string) => {
    const g = grammarOf('rule_def', attr);
    if (g.kind !== 'json') throw new Error(`rule_def.${attr} is not free JSON`);
    return { maxBytes: g.maxBytes, maxDepth: g.maxDepth };
  };
  return { when: read('when'), then: read('then'), else: read('else') };
}

/** The CDM's bound on `validation.pattern`, for the same test. */
export function patternLengthBound(): number {
  const g = grammarOf('form_field', 'validation');
  const inner = g.kind === 'object' ? g.properties['pattern'] : g;
  if (!inner || inner.kind !== 'string')
    throw new Error('form_field.validation.pattern is not a string');
  return inner.maxLength;
}
