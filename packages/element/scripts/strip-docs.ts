/**
 * Build-time removal of the documentation that the protocol definition and the CDM definition carry
 * as data (FND-008; ADR 0418 item 5).
 *
 * Both definitions are written once, with prose beside each shape, node and message (`doc`, `spec`,
 * `summary`, `gaps`, `decisions`), because the generators and the documents read it. The client
 * and the editor never do. The library build removes those members from the definitions' modules
 * before it bundles them, so the first download does not carry the prose. The sources, the
 * generators and the tests still see the whole definition; only the shipped chunks do not.
 *
 * What is removed (after the TypeScript has been erased, so the code is JavaScript):
 * - a property named `doc`, `spec`, `summary`, `gaps` or `decisions` whose value is a string, a
 *   template without expressions, or an array of such strings. A property of that name whose value
 *   is anything else (the `doc` member of a message that carries the document) is kept;
 * - the documentation argument of the constructors the module is given (`req`, `opt` and `reqIf`
 *   of the protocol's `shapes.ts`; `attr` of the CDM's `grammar.ts`) when it is a string.
 */
import { parseAst } from 'vite';
import type { Plugin } from 'vite';

const DOCUMENTATION_KEYS = new Set(['doc', 'spec', 'summary', 'gaps', 'decisions', 'clientAction']);
/** The argument position of the documentation in a constructor, by the constructor's name. */
export type DocArguments = Readonly<Record<string, number>>;
/** The prop constructors of the protocol's `shapes.ts`. */
export const PROTOCOL_DOC_ARGUMENTS: DocArguments = { req: 1, opt: 1, reqIf: 3 };
/** `attr` of the CDM's `grammar.ts`. */
export const CDM_DOC_ARGUMENTS: DocArguments = { attr: 2 };

/** The modules whose documentation is removed: the protocol's definition and the CDM's. */
export const STRIPPED_MODULES =
  /\/packages\/(?:protocol\/src\/definition\/(?:common|messages|errors|events|notifications|features|frw|frw-shapes|wire-more|resources)|model\/src\/definition\/(?:cdm1|citations|fields|projection|shared))\.ts$/;
const PROTOCOL_MODULES = /\/packages\/protocol\/src\/definition\//;

/** A range of the code to cut out, and what to put there instead (nothing, by default). */
type Cut = [start: number, end: number, replacement?: string];

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

function isProse(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return typeof node['value'] === 'string';
  if (node.type === 'TemplateLiteral') return (node['expressions'] as unknown[]).length === 0;
  if (node.type === 'ArrayExpression')
    return (node['elements'] as unknown[]).every((e) => isNode(e) && e.type === 'Literal');
  return false;
}

/** `code` without the documentation members and without the `positional` constructors' documentation. */
export function stripDocumentation(code: string, positional: DocArguments = {}): string {
  const program = parseAst(code) as unknown as Node;
  const cuts: Cut[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!isNode(node)) return;
    if (node.type === 'ObjectExpression') {
      const props = node['properties'] as Node[];
      const remove = props.map((p) => {
        const key = p['key'] as Node | undefined;
        return (
          p.type === 'Property' &&
          p['computed'] !== true &&
          p['method'] !== true &&
          key !== undefined &&
          key.type === 'Identifier' &&
          DOCUMENTATION_KEYS.has(key['name'] as string) &&
          isProse(p['value'])
        );
      });
      // A trailing run of removed members goes with the comma before it; any other removed
      // member goes with the comma after it.
      let runStart = props.length;
      while (runStart > 0 && remove[runStart - 1]) runStart--;
      props.forEach((p, i) => {
        if (!remove[i]) return;
        if (i >= runStart) {
          if (i === runStart) {
            const before = props[i - 1];
            cuts.push([before ? before.end : p.start, props[props.length - 1]!.end]);
          }
        } else cuts.push([p.start, props[i + 1]!.start]);
      });
    } else if (node.type === 'CallExpression') {
      const callee = node['callee'] as Node;
      const at = callee.type === 'Identifier' ? positional[callee['name'] as string] : undefined;
      const args = node['arguments'] as Node[];
      const arg = at === undefined ? undefined : args[at];
      if (at !== undefined && arg && isProse(arg) && arg.type !== 'ArrayExpression') {
        // The last argument goes with its comma; one before others becomes `void 0`.
        if (at === args.length - 1) cuts.push([args[at - 1]!.end, arg.end]);
        else cuts.push([arg.start, arg.end, 'void 0']);
      }
    }
    for (const value of Object.values(node)) if (typeof value === 'object') walk(value);
  };
  walk(program);
  if (cuts.length === 0) return code;
  cuts.sort((a, b) => b[0] - a[0]);
  let out = code;
  for (const cut of cuts) {
    out = out.slice(0, cut[0]) + (cut[2] ?? '') + out.slice(cut[1]);
  }
  return out;
}

/** The plugin: runs on the JavaScript the TypeScript transform leaves, in the modules named above. */
export function stripDefinitionDocs(): Plugin {
  return {
    name: 'docedit-strip-definition-docs',
    transform(code, id) {
      const path = id.replaceAll('\\', '/').replace(/\?.*$/, '');
      if (!STRIPPED_MODULES.test(path)) return null;
      const positional = PROTOCOL_MODULES.test(path) ? PROTOCOL_DOC_ARGUMENTS : CDM_DOC_ARGUMENTS;
      return { code: stripDocumentation(code, positional), map: null };
    },
  };
}
