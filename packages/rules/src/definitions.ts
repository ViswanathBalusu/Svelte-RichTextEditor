/**
 * Save-time check of the patterns in a document (FRW-018 criterion 1; 12 §3.2, §5.2; ADR 0030 §5
 * and §8). A `validation.pattern` of a `form_field`, or a `matches` pattern of a `rule_def`, that
 * lies outside the pattern subset is refused, and the construct it uses is named. Every problem is
 * reported with its absolute JSON Pointer into the document (under `/doc` for an envelope).
 *
 * The function only reports; the save path decides. It is separate from `compileDocument` so that
 * the send checklist and the commit path keep their own refusals (12 §6.2).
 */
import type { JsonValue } from '@docedit/model';
import { fieldFrom, readDocument } from './document.ts';
import { checkFieldDefinition } from './fields.ts';
import { isObject, pointer } from './json.ts';
import { compileRules } from './language.ts';

export interface PatternSaveProblem {
  /** Absolute JSON Pointer of the offending value in the document. */
  path: string;
  code: 'pattern_syntax' | 'pattern_unsupported' | 'pattern_limit';
  /** The construct that is outside the subset, such as `back-reference`, when it has a name. */
  construct?: string;
  message: string;
}

const PATTERN_CODES = new Set<string>(['pattern_syntax', 'pattern_unsupported', 'pattern_limit']);

interface FormFieldNode {
  attrs: Record<string, JsonValue>;
  path: string;
}

/** Every `form_field` node, in document order, with its JSON Pointer (as `readDocument` walks). */
function formFieldNodes(input: unknown): FormFieldNode[] {
  const out: FormFieldNode[] = [];
  let root: unknown = input;
  let base = '';
  if (isObject(input) && 'doc' in input) {
    root = input['doc'];
    base = '/doc';
  }
  const stack: Array<[unknown, string]> = [[root, base]];
  while (stack.length) {
    const [node, path] = stack.pop()!;
    if (!isObject(node)) continue;
    const attrs = node['attrs'];
    if (node['type'] === 'form_field' && isObject(attrs)) out.push({ attrs, path });
    const content = node['content'];
    if (Array.isArray(content))
      for (let i = content.length - 1; i >= 0; i--)
        stack.push([content[i], pointer(pointer(path, 'content'), i)]);
  }
  return out;
}

/**
 * Every pattern of the document that the subset refuses: the `validation.pattern` of each
 * `form_field` (checked by `checkFieldDefinition`) and each `matches` pattern of a `rule_def`
 * (checked by `compileRules`). Other problems are not reported here.
 */
export function checkDocumentPatterns(input: unknown): PatternSaveProblem[] {
  const out: PatternSaveProblem[] = [];
  for (const node of formFieldNodes(input)) {
    const field = fieldFrom(node.attrs);
    if (!field) continue;
    for (const p of checkFieldDefinition(field)) {
      if (!PATTERN_CODES.has(p.code)) continue;
      out.push({
        path: `${pointer(node.path, 'attrs')}${p.path}`,
        code: p.code as PatternSaveProblem['code'],
        message: p.message,
        ...(p.construct !== undefined ? { construct: p.construct } : {}),
      });
    }
  }
  const read = readDocument(input);
  const compiled = compileRules(read.rules, { fields: read.fields, roles: read.roles });
  if (!compiled.ok)
    for (const p of compiled.problems) {
      if (!PATTERN_CODES.has(p.code)) continue;
      out.push({
        path: p.path,
        code: p.code as PatternSaveProblem['code'],
        message: p.message,
        ...(p.construct !== undefined ? { construct: p.construct } : {}),
      });
    }
  return out;
}
