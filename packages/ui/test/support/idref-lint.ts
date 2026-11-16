/**
 * The ID-reference rule of the shell's components (FE-108 criterion 2; 02 §10).
 *
 * An ID reference (`aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`,
 * `aria-activedescendant`, `aria-details`, `aria-errormessage`, `aria-flowto`, and `for` on a label)
 * resolves only inside one tree: a reference never crosses a shadow boundary. The rule is therefore
 * local: **every ID a component references must be an ID the same component file gives to one of its
 * own elements.** A component and the elements of its template are always in the same root, so a
 * reference that passes the rule cannot point out of the root. A reference to an ID that comes from
 * elsewhere (a property, a context, a literal that no element here carries) fails it.
 *
 * ESLint does not parse `.svelte` files in this workspace, so the rule is this module, run over
 * every component by `fe-108-idref-lint.test.ts` (part of `pnpm test`, and so of `pnpm check`).
 *
 * How a value is read. Each reference and each `id` is reduced to shapes:
 * - `"a b"`, `'a b'` and `` `${id}-a ${id}-b` `` give one shape for each ID in the list; the shape
 *   of an ID is its fixed text with a gap for each expression, so `` `${id}-option-${i}` `` and
 *   `` `${id}-option-${active}` `` agree;
 * - `c ? x : y`, `x || y` and `x ?? y` give the shapes of both sides; `undefined`, `null` and the
 *   empty string give none;
 * - `name(args)` gives the function's name, `name` gives the name;
 * - a name defined in the component's script by `const name = …` (also `$derived(…)`), by
 *   `function name(…) { return …; }` or by `const name = (…) => …` also gives the shapes of what it
 *   is defined as, and `[a, b].filter(Boolean).join(' ')` gives the shapes of its members.
 * A reference passes when one of its shapes is a shape of an `id` in the same file.
 */

export const IDREF_ATTRIBUTES = [
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'aria-activedescendant',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'for',
] as const;

export interface Reference {
  readonly attribute: string;
  /** The value as written, with its quotes or braces. */
  readonly value: string;
  /** 1-based line in the file. */
  readonly line: number;
  /** The shapes the value was reduced to. */
  readonly shapes: readonly string[];
}

export interface Finding extends Reference {
  readonly file: string;
  readonly message: string;
}

/** The end (exclusive) of the balanced `{…}` that starts at `start`, quotes and templates skipped. */
function closeBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      i = text.indexOf(c, i + 1);
      if (i < 0) return text.length;
    } else if (c === '`') {
      i = closeTemplate(text, i);
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The index of the backtick that closes the template literal starting at `start`. */
function closeTemplate(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') i++;
    else if (c === '`') return i;
    else if (c === '$' && text[i + 1] === '{') i = closeBrace(text, i + 1) - 1;
  }
  return text.length - 1;
}

/** Splits at the separator where it is outside brackets, quotes and templates. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '`') i = closeTemplate(text, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(from, i));
      from = i + separator.length;
      i = from - 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The `c ? a : b` at the top level of an expression, or null. `?.` and `??` are not it. */
function ternary(text: string): { yes: string; no: string } | null {
  let depth = 0;
  let question = -1;
  let nested = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '`') i = closeTemplate(text, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?') {
      const next = text[i + 1];
      if (next === '.' || next === '?') {
        i++;
        continue;
      }
      if (question < 0) question = i;
      else nested++;
    } else if (depth === 0 && c === ':' && question >= 0) {
      if (nested > 0) nested--;
      else return { yes: text.slice(question + 1, i), no: text.slice(i + 1) };
    }
  }
  return null;
}

const squash = (text: string): string => text.replace(/\s+/g, '');

/** The IDs of a space-separated list inside a template or a quoted value, as shapes. */
function listShapes(body: string): string[] {
  const ids: string[] = [];
  let current = '';
  let holes: string[] = [];
  const flush = (): void => {
    // An ID that is one expression and nothing else is that expression.
    if (current === '${}') ids.push(...expressionShapes(holes[0]!));
    else if (current) ids.push(`id:${current}`);
    current = '';
    holes = [];
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if ((c === '$' && body[i + 1] === '{') || c === '{') {
      const open = c === '$' ? i + 1 : i;
      const end = closeBrace(body, open);
      // `{x}` in a quoted attribute and `${x}` in a template mean the same. The expression is kept
      // apart: two IDs agree when their fixed text agrees, whatever fills the gaps (an option's id
      // is written with the loop's index, and referenced with the index of the active option).
      holes.push(squash(body.slice(open + 1, end - 1)));
      current += '${}';
      i = end - 1;
    } else if (/\s/.test(c)) {
      flush();
    } else current += c;
  }
  flush();
  return ids;
}

