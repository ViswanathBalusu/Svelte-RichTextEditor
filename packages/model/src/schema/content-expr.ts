/**
 * A small reader for ProseMirror content expressions, used by the generators to find which node
 * types a node may contain and how many children it needs at least. Validation of the order itself
 * is done by ProseMirror in model.validate().
 */
import type { CdmDefinition } from '../definition/grammar.ts';

type Ast =
  | { t: 'name'; name: string }
  | { t: 'seq'; items: Ast[] }
  | { t: 'choice'; items: Ast[] }
  | { t: 'rep'; inner: Ast; min: number };

function tokenize(expr: string): string[] {
  return expr.match(/\w+|\(|\)|\||\*|\+|\?|\{\d+(?:,\d*)?\}/g) ?? [];
}

export function parseContent(expr: string): Ast {
  const tokens = tokenize(expr);
  let pos = 0;
  const parseChoice = (): Ast => {
    const items = [parseSeq()];
    while (tokens[pos] === '|') {
      pos++;
      items.push(parseSeq());
    }
    return items.length === 1 ? items[0]! : { t: 'choice', items };
  };
  const parseSeq = (): Ast => {
    const items: Ast[] = [];
    while (pos < tokens.length && tokens[pos] !== ')' && tokens[pos] !== '|')
      items.push(parseAtom());
    return items.length === 1 ? items[0]! : { t: 'seq', items };
  };
  const parseAtom = (): Ast => {
    let node: Ast;
    const tok = tokens[pos++];
    if (tok === '(') {
      node = parseChoice();
      if (tokens[pos++] !== ')') throw new SyntaxError(`unbalanced parenthesis in "${expr}"`);
    } else if (tok && /^\w+$/.test(tok)) {
      node = { t: 'name', name: tok };
    } else {
      throw new SyntaxError(`unexpected token ${String(tok)} in "${expr}"`);
    }
    for (;;) {
      const m = tokens[pos];
      if (m === '*' || m === '?') node = { t: 'rep', inner: node, min: 0 };
      else if (m === '+') node = { t: 'rep', inner: node, min: 1 };
      else if (m?.startsWith('{'))
        node = { t: 'rep', inner: node, min: Number(m.slice(1).split(/[,}]/)[0]) };
      else break;
      pos++;
    }
    return node;
  };
  const ast = parseChoice();
  if (pos !== tokens.length) throw new SyntaxError(`trailing tokens in "${expr}"`);
  return ast;
}

function names(ast: Ast, out: Set<string>): Set<string> {
  switch (ast.t) {
    case 'name':
      out.add(ast.name);
      break;
    case 'rep':
      names(ast.inner, out);
      break;
    default:
      for (const i of ast.items) names(i, out);
  }
  return out;
}

function minLength(ast: Ast): number {
  switch (ast.t) {
    case 'name':
      return 1;
    case 'rep':
      return ast.min * minLength(ast.inner);
    case 'seq':
      return ast.items.reduce((a, i) => a + minLength(i), 0);
    case 'choice':
      return Math.min(...ast.items.map(minLength));
  }
}

/** Node types (groups expanded) a content expression admits, in definition order. */
export function allowedChildren(def: CdmDefinition, expr: string): string[] {
  const referenced = names(parseContent(expr), new Set());
  return def.nodes
    .filter(
      (n) => referenced.has(n.name) || (n.group ?? '').split(' ').some((g) => referenced.has(g)),
    )
    .map((n) => n.name);
}

export function minChildren(expr: string): number {
  return minLength(parseContent(expr));
}

/**
 * Adds a node type as one more choice to a repeated choice expression, for the projection schema
 * (ADR 0019): `(block | region | section_break)+` becomes `(block | region | section_break |
 * hidden_region)+`. Other forms are refused, so the change can never alter what else is allowed.
 */
export function extendContent(expr: string, name: string): string {
  const m = /^\((.*)\)([*+])$/.exec(expr.trim());
  const ast = m ? parseContent(`(${m[1]!})`) : null;
  if (!m || !ast || (ast.t !== 'choice' && ast.t !== 'name'))
    throw new SyntaxError(`content "${expr}" is not a repeated choice that can take "${name}"`);
  return `(${m[1]!} | ${name})${m[2]!}`;
}