/** The shapes of a JavaScript expression that gives an ID, a list of IDs or nothing. */
export function expressionShapes(expression: string): string[] {
  let e = expression.trim();
  while (e.startsWith('(') && closeParen(e) === e.length) e = e.slice(1, -1).trim();
  if (e === '' || e === 'undefined' || e === 'null' || e === "''" || e === '""' || e === 'false')
    return [];
  const choice = ternary(e);
  if (choice) return [...expressionShapes(choice.yes), ...expressionShapes(choice.no)];
  for (const operator of ['||', '??']) {
    const sides = splitTop(e, operator);
    if (sides.length > 1) return sides.flatMap(expressionShapes);
  }
  if (e.startsWith('`') && closeTemplate(e, 0) === e.length - 1) return listShapes(e.slice(1, -1));
  if (/^'[^']*'$/.test(e) || /^"[^"]*"$/.test(e)) return listShapes(e.slice(1, -1));
  const joined = /^\[([\s\S]*)\]\s*(?:\.filter\([\s\S]*?\))?\s*\.join\(\s*['"] ['"]\s*\)$/.exec(e);
  if (joined) return splitTop(joined[1]!, ',').flatMap(expressionShapes);
  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(e);
  if (call && closeParen(e.slice(call[1]!.length).trimStart()) > 0) return [`call:${call[1]}`];
  if (/^[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*$/.test(e)) return [`name:${e}`];
  return [`other:${squash(e)}`];
}

/** The length of the balanced `(…)` at the start of `text`, or 0. */
function closeParen(text: string): number {
  if (!text.startsWith('(')) return 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '`') i = closeTemplate(text, i);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return 0;
}

/** The shapes of an attribute value as written: `"…"`, `{…}` or a bare word. */
function valueShapes(value: string): string[] {
  if (value.startsWith('{')) return expressionShapes(value.slice(1, -1));
  if (value.startsWith('"') || value.startsWith("'")) return listShapes(value.slice(1, -1));
  return listShapes(value);
}

/** What a name is defined as in the component's script, as an expression, or null. */
function definition(script: string, name: string): string | null {
  const escaped = name.replace(/[$.]/g, '\\$&');
  const variable = new RegExp(`(?:const|let)\\s+${escaped}\\s*(?::[^=]+)?=\\s*`).exec(script);
  if (variable) {
    const rest = script.slice(variable.index + variable[0].length);
    let expression = splitTop(rest, ';')[0]!.trim();
    const derived = /^\$derived\s*\(/.exec(expression);
    if (derived) expression = expression.slice(derived[0].length - 1);
    const arrow = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*/.exec(expression);
    if (arrow) {
      const body = expression.slice(arrow[0].length).trim();
      if (!body.startsWith('{')) return body;
      const returned = /\breturn\s+([\s\S]*?);/.exec(body);
      return returned ? returned[1]! : null;
    }
    return expression;
  }
  const fn = new RegExp(`function\\s+${escaped}\\s*\\(`).exec(script);
  if (fn) {
    const open = script.indexOf('{', script.indexOf(')', fn.index));
    const body = script.slice(open, closeBrace(script, open));
    const returned = /\breturn\s+([\s\S]*?);/.exec(body);
    return returned ? returned[1]! : null;
  }
  return null;
}

/** The shapes with what their names are defined as, followed three levels deep. */
function expand(shapes: readonly string[], script: string): Set<string> {
  const all = new Set(shapes);
  let frontier = [...shapes];
  for (let level = 0; level < 3 && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const shape of frontier) {
      const named = /^(?:name|call):(.+)$/.exec(shape);
      const defined = named ? definition(script, named[1]!) : null;
      if (defined === null) continue;
      for (const s of expressionShapes(defined))
        if (!all.has(s)) {
          all.add(s);
          next.push(s);
        }
    }
    frontier = next;
  }
  return all;
}

/** Every `id` and every ID reference in a component's markup. */
export function scan(source: string): { ids: Reference[]; references: Reference[] } {
  // Scripts and styles are blanked, keeping their line breaks, so that lines stay right.
  const markup = source.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  const ids: Reference[] = [];
  const references: Reference[] = [];
  const names = ['id', ...IDREF_ATTRIBUTES].join('|');
  const attribute = new RegExp(`(?<![\\w:-])(${names})=`, 'g');
  for (let m = attribute.exec(markup); m; m = attribute.exec(markup)) {
    const start = m.index + m[0].length;
    const first = markup[start];
    let end: number;
    if (first === '{') end = closeBrace(markup, start);
    else if (first === '"' || first === "'") end = markup.indexOf(first, start + 1) + 1;
    else end = start + /^[^\s>]*/.exec(markup.slice(start))![0].length;
    const value = markup.slice(start, end);
    const found: Reference = {
      attribute: m[1]!,
      value,
      line: markup.slice(0, m.index).split('\n').length,
      shapes: valueShapes(value),
    };
    (found.attribute === 'id' ? ids : references).push(found);
    attribute.lastIndex = end;
  }
  return { ids, references };
}

/** The references of one component that are not to an ID the component gives to its own elements. */
export function idrefFindings(source: string, file: string): Finding[] {
  const script = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .join('\n');
  const { ids, references } = scan(source);
  const declared = new Set<string>();
  for (const id of ids) for (const shape of expand(id.shapes, script)) declared.add(shape);
  const findings: Finding[] = [];
  for (const reference of references) {
    if (reference.shapes.length === 0) continue;
    const reachable = expand(reference.shapes, script);
    // Each ID of the reference must be one of the component's own: a name or a call counts through
    // what it is defined as.
    const missing = reference.shapes.filter((shape) => {
      const own = expand([shape], script);
      return ![...own].some((s) => declared.has(s));
    });
    if (missing.length === 0) continue;
    findings.push({
      ...reference,
      file,
      message:
        `${reference.attribute}=${reference.value} names ${missing.join(', ')}, which no element of ` +
        `this component carries as its id (FE-108: a reference must stay in its component, and so ` +
        `in its root). Reached: ${[...reachable].join(', ')}`,
    });
  }
  return findings;
}
